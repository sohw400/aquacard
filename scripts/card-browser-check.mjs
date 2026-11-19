import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

// All financial operations reach the real sandbox API or the local operator CLI.
// The API and both CLIs must point at the same dedicated PostgreSQL database/schema.
const base = new URL(process.env.AQUA_BASE_URL ?? 'http://127.0.0.1:5173');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), 'Card browser checks require a loopback sandbox UI.');
const repo = fileURLToPath(new URL('../', import.meta.url));
const artifacts = new URL('../artifacts/card-server/', import.meta.url);
await mkdir(artifacts, { recursive: true });
const eventDirectory = await mkdtemp(join(tmpdir(), 'aqua-card-browser-'));
const runId = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
const password = 'AquaCardBrowser#2026';
const owner = { name: '카드 결제 테스트', email: `card-${runId}@aqua.example.test`, tag: `c${runId}` };
const other = { name: '별도 계정 테스트', email: `other-${runId}@aqua.example.test`, tag: `o${runId}` };
const paymentId = `browser-payment-${runId}`;
const cancelledId = `browser-cancelled-${runId}`;
const merchantName = '아쿠아 카드 결제 검증을 위한 긴 가맹점 이름 테스트 스튜디오';
const checks = [];
const runtimeErrors = [];
let browser;
let currentPage;

function pass(name) { checks.push(name); console.log(`PASS ${checks.length}: ${name}`); }
function watch(page, name) {
  currentPage = page;
  page.setDefaultTimeout(15_000);
  page.on('pageerror', (error) => runtimeErrors.push(`${name}: ${error.message}`));
}

async function account(context, query = '') {
  const response = await context.request.get(new URL(`/api/account${query}`, base).href);
  assert.equal(response.status(), 200, 'The signed-in account API must return its own snapshot.');
  return response.json();
}

async function balances(page, balanceWon, heldBalanceWon, totalBalanceWon) {
  currentPage = page;
  // No refresh button or reload: wait for the app's real account poll to render.
  await page.waitForFunction((expected) => expected.every(([id, amount]) => {
    const value = document.querySelector(`[data-testid="${id}"]`)?.textContent ?? '';
    return /\d/.test(value) && Number(value.replace(/[^\d-]/g, '')) === amount;
  }), [['server-balance', balanceWon], ['server-held-balance', heldBalanceWon], ['server-total-balance', totalBalanceWon]]);
  const snapshot = await account(page.context());
  assert.equal(snapshot.balanceWon, balanceWon);
  assert.equal(snapshot.heldBalanceWon, heldBalanceWon);
  assert.equal(snapshot.totalBalanceWon, totalBalanceWon);
  assert.equal(snapshot.totalBalanceWon, snapshot.balanceWon + snapshot.heldBalanceWon);
  return snapshot;
}

async function payment(page, id, status, expected) {
  currentPage = page;
  await page.waitForFunction(({ id, status }) => document.querySelector(`[data-testid="server-card-payment-${id}"]`)?.getAttribute('data-status') === status, { id, status });
  const row = page.getByTestId(`server-card-payment-${id}`);
  if (!await row.evaluate((node) => node.open)) await row.locator('summary').click();
  for (const [name, amount] of Object.entries(expected)) {
    const shown = await page.getByTestId(`server-card-${name}-${id}`).innerText();
    assert.equal(Number(shown.replace(/[^\d-]/g, '')), amount, `${id}: ${name}`);
  }
  const snapshot = await account(page.context());
  const record = snapshot.cardPayments.find((entry) => entry.id === id);
  assert.ok(record, 'The UI card payment must come from the authenticated API snapshot.');
  assert.equal(record.status, status);
  for (const [name, amount] of Object.entries(expected)) {
    if (name === 'net') assert.equal(record.capturedWon - record.refundedWon, amount);
    else assert.equal(record[`${name}Won`], amount, `${id}: API ${name}`);
  }
  assert.equal(record.authorizedWon, record.heldWon + record.capturedWon + record.releasedWon);
  assert.ok(record.refundedWon <= record.capturedWon);
  return record;
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
  const snapshot = await balances(page, 0, 0, 0);
  assert.equal(snapshot.user.email, user.email);
  assert.deepEqual(snapshot.cardPayments, []);
  return snapshot.user;
}

function command(script, args) {
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', script, '--', ...args], {
    cwd: repo, env: { ...process.env }, encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(result.status, 0, `${script} failed; match DATABASE_URL and DATABASE_SCHEMA with the running API.\n${result.error?.message ?? ''}\n${result.stderr?.slice(-2_000) ?? ''}`);
}

