import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { chromium } from 'playwright-core';

// This suite uses a dedicated migrated schema and the connected client served
// by the real API. Only transport replies are delayed/dropped; API state is real.
const base = new URL(process.env.AQUA_BASE_URL ?? 'http://127.0.0.1:3006');
const schema = process.env.DATABASE_SCHEMA ?? '';
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), 'Use a loopback sandbox UI.');
assert.ok(/^(?:aqua_issuer_browser|issuer_browser|test_)[a-z0-9_]*$/.test(schema), 'Use a dedicated issuer browser schema, not the application schema.');
assert.notEqual(process.env.NODE_ENV, 'production');
assert.ok(process.env.MIGRATION_DATABASE_URL && process.env.DISPATCHER_DATABASE_URL, 'Set the owner and separate dispatcher database URLs.');
for (const name of ['MIGRATION_DATABASE_URL', 'DISPATCHER_DATABASE_URL']) {
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(process.env[name]).hostname), 'The browser suite requires a local PostgreSQL sandbox.');
}
const repo = fileURLToPath(new URL('../', import.meta.url));
const artifacts = new URL('../artifacts/issuer-server/', import.meta.url);
await mkdir(artifacts, { recursive: true });
const database = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, options: `-c search_path=${schema},pg_catalog,pg_temp -c statement_timeout=10000`, max: 2 });
const runId = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
const password = 'AquaIssuerBrowser#2026';
const owner = { name: '카드 설정 검증', email: `issuer-${runId}@aqua.example.test`, tag: `i${runId}` };
const other = { name: '다른 카드 회원', email: `issuer-other-${runId}@aqua.example.test`, tag: `j${runId}` };
const checks = [], runtimeErrors = [], commandRequests = [], childProcesses = new Set();
const isCommand = (request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/issuer-card/status';
let browser, page, providerServer, providerOrigin, ownerId, cardId;
let stopping = false;
let providerClock = null;
const providerKey = randomBytes(32);
const operations = new Map(), bodies = new Map(), providerCalls = [], providerErrors = [];
let nextProviderBehavior = 'success';

const pass = (name) => { checks.push(name); console.log(`PASS ${checks.length}: ${name}`); };
const panel = () => page.getByTestId('issuer-card-panel');
const interrupt = () => {
  stopping = true;
  for (const processChild of childProcesses) processChild.kill('SIGTERM');
  void browser?.close().catch(() => {});
  providerServer?.closeAllConnections();
};
process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
function child(entry, args = [], extraEnv = {}) {
  assert.equal(stopping, false, 'Issuer browser checks were interrupted.');
  const processChild = spawn(process.execPath, ['--import', 'tsx', entry, ...args], {
    cwd: repo, env: { ...process.env, NODE_ENV: 'development', ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  childProcesses.add(processChild);
  let stdout = '', stderr = '';
  processChild.stdout.on('data', (data) => { stdout += data.toString(); });
  processChild.stderr.on('data', (data) => { stderr += data.toString(); });
  const timer = setTimeout(() => processChild.kill('SIGKILL'), 20_000); timer.unref();
  return new Promise((resolve, reject) => {
    processChild.once('error', reject);
    processChild.once('close', (code, signal) => {
      clearTimeout(timer); childProcesses.delete(processChild);
      resolve({ code, signal, stdout, stderr });
    });
  });
}
async function operator(args) {
  const result = await child('server/issuer-operator.ts', args);
  assert.equal(result.code, 0, `Issuer operator failed: ${result.stderr.slice(-1500)}`);
  return JSON.parse(result.stdout);
}
async function cardEvent(event) {
  // Exercise the same application role and transaction boundary as the sandbox
  // operator. A policy decline must commit its decision before surfacing an error.
  const code = `
    import { databaseFromEnvironment } from './server/database.ts';
    import { CardPaymentStore } from './server/card-payments.ts';
    import { LedgerError } from './server/ledger.ts';
    const db = await databaseFromEnvironment();
    try {
      try {
        const result = await new CardPaymentStore(db).apply(JSON.parse(process.env.AQUA_BROWSER_CARD_EVENT));
        console.log(JSON.stringify({ accepted: true, result }));
      } catch (error) {
        if (!(error instanceof LedgerError)) throw error;
        console.log(JSON.stringify({ accepted: false, code: error.code }));
      }
    } finally { await db.close(); }
  `;
  const result = await child('--input-type=module', ['-e', code], { AQUA_BROWSER_CARD_EVENT: JSON.stringify(event) });
  assert.equal(result.code, 0, `Card policy command failed: ${result.stderr.slice(-1500)}`);
  return JSON.parse(result.stdout);
}
const authorize = (suffix, amountWon = 1_000) => ({ kind: 'authorize', eventId: `${runId}-${suffix}-authorize`,
  paymentId: `${runId}-${suffix}`, userId: ownerId, amountWon, merchantName: '카드 잠금 검증' });
const paymentEvent = (authorization, kind, fields = {}) => ({ kind, eventId: `${authorization.paymentId}-${kind}`,
  paymentId: authorization.paymentId, userId: ownerId, ...fields });
async function approvalState(expected, target = page) {
  await target.waitForFunction((expected) => document.querySelector('[data-testid="issuer-authorization-state"]')
    ?.getAttribute('data-authorization') === expected, expected);
}
const dispatchEnv = () => ({ AQUA_ISSUER_SANDBOX_URL: providerOrigin, AQUA_ISSUER_KEY_ID: 'browser', AQUA_ISSUER_SIGNING_KEY: providerKey.toString('base64url') });
async function dispatch() {
  providerClock = null;
  const result = await child('server/issuer-dispatcher.ts', ['--once'], dispatchEnv());
  assert.equal(result.code, 0, `Issuer dispatcher failed: ${result.stderr.slice(-1500)}`);
  assert.doesNotMatch(result.stdout + result.stderr, /postgres(?:ql)?:\/\/|leaseToken|requestKey|sandbox-card-/);
  return JSON.parse(result.stdout.trim().split('\n')[0]).result;
}

// The virtual clock is confined to retry tests. The real restricted dispatcher,
// signed HTTP adapter, and provider fixture still execute every attempt.
async function dispatchAt(now) {
  providerClock = now;
  const code = `
    import { cardServiceDatabase } from './server/card-service-database.ts';
    import { IssuerOutboxStore } from './server/issuer-outbox.ts';
    import { createSandboxIssuerAdapter } from './server/issuer-adapter.ts';
    import { dispatchIssuerOnce } from './server/issuer-dispatcher-loop.ts';
    const now = Number(process.env.AQUA_BROWSER_CLOCK);
    const db = await cardServiceDatabase('dispatcher');
    try {
      const store = new IssuerOutboxStore(db, { now: () => now });
      const adapter = createSandboxIssuerAdapter({ baseUrl: process.env.AQUA_ISSUER_SANDBOX_URL,
        keyId: 'browser', signingKey: process.env.AQUA_ISSUER_SIGNING_KEY, now: () => now });
      console.log(JSON.stringify(await dispatchIssuerOnce(store, adapter)));
    } finally { await db.close(); }
  `;
  const result = await child('--input-type=module', ['-e', code], { ...dispatchEnv(), AQUA_BROWSER_CLOCK: String(now) });
  assert.equal(result.code, 0, `Timed dispatcher failed: ${result.stderr.slice(-1500)}`);
  return JSON.parse(result.stdout);
}

async function startProvider() {
  const reply = (response, status, body) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
  async function receive(request, response) {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks), method = request.method, path = request.url;
    const timestamp = request.headers['x-aqua-timestamp'];
    assert.equal(request.headers['x-aqua-key-id'], 'browser');
    assert.match(timestamp ?? '', /^\d+$/);
    assert.ok(Math.abs(Number(timestamp) * 1000 - (providerClock ?? Date.now())) <= 300_000);
    const signed = createHmac('sha256', providerKey).update(`sandbox.issuer.v1.browser.${timestamp}.${method}.${path}.`).update(bytes).digest('hex');
    assert.equal(request.headers['x-aqua-signature'], `v1=${signed}`);
    if (method === 'POST') {
      const command = JSON.parse(bytes.toString('utf8'));
      assert.deepEqual(Object.keys(command).sort(), ['cardRef', 'expiresAt', 'requestKey', 'targetStatus']);
      assert.equal(path, `/cards/${command.cardRef}/status`);
      assert.equal(request.headers['idempotency-key'], command.requestKey);
      providerCalls.push({ method, requestKey: command.requestKey });
      if (bodies.has(command.requestKey)) assert.equal(bodies.get(command.requestKey), bytes.toString('utf8'));
      else {
        bodies.set(command.requestKey, bytes.toString('utf8'));
        const behavior = nextProviderBehavior; nextProviderBehavior = 'success';
        assert.ok(Number.isSafeInteger(command.expiresAt));
        const result = command.expiresAt <= (providerClock ?? Date.now()) || behavior === 'reject'
          ? { requestKey: command.requestKey, cardRef: command.cardRef, status: 'rejected', code: 'COMMAND_REJECTED' }
          : behavior === 'pending'
            ? { requestKey: command.requestKey, cardRef: command.cardRef, status: 'pending' }
            : { requestKey: command.requestKey, cardRef: command.cardRef, status: 'succeeded', cardStatus: command.targetStatus };
        operations.set(command.requestKey, result);
      }
      const result = operations.get(command.requestKey);
      reply(response, result.status === 'rejected' ? 422 : result.status === 'pending' ? 202 : 200, result);
    } else {
      assert.equal(method, 'GET'); assert.equal(bytes.length, 0); assert.ok(path.startsWith('/operations/'));
      const requestKey = path.slice('/operations/'.length);
      providerCalls.push({ method, requestKey });
      const result = operations.get(requestKey);
      reply(response, !result ? 404 : result.status === 'pending' ? 202 : 200, result ?? { requestKey, status: 'not_found', authoritative: true });
    }
  }
  providerServer = createServer((request, response) => {
    void receive(request, response).catch((error) => { providerErrors.push(String(error)); reply(response, 500, { error: 'Fixture rejected request' }); });
  });
  await new Promise((resolve) => providerServer.listen(0, '127.0.0.1', resolve));
  providerOrigin = `http://127.0.0.1:${providerServer.address().port}`;
}

function watch(target) {
  target.setDefaultTimeout(15_000);
  target.on('pageerror', (error) => runtimeErrors.push(error.message));
  target.on('request', (request) => {
    if (isCommand(request)) commandRequests.push({ key: request.headers()['idempotency-key'], ownerId: request.headers()['x-aqua-account'], body: request.postDataJSON() });
  });
}
async function signup(target, member) {
  await target.goto(base.href, { waitUntil: 'networkidle' });
  await target.getByTestId('auth-signup-tab').click();
  await target.getByTestId('auth-name').fill(member.name);
  await target.getByTestId('auth-email').fill(member.email);
  await target.getByTestId('auth-tag').fill(member.tag);
  await target.getByTestId('auth-password').fill(password);
  await target.getByTestId('auth-submit').click();
  await target.getByTestId('server-balance').waitFor();
  const response = await target.context().request.get(new URL('/api/account', base).href);
  assert.equal(response.status(), 200);
  return (await response.json()).user;
}
async function login(target, member) {
  await target.getByTestId('auth-email').fill(member.email);
  await target.getByTestId('auth-password').fill(password);
  await target.getByTestId('auth-submit').click();
  await target.getByTestId('server-balance').waitFor();
}
async function snapshot(target = page, accountId = ownerId) {
  const response = await target.context().request.get(new URL('/api/issuer-card', base).href, { headers: { 'X-Aqua-Account': accountId } });
  assert.equal(response.status(), 200);
  return response.json();
}
async function state(confirmed, commandStatus, target = page) {
  await target.waitForFunction(({ confirmed, commandStatus }) => {
    const element = document.querySelector('[data-testid="issuer-card-panel"]');
    return element?.getAttribute('data-confirmed-status') === confirmed
      && element?.getAttribute('data-command-status') === (commandStatus === 'none' ? '' : commandStatus)
      && element?.getAttribute('data-fresh') === 'true';
  }, { confirmed, commandStatus });
}
async function refresh(target = page) {
  await target.getByTestId('issuer-refresh').click();
  await target.waitForFunction(() => document.querySelector('[data-testid="issuer-card-panel"]')?.getAttribute('data-fresh') === 'true');
}
async function countCommands(userId = ownerId) {
  return Number((await database.query('SELECT count(*)::text AS n FROM issuer_outbox WHERE user_id=$1', [userId])).rows[0].n);
}
async function storedIntents(target = page, userId = ownerId) {
  return target.evaluate((prefix) => Object.keys(localStorage).filter((key) => key.startsWith(prefix)).map((key) => JSON.parse(localStorage.getItem(key))), `aqua.server.issuer.${encodeURIComponent(userId)}.`);
}
async function lock(target = page) {
  const response = target.waitForResponse((reply) => isCommand(reply.request()));
  await target.getByTestId('issuer-lock').click();
  assert.equal((await response).status(), 202);
}
async function unlock(target = page) {
  await target.getByTestId('issuer-unlock').click();
  await target.getByTestId('issuer-unlock-dialog').waitFor();
  const response = target.waitForResponse((reply) => isCommand(reply.request()));
  await target.getByTestId('issuer-unlock-confirm').click();
  assert.equal((await response).status(), 202);
}
async function finishSuccess(confirmed, commandStatus = 'succeeded') {
  const result = await dispatch(); assert.equal(result.status, 'succeeded');
  await refresh(); await state(confirmed, commandStatus);
}
async function fits(target, name) {
  const size = await target.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth }));
  assert.ok(size.width <= size.viewport + 1, `${name}: horizontal overflow ${size.width}/${size.viewport}`);
}

