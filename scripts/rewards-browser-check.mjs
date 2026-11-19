import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

// Run last against the caller's dedicated sandbox schema. Exactly one new account
// keeps this and the two existing browser suites within the shared signup limit.
const base = new URL(process.env.AQUA_BASE_URL ?? 'http://127.0.0.1:5173');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), 'Rewards browser checks require a loopback sandbox UI.');
const repo = fileURLToPath(new URL('../', import.meta.url));
const artifacts = new URL('../artifacts/rewards-server/', import.meta.url);
await mkdir(artifacts, { recursive: true });
const eventDirectory = await mkdtemp(join(tmpdir(), 'aqua-rewards-browser-'));
const runId = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
const password = 'AquaRewardsBrowser#2026';
const owner = { name: '리워드 결제 테스트', email: `rewards-${runId}@aqua.example.test`, tag: `w${runId}` };
const paymentA = `rewards-mixed-${runId}`;
const paymentB = `rewards-principal-${runId}`;
const paymentC = `rewards-held-${runId}`;
const checks = [];
const runtimeErrors = [];
const preferenceRequests = [];
let browser;
let page;
let originalProgramActive;
let programChanged = false;
let droppedPreference;

const pass = (name) => { checks.push(name); console.log(`PASS ${checks.length}: ${name}`); };
const preferenceRequest = (request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/rewards/preference';

function command(script, args) {
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', script, '--', ...args], {
    cwd: repo, env: { ...process.env }, encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(result.status, 0, `${script} failed; match the API schema and operator database configuration.\n${result.error?.message ?? ''}\n${result.stderr?.slice(-2_000) ?? ''}`);
}

async function cardEvent(event) {
  const path = join(eventDirectory, `${event.eventId}.json`);
  await writeFile(path, JSON.stringify(event), { mode: 0o600 });
  command('server:card', [path]);
}

async function account() {
  const response = await page.context().request.get(new URL('/api/account', base).href);
  assert.equal(response.status(), 200, 'The signed-in sandbox account must be readable.');
  return response.json();
}

async function moneyIs(id, amount) {
  await page.waitForFunction(({ id, amount }) => {
    const shown = document.querySelector(`[data-testid="${id}"]`)?.textContent ?? '';
    return /\d/.test(shown) && Number(shown.replace(/[^\d-]/g, '')) === amount;
  }, { id, amount });
}

async function snapshot(expected) {
  // Wait for real account polling; financial responses are never replaced by fixtures.
  const ids = {
    cash: 'server-balance', cashHeld: 'server-held-balance', cashTotal: 'server-total-balance',
    reward: 'rewards-available', rewardHeld: 'rewards-held', confirmed: 'cashback-confirmed',
    pending: 'cashback-pending', reversed: 'cashback-reversed', remaining: 'cashback-remaining',
  };
  for (const [name, id] of Object.entries(ids)) await moneyIs(id, expected[name]);
  if (expected.debt > 0) await moneyIs('rewards-adjustment', expected.debt);
  else await page.getByTestId('rewards-adjustment').waitFor({ state: 'hidden' });
  const value = await account();
  assert.equal(value.balanceWon, expected.cash);
  assert.equal(value.heldBalanceWon, expected.cashHeld);
  assert.equal(value.totalBalanceWon, expected.cashTotal);
  assert.equal(value.balanceWon + value.heldBalanceWon, value.totalBalanceWon, 'Principal total excludes every reward balance.');
  assert.equal(value.rewards.availableWon, expected.reward);
  assert.equal(value.rewards.heldWon, expected.rewardHeld);
  assert.equal(value.rewards.adjustmentDueWon, expected.debt);
  for (const name of ['confirmed', 'pending', 'reversed', 'remaining']) assert.equal(value.rewards.cashback[`${name}Won`], expected[name], `cashback ${name}`);
  assert.equal(value.limits.available, Math.min(value.balanceWon, value.limits.perTransfer, value.limits.daily - value.limits.sentToday, value.limits.monthly - value.limits.sentMonth), 'Member transfer capacity uses principal only.');
  return value;
}

async function card(id, status, funding, cashback) {
  await page.waitForFunction(({ id, status }) => document.querySelector(`[data-testid="server-card-payment-${id}"]`)?.getAttribute('data-status') === status, { id, status });
  const row = page.getByTestId(`server-card-payment-${id}`);
  if (!await row.evaluate((node) => node.open)) await row.locator('summary').click();
  const record = (await account()).cardPayments.find((entry) => entry.id === id);
  assert.ok(record?.funding && record.cashback, 'New card receipts must disclose funding and cashback records.');
  assert.equal(record.status, status);
  for (const source of ['principal', 'rewards']) {
    for (const [name, amount] of Object.entries(funding[source] ?? {})) {
      await moneyIs(`server-card-${source}-${name}-${id}`, amount);
      assert.equal(record.funding[source][`${name}Won`], amount, `${id}: ${source} ${name}`);
    }
  }
  for (const [name, amount] of Object.entries(cashback)) {
    await moneyIs(`server-card-cashback-${name}-${id}`, amount);
    assert.equal(record.cashback[`${name}Won`], amount, `${id}: cashback ${name}`);
  }
  return record;
}

async function settledPreference(useFirst) {
  await page.waitForFunction((desired) => {
    const control = document.querySelector('[data-testid="rewards-use-first"]');
    return control?.getAttribute('aria-checked') === String(desired) && !control.hasAttribute('disabled') && control.getAttribute('aria-disabled') !== 'true';
  }, useFirst);
  assert.equal((await account()).rewards.useFirst, useFirst);
}

async function setPreference(useFirst) {
  const prior = (await account()).rewards;
  if (prior.useFirst === useFirst) { await settledPreference(useFirst); return prior.preferenceVersion; }
  const response = page.waitForResponse((reply) => preferenceRequest(reply.request()));
  await page.getByTestId('rewards-use-first').click();
  assert.equal((await response).status(), 200);
  await settledPreference(useFirst);
  const updated = (await account()).rewards;
  assert.equal(updated.preferenceVersion, prior.preferenceVersion + 1);
  return updated.preferenceVersion;
}

async function fits(label) {
  const dimensions = await page.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth }));
  assert.ok(dimensions.content <= dimensions.viewport + 1, `${label}: horizontal overflow ${dimensions.content}/${dimensions.viewport}`);
}

