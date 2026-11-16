import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

// Run against the server UI and API started by the caller. The credit CLI must use the same AQUA_DB_PATH as the API.
const base = new URL(process.env.AQUA_BASE_URL ?? 'http://127.0.0.1:5173');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), 'This suite requires a loopback UI: test funding uses the local SQLite credit CLI.');
const accountUrl = new URL('/api/account', base).href;
const healthUrl = new URL('/api/health', base).href;
const repo = fileURLToPath(new URL('../', import.meta.url));
const artifacts = new URL('../artifacts/server/', import.meta.url);
await mkdir(artifacts, { recursive: true });
const runId = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
// Throwaway test accounts only; never use a customer's account or password here.
const password = 'AquaServerTest#2026';
const sender = { name: '아쿠아 보내는 테스트', email: `sender-${runId}@aqua.example.test`, tag: `s${runId}` };
const receiver = { name: '아쿠아 받는 테스트', email: `receiver-${runId}@aqua.example.test`, tag: `r${runId}` };
const funded = { sender: 100_000, receiver: 5_000 };
const amounts = { normal: 20_000, interrupted: 7_000 };
const expected = { sender: funded.sender - amounts.normal - amounts.interrupted, receiver: funded.receiver + amounts.normal + amounts.interrupted };
const checks = [];
const runtimeErrors = [];
const transferRequests = [];
let currentPage;
let droppedResponse;
let browser;
let senderContext;
let receiverContext;

const pass = (name) => { checks.push(name); console.log(`PASS ${checks.length}: ${name}`); };
const transferRequest = (request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/transfers';
const watch = (page, label) => {
  currentPage = page;
  page.setDefaultTimeout(15_000);
  page.on('pageerror', (error) => runtimeErrors.push(`${label}: ${error.message}`));
  page.on('request', (request) => {
    if (transferRequest(request)) transferRequests.push({ label, key: request.headers()['idempotency-key'], ownerId: request.headers()['x-aqua-account'], body: request.postDataJSON() });
  });
};

async function account(context, expectedStatus = 200) {
  const response = await context.request.get(accountUrl);
  assert.equal(response.status(), expectedStatus, `GET /api/account expected HTTP ${expectedStatus}`);
  return expectedStatus === 200 ? response.json() : null;
}

async function balance(page, expectedWon, refresh = true) {
  currentPage = page;
  if (refresh) await page.getByTestId('server-refresh').click();
  await page.waitForFunction((amount) => {
    const value = document.querySelector('[data-testid="server-balance"]')?.textContent ?? '';
    return /\d/.test(value) && Number(value.replace(/[^\d-]/g, '')) === amount;
  }, expectedWon);
  assert.equal((await account(page.context())).balanceWon, expectedWon);
}

async function fits(page, description) {
  const dimensions = await page.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth }));
  assert.ok(dimensions.content <= dimensions.viewport + 1, `${description}: horizontal overflow ${dimensions.content}/${dimensions.viewport}`);
}

async function signup(page, user) {
  currentPage = page;
  await page.goto(base.href, { waitUntil: 'networkidle' });
  await page.getByTestId('auth-signup-tab').click();
  await page.getByTestId('auth-name').fill(user.name);
  await page.getByTestId('auth-email').fill(user.email);
  await page.getByTestId('auth-tag').fill(user.tag);
  await page.getByTestId('auth-password').fill(password);
  await page.getByTestId('auth-submit').click();
  await balance(page, 0, false);
  const snapshot = await account(page.context());
  assert.equal(snapshot.user.email, user.email);
  assert.equal(snapshot.user.tag, user.tag);
  return snapshot;
}

async function login(page, user) {
  currentPage = page;
  await page.getByTestId('auth-login-tab').click();
  await page.getByTestId('auth-email').fill(user.email);
  await page.getByTestId('auth-password').fill(password);
  await page.getByTestId('auth-submit').click();
  await page.getByTestId('server-balance').waitFor({ state: 'visible' });
}

