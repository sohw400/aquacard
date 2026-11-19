import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { chromium } from 'playwright-core';

const base = new URL(process.env.AQUA_BASE_URL ?? 'http://127.0.0.1:3007');
const schema = process.env.DATABASE_SCHEMA ?? '';
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), 'Use a loopback sandbox UI.');
assert.ok(/^test_[a-z0-9_]+$/.test(schema), 'Use the disposable schema created by security-browser-runner.');
assert.notEqual(process.env.NODE_ENV, 'production');
assert.ok(process.env.MIGRATION_DATABASE_URL, 'The fixture requires an owner connection.');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(process.env.MIGRATION_DATABASE_URL).hostname));
const repo = fileURLToPath(new URL('../', import.meta.url));
const artifacts = new URL('../artifacts/security-server/', import.meta.url);
await mkdir(artifacts, { recursive: true });
const database = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, options: `-c search_path=${schema},pg_catalog,pg_temp -c statement_timeout=10000`, max: 2 });
const runId = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
const password = 'AquaSecurityBrowser#2026';
const owner = { name: '계정 보안 검증', email: `security-${runId}@aqua.example.test`, tag: `q${runId}` };
const recipient = { name: '거래 제한 검증', email: `recipient-${runId}@aqua.example.test`, tag: `w${runId}` };
const checks = [], errors = [], securityRequests = [];
const pass = (name) => { checks.push(name); console.log(`PASS ${checks.length}: ${name}`); };
const url = (path) => new URL(path, base).href;
let browser, page;
let stopping = false;
let creditChild;
const interrupt = () => { stopping = true; creditChild?.kill('SIGTERM'); void browser?.close().catch(() => {}); };
process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);

function watch(target) {
  target.setDefaultTimeout(15_000);
  target.on('pageerror', (error) => errors.push(error.message));
  // Capture ownership headers only; never retain passwords or session bearer cookies.
  target.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/auth/sessions') || path === '/api/auth/reauthenticate') {
      securityRequests.push({ path, owner: request.headers()['x-aqua-account'] });
    }
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
  const response = await target.context().request.get(url('/api/account'));
  assert.equal(response.status(), 200);
  return response.json();
}
async function login(target, member) {
  await target.goto(base.href, { waitUntil: 'networkidle' });
  await target.getByTestId('auth-login-tab').click();
  await target.getByTestId('auth-email').fill(member.email);
  await target.getByTestId('auth-password').fill(password);
  await target.getByTestId('auth-submit').click();
  await target.getByTestId('server-balance').waitFor();
}
async function changeAccess(userId, status, expectedVersion) {
  const response = await database.query('SELECT operator_set_customer_access($1::jsonb,$2::bigint) AS result', [JSON.stringify({
    userId, status, expectedVersion, idempotencyKey: `${runId}:${userId}:${status}:${expectedVersion}`,
    reason: 'Disposable security browser fixture state transition',
  }), Date.now()]);
  assert.equal(response.rows[0].result.status, status);
}
async function fund() {
  creditChild = spawn(process.execPath, ['--import', 'tsx', 'server/credit.ts', owner.email, '15000', `${runId}-funding`], {
    cwd: repo, env: process.env, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  creditChild.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-1500); });
  const timer = setTimeout(() => creditChild?.kill('SIGKILL'), 20_000); timer.unref();
  let code;
  try { code = await new Promise((resolve, reject) => { creditChild.once('error', reject); creditChild.once('close', resolve); }); }
  finally { clearTimeout(timer); }
  creditChild = undefined;
  assert.equal(code, 0, `Fixture funding failed: ${stderr}`);
}
async function sessions(target, expectedCount) {
  await target.getByTestId('security-refresh').click();
  await target.waitForFunction((count) => document.querySelectorAll('[data-testid="security-session"]').length === count
    && document.querySelector('[data-testid="security-sessions-panel"]')?.getAttribute('aria-busy') === 'false', expectedCount);
}
async function fits(target, name) {
  const dimensions = await target.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth }));
  assert.ok(dimensions.width <= dimensions.viewport + 1, `${name}: horizontal overflow ${dimensions.width}/${dimensions.viewport}`);
}

