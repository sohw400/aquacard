import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { chromium } from 'playwright-core';

const base = new URL(process.env.AQUA_BASE_URL ?? 'http://127.0.0.1:3009');
const schema = process.env.DATABASE_SCHEMA ?? '';
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), 'Use a loopback sandbox UI.');
assert.ok(/^test_[a-z0-9_]+$/.test(schema), 'Use the disposable schema created by email-browser-runner.');
assert.notEqual(process.env.NODE_ENV, 'production');
assert.ok(process.env.MIGRATION_DATABASE_URL && process.env.AQUA_MAIL_DIR, 'The fixture requires its owner connection and isolated mailbox.');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(process.env.MIGRATION_DATABASE_URL).hostname));
const artifacts = new URL('../artifacts/email-server/', import.meta.url);
await mkdir(artifacts, { recursive: true });
const database = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, options: `-c search_path=${schema},pg_catalog,pg_temp -c statement_timeout=10000`, max: 2 });
const runId = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
const password = 'AquaEmailBrowser#2026';
const replacementPassword = 'AquaEmailReplacement#2026';
const alice = { name: '이메일 확인 검증', email: `email-${runId}@aqua.example.test`, tag: `e${runId}` };
const bob = { name: '이메일 소유 검증', email: `other-${runId}@aqua.example.test`, tag: `v${runId}` };
const checks = [], errors = [], emailRequests = [], secrets = [];
const pass = (name) => { checks.push(name); console.log(`PASS ${checks.length}: ${name}`); };
const url = (path) => new URL(path, base).href;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let browser, page;
const interrupt = () => { void browser?.close().catch(() => {}); };
process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);

function watch(target) {
  target.setDefaultTimeout(15_000);
  target.on('pageerror', (error) => errors.push(error.message));
  target.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/auth/email')) emailRequests.push({ path, owner: request.headers()['x-aqua-account'] });
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
  await target.locator('[data-testid="email-verification-panel"][data-verified="false"]').waitFor();
  const response = await target.context().request.get(url('/api/account'));
  assert.equal(response.status(), 200);
  return response.json();
}
async function login(target, member, credential = password) {
  await target.goto(base.href, { waitUntil: 'networkidle' });
  await target.getByTestId('auth-login-tab').click();
  await target.getByTestId('auth-email').fill(member.email);
  await target.getByTestId('auth-password').fill(credential);
  await target.getByTestId('auth-submit').click();
  await target.getByTestId('server-balance').waitFor();
}
async function mail(member, purpose, except = []) {
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    const files = await readdir(process.env.AQUA_MAIL_DIR).catch(() => []);
    for (const file of files.filter((name) => /^[a-f0-9-]+\.json$/.test(name))) {
      let message;
      try { message = JSON.parse(await readFile(`${process.env.AQUA_MAIL_DIR}/${file}`, 'utf8')); } catch { continue; }
      if (message.to === member.email && message.purpose === purpose && !except.includes(message.token)) {
        assert.ok(typeof message.token === 'string' && /^[a-f0-9]{64}$/.test(message.token), 'The private mailbox must contain a valid opaque code.');
        secrets.push(message.token);
        return message;
      }
    }
    await pause(100);
  }
  throw new Error(`The isolated mail worker did not deliver the expected ${purpose} message.`);
}
async function requestVerification(target, member, except = []) {
  await target.getByTestId('email-request').click();
  await target.getByTestId('email-notice').waitFor();
  assert.match(await target.getByTestId('email-notice').innerText(), /요청/);
  return mail(member, 'email-verification', except);
}
async function confirm(target, token) {
  await target.getByTestId('email-token').fill(token);
  await target.getByTestId('email-confirm').click();
}
async function account(context) {
  const response = await context.request.get(url('/api/account'));
  assert.equal(response.status(), 200);
  return response.json();
}
async function fits(target) {
  const dimensions = await target.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth }));
  assert.ok(dimensions.width <= dimensions.viewport + 1, 'The email UI must fit the viewport.');
}