function credit(user, amountWon, key) {
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'server:credit', '--', user.email, String(amountWon), key], {
    cwd: repo, env: { ...process.env }, encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(result.status, 0, `Credit CLI failed; ensure AQUA_DB_PATH matches the running API.\n${result.error?.message ?? ''}\n${result.stderr?.slice(-2000) ?? ''}`);
}

async function prepareTransfer(page, to, amountWon) {
  currentPage = page;
  await page.getByTestId('server-send').click();
  await page.getByTestId('transfer-recipient').fill(to.tag);
  await page.getByTestId('transfer-lookup').click();
  const found = page.getByTestId('transfer-recipient-result');
  await found.waitFor({ state: 'visible' });
  assert.ok((await found.innerText()).includes(`@${to.tag}`), 'The lookup confirms the requested public tag; names are masked by the API.');
  await page.getByTestId('transfer-next').click();
  await page.getByTestId('transfer-amount').fill(String(amountWon));
  await page.getByTestId('transfer-review').click();
  await fits(page, 'Transfer review');
}

async function completed(page, amountWon, balanceWon) {
  currentPage = page;
  await page.waitForFunction(() => document.querySelector('[data-testid="transfer-status"]')?.getAttribute('data-status') === 'completed');
  for (const [id, amount] of [['transfer-receipt-amount', amountWon], ['transfer-balance-after', balanceWon]]) {
    const actual = await page.getByTestId(id).innerText();
    assert.equal(Number(actual.replace(/[^\d-]/g, '')), amount, id);
  }
  await page.getByTestId('transfer-done').click();
}

function assertHistories(senderSnapshot, receiverSnapshot) {
  const sent = senderSnapshot.transactions.filter((entry) => entry.direction === 'sent');
  const received = receiverSnapshot.transactions.filter((entry) => entry.direction === 'received');
  assert.equal(sent.length, 2, 'Sender has exactly two completed transfers, including the retried request once.');
  assert.equal(received.length, 2, 'Receiver has exactly two credits, including the retried request once.');
  assert.deepEqual(sent.map((entry) => entry.amountWon).sort((a, b) => a - b), [amounts.interrupted, amounts.normal]);
  assert.deepEqual(received.map((entry) => entry.amountWon).sort((a, b) => a - b), [amounts.interrupted, amounts.normal]);
  assert.ok(sent.every((entry) => entry.counterpartyTag === receiver.tag));
  assert.ok(received.every((entry) => entry.counterpartyTag === sender.tag));
  assert.equal(senderSnapshot.balanceWon + receiverSnapshot.balanceWon, funded.sender + funded.receiver, 'Transfers conserve the two users’ funded test won.');
}