try {
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    env: { ...process.env, XDG_CONFIG_HOME: '/tmp/aqua-chromium-config', XDG_CACHE_HOME: '/tmp/aqua-chromium-cache' },
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
  page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  page.on('request', (request) => {
    if (preferenceRequest(request)) preferenceRequests.push({ key: request.headers()['idempotency-key'], ownerId: request.headers()['x-aqua-account'], body: request.postDataJSON() });
  });
  const health = await context.request.get(new URL('/api/health', base).href);
  assert.equal(health.status(), 200, 'Start the migrated sandbox API and connected UI before this suite.');
  assert.equal((await health.json()).mode, 'sandbox');
  await page.goto(base.href, { waitUntil: 'networkidle' });
  await page.getByTestId('auth-signup-tab').click();
  await page.getByTestId('auth-name').fill(owner.name);
  await page.getByTestId('auth-email').fill(owner.email);
  await page.getByTestId('auth-tag').fill(owner.tag);
  await page.getByTestId('auth-password').fill(password);
  await page.getByTestId('auth-submit').click();
  await moneyIs('server-balance', 0);
  const initial = await account();
  assert.equal(initial.user.email, owner.email);
  assert.equal(initial.rewards.availableWon, 0);
  assert.equal(initial.rewards.heldWon, 0);
  assert.equal(initial.rewards.adjustmentDueWon, 0);
  assert.equal(initial.rewards.policy.rateBps, 100);
  assert.equal(initial.rewards.policy.monthlyCapWon, 10_000);
  originalProgramActive = initial.rewards.programActive;
  const userId = initial.user.id;
  command('server:issuer', ['register', userId, `sandbox-card-rewards-${runId}`, 'active']);
  command('server:credit', [owner.email, '100000', `${runId}-principal`]);
  command('server:rewards', ['budget', '1000000', `${runId}-budget`]);
  command('server:rewards', ['program', 'on', `${runId}-program-on`]);
  programChanged = !originalProgramActive;
  command('server:rewards', ['grant', owner.email, '3000', `${runId}-grant`]);
  await snapshot({ cash: 100_000, cashHeld: 0, cashTotal: 100_000, reward: 3_000, rewardHeld: 0, debt: 0, confirmed: 0, pending: 0, reversed: 0, remaining: 10_000 });
  await setPreference(true);
  assert.equal((await account()).rewards.programActive, true);
  pass('One new account receives funded card-only rewards; principal totals and transfer capacity exclude the reward units.');

  await cardEvent({ eventId: `${runId}-a-authorize`, paymentId: paymentA, userId, kind: 'authorize', amountWon: 10_000, merchantName: '리워드 혼합 결제 테스트 매장' });
  await snapshot({ cash: 93_000, cashHeld: 7_000, cashTotal: 100_000, reward: 0, rewardHeld: 3_000, debt: 0, confirmed: 0, pending: 70, reversed: 0, remaining: 9_930 });
  const authorized = await card(paymentA, 'authorized', { principal: { authorized: 7_000, held: 7_000, captured: 0 }, rewards: { authorized: 3_000, held: 3_000, captured: 0 } }, { pending: 70, awarded: 0, reversed: 0, offset: 0 });
  assert.equal(authorized.cashback.closedAt, null);
  pass('Reward-first authorization holds 3,000 reward units and 7,000 principal, with 70 cashback units pending rather than credited.');

  await cardEvent({ eventId: `${runId}-a-partial`, paymentId: paymentA, userId, kind: 'capture', amountWon: 3_000, finalCapture: false });
  await snapshot({ cash: 93_000, cashHeld: 4_900, cashTotal: 97_900, reward: 0, rewardHeld: 2_100, debt: 0, confirmed: 0, pending: 70, reversed: 0, remaining: 9_930 });
  const partial = await card(paymentA, 'partially_captured', { principal: { captured: 2_100, held: 4_900 }, rewards: { captured: 900, held: 2_100 } }, { pending: 70, awarded: 0 });
  assert.equal(partial.cashback.closedAt, null);
  await cardEvent({ eventId: `${runId}-a-final`, paymentId: paymentA, userId, kind: 'capture', amountWon: 3_000, finalCapture: true });
  await snapshot({ cash: 95_800, cashHeld: 0, cashTotal: 95_800, reward: 1_242, rewardHeld: 0, debt: 0, confirmed: 42, pending: 0, reversed: 0, remaining: 9_958 });
  const captured = await card(paymentA, 'captured', { principal: { captured: 4_200, held: 0, released: 2_800 }, rewards: { captured: 1_800, held: 0, released: 1_200 } }, { pending: 0, awarded: 42, reversed: 0, offset: 0 });
  assert.ok(Number.isSafeInteger(captured.cashback.closedAt));
  pass('Partial capture retains pending cashback; final capture releases unused funding and separately shows 1,800 rewards spent and 42 newly earned.');

  const refundA = { eventId: `${runId}-a-refund`, paymentId: paymentA, userId, kind: 'refund', amountWon: 3_000 };
  await cardEvent(refundA);
  const afterRefund = await snapshot({ cash: 97_900, cashHeld: 0, cashTotal: 97_900, reward: 2_121, rewardHeld: 0, debt: 0, confirmed: 21, pending: 0, reversed: 21, remaining: 9_979 });
  await card(paymentA, 'partially_refunded', { principal: { refunded: 2_100 }, rewards: { refunded: 900 } }, { awarded: 42, reversed: 21, pending: 0 });
  await cardEvent(refundA);
  assert.deepEqual(await account(), afterRefund, 'Replaying the refund cannot duplicate returned rewards or cashback reversal.');
  pass('A partial refund returns the original principal/reward mix and reverses cashback exactly once without converting rewards into principal.');

  const priorPreference = (await account()).rewards;
  const requestStart = preferenceRequests.length;
  await page.route('**/api/rewards/preference', async (route) => {
    try {
      const response = await route.fetch();
      droppedPreference = { status: response.status(), body: await response.json() };
    } finally { await route.abort('failed'); }
  }, { times: 1 });
  await page.getByTestId('rewards-use-first').click();
  await page.getByTestId('rewards-preference-unknown').waitFor({ state: 'visible' });
  assert.equal(droppedPreference?.status, 200, 'The real API commits the preference before only its response is dropped.');
  assert.equal(droppedPreference.body.useFirst, false);
  assert.equal(droppedPreference.body.version, priorPreference.preferenceVersion + 1);
  assert.equal(await page.getByTestId('rewards-use-first').isDisabled(), true);
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByTestId('rewards-preference-unknown').waitFor({ state: 'visible' });
  assert.equal(await page.getByTestId('rewards-use-first').isDisabled(), true);
  const retryResponse = page.waitForResponse((reply) => preferenceRequest(reply.request()));
  await page.getByTestId('rewards-preference-retry').click();
  assert.equal((await retryResponse).status(), 200);
  await page.getByTestId('rewards-preference-unknown').waitFor({ state: 'hidden' });
  await settledPreference(false);
  const recovered = (await account()).rewards;
  assert.equal(recovered.preferenceVersion, priorPreference.preferenceVersion + 1);
  const uncertainRequests = preferenceRequests.slice(requestStart);
  assert.equal(uncertainRequests.length, 2);
  assert.ok(uncertainRequests[0].key);
  assert.equal(uncertainRequests[0].key, uncertainRequests[1].key);
  assert.equal(uncertainRequests[0].ownerId, userId);
  assert.equal(uncertainRequests[1].ownerId, userId);
  assert.deepEqual(uncertainRequests[0].body, { useFirst: false, expectedVersion: priorPreference.preferenceVersion });
  assert.deepEqual(uncertainRequests[1].body, uncertainRequests[0].body);
  const stale = await context.request.post(new URL('/api/rewards/preference', base).href, {
    headers: { Origin: base.origin, 'X-Aqua-Account': userId, 'Idempotency-Key': `${runId}-stale-preference` },
    data: { useFirst: true, expectedVersion: priorPreference.preferenceVersion },
  });
  assert.equal(stale.status(), 409);
  assert.equal((await account()).rewards.preferenceVersion, recovered.preferenceVersion);
  assert.equal((await account()).rewards.useFirst, false);
  pass('A committed preference with a lost response survives reload, retries its original key/version once, and rejects a stale version.');

  await cardEvent({ eventId: `${runId}-b-authorize`, paymentId: paymentB, userId, kind: 'authorize', amountWon: 10_000, merchantName: '원금 결제 테스트 매장' });
  await snapshot({ cash: 87_900, cashHeld: 10_000, cashTotal: 97_900, reward: 2_121, rewardHeld: 0, debt: 0, confirmed: 21, pending: 100, reversed: 21, remaining: 9_879 });
  await cardEvent({ eventId: `${runId}-b-capture`, paymentId: paymentB, userId, kind: 'capture', amountWon: 10_000, finalCapture: true });
  await snapshot({ cash: 87_900, cashHeld: 0, cashTotal: 87_900, reward: 2_221, rewardHeld: 0, debt: 0, confirmed: 121, pending: 0, reversed: 21, remaining: 9_879 });
  await card(paymentB, 'captured', { principal: { captured: 10_000 }, rewards: { authorized: 0, captured: 0 } }, { awarded: 100, reversed: 0, pending: 0 });
  await setPreference(true);
  await cardEvent({ eventId: `${runId}-c-authorize`, paymentId: paymentC, userId, kind: 'authorize', amountWon: 2_221, merchantName: '리워드 전액 사용 테스트 매장' });
  await snapshot({ cash: 87_900, cashHeld: 0, cashTotal: 87_900, reward: 0, rewardHeld: 2_221, debt: 0, confirmed: 121, pending: 0, reversed: 21, remaining: 9_879 });
  await card(paymentC, 'authorized', { principal: { authorized: 0, held: 0 }, rewards: { authorized: 2_221, held: 2_221 } }, { pending: 0, awarded: 0 });
  pass('Disabling reward-first preserves rewards on a principal payment; re-enabling it reserves only rewards without reducing principal.');

  await cardEvent({ eventId: `${runId}-b-refund`, paymentId: paymentB, userId, kind: 'refund', amountWon: 10_000 });
  await snapshot({ cash: 97_900, cashHeld: 0, cashTotal: 97_900, reward: 0, rewardHeld: 2_221, debt: 100, confirmed: 21, pending: 0, reversed: 121, remaining: 9_979 });
  await card(paymentB, 'refunded', { principal: { refunded: 10_000 }, rewards: { refunded: 0 } }, { awarded: 100, reversed: 100 });
  await card(paymentC, 'authorized', { rewards: { held: 2_221 } }, { awarded: 0 });
  await cardEvent({ eventId: `${runId}-c-reverse`, paymentId: paymentC, userId, kind: 'reverse' });
  const final = await snapshot({ cash: 97_900, cashHeld: 0, cashTotal: 97_900, reward: 2_121, rewardHeld: 0, debt: 0, confirmed: 21, pending: 0, reversed: 121, remaining: 9_979 });
  await card(paymentC, 'cancelled', { principal: { released: 0 }, rewards: { released: 2_221, held: 0 } }, { awarded: 0, pending: 0 });
  assert.ok(final.rewards.history.some((entry) => entry.kind === 'card_release' && entry.paymentId === paymentC
    && entry.amountWon === 2_221 && entry.availableDeltaWon === 2_121 && entry.heldDeltaWon === -2_221
    && entry.adjustmentDeltaWon === -100), 'The release records its returned rewards and adjustment offset together without double-crediting available rewards.');
  assert.equal(final.transactions.filter((entry) => entry.direction !== 'funded').length, 0, 'Reward and card records are not presented as cash transfers.');
  pass('Cashback reversal leaves held rewards intact, shows the outstanding adjustment, then offsets it from released rewards without taking principal.');

  await page.reload({ waitUntil: 'networkidle' });
  await snapshot({ cash: 97_900, cashHeld: 0, cashTotal: 97_900, reward: 2_121, rewardHeld: 0, debt: 0, confirmed: 21, pending: 0, reversed: 121, remaining: 9_979 });
  await settledPreference(true);
  await card(paymentA, 'partially_refunded', { principal: { captured: 4_200, refunded: 2_100 }, rewards: { captured: 1_800, refunded: 900 } }, { awarded: 42, reversed: 21 });
  await fits('Desktop rewards and receipt details');
  await page.screenshot({ path: new URL('rewards-desktop.png', artifacts).pathname, fullPage: true });
  await page.setViewportSize({ width: 320, height: 740 });
  await fits('320px rewards and receipt details');
  await page.screenshot({ path: new URL('rewards-mobile.png', artifacts).pathname, fullPage: true });
  assert.deepEqual(runtimeErrors, []);
  pass('Reward preferences, balances, monthly cashback and mixed-funding receipts persist after reload and fit a 320px screen.');

  await writeFile(new URL('results.json', artifacts), JSON.stringify({
    recordedAt: new Date().toISOString(), baseUrl: base.href, passed: checks.length, checks,
    backendMocked: false, database: 'PostgreSQL', accountsCreated: 1, engine: 'Chromium', realDeviceTested: false,
    mutationPaths: ['Real preference API', 'Local sandbox rewards and card CLIs'],
    droppedResponse: 'Only the reply to a committed preference POST was dropped; its original key and version were retried after reload.',
    finalPrincipalWon: 97_900, finalRewardWon: 2_121, finalAdjustmentWon: 0,
    cashback: { confirmedWon: 21, reversedWon: 121, pendingWon: 0 },
    screenshots: ['rewards-desktop.png', 'rewards-mobile.png'],
  }, null, 2));
  console.log(`${checks.length} rewards browser checks passed against real HTTP sessions, PostgreSQL and operator CLIs.`);
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: new URL('failure.png', artifacts).pathname, fullPage: true }).catch(() => {});
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (programChanged) {
    try { command('server:rewards', ['program', 'off', `${runId}-restore-program`]); }
    catch (error) { console.error(error); process.exitCode = 1; }
  }
  await rm(eventDirectory, { recursive: true, force: true });
}