try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'], env: { ...process.env, XDG_CONFIG_HOME: '/tmp/aqua-chromium-config', XDG_CACHE_HOME: '/tmp/aqua-chromium-cache' } });
  assert.equal(stopping, false);
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul', reducedMotion: 'reduce' });
  const secondContext = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul', reducedMotion: 'reduce' });
  const recipientContext = await browser.newContext();
  page = await context.newPage(); watch(page);
  const health = await context.request.get(url('/api/health'));
  assert.equal(health.status(), 200); assert.equal((await health.json()).mode, 'sandbox');
  const account = await signup(page, owner);
  assert.equal(account.access.status, 'unverified'); assert.equal(account.access.canTransact, false);
  await page.locator('[data-testid="customer-access-panel"][data-status="unverified"]').waitFor();
  assert.equal(await page.getByTestId('server-send').isDisabled(), true);
  await sessions(page, 1);
  const firstList = await context.request.get(url('/api/auth/sessions'), { headers: { 'X-Aqua-Account': account.user.id } });
  assert.equal(firstList.status(), 200);
  const firstBody = await firstList.json();
  assert.deepEqual(Object.keys(firstBody.sessions[0]).sort(), ['id', 'deviceLabel', 'createdAt', 'lastSeenAt', 'expiresAt', 'current'].sort());
  pass('New signup remains unverified, Send is disabled, and session JSON contains no bearer or token hash.');

  const recipientResponse = await recipientContext.request.post(url('/api/auth/signup'), { headers: { Origin: base.origin }, data: { ...recipient, password } });
  assert.equal(recipientResponse.status(), 201);
  const recipientId = (await recipientResponse.json()).user.id;
  await changeAccess(account.user.id, 'active', 1); await changeAccess(recipientId, 'active', 1);
  await fund();
  await page.getByTestId('server-refresh').click();
  await page.locator('[data-testid="customer-access-panel"][data-status="active"]').waitFor();
  await page.getByTestId('server-send').click();
  await page.getByTestId('transfer-recipient').fill(recipient.tag);
  await page.getByTestId('transfer-lookup').click(); await page.getByTestId('transfer-next').click();
  await page.getByTestId('transfer-amount').fill('1000'); await page.getByTestId('transfer-review').click();
  await changeAccess(account.user.id, 'frozen', 2);
  await page.getByTestId('transfer-access-blocked').waitFor();
  assert.equal(await page.getByTestId('transfer-confirm').isDisabled(), true);
  await page.getByTestId('transfer-close').click();
  assert.equal(await page.getByTestId('server-send').isDisabled(), true);
  const unchanged = await context.request.get(url('/api/account'));
  assert.equal((await unchanged.json()).balanceWon, 15_000);
  pass('A freeze received while a transfer form is open disables confirmation without changing the balance.');

  const secondPage = await secondContext.newPage(); watch(secondPage);
  await login(secondPage, owner);
  await sessions(page, 2);
  await page.locator('[data-testid="security-session"][data-current="false"]').getByTestId('security-revoke-session').click();
  await page.getByTestId('security-revoke-dialog').waitFor();
  assert.equal(await page.getByTestId('security-password').count(), 0);
  await page.getByTestId('security-confirm-revoke').click();
  await page.getByTestId('security-revoke-dialog').waitFor({ state: 'hidden' });
  await sessions(page, 1);
  assert.equal((await context.request.get(url('/api/account'))).status(), 200);
  assert.equal((await secondContext.request.get(url('/api/account'))).status(), 401);
  pass('Revoking another login invalidates its server session and preserves the current login.');

  await login(secondPage, owner);
  await database.query('UPDATE auth_sessions SET reauthenticated_at = NULL WHERE user_id = $1', [account.user.id]);
  await sessions(page, 2);
  await page.getByTestId('security-revoke-others').click();
  await page.getByTestId('security-password').fill('IncorrectBrowserPassword#2026');
  await page.getByTestId('security-confirm-revoke').click();
  await page.getByTestId('security-dialog-error').waitFor();
  assert.equal(await page.getByTestId('security-password').inputValue(), '');
  assert.equal((await context.request.get(url('/api/account'))).status(), 200);
  assert.equal((await secondContext.request.get(url('/api/account'))).status(), 200);
  await page.getByTestId('security-password').fill(password);
  await page.getByTestId('security-confirm-revoke').click();
  await page.getByTestId('security-revoke-dialog').waitFor({ state: 'hidden' });
  await sessions(page, 1);
  assert.equal((await secondContext.request.get(url('/api/account'))).status(), 401);
  pass('Expired password verification requires reauthentication; an incorrect password keeps the login and correct verification permits revoke-others.');

  await page.setViewportSize({ width: 320, height: 780 });
  await fits(page, '320px account and security panels');
  await page.getByTestId('security-revoke-session').click();
  const dialog = page.getByTestId('security-revoke-dialog');
  await dialog.waitFor();
  assert.equal(await page.locator('.sa-shell').evaluate((element) => element.inert), true);
  for (let index = 0; index < 8; index++) {
    await page.keyboard.press(index < 4 ? 'Tab' : 'Shift+Tab');
    assert.equal(await dialog.evaluate((element) => element.contains(document.activeElement)), true);
  }
  await fits(page, '320px password confirmation dialog');
  await page.screenshot({ path: fileURLToPath(new URL('security-320.png', artifacts)), fullPage: true });
  await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.sa-shell').evaluate((element) => element.inert), false);
  pass('The 320px layout fits, the dialog traps keyboard focus, and Escape restores page access.');

  await page.getByTestId('security-revoke-session').click();
  await page.getByTestId('security-confirm-revoke').click();
  await page.getByTestId('auth-login-tab').waitFor();
  assert.equal((await context.request.get(url('/api/account'))).status(), 401);
  pass('Revoking the current session returns to login and removes server account access.');

  await login(page, owner);
  await page.getByTestId('security-sessions-panel').waitFor();
  const switched = await context.request.post(url('/api/auth/login'), { headers: { Origin: base.origin }, data: { email: recipient.email, password } });
  assert.equal(switched.status(), 200);
  const mismatched = await context.request.get(url('/api/auth/sessions'), { headers: { 'X-Aqua-Account': account.user.id } });
  assert.equal(mismatched.status(), 409);
  assert.equal((await mismatched.json()).error.code, 'SESSION_CHANGED');
  await page.getByTestId('security-refresh').click();
  await page.getByTestId('auth-login-tab').waitFor();
  assert.equal(await page.getByTestId('security-sessions-panel').count(), 0);
  pass('Switching accounts in another tab cannot expose or mutate the new account through the previous security panel.');

  assert.ok(securityRequests.length > 0);
  assert.equal(securityRequests.every((request) => request.owner === account.user.id), true);
  assert.deepEqual(errors, []);
  pass('Every security request binds the viewed account and the connected UI produces no runtime errors.');
  await writeFile(new URL('report.json', artifacts), JSON.stringify({ mode: 'real-local-api', checks }, null, 2), { mode: 0o600 });
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: fileURLToPath(new URL('failure.png', artifacts)), fullPage: true }).catch(() => {});
  throw error;
} finally {
  process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
  await browser?.close();
  await database.end();
}
