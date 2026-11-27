import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';

const repo = fileURLToPath(new URL('..', import.meta.url));
const stateDir = resolve(process.env.AQUA_STAGING_DIR || join(repo, 'data/local-staging'));
const origin = 'https://localhost:3443';
const amountWon = 1000;
const mode = process.argv[2];
assert.ok(process.argv.length <= 3 && [undefined, '--after-restart', '--chain-deposit', '--card-controls'].includes(mode),
  'Usage: node scripts/staging-smoke.mjs [--after-restart | --chain-deposit | --card-controls]');
const afterRestart = mode === '--after-restart';
const chainDeposit = mode === '--chain-deposit';
const cardControls = mode === '--card-controls';
const journal = join(stateDir, chainDeposit ? 'smoke-deposit.json' : 'smoke-reserve.json');
const execute = promisify(execFile);

async function loadJournal() {
  try { return JSON.parse(await readFile(journal, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function saveJournal(value) {
  const temp = journal + '.' + randomUUID();
  await writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  await rename(temp, journal);
}

async function exerciseDeposit(api, account, cardId, previous) {
  const amount = 5_000;
  const run = previous?.phase === 'pending' ? previous : {
    phase: 'pending', userId: account.user.id, cardId, key: randomUUID(), wallet: account.balanceWon,
  };
  await saveJournal(run);
  const reserveDeposit = async () => {
    const quote = await api('/api/funding', { action: 'quote', direction: 'deposit', asset: 'KRWS',
      network: 'ethereum', quantity: String(amount) }, run.key + '-quote');
    assert.equal(quote.netWon, amount);
    const accepted = await api('/api/funding', { action: 'accept_deposit', id: quote.id }, run.key + '-accept');
    assert.equal(accepted.status, 'awaiting');
    return quote.id;
  };
  let id;
  try { id = await reserveDeposit(); }
  catch (error) {
    if (error.code !== 'FUNDING_QUOTE_EXPIRED') throw error;
    // No transfer can have been sent for a quote that was never accepted.
    run.key = randomUUID();
    await saveJournal(run);
    id = await reserveDeposit();
  }
  assert.match(id, /^[a-f0-9-]{36}$/);
  async function deliver() {
    const result = await execute(process.execPath, ['--import', 'tsx', 'scripts/staging-chain-deposit.ts', id], {
      cwd: repo, env: { ...process.env, AQUA_STAGING_DIR: stateDir }, encoding: 'utf8', timeout: 120_000,
    });
    const proof = JSON.parse(result.stdout);
    assert.equal(proof.id, id);
    assert.equal(proof.status, 'credited');
    assert.equal(proof.chainId, 31337);
    assert.equal(proof.amountWon, amount);
    assert.match(proof.transactionHash, /^0x[a-f0-9]{64}$/i);
    assert.ok(proof.confirmations >= 12);
    return proof;
  }
  // Competing funding operators must agree on the first receipt; reopening
  // it from disk after both processes exit must produce the same result.
  const [first, contender] = await Promise.allSettled([deliver(), deliver()]);
  if (first.status === 'rejected') throw first.reason;
  if (contender.status === 'rejected') throw contender.reason;
  assert.deepEqual(contender.value, first.value);
  assert.deepEqual(await deliver(), first.value);
  const history = (await api('/api/funding')).filter(row => row.id === id);
  assert.deepEqual(history.map(row => [row.status, row.netWon]), [['credited', amount]]);
  assert.equal((await api('/api/account')).balanceWon, run.wallet + amount);
  await saveJournal({ ...run, phase: 'complete', id, transactionHash: first.value.transactionHash });
}

async function run() {
  const member = JSON.parse(await readFile(join(stateDir, 'member.json'), 'utf8'));
  assert.ok(member.email?.endsWith('@example.test') && member.tag?.startsWith('stageqa') && member.password,
    'Provision the local staging QA member before running the smoke.');
  for (const [path, expected] of [['/api/live', { status: 'ok' }], ['/api/health', { status: 'ok', mode: 'sandbox' }]]) {
    const response = await fetch(origin + path, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('strict-transport-security') ?? '', /max-age=[1-9]\d*/);
    assert.deepEqual(await response.json(), expected);
  }
  assert.equal((await fetch(origin + '/api/account', { redirect: 'error', signal: AbortSignal.timeout(10_000) })).status, 401);

  const profile = await mkdtemp(join(tmpdir(), 'aqua-stage-smoke-'));
  let browser;
  try {
    // Chromium's Linux root store reads NSS user roots. Trust only the local
    // stage CA in a disposable XDG data directory, without editing the tester's profile.
    const nss = join(profile, 'data/pki/nssdb');
    await mkdir(nss, { recursive: true, mode: 0o700 });
    // Versions before Chromium's XDG migration resolve user roots under ~/.pki.
    await symlink(join(profile, 'data/pki'), join(profile, '.pki'));
    execFileSync('certutil', ['-N', '-d', 'sql:' + nss, '--empty-password']);
    execFileSync('certutil', ['-A', '-d', 'sql:' + nss, '-t', 'C,,', '-n', 'Aqua staging', '-i', join(stateDir, 'ca.crt')]);
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
      env: { PATH: process.env.PATH, HOME: profile, XDG_CONFIG_HOME: join(profile, 'config'),
        XDG_CACHE_HOME: join(profile, 'cache'), XDG_DATA_HOME: join(profile, 'data'), LANG: 'C.UTF-8' },
    });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ko-KR', reducedMotion: 'reduce' });
    const page = await context.newPage();
    const runtimeErrors = [];
    page.on('pageerror', () => runtimeErrors.push('pageerror'));
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    assert.ok(await page.locator('script[type="module"][src*="/assets/"]').count(), 'Serve the compiled connected web client.');
    await page.getByTestId('auth-email').fill(member.email);
    await page.getByTestId('auth-password').fill(member.password);
    await page.getByTestId('auth-submit').click();
    const balance = page.getByTestId('server-balance');
    await balance.waitFor({ state: 'visible' });
    await page.waitForFunction(allowLocked => {
      const status = document.querySelector('[data-testid="issuer-card-panel"]')?.dataset.confirmedStatus;
      return status === 'active' || (allowLocked && status === 'locked');
    }, cardControls);
    const cookies = await context.cookies(origin + '/api/account');
    const session = cookies.find(cookie => cookie.path === '/api' && cookie.httpOnly);
    assert.ok(session?.secure && session.sameSite === 'Strict', 'Session must use Secure, HttpOnly and SameSite=Strict.');
    const sessionHeader = session.name + '=' + session.value;

    let userId;
    async function api(path, body, key, expectedStatus = 200) {
      const headers = { Cookie: sessionHeader };
      if (userId) headers['X-Aqua-Account'] = userId;
      if (body !== undefined) Object.assign(headers, { Origin: origin, 'Content-Type': 'application/json' });
      if (key !== undefined) headers['Idempotency-Key'] = key;
      const response = await fetch(origin + path, {
        method: body === undefined ? 'GET' : 'POST', headers,
        body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(10_000),
      });
      if (response.status !== expectedStatus) {
        const code = (await response.json().catch(() => null))?.error?.code;
        throw Object.assign(new Error(path + ' returned HTTP ' + response.status), { code });
      }
      return response.json();
    }

    const account = await api('/api/account');
    assert.equal(account.user.email, member.email);
    assert.equal(account.user.tag, member.tag);
    assert.ok(account.access.canTransact, 'The fixture must be transaction-enabled.');
    userId = account.user.id;
    const cardId = await page.getByTestId('issuer-card-panel').getAttribute('data-card-id');
    assert.ok(cardId);
    assert.equal((await api('/api/issuer-card')).card.id, cardId);
    const rejected = await fetch(origin + '/api/auth/logout', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { Cookie: sessionHeader, Origin: 'https://untrusted.example.invalid', 'Content-Type': 'application/json', 'X-Aqua-Account': userId },
      body: '{}',
    });
    assert.equal(rejected.status, 403);
    assert.equal((await rejected.json()).error.code, 'ORIGIN_REJECTED');
    assert.equal((await api('/api/session')).user.id, userId);

    const history = async () => (await api('/api/account/activity/reserve')).items;
    const previous = cardControls ? null : await loadJournal();
    if (previous) assert.ok(previous.userId === userId && previous.cardId === cardId, 'The smoke journal belongs to a different fixture.');
    if (cardControls) {
      const { verifyCardControls } = await import('./staging-card-controls.mjs');
      await verifyCardControls(api, member, stateDir);
    } else if (chainDeposit) {
      await exerciseDeposit(api, account, cardId, previous);
    } else if (afterRestart) {
      assert.equal(previous?.phase, 'complete', 'Run the regular smoke before verifying a restart.');
      assert.equal(account.balanceWon, previous.wallet, 'The saved spendable balance must survive the restart.');
      assert.equal(account.reserve.availableWon, previous.reserve, 'The saved Reserve principal must survive the restart.');
      const remaining = new Set(previous.entries);
      let cursor;
      do {
        const query = cursor ? '?' + new URLSearchParams({ cursor }) : '';
        const batch = await api('/api/account/activity/reserve' + query);
        for (const entry of batch.items) remaining.delete(entry.id);
        cursor = batch.nextCursor;
      } while (remaining.size && cursor);
      assert.equal(remaining.size, 0, 'Both posted Reserve movements must survive a restart.');
    } else {
      // Retain the exact command keys on timeout/interruption. Running the smoke
      // again finishes the same pair instead of moving the funds a second time.
      const run = previous?.phase === 'pending' ? previous : {
        phase: 'pending', userId, cardId, key: randomUUID(),
        wallet: account.balanceWon, reserve: account.reserve.availableWon,
        newest: (await history())[0]?.id ?? null,
      };
      assert.ok(run.wallet >= amountWon, 'The QA member needs at least 1,000 TEST_KRW for this smoke.');
      await saveJournal(run);
      const move = direction => api('/api/reserve/movement', { direction, amountWon }, run.key + '-' + direction);
      const inbound = await move('in');
      // Complete the outward move even if an assertion fails. If the first
      // response is lost, the persisted pair can be retried on the next run.
      let outbound;
      try {
        assert.equal(inbound.availableWon, run.reserve + amountWon);
        assert.deepEqual(await move('in'), inbound);
      } finally {
        outbound = await move('out');
      }
      assert.equal(outbound.availableWon, run.reserve);
      assert.deepEqual(await move('out'), outbound);
      const restored = await api('/api/account');
      assert.equal(restored.balanceWon, run.wallet);
      assert.equal(restored.reserve.availableWon, run.reserve);
      const rows = await history();
      const boundary = run.newest ? rows.findIndex(row => row.id === run.newest) : rows.length;
      assert.ok(boundary >= 0, 'The fixture history changed during the smoke.');
      const posted = rows.slice(0, boundary);
      assert.deepEqual(posted.map(row => [row.direction, row.source, row.amountWon]).sort(),
        [['in', 'wallet', amountWon], ['out', 'wallet', amountWon]]);
      await saveJournal({ phase: 'complete', userId, cardId, wallet: run.wallet, reserve: run.reserve, entries: posted.map(row => row.id) });
    }

    await page.reload({ waitUntil: 'domcontentloaded' });
    const current = await api('/api/account');
    await page.waitForFunction(expected => {
      const text = document.querySelector('[data-testid="server-balance"]')?.textContent ?? '';
      return /\d/.test(text) && Number(text.replace(/[^\d]/g, '')) === expected;
    }, current.balanceWon);
    await page.waitForFunction(() => document.querySelector('[data-testid="issuer-card-panel"]')?.dataset.confirmedStatus === 'active');
    await mkdir(join(repo, 'artifacts/staging'), { recursive: true });
    await page.screenshot({ path: join(repo, 'artifacts/staging/home.png') });
    await page.getByTestId('server-logout').click();
    await page.getByTestId('auth-email').waitFor();
    assert.equal((await fetch(origin + '/api/account', { headers: { Cookie: sessionHeader }, redirect: 'error', signal: AbortSignal.timeout(10_000) })).status, 401);
    assert.equal(runtimeErrors.length, 0, 'Connected UI emitted an unhandled error.');
    console.log(cardControls ? 'PASS: verified card locking and unlocking through the staged issuer and dispatcher.'
      : chainDeposit ? 'PASS: accepted a 5,000 TEST_KRW deposit over HTTPS, verified concurrent delivery and a later replay, and credited the wallet once.'
      : afterRestart
      ? 'PASS: verified TLS, compiled mobile UI, hardened session, CSRF, account, active card and persisted Reserve receipts after restart.'
      : 'PASS: verified TLS, compiled mobile UI, hardened session, CSRF, active card and a replayed, balanced 1,000 TEST_KRW Reserve round trip.');
  } finally { try { await browser?.close(); } finally { await rm(profile, { recursive: true, force: true }); } }
}

// A kernel lock serializes smoke runners, and Node loads the explicit stage CA
// before starting the test. Both are scoped to this child and staging instance.
if (process.env.AQUA_SMOKE_UNDER_LOCK === '1') {
  await run();
} else {
  const child = spawnSync('flock', ['-w', '5', join(stateDir, 'smoke.lock'), process.execPath, fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: 'inherit', env: { ...process.env, AQUA_SMOKE_UNDER_LOCK: '1', NODE_EXTRA_CA_CERTS: join(stateDir, 'ca.crt') },
  });
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 1;
}