try {
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    env: { ...process.env, XDG_CONFIG_HOME: '/tmp/aqua-chromium-config', XDG_CACHE_HOME: '/tmp/aqua-chromium-cache' },
  });
  senderContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
  receiverContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
  const senderPage = await senderContext.newPage();
  const receiverPage = await receiverContext.newPage();
  watch(senderPage, 'sender'); watch(receiverPage, 'receiver');
  const health = await senderContext.request.get(healthUrl);
  assert.equal(health.status(), 200, 'Start the API and the Vite server UI before running this suite.');
  assert.equal((await health.json()).mode, 'sandbox', 'Only test the sandbox API.');
  await account(senderContext, 401);
  await account(receiverContext, 401);
  pass('Unauthenticated isolated browser contexts cannot read account balances.');

  const firstSender = await signup(senderPage, sender);
  const firstReceiver = await signup(receiverPage, receiver);
  assert.notEqual(firstSender.user.id, firstReceiver.user.id);
  assert.equal((await account(senderContext)).user.id, firstSender.user.id);
  assert.equal((await account(receiverContext)).user.id, firstReceiver.user.id);
  const cookies = await senderContext.cookies(accountUrl);
  const sessionCookie = cookies.find((cookie) => cookie.httpOnly);
  assert.ok(sessionCookie && ['Strict', 'Lax'].includes(sessionCookie.sameSite), 'Authentication uses an HttpOnly SameSite session cookie.');
  assert.equal(await senderPage.evaluate((name) => document.cookie.split(';').some((value) => value.trim().startsWith(`${name}=`)), sessionCookie.name), false);
  pass('Two different users sign up through the UI with separate HttpOnly-cookie sessions and zero initial balances.');

  credit(sender, funded.sender, `${runId}-sender-credit`);
  credit(sender, funded.sender, `${runId}-sender-credit`);
  credit(receiver, funded.receiver, `${runId}-receiver-credit`);
  await balance(senderPage, funded.sender);
  await balance(receiverPage, funded.receiver);
  assert.equal((await account(senderContext)).transactions.filter((entry) => entry.direction === 'funded').length, 1);
  pass('The local credit CLI funds the real database; repeating its idempotency key does not double the credit.');

  const wrongOwner = await receiverContext.request.post(new URL('/api/transfers', base).href, {
    headers: { Origin: base.origin, 'X-Aqua-Account': firstSender.user.id, 'Idempotency-Key': `${runId}-wrong-owner` },
    data: { recipientTag: sender.tag, amountWon: 1_000 },
  });
  assert.equal(wrongOwner.status(), 409);
  assert.equal((await wrongOwner.json()).error.code, 'SESSION_CHANGED');
  assert.equal((await account(senderContext)).balanceWon, funded.sender);
  assert.equal((await account(receiverContext)).balanceWon, funded.receiver);
  pass('A cookie belonging to another user cannot submit a stale account’s transfer intent; neither balance changes.');

  await prepareTransfer(senderPage, receiver, amounts.normal);
  const normalResponse = senderPage.waitForResponse((response) => transferRequest(response.request()));
  await senderPage.getByTestId('transfer-confirm').click();
  const normal = await normalResponse;
  assert.ok(normal.ok(), `Transfer returned HTTP ${normal.status()}`);
  await completed(senderPage, amounts.normal, funded.sender - amounts.normal);
  await balance(senderPage, funded.sender - amounts.normal);
  await balance(receiverPage, funded.receiver + amounts.normal);
  pass('A UI transfer debits the sender and credits the other browser user in the database.');

  await senderPage.route('**/api/transfers', async (route) => {
    try {
      const response = await route.fetch();
      droppedResponse = { status: response.status(), body: await response.json() };
    } finally {
      await route.abort('failed');
    }
  }, { times: 1 });
  await prepareTransfer(senderPage, receiver, amounts.interrupted);
  await senderPage.getByTestId('transfer-confirm').click();
  await senderPage.waitForFunction(() => document.querySelector('[data-testid="transfer-status"]')?.getAttribute('data-status') === 'unknown');
  assert.ok(droppedResponse && droppedResponse.status >= 200 && droppedResponse.status < 300, 'The real backend committed before its response was deliberately dropped.');
  assert.equal(droppedResponse.body.balanceWon, expected.sender);
  assert.equal(await senderPage.getByTestId('server-send').isDisabled(), true);
  assert.equal((await account(senderContext)).balanceWon, expected.sender);
  await balance(receiverPage, expected.receiver);
  currentPage = senderPage;
  await senderPage.reload({ waitUntil: 'networkidle' });
  await senderPage.waitForFunction(() => document.querySelector('[data-testid="transfer-status"]')?.getAttribute('data-status') === 'unknown');
  assert.equal(await senderPage.getByTestId('server-send').isDisabled(), true);
  await fits(senderPage, 'Recovered unknown transfer');
  await senderPage.screenshot({ path: new URL('unknown-after-refresh.png', artifacts).pathname, fullPage: true });
  pass('A dropped reply after a real commit leaves an unknown request, blocks a second send, and survives page refresh.');

  const retryResponse = senderPage.waitForResponse((response) => transferRequest(response.request()));
  await senderPage.getByTestId('transfer-retry').click();
  assert.ok((await retryResponse).ok());
  await completed(senderPage, amounts.interrupted, expected.sender);
  const sentRequests = transferRequests.filter((entry) => entry.label === 'sender');
  assert.equal(sentRequests.length, 3, 'One normal request and one interrupted request retried once.');
  assert.ok(sentRequests.every((entry) => entry.ownerId === firstSender.user.id), 'Every request binds the intent to its authenticated account, including the retry.');
  assert.ok(typeof sentRequests[0].key === 'string' && sentRequests[0].key.length > 0);
  assert.ok(typeof sentRequests[1].key === 'string' && sentRequests[1].key.length > 0);
  assert.notEqual(sentRequests[0].key, sentRequests[1].key);
  assert.equal(sentRequests[1].key, sentRequests[2].key, 'The uncertain request keeps its original Idempotency-Key.');
  assert.deepEqual(sentRequests[1].body, sentRequests[2].body, 'The retry keeps the original recipient and amount.');
  await balance(senderPage, expected.sender);
  await balance(receiverPage, expected.receiver);
  assertHistories(await account(senderContext), await account(receiverContext));
  pass('Retrying the saved intent uses the same key and payload; each account records the transfer exactly once.');

  await senderPage.reload({ waitUntil: 'networkidle' });
  await receiverPage.reload({ waitUntil: 'networkidle' });
  await balance(senderPage, expected.sender, false);
  await balance(receiverPage, expected.receiver, false);
  assertHistories(await account(senderContext), await account(receiverContext));
  await fits(senderPage, 'Desktop account');
  await fits(receiverPage, 'Mobile account');
  await senderPage.screenshot({ path: new URL('sender-desktop.png', artifacts).pathname, fullPage: true });
  await receiverPage.screenshot({ path: new URL('receiver-mobile.png', artifacts).pathname, fullPage: true });
  pass('Desktop and mobile account views restore both balances and histories after refresh.');

  const signedInState = await senderContext.storageState();
  await senderPage.getByTestId('server-logout').click();
  await senderPage.getByTestId('auth-submit').waitFor({ state: 'visible' });
  await account(senderContext, 401);
  const revokedContext = await browser.newContext({ storageState: signedInState });
  try { await account(revokedContext, 401); } finally { await revokedContext.close(); }
  await balance(receiverPage, expected.receiver);
  await login(senderPage, sender);
  await balance(senderPage, expected.sender, false);
  assert.equal((await account(senderContext)).user.id, firstSender.user.id);
  pass('Logout revokes the server session, preserves the other user’s session, and login restores the same database account.');

  const freshContext = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
  try {
    const freshPage = await freshContext.newPage();
    watch(freshPage, 'fresh');
    await freshPage.goto(base.href, { waitUntil: 'networkidle' });
    await account(freshContext, 401);
    await freshPage.getByTestId('auth-login-tab').click();
    await freshPage.getByTestId('auth-email').fill(sender.email);
    await freshPage.getByTestId('auth-password').fill('Wrong-Test-Password#2026');
    await freshPage.getByTestId('auth-submit').click();
    await freshPage.getByRole('alert').first().waitFor({ state: 'visible' });
    await account(freshContext, 401);
    await login(freshPage, sender);
    await balance(freshPage, expected.sender, false);
    assert.equal((await account(freshContext)).user.id, firstSender.user.id);
    assertHistories(await account(freshContext), await account(receiverContext));
  } finally { await freshContext.close(); }
  pass('A fresh browser rejects a wrong password and restores persistent balances after a real login.');

  currentPage = senderPage;
  const delayMs = 6_100;
  let delayedReads = 0;
  const slowAccount = async (route) => {
    const response = await route.fetch();
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    await route.fulfill({ response });
    delayedReads += 1;
  };
  await senderPage.route('**/api/account', slowAccount);
  const slowReadStarted = Date.now();
  try {
    await senderPage.reload({ waitUntil: 'domcontentloaded' });
    await balance(senderPage, expected.sender, false);
    assert.ok(delayedReads > 0 && Date.now() - slowReadStarted >= delayMs, 'The real account response was delayed longer than the five-second polling interval.');
  } finally { await senderPage.unroute('**/api/account', slowAccount); }
  pass('A real account response delayed over six seconds still reaches the UI instead of being starved by five-second polling.');

  const sharedTab = await senderContext.newPage();
  try {
    watch(sharedTab, 'shared-cookie-tab');
    await sharedTab.goto(base.href, { waitUntil: 'networkidle' });
    await balance(sharedTab, expected.sender, false);
    // A login in another tab replaces the cookie for every tab in this context.
    const changedSession = await senderContext.request.post(new URL('/api/auth/login', base).href, {
      headers: { Origin: base.origin }, data: { email: receiver.email, password },
    });
    assert.equal(changedSession.status(), 200);
    assert.equal((await changedSession.json()).user.id, firstReceiver.user.id);
    await sharedTab.reload({ waitUntil: 'networkidle' });
    await balance(sharedTab, expected.receiver, false);
    assert.equal((await sharedTab.getByTestId('server-tag').innerText()).trim(), `@${receiver.tag}`);

    const staleLogout = await senderContext.request.post(new URL('/api/auth/logout', base).href, {
      headers: { Origin: base.origin, 'X-Aqua-Account': firstSender.user.id }, data: {},
    });
    assert.equal(staleLogout.status(), 409, 'A stale tab must not log the other account out.');
    assert.equal((await staleLogout.json()).error.code, 'SESSION_CHANGED');
    assert.equal((await account(senderContext)).user.id, firstReceiver.user.id);

    currentPage = senderPage;
    if (!await senderPage.getByTestId('auth-submit').isVisible()) {
      await senderPage.getByTestId('server-refresh').click({ timeout: 2_000 }).catch(async (error) => {
        if (!await senderPage.getByTestId('auth-submit').isVisible()) throw error;
      });
    }
    await senderPage.getByTestId('auth-submit').waitFor({ state: 'visible' });
    assert.equal(await senderPage.getByTestId('server-balance').count(), 0, 'A stale Alice view cannot show Bob’s balance under Alice’s identity.');
    await login(senderPage, sender);
    await balance(senderPage, expected.sender, false);
    assert.equal((await account(senderContext)).user.id, firstSender.user.id);
    assertHistories(await account(senderContext), await account(receiverContext));
  } finally { await sharedTab.close(); }
  assert.deepEqual(runtimeErrors, []);
  pass('Shared-cookie tabs discard another account’s snapshot, reject stale logout, and restore the original account without changing balances.');

  await writeFile(new URL('results.json', artifacts), JSON.stringify({
    recordedAt: new Date().toISOString(), baseUrl: base.href, passed: checks.length, checks,
    backendMocked: false, deliberateNetworkLoss: 'The transfer POST reached the real API; only its reply was dropped.',
    apiRestartVerified: false, persistenceVerified: 'Database balances and histories survive refresh, logout/login, and a fresh browser context.',
    slowReadsVerified: true, sharedCookieAccountChangesVerified: true,
    engine: 'Chromium', realDeviceTested: false, balances: expected, totalWon: expected.sender + expected.receiver,
    screenshots: ['sender-desktop.png', 'receiver-mobile.png', 'unknown-after-refresh.png'],
  }, null, 2));
  console.log(`${checks.length} server browser checks passed. Both accounts use real HTTP, cookie sessions, and the local SQLite database.`);
} catch (error) {
  if (currentPage && !currentPage.isClosed()) await currentPage.screenshot({ path: new URL('failure.png', artifacts).pathname, fullPage: true }).catch(() => {});
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
}