try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'], env: { ...process.env, XDG_CONFIG_HOME: '/tmp/aqua-chromium-config', XDG_CACHE_HOME: '/tmp/aqua-chromium-cache' } });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul', reducedMotion: 'reduce' });
  const other = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul', reducedMotion: 'reduce' });
  const recovery = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul', reducedMotion: 'reduce' });
  page = await context.newPage(); watch(page);
  const otherPage = await other.newPage(); watch(otherPage);
  const recoveryPage = await recovery.newPage(); watch(recoveryPage);
  const initial = await signup(page, alice);
  const otherInitial = await signup(otherPage, bob);
  assert.equal(initial.user.emailVerifiedAt, null);
  assert.equal(initial.access.status, 'unverified'); assert.equal(initial.access.canTransact, false);
  await database.query('SELECT operator_set_customer_access($1::jsonb,$2::bigint)', [JSON.stringify({ userId: initial.user.id,
    status: 'active', expectedVersion: 1, idempotencyKey: `${runId}:approve`, reason: 'Explicit disposable browser fixture approval before email proof' }), Date.now()]);
  await page.getByTestId('server-refresh').click();
  await page.locator('[data-testid="customer-access-panel"][data-status="active"]').waitFor();
  assert.match(await page.getByTestId('customer-access-panel').innerText(), /이메일/);
  assert.equal((await account(context)).access.canTransact, false);
  pass('Signup has no email proof, and explicit customer approval alone cannot enable transactions.');

  const first = await requestVerification(page, alice);
  await confirm(otherPage, first.token);
  await otherPage.getByTestId('email-error').waitFor();
  await otherPage.setViewportSize({ width: 320, height: 780 });
  await fits(otherPage);
  await otherPage.getByTestId('email-token').focus();
  assert.equal(await otherPage.getByTestId('email-token').evaluate((element) => document.activeElement === element), true);
  assert.equal((await account(other)).user.emailVerifiedAt, null);
  assert.equal((await account(context)).user.emailVerifiedAt, null);
  pass('The separate mail worker delivers a code, and a different signed-in member cannot consume it.');

  const second = await requestVerification(page, alice, [first.token]);
  await confirm(page, first.token); await page.getByTestId('email-error').waitFor();
  assert.equal((await account(context)).user.emailVerifiedAt, null);
  await database.query('UPDATE auth_email_verification SET expires_at=created_at+1 WHERE user_id=$1 AND used_at IS NULL', [initial.user.id]);
  await confirm(page, second.token); await page.getByTestId('email-error').waitFor();
  assert.equal((await account(context)).user.emailVerifiedAt, null);
  pass('A resend invalidates the previous code, and an expired code cannot verify the account.');

  const third = await requestVerification(page, alice, [first.token, second.token]);
  await recoveryPage.goto(base.href, { waitUntil: 'networkidle' });
  await recoveryPage.getByTestId('auth-recovery').click();
  await recoveryPage.getByTestId('auth-email').fill(alice.email);
  await recoveryPage.getByTestId('recovery-request').click();
  await recoveryPage.getByTestId('recovery-token').waitFor();
  const recoveryMail = await mail(alice, 'password-recovery');
  await confirm(page, recoveryMail.token); await page.getByTestId('email-error').waitFor();
  await recoveryPage.getByTestId('recovery-token').fill(third.token);
  await recoveryPage.getByTestId('recovery-password').fill(replacementPassword);
  await recoveryPage.getByTestId('recovery-confirm').click();
  await recoveryPage.getByTestId('auth-error').waitFor();
  assert.equal((await account(context)).user.emailVerifiedAt, null);
  pass('Email verification and password recovery codes cannot be exchanged between purposes.');

  await confirm(page, third.token); await page.getByTestId('email-verified').waitFor();
  const verified = await account(context);
  assert.ok(Number.isSafeInteger(verified.user.emailVerifiedAt));
  assert.equal(verified.access.status, 'active'); assert.equal(verified.access.canTransact, true);
  const replay = await context.request.post(url('/api/auth/email/confirm'), { headers: { Origin: base.origin, 'X-Aqua-Account': initial.user.id }, data: { token: third.token } });
  assert.equal(replay.status(), 200);
  const bobMail = await requestVerification(otherPage, bob);
  await otherPage.route('**/api/auth/email/confirm', async (route) => {
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    await route.abort('failed');
  }, { times: 1 });
  await confirm(otherPage, bobMail.token); await otherPage.getByTestId('email-verified').waitFor();
  const bobVerified = await account(other);
  assert.ok(Number.isSafeInteger(bobVerified.user.emailVerifiedAt));
  assert.equal(bobVerified.access.status, 'unverified'); assert.equal(bobVerified.access.canTransact, false);
  pass('Verification preserves customer-review status, supports same-code retry, and recovers a lost confirmation response by reading current state.');

  await otherPage.setViewportSize({ width: 320, height: 780 });
  await fits(otherPage);
  await otherPage.getByTestId('email-refresh').focus();
  assert.equal(await otherPage.getByTestId('email-refresh').evaluate((element) => document.activeElement === element), true);
  await otherPage.screenshot({ path: fileURLToPath(new URL('email-320.png', artifacts)), fullPage: true });
  for (const target of [page, otherPage, recoveryPage]) {
    const persisted = await target.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, url: location.href }));
    assert.ok(secrets.every((secret) => !persisted.includes(secret)), 'Authentication codes must not be persisted in browser storage or URLs.');
  }
  pass('The email panel fits 320px and is keyboard accessible; codes are absent from URLs and browser storage.');

  await recoveryPage.getByTestId('recovery-token').fill(recoveryMail.token);
  await recoveryPage.getByTestId('recovery-password').fill(replacementPassword);
  await recoveryPage.getByTestId('recovery-confirm').click();
  await recoveryPage.getByTestId('auth-login-tab').waitFor();
  assert.equal((await context.request.get(url('/api/account'))).status(), 401);
  await login(recoveryPage, alice, replacementPassword);
  assert.ok(Number.isSafeInteger((await account(recovery)).user.emailVerifiedAt));
  pass('A delivered recovery code resets the password, revokes existing sessions, and preserves established email proof.');

  const switched = await recovery.request.post(url('/api/auth/login'), { headers: { Origin: base.origin }, data: { email: bob.email, password } });
  assert.equal(switched.status(), 200);
  await recoveryPage.getByTestId('email-refresh').click();
  await recoveryPage.getByTestId('auth-login-tab').waitFor();
  assert.equal(await recoveryPage.getByTestId('email-verification-panel').count(), 0);
  assert.ok(emailRequests.length > 0 && emailRequests.every((request) => [initial.user.id, otherInitial.user.id].includes(request.owner)));
  assert.deepEqual(errors, []);
  pass('Every email request binds its displayed account, and a cross-tab account change closes the stale panel.');
  await writeFile(new URL('report.json', artifacts), JSON.stringify({ mode: 'real-local-api-and-mail-worker', checks }, null, 2), { mode: 0o600 });
} catch (error) {
  if (page && !page.isClosed()) {
    await page.evaluate(() => { for (const input of document.querySelectorAll('input')) if (input.type === 'password' || /token/.test(input.dataset.testid ?? '')) input.value = ''; }).catch(() => {});
    await page.screenshot({ path: fileURLToPath(new URL('failure.png', artifacts)), fullPage: true }).catch(() => {});
  }
  throw error;
} finally {
  process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
  await browser?.close(); await database.end();
}