async function cardEvent(event) {
  const path = join(eventDirectory, `${event.eventId}.json`);
  await writeFile(path, JSON.stringify(event), { mode: 0o600 });
  command('server:card', [path]);
}

async function fits(page, name) {
  const size = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth }));
  assert.ok(size.width <= size.viewport + 1, `${name}: horizontal overflow ${size.width}/${size.viewport}`);
}

try {
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    env: { ...process.env, XDG_CONFIG_HOME: '/tmp/aqua-chromium-config', XDG_CACHE_HOME: '/tmp/aqua-chromium-cache' },
  });
  const ownerContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
  const otherContext = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
  const ownerPage = await ownerContext.newPage();
  const otherPage = await otherContext.newPage();
  watch(ownerPage, 'card owner'); watch(otherPage, 'other account');
  const health = await ownerContext.request.get(new URL('/api/health', base).href);
  assert.equal(health.status(), 200, 'Start the migrated sandbox API and connected web app before this suite.');
  assert.equal((await health.json()).mode, 'sandbox');
  assert.equal((await ownerContext.request.get(new URL('/api/account', base).href)).status(), 401);
  const ownerProfile = await signup(ownerPage, owner);
  const otherProfile = await signup(otherPage, other);
  assert.notEqual(ownerProfile.id, otherProfile.id);
  command('server:credit', [owner.email, '100000', `${runId}-fund-owner`]);
  command('server:credit', [other.email, '2000', `${runId}-fund-other`]);
  await ownerPage.bringToFront();
  await balances(ownerPage, 100_000, 0, 100_000);
  pass('Two separate cookie sessions create empty card histories and the real operator CLI funds only their test accounts.');

  const authorize = { eventId: `${runId}-authorize`, paymentId, userId: ownerProfile.id, kind: 'authorize', amountWon: 60_000, merchantName };
  await cardEvent(authorize);
  await balances(ownerPage, 40_000, 60_000, 100_000);
  await payment(ownerPage, paymentId, 'authorized', { authorized: 60_000, held: 60_000, captured: 0, released: 0, refunded: 0, net: 0 });
  assert.ok((await ownerPage.getByTestId(`server-card-payment-${paymentId}`).innerText()).includes(merchantName));
  pass('A real card authorization automatically reduces available funds, preserves total funds and displays the held amount.');

  await ownerPage.getByTestId('server-send').click();
  await ownerPage.getByTestId('transfer-recipient').fill(other.tag);
  await ownerPage.getByTestId('transfer-lookup').click();
  await ownerPage.getByTestId('transfer-recipient-result').waitFor({ state: 'visible' });
  await ownerPage.getByTestId('transfer-next').click();
  await ownerPage.getByTestId('transfer-amount').fill('50000');
  await ownerPage.getByTestId('transfer-review').click();
  await ownerPage.getByTestId('transfer-error').waitFor({ state: 'visible' });
  assert.match(await ownerPage.getByTestId('transfer-error').innerText(), /40,000/);
  assert.equal(await ownerPage.getByTestId('transfer-confirm').count(), 0);
  await ownerPage.getByTestId('transfer-close').click();
  const overAvailable = await ownerContext.request.post(new URL('/api/transfers', base).href, {
    headers: { Origin: base.origin, 'X-Aqua-Account': ownerProfile.id, 'Idempotency-Key': `${runId}-held-transfer` },
    data: { recipientTag: other.tag, amountWon: 50_000 },
  });
  assert.equal(overAvailable.status(), 409);
  assert.equal((await overAvailable.json()).error.code, 'INSUFFICIENT_FUNDS');
  const unchanged = await balances(ownerPage, 40_000, 60_000, 100_000);
  assert.equal(unchanged.transactions.filter((entry) => entry.direction === 'sent').length, 0);
  assert.equal((await account(otherContext)).balanceWon, 2_000);
  pass('Both the UI and actual transfer API prevent reusing authorized funds; neither account receives a transfer.');

  await cardEvent({ eventId: `${runId}-capture-part`, paymentId, userId: ownerProfile.id, kind: 'capture', amountWon: 20_000, finalCapture: false });
  await balances(ownerPage, 40_000, 40_000, 80_000);
  await payment(ownerPage, paymentId, 'partially_captured', { held: 40_000, captured: 20_000, released: 0, net: 20_000 });
  await cardEvent({ eventId: `${runId}-capture-final`, paymentId, userId: ownerProfile.id, kind: 'capture', amountWon: 15_000, finalCapture: true });
  await balances(ownerPage, 65_000, 0, 65_000);
  await payment(ownerPage, paymentId, 'captured', { held: 0, captured: 35_000, released: 25_000, refunded: 0, net: 35_000 });
  pass('Partial capture consumes only its reserved amount; final capture releases the unused authorization without charging it.');

  const refund = { eventId: `${runId}-refund`, paymentId, userId: ownerProfile.id, kind: 'refund', amountWon: 10_000 };
  await cardEvent(refund);
  await balances(ownerPage, 75_000, 0, 75_000);
  await payment(ownerPage, paymentId, 'partially_refunded', { authorized: 60_000, held: 0, captured: 35_000, released: 25_000, refunded: 10_000, net: 25_000 });
  const beforeReplay = await account(ownerContext);
  await cardEvent(refund);
  const afterReplay = await account(ownerContext);
  assert.deepEqual(afterReplay, beforeReplay, 'Repeating the same successful card event changes no balance or payment record.');
  assert.equal(afterReplay.cardPayments.length, 1);
  assert.equal(afterReplay.transactions.filter((entry) => entry.direction !== 'funded').length, 0, 'Card journals must not appear as unrelated member transfers.');
  pass('A partial refund returns only the refunded amount, and replaying its event neither credits again nor duplicates the history.');

  await cardEvent({ eventId: `${runId}-cancel-authorize`, paymentId: cancelledId, userId: ownerProfile.id, kind: 'authorize', amountWon: 15_000, merchantName: '승인 취소 테스트 매장' });
  await balances(ownerPage, 60_000, 15_000, 75_000);
  await payment(ownerPage, cancelledId, 'authorized', { held: 15_000, captured: 0 });
  await cardEvent({ eventId: `${runId}-reverse`, paymentId: cancelledId, userId: ownerProfile.id, kind: 'reverse' });
  await balances(ownerPage, 75_000, 0, 75_000);
  await payment(ownerPage, cancelledId, 'cancelled', { held: 0, captured: 0, released: 15_000, refunded: 0, net: 0 });
  pass('Authorization cancellation releases the full remaining hold and retains a cancelled payment record.');

  await otherPage.bringToFront();
  const isolated = await balances(otherPage, 2_000, 0, 2_000);
  assert.deepEqual(isolated.cardPayments, []);
  const attemptedOwnerQuery = await account(otherContext, `?userId=${encodeURIComponent(ownerProfile.id)}`);
  assert.equal(attemptedOwnerQuery.user.id, otherProfile.id);
  assert.deepEqual(attemptedOwnerQuery.cardPayments, []);
  assert.equal(await otherPage.getByTestId(`server-card-payment-${paymentId}`).count(), 0);
  assert.equal(await otherPage.getByTestId(`server-card-payment-${cancelledId}`).count(), 0);
  await fits(otherPage, 'Other account mobile view');
  pass('A second browser sees only its own balance and no card history, including when another user ID is supplied in the query.');

  await ownerPage.bringToFront();
  await ownerPage.reload({ waitUntil: 'networkidle' });
  await balances(ownerPage, 75_000, 0, 75_000);
  await payment(ownerPage, paymentId, 'partially_refunded', { held: 0, captured: 35_000, refunded: 10_000, net: 25_000 });
  await payment(ownerPage, cancelledId, 'cancelled', { held: 0, released: 15_000, net: 0 });
  assert.equal((await account(ownerContext)).cardPayments.length, 2);
  await fits(ownerPage, 'Desktop card history');
  await ownerPage.screenshot({ path: new URL('card-desktop.png', artifacts).pathname, fullPage: true });
  await ownerPage.setViewportSize({ width: 320, height: 740 });
  await fits(ownerPage, '320px card details');
  await ownerPage.screenshot({ path: new URL('card-mobile.png', artifacts).pathname, fullPage: true });
  assert.deepEqual(runtimeErrors, []);
  pass('Card balances and expanded payment details survive refresh and fit desktop and 320px screens without runtime errors.');

  await writeFile(new URL('results.json', artifacts), JSON.stringify({
    recordedAt: new Date().toISOString(), baseUrl: base.href, passed: checks.length, checks,
    backendMocked: false, database: 'PostgreSQL', mutationPath: 'Local sandbox operator CLI',
    automaticPollingVerified: true, ownerIsolationVerified: true, duplicateEventVerified: true,
    realIssuerConnected: false, realDeviceTested: false, engine: 'Chromium',
    finalBalanceWon: 75_000, finalHeldWon: 0, cardPayments: 2,
    screenshots: ['card-desktop.png', 'card-mobile.png'],
  }, null, 2));
  console.log(`${checks.length} card browser checks passed against real HTTP sessions, PostgreSQL and the operator CLI.`);
} catch (error) {
  if (currentPage && !currentPage.isClosed()) await currentPage.screenshot({ path: new URL('failure.png', artifacts).pathname, fullPage: true }).catch(() => {});
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await rm(eventDirectory, { recursive: true, force: true });
}