try {
  assert.equal(Number((await database.query("SELECT count(*)::text AS n FROM issuer_outbox WHERE status IN ('pending','in_flight','retry','needs_review')")).rows[0].n), 0, 'Start with an empty isolated issuer queue.');
  await startProvider();
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'], env: { ...process.env, XDG_CONFIG_HOME: '/tmp/aqua-chromium-config', XDG_CACHE_HOME: '/tmp/aqua-chromium-cache' } });
  assert.equal(stopping, false, 'Issuer browser checks were interrupted.');
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul', reducedMotion: 'reduce' });
  const otherContext = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul', reducedMotion: 'reduce' });
  page = await context.newPage(); watch(page);
  const health = await context.request.get(new URL('/api/health', base).href);
  assert.equal(health.status(), 200); assert.equal((await health.json()).mode, 'sandbox');
  ownerId = (await signup(page, owner)).id;
  await page.getByTestId('issuer-empty').waitFor();
  assert.equal(await page.getByTestId('issuer-lock').count(), 0);
  assert.equal((await snapshot()).card, null);
  const noCardAuthorization = authorize('unmapped');
  assert.deepEqual(await cardEvent(noCardAuthorization), { accepted: false, code: 'CARD_NOT_ISSUED' });
  pass('A newly registered account shows no linked card and cannot issue a fabricated card command.');

  cardId = (await operator(['register', ownerId, `sandbox-card-${runId}`, 'active'])).cardId;
  await refresh(); await state('active', 'none');
  assert.equal(await panel().getAttribute('data-card-id'), cardId);
  assert.match(await page.getByTestId('issuer-confirmed-state').innerText(), /잠금 해제/);
  assert.equal(await page.getByTestId('issuer-lock').isEnabled(), true);
  await approvalState('allowed');
  assert.deepEqual(await cardEvent(noCardAuthorization), { accepted: false, code: 'CARD_NOT_ISSUED' });
  const funded = await child('server/credit.ts', [owner.email, '20000', `${runId}-card-policy-funds`]);
  assert.equal(funded.code, 0, `Test funding failed: ${funded.stderr.slice(-1500)}`);
  const originalAuthorization = authorize('before-lock', 4_000);
  const originalApproval = await cardEvent(originalAuthorization);
  assert.equal(originalApproval.accepted, true);
  const reverseAuthorization = authorize('reverse-after-lock', 2_000);
  assert.equal((await cardEvent(reverseAuthorization)).accepted, true);
  let beforeMoney = await (await context.request.get(new URL('/api/account', base).href)).json();
  await page.screenshot({ path: new URL('issuer-active.png', artifacts).pathname, fullPage: true });
  pass('The connected card panel reads the registered owner card and displays only the server-confirmed status.');

  await lock(); await state('active', 'pending');
  assert.match(await page.getByTestId('issuer-request-state').innerText(), /확인|처리/);
  assert.equal(await page.getByTestId('issuer-lock').isDisabled(), true);
  assert.equal(await page.getByTestId('issuer-unlock').count(), 0);
  assert.equal((await snapshot()).card.confirmedStatus, 'active');
  await approvalState('blocked');
  const lockedAuthorization = authorize('declined-while-lock-pending');
  assert.deepEqual(await cardEvent(lockedAuthorization), { accepted: false, code: 'CARD_LOCKED' });
  assert.deepEqual(await cardEvent(originalAuthorization), originalApproval);
  const declinedMoney = await (await context.request.get(new URL('/api/account', base).href)).json();
  assert.deepEqual([declinedMoney.balanceWon, declinedMoney.heldBalanceWon, declinedMoney.transactions],
    [beforeMoney.balanceWon, beforeMoney.heldBalanceWon, beforeMoney.transactions]);
  pass('A pending lock immediately stops new authorization, preserves the original approved replay and leaves funds untouched on decline.');
  await page.screenshot({ path: new URL('issuer-pending.png', artifacts).pathname, fullPage: true });
  await finishSuccess('locked');
  assert.match(await page.getByTestId('issuer-confirmed-state').innerText(), /^잠금$/);
  assert.equal(providerCalls.filter((call) => call.method === 'POST').length, 1);
  await approvalState('blocked');
  const capturedPayment = await cardEvent(paymentEvent(originalAuthorization, 'capture', { amountWon: 4_000, finalCapture: true }));
  assert.equal(capturedPayment.accepted, true);
  assert.equal((await cardEvent(paymentEvent(originalAuthorization, 'refund', { amountWon: 4_000 }))).accepted, true);
  assert.equal((await cardEvent(paymentEvent(reverseAuthorization, 'reverse'))).accepted, true);
  pass('HTTP 202 leaves the last confirmed state unchanged; a real signed dispatcher response is required before the card appears locked.');
  pass('A locked card still permits capture, refund and reversal of payments approved before the lock.');

  let requestStart = commandRequests.length;
  await page.getByTestId('issuer-unlock').click();
  await page.getByTestId('issuer-unlock-dialog').waitFor();
  await page.getByTestId('issuer-unlock-cancel').waitFor();
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'issuer-unlock-cancel');
  await page.keyboard.press('Escape');
  await page.getByTestId('issuer-unlock-dialog').waitFor({ state: 'hidden' });
  assert.equal(commandRequests.length, requestStart);
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'issuer-unlock');
  await page.getByTestId('issuer-unlock').click();
  await page.getByTestId('issuer-unlock-cancel').click();
  assert.equal(commandRequests.length, requestStart);
  await unlock(); await state('locked', 'pending');
  assert.equal(await page.getByTestId('issuer-unlock').isDisabled(), true);
  await approvalState('blocked');
  const unlockingAuthorization = authorize('declined-while-unlocking');
  assert.deepEqual(await cardEvent(unlockingAuthorization), { accepted: false, code: 'CARD_LOCKED' });
  await finishSuccess('active');
  await approvalState('allowed');
  assert.deepEqual(await cardEvent(lockedAuthorization), { accepted: false, code: 'CARD_LOCKED' });
  assert.deepEqual(await cardEvent(unlockingAuthorization), { accepted: false, code: 'CARD_LOCKED' });
  const afterUnlockAuthorization = authorize('after-unlock');
  assert.equal((await cardEvent(afterUnlockAuthorization)).accepted, true);
  assert.equal((await cardEvent(paymentEvent(afterUnlockAuthorization, 'reverse'))).accepted, true);
  // Subsequent checks only change card controls. Keep their monetary baseline
  // after the completed policy lifecycle above, including its immutable history.
  beforeMoney = await (await context.request.get(new URL('/api/account', base).href)).json();
  assert.equal(beforeMoney.balanceWon, 20_000); assert.equal(beforeMoney.heldBalanceWon, 0);
  pass('Unlock requires an accessible confirmation; cancel and Escape send no request and restore focus.');
  pass('Only confirmed unlock permits a new authorization ID; earlier declined IDs stay declined after unlock.');

  const beforeLost = await countCommands(); requestStart = commandRequests.length;
  let droppedReceipt, resolveDropped;
  const dropped = new Promise((resolve) => { resolveDropped = resolve; });
  const drop = async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch(); assert.equal(response.status(), 202);
    droppedReceipt = await response.json(); await route.abort('failed'); resolveDropped();
  };
  await page.route('**/api/issuer-card/status', drop, { times: 1 });
  await page.getByTestId('issuer-lock').click();
  await dropped;
  await page.getByTestId('issuer-error').waitFor();
  await page.getByTestId('issuer-retry').waitFor();
  assert.ok(droppedReceipt);
  const intentBeforeReload = await storedIntents(); assert.equal(intentBeforeReload.length, 1);
  assert.equal(await countCommands(), beforeLost + 1);
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByTestId('issuer-retry').waitFor();
  assert.deepEqual(await storedIntents(), intentBeforeReload);
  await page.close();
  page = await context.newPage(); watch(page);
  await page.goto(base.href, { waitUntil: 'networkidle' });
  await page.getByTestId('issuer-retry').waitFor();
  assert.deepEqual(await storedIntents(), intentBeforeReload);
  const replay = page.waitForResponse((reply) => isCommand(reply.request()));
  await page.getByTestId('issuer-retry').click();
  const replayResponse = await replay; assert.equal(replayResponse.status(), 202);
  assert.equal((await replayResponse.json()).duplicate, true);
  await state('active', 'pending');
  await page.getByTestId('issuer-retry').waitFor({ state: 'hidden' });
  const replays = commandRequests.slice(requestStart);
  assert.equal(replays.length, 2); assert.equal(replays[0].key, replays[1].key);
  assert.deepEqual(replays[0].body, replays[1].body); assert.equal(replays[0].ownerId, ownerId);
  assert.equal(await countCommands(), beforeLost + 1);
  await finishSuccess('locked');
  pass('A committed request with a lost 202 survives reload and tab closure, then reuses the original owner, key and payload without another outbox record.');

  await unlock(); await finishSuccess('active');
  let releaseOld, heldResponse, oldCaptured;
  const captured = new Promise((resolve) => { oldCaptured = resolve; });
  const released = new Promise((resolve) => { releaseOld = resolve; });
  const holdOld = async (route) => {
    heldResponse = await route.fetch(); oldCaptured(); await released;
    await route.fulfill({ response: heldResponse }).catch(() => {});
  };
  await page.route('**/api/issuer-card', holdOld, { times: 1 });
  await page.getByTestId('issuer-refresh').click(); await captured;
  const accepted = page.waitForResponse((reply) => isCommand(reply.request()));
  await page.getByTestId('issuer-lock').click(); assert.equal((await accepted).status(), 202);
  releaseOld(); await state('active', 'pending');
  assert.equal(await page.getByTestId('issuer-lock').isDisabled(), true);
  await delay(100);
  assert.equal(await panel().getAttribute('data-command-status'), 'pending');
  assert.equal(await page.getByTestId('issuer-unlock').count(), 0);
  await finishSuccess('locked');
  pass('A pre-write GET released after the accepted request cannot restore an old state or enable the opposite action.');

  await unlock(); await finishSuccess('active');
  const beforeStorage = await countCommands(); requestStart = commandRequests.length;
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('aqua.server.issuer.')) throw new DOMException('Test storage full', 'QuotaExceededError');
      return original.call(this, key, value);
    };
  });
  await page.getByTestId('issuer-lock').click();
  await page.getByTestId('issuer-error').waitFor();
  assert.equal(commandRequests.length, requestStart); assert.equal(await countCommands(), beforeStorage);
  assert.equal(await page.getByTestId('issuer-lock').isDisabled(), true);
  await page.reload({ waitUntil: 'networkidle' }); await state('active', 'succeeded');
  pass('Unavailable request persistence blocks the POST instead of losing its idempotency key.');

  requestStart = commandRequests.length;
  await page.evaluate(() => {
    const original = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function (key) {
      if (key.startsWith('aqua.server.issuer.')) throw new DOMException('Test storage unavailable', 'SecurityError');
      return original.call(this, key);
    };
  });
  await lock(); await page.getByTestId('issuer-error').waitFor();
  assert.equal((await storedIntents()).length, 1);
  assert.equal(await page.getByTestId('issuer-lock').isDisabled(), true);
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByTestId('issuer-retry').click();
  await page.getByTestId('issuer-retry').waitFor({ state: 'hidden' });
  assert.equal(commandRequests[requestStart].key, commandRequests[requestStart + 1].key);
  assert.equal(await countCommands(), beforeStorage + 1);
  await finishSuccess('locked');
  pass('Failed local cleanup retains the accepted request and blocks fresh keys until the same request is recovered.');

  await context.setOffline(true);
  await page.waitForFunction(() => document.querySelector('[data-testid="issuer-card-panel"]')?.getAttribute('data-fresh') === 'false');
  assert.equal(await page.getByTestId('issuer-unlock').isDisabled(), true);
  assert.equal(await panel().getAttribute('data-confirmed-status'), 'locked');
  assert.match(await page.getByTestId('issuer-request-state').innerText(), /확인|연결/);
  await approvalState('unconfirmed');
  await context.setOffline(false); await state('locked', 'succeeded');
  pass('Offline state disables changes while retaining an explicitly last-confirmed status, then refreshes after reconnection.');

  await unlock(); await finishSuccess('active');
  nextProviderBehavior = 'reject';
  await lock(); assert.equal((await dispatch()).status, 'failed');
  await refresh(); await state('active', 'failed');
  assert.equal(await page.getByTestId('issuer-lock').isEnabled(), true);
  assert.match(await page.getByTestId('issuer-request-state').innerText(), /반영|거절|완료|변경|처리/);
  await approvalState('blocked');
  assert.deepEqual(await cardEvent(authorize('failed-lock')), { accepted: false, code: 'CARD_LOCKED' });
  pass('An explicit provider rejection leaves the confirmed card unchanged and offers a fresh versioned request.');

  const secondPage = await context.newPage(); watch(secondPage);
  await secondPage.goto(base.href, { waitUntil: 'networkidle' }); await state('active', 'failed', secondPage);
  const originalVersion = (await snapshot()).card.version;
  const beforeTabs = await countCommands();
  await page.bringToFront(); await refresh();
  await lock();
  const competing = await context.request.post(new URL('/api/issuer-card/status', base).href, {
    headers: { Origin: base.origin, 'X-Aqua-Account': ownerId, 'Idempotency-Key': `${runId}-stale-tab` },
    data: { cardId, targetStatus: 'active', expectedVersion: originalVersion },
  });
  assert.equal(competing.status(), 409);
  await secondPage.bringToFront(); await refresh(secondPage); await state('active', 'pending', secondPage);
  assert.equal(await secondPage.getByTestId('issuer-lock').isDisabled(), true);
  assert.equal(await countCommands(), beforeTabs + 1);
  await secondPage.close(); await page.bringToFront();
  await finishSuccess('locked');
  pass('Another tab sees the unresolved request and a stale opposite command cannot create a competing operation.');

  await unlock(); await finishSuccess('active');
  nextProviderBehavior = 'pending'; await lock();
  let result = await dispatch(); assert.equal(result.status, 'retry');
  await refresh(); await state('active', 'retry');
  assert.equal(await page.getByTestId('issuer-lock').isDisabled(), true);
  const reviewId = result.id;
  for (let attempt = 2; attempt <= 8; attempt++) {
    const row = (await database.query('SELECT next_attempt_at FROM issuer_outbox WHERE id=$1', [reviewId])).rows[0];
    result = await dispatchAt(Number(row.next_attempt_at));
  }
  assert.equal(result.status, 'needs_review');
  await refresh(); await state('active', 'needs_review');
  assert.equal(await page.getByTestId('issuer-lock').isDisabled(), true);
  assert.equal(await page.getByTestId('issuer-retry').count(), 0, 'The user cannot requeue a provider review operation.');
  await approvalState('blocked');
  assert.deepEqual(await cardEvent(authorize('lock-under-review')), { accepted: false, code: 'CARD_LOCKED' });
  await page.screenshot({ path: new URL('issuer-review.png', artifacts).pathname, fullPage: true });
  pass('Pending provider responses remain unconfirmed and exhausted retries show review status without a customer-side requeue action.');

  const review = (await database.query('SELECT request_key,version,updated_at FROM issuer_outbox WHERE id=$1', [reviewId])).rows[0];
  const originalCommand = JSON.parse(bodies.get(review.request_key));
  operations.set(review.request_key, { requestKey: review.request_key, cardRef: originalCommand.cardRef, status: 'succeeded', cardStatus: originalCommand.targetStatus });
  await operator(['retry', reviewId, review.version, `${runId}-review-recovery`, '공급업체 처리 결과를 확인한 뒤 다시 조회']);
  assert.equal((await dispatchAt(Number(review.updated_at) + 1)).status, 'succeeded');
  providerClock = null;
  await refresh(); await state('locked', 'succeeded');
  const finalMoney = await (await context.request.get(new URL('/api/account', base).href)).json();
  assert.deepEqual([finalMoney.balanceWon, finalMoney.heldBalanceWon, finalMoney.totalBalanceWon, finalMoney.transactions],
    [beforeMoney.balanceWon, beforeMoney.heldBalanceWon, beforeMoney.totalBalanceWon, beforeMoney.transactions]);
  pass('Operator-authorized lookup recovery updates the card panel and leaves all monetary balances and transfer history unchanged.');

  await fits(page, 'Desktop issuer panel');
  await page.screenshot({ path: new URL('issuer-desktop.png', artifacts).pathname, fullPage: true });
  for (const width of [320, 390, 430]) {
    await page.setViewportSize({ width, height: 900 });
    await fits(page, `${width}px issuer panel`);
    const bounds = await page.getByTestId('issuer-unlock').boundingBox();
    assert.ok(bounds && bounds.height >= 44 && bounds.width >= 44);
    await page.screenshot({ path: new URL(`issuer-${width}.png`, artifacts).pathname, fullPage: true });
  }
  pass('The connected card panel fits desktop and 320/390/430px reduced-motion profiles with usable action targets.');

  const otherPage = await otherContext.newPage(); watch(otherPage);
  const otherUser = await signup(otherPage, other);
  const otherCard = await operator(['register', otherUser.id, `sandbox-card-other-${runId}`, 'active']);
  await otherPage.getByTestId('issuer-refresh').click(); await state('active', 'none', otherPage);
  await page.bringToFront();
  await refresh();
  let releaseOldOwner, oldOwnerCaptured;
  const capturedOwner = new Promise((resolve) => { oldOwnerCaptured = resolve; });
  const releaseOwner = new Promise((resolve) => { releaseOldOwner = resolve; });
  await page.route('**/api/issuer-card', async (route) => {
    const previousOwnerResponse = await route.fetch();
    oldOwnerCaptured(); await releaseOwner;
    await route.fulfill({ response: previousOwnerResponse }).catch(() => {});
  }, { times: 1 });
  await page.getByTestId('issuer-refresh').click(); await capturedOwner;
  const swapped = await context.request.post(new URL('/api/auth/login', base).href, { headers: { Origin: base.origin }, data: { email: other.email, password } });
  assert.equal(swapped.status(), 200);
  const wrongOwner = await context.request.get(new URL('/api/issuer-card', base).href, { headers: { 'X-Aqua-Account': ownerId } });
  assert.equal(wrongOwner.status(), 409); assert.equal((await wrongOwner.json()).error.code, 'SESSION_CHANGED');
  assert.equal((await wrongOwner.text()).includes(otherCard.cardId), false);
  // The existing account guard expires the old owner while its issuer read is
  // still in flight. Its late response must not overwrite the next login.
  await page.getByTestId('server-refresh').click();
  await page.getByTestId('auth-email').waitFor();
  assert.equal(await page.getByTestId('issuer-card-panel').count(), 0);
  assert.equal(await page.locator(`[data-card-id="${otherCard.cardId}"]`).count(), 0);
  await login(page, other); await state('active', 'none');
  releaseOldOwner(); await delay(100);
  assert.equal(await panel().getAttribute('data-card-id'), otherCard.cardId);
  assert.equal(await page.locator(`[data-card-id="${cardId}"]`).count(), 0);
  assert.equal(await page.getByTestId('issuer-retry').count(), 0);
  pass('A cross-tab cookie change yields SESSION_CHANGED, and a delayed prior-owner response cannot overwrite the card after a different login.');

  assert.deepEqual(providerErrors, []); assert.deepEqual(runtimeErrors, []);
  await writeFile(new URL('results.json', artifacts), JSON.stringify({ recordedAt: new Date().toISOString(), baseUrl: base.href,
    passed: checks.length, checks, backendMocked: false, database: 'PostgreSQL', accountsCreated: 2,
    engine: 'Chromium', realDeviceTested: false, provider: 'Loopback Aqua sandbox contract fixture',
    mutationPaths: ['Authenticated issuer status API', 'Restricted dispatcher with signed HTTP', 'Restricted application role card authorization and settlement', 'Local operator registration and audited recovery'],
    faultInjection: ['Lost committed 202 response', 'Delayed pre-write GET', 'Storage write/removal failures', 'Offline browser', 'Cross-tab cookie replacement'],
    virtualClock: 'Only bounded provider-pending retry exhaustion uses an injected worker clock; stored states and HTTP outcomes are real.',
    screenshots: ['issuer-active.png', 'issuer-pending.png', 'issuer-review.png', 'issuer-desktop.png', 'issuer-320.png', 'issuer-390.png', 'issuer-430.png'],
  }, null, 2));
  console.log(`${checks.length} issuer browser checks passed with real sessions, PostgreSQL and signed local provider requests.`);
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: new URL('failure.png', artifacts).pathname, fullPage: true }).catch(() => {});
  console.error(error); process.exitCode = 1;
} finally {
  for (const processChild of childProcesses) processChild.kill('SIGKILL');
  await browser?.close();
  if (providerServer) { providerServer.closeAllConnections(); await new Promise((resolve) => providerServer.close(resolve)); }
  await database.end();
  process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
}
