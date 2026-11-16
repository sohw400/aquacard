import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthService } from './auth';
import { LedgerError, LedgerStore } from './ledger';

const NOW = Date.UTC(2026, 10, 16, 5);
const MINUTE = 60_000;
const PASSWORD = 'Aqua-Secure-Password42!';
const REPLACEMENT = 'Aqua-Replaced-Password84!';
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

function fixture(t: TestContext, persistent = false) {
  const directory = persistent ? mkdtempSync(join(tmpdir(), 'aqua-auth-test-')) : null;
  const filename = directory ? join(directory, 'auth.sqlite') : ':memory:';
  let now = NOW;
  let store = new LedgerStore(filename);
  const mail: { email: string; token: string }[] = [];
  const options = { now: () => now, deliverRecovery: async (email: string, token: string) => { mail.push({ email, token }); } };
  let auth = new AuthService(store, options);
  t.after(() => { store.close(); if (directory) rmSync(directory, { recursive: true, force: true }); });
  return {
    get store() { return store; }, get auth() { return auth; }, mail,
    now: () => now,
    advance(milliseconds: number) { now += milliseconds; },
    reopen() { store.close(); store = new LedgerStore(filename); auth = new AuthService(store, options); },
  };
}

function signup(auth: AuthService, tag = 'alice', password = PASSWORD) {
  return auth.signup({ email: `${tag}@example.test`, name: '테스트 회원', tag, password }, `signup-${tag}`);
}

async function failure(promise: Promise<unknown>, status: number, code?: string): Promise<LedgerError> {
  let received: LedgerError | undefined;
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof LedgerError);
    assert.equal(error.status, status);
    if (code) assert.equal(error.code, code);
    received = error;
    return true;
  });
  return received!;
}

test('signup normalizes profile fields, uses independent scrypt salts, and starts with zero money', async (t) => {
  const f = fixture(t);
  const first = await f.auth.signup({ email: '  Alice@Example.TEST ', name: '  김  아쿠아  ', tag: ' @Alice_7 ', password: PASSWORD }, 'signup-first');
  const second = await signup(f.auth, 'bobby');
  assert.deepEqual(Object.keys(first.user).sort(), ['createdAt', 'email', 'id', 'name', 'tag']);
  assert.equal(first.user.email, 'alice@example.test');
  assert.equal(first.user.tag, 'alice_7');
  assert.equal(first.user.name, '김 아쿠아');
  assert.equal(first.user.createdAt, NOW);
  assert.equal(f.store.snapshot(first.user.id).balanceWon, 0);
  assert.equal(f.store.snapshot(first.user.id).transactions.length, 0);
  const firstHash = f.store.getUserById(first.user.id)!.passwordHash;
  const secondHash = f.store.getUserById(second.user.id)!.passwordHash;
  assert.equal(firstHash.split('$')[0], 'scrypt');
  assert.ok(firstHash !== secondHash, 'identical passwords must receive independent salts');
  assert.ok(!firstHash.includes(PASSWORD), 'passwords must never be stored as plaintext');
  assert.equal('passwordHash' in f.auth.authenticate(first.token)!, false);
});

test('signup rejects malformed input and reserved or ambiguous tags before creating a user', async (t) => {
  const f = fixture(t);
  const base = { email: 'valid@example.test', name: '유효 이름', tag: 'valid.user', password: PASSWORD };
  const invalid: Record<string, unknown>[] = [
    { email: 'broken' }, { email: 'a\r\nb@example.test' }, { email: `${'a'.repeat(65)}@example.test` },
    { email: `${'a'.repeat(255)}@example.test` }, { email: 42 },
    { name: '김' }, { name: '김'.repeat(41) }, { name: '유효\u0000이름' },
    { tag: 'admin' }, { tag: '@SUPPORT' }, { tag: 'aqua.card' }, { tag: 'ab' },
    { tag: 'bad..tag' }, { tag: 'trailing_' }, { tag: '12345' }, { tag: '<script>' },
    { password: 'short-A1!' }, { password: 'a'.repeat(20) }, { password: 'A'.repeat(129) },
    { password: 'Long-Password1!\u0000' }, { password: null },
  ];
  for (const [index, change] of invalid.entries()) {
    await failure(f.auth.signup({ ...base, ...change } as typeof base, `invalid-${index}`), 400);
  }
  assert.equal((f.store.db.prepare('SELECT COUNT(*) AS total FROM users').get() as { total: number }).total, 0);
});

test('duplicate normalized email and tag return the same signup conflict without exposing hashes', async (t) => {
  const f = fixture(t);
  await signup(f.auth);
  const sameEmail = await failure(f.auth.signup({ email: 'ALICE@example.test', name: '다른 이름', tag: 'other.user', password: PASSWORD }, 'duplicate-email'), 409);
  const sameTag = await failure(f.auth.signup({ email: 'other@example.test', name: '다른 이름', tag: '@ALICE', password: PASSWORD }, 'duplicate-tag'), 409);
  assert.equal(sameEmail.code, sameTag.code);
  assert.equal(sameEmail.message, sameTag.message);
});

test('known, unknown, and malformed login credentials fail generically; valid login issues a fresh session', async (t) => {
  const f = fixture(t);
  const member = await signup(f.auth);
  const known = await failure(f.auth.login({ email: 'alice@example.test', password: REPLACEMENT }, 'known-ip'), 401);
  const unknown = await failure(f.auth.login({ email: 'absent@example.test', password: REPLACEMENT }, 'unknown-ip'), 401);
  const malformed = await failure(f.auth.login({ email: 'invalid', password: 'x'.repeat(1000) }, 'malformed-ip'), 401);
  assert.equal(known.code, unknown.code);
  assert.equal(known.message, unknown.message);
  assert.equal(known.message, malformed.message);
  const login = await f.auth.login({ email: ' ALICE@EXAMPLE.TEST ', password: PASSWORD }, 'valid-ip');
  assert.equal(login.user.id, member.user.id);
  assert.ok(login.token !== member.token, 'each login must generate an independent session secret');
  assert.equal(f.auth.authenticate(login.token)?.id, member.user.id);
});

test('session secrets are hashed in SQLite; logout, restart, and fixed TTL cannot revive a session', async (t) => {
  const f = fixture(t, true);
  const first = await signup(f.auth);
  const second = await f.auth.login({ email: 'alice@example.test', password: PASSWORD }, 'second-session');
  const rows = f.store.db.prepare('SELECT token_hash FROM auth_sessions').all() as { token_hash: string }[];
  assert.equal(first.token.length, 64);
  assert.ok(rows.some((row) => row.token_hash === hash(first.token)));
  assert.ok(rows.every((row) => row.token_hash !== first.token && row.token_hash !== second.token));
  f.reopen();
  assert.equal(f.auth.authenticate(first.token)?.id, first.user.id);
  f.auth.logout(first.token);
  f.auth.logout(first.token);
  f.reopen();
  assert.equal(f.auth.authenticate(first.token), null);
  assert.equal(f.auth.authenticate(second.token)?.id, second.user.id);
  assert.equal(f.auth.authenticate(undefined), null);
  assert.equal(f.auth.authenticate('not-a-token'), null);
  f.advance(7 * 24 * 60 * MINUTE);
  assert.equal(f.auth.authenticate(second.token), null);
  assert.equal((f.store.db.prepare('SELECT COUNT(*) AS total FROM auth_sessions').get() as { total: number }).total, 0);
});

test('recovery is generic, stores only a token hash, consumes the token, and invalidates every old session', async (t) => {
  const f = fixture(t);
  const first = await signup(f.auth);
  const second = await f.auth.login({ email: first.user.email, password: PASSWORD }, 'second-login');
  assert.equal(await f.auth.requestRecovery('absent@example.test', 'missing-recovery'), undefined);
  assert.equal(await f.auth.requestRecovery(' ALICE@EXAMPLE.TEST ', 'known-recovery'), undefined);
  assert.equal(f.mail.length, 1);
  const token = f.mail[0].token;
  assert.equal(f.mail[0].email, first.user.email);
  const stored = f.store.db.prepare('SELECT token_hash FROM auth_recovery').get() as { token_hash: string };
  assert.ok(stored.token_hash !== token);
  assert.ok(stored.token_hash === hash(token));
  await f.auth.resetPassword(token, REPLACEMENT, 'reset-user');
  assert.equal(f.auth.authenticate(first.token), null);
  assert.equal(f.auth.authenticate(second.token), null);
  await failure(f.auth.resetPassword(token, PASSWORD, 'replay-user'), 400, 'INVALID_RECOVERY');
  await failure(f.auth.login({ email: first.user.email, password: PASSWORD }, 'old-password'), 401);
  assert.equal((await f.auth.login({ email: first.user.email, password: REPLACEMENT }, 'new-password')).user.id, first.user.id);
  assert.equal((f.store.db.prepare('SELECT COUNT(*) AS total FROM auth_recovery').get() as { total: number }).total, 0);
});

test('expired and superseded recovery tokens cannot reset a password or invalidate an existing session', async (t) => {
  const f = fixture(t);
  const member = await signup(f.auth);
  await f.auth.requestRecovery(member.user.email, 'first-request');
  const oldToken = f.mail[0].token;
  await f.auth.requestRecovery(member.user.email, 'replacement-request');
  await failure(f.auth.resetPassword(oldToken, REPLACEMENT, 'superseded-reset'), 400, 'INVALID_RECOVERY');
  f.advance(15 * MINUTE);
  await failure(f.auth.resetPassword(f.mail[1].token, REPLACEMENT, 'expired-reset'), 400, 'INVALID_RECOVERY');
  assert.equal(f.auth.authenticate(member.token)?.id, member.user.id);
  assert.equal((await f.auth.login({ email: member.user.email, password: PASSWORD }, 'unchanged-login')).user.id, member.user.id);
});

test('simultaneous password resets consume one recovery token exactly once', async (t) => {
  const f = fixture(t);
  const member = await signup(f.auth);
  await f.auth.requestRecovery(member.user.email, 'concurrent-request');
  const alternatives = [REPLACEMENT, 'Other-Replacement-Password19!'];
  const results = await Promise.allSettled(alternatives.map((password, index) => f.auth.resetPassword(f.mail[0].token, password, `reset-${index}`)));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const loser = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
  assert.ok(loser.reason instanceof LedgerError);
  assert.equal(loser.reason.code, 'INVALID_RECOVERY');
  assert.equal(f.auth.authenticate(member.token), null);
  const winner = results.findIndex((result) => result.status === 'fulfilled');
  assert.equal((await f.auth.login({ email: member.user.email, password: alternatives[winner] }, 'reset-winner-login')).user.id, member.user.id);
});

test('a password changed during async verification cannot issue an old-credential session', async (t) => {
  const f = fixture(t);
  const alice = await signup(f.auth);
  const other = await signup(f.auth, 'bobby', REPLACEMENT);
  const replacementHash = f.store.getUserById(other.user.id)!.passwordHash;
  const inFlight = f.auth.login({ email: alice.user.email, password: PASSWORD }, 'login-during-reset');
  // Model a committed reset from another request while the old password's scrypt is pending.
  f.store.db.exec('BEGIN IMMEDIATE');
  f.store.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(replacementHash, alice.user.id);
  f.store.db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(alice.user.id);
  f.store.db.exec('COMMIT');
  await failure(inFlight, 401, 'INVALID_CREDENTIALS');
  assert.equal(f.auth.authenticate(alice.token), null);
  assert.equal(f.auth.authenticate(other.token)?.id, other.user.id);
});

test('account login throttles survive restart and blocked requests do not extend the fixed window', async (t) => {
  const f = fixture(t, true);
  const member = await signup(f.auth);
  for (let index = 0; index < 5; index += 1) {
    if (index === 3) f.reopen();
    await failure(f.auth.login({ email: member.user.email, password: REPLACEMENT }, `wrong-ip-${index}`), 401);
  }
  await failure(f.auth.login({ email: member.user.email, password: PASSWORD }, 'new-ip'), 429, 'RATE_LIMITED');
  f.advance(4 * MINUTE);
  await failure(f.auth.login({ email: member.user.email, password: PASSWORD }, 'blocked-ip'), 429);
  f.advance(MINUTE + 1);
  assert.equal((await f.auth.login({ email: member.user.email, password: PASSWORD }, 'unblocked-ip')).user.id, member.user.id);
  const stale = f.store.db.prepare('SELECT COUNT(*) AS total FROM auth_rate_limits WHERE expires_at <= ?').get(f.now()) as { total: number };
  assert.equal(stale.total, 0);
});

test('login IP limits apply across different account names and expire independently', async (t) => {
  const f = fixture(t);
  for (let index = 0; index < 10; index += 1) {
    await failure(f.auth.login({ email: `unknown${index}@example.test`, password: PASSWORD }, 'same-ip'), 401);
  }
  await failure(f.auth.login({ email: 'different@example.test', password: PASSWORD }, 'same-ip'), 429);
  f.advance(MINUTE + 1);
  await failure(f.auth.login({ email: 'newunknown@example.test', password: PASSWORD }, 'same-ip'), 401);
  const rows = f.store.db.prepare('SELECT key_hash FROM auth_rate_limits').all() as { key_hash: string }[];
  assert.ok(rows.every((row) => /^[a-f0-9]{64}$/.test(row.key_hash)), 'rate tables store bounded hashed identifiers');
});

test('signup and recovery limits reject excess attempts without indefinitely locking an account', async (t) => {
  const f = fixture(t);
  for (let index = 0; index < 5; index += 1) {
    await failure(f.auth.signup({ email: `invalid${index}@example.test`, name: '테스트 회원', tag: 'admin', password: PASSWORD }, 'signup-ip'), 400);
  }
  await failure(f.auth.signup({ email: 'new@example.test', name: '테스트 회원', tag: 'valid.user', password: PASSWORD }, 'signup-ip'), 429);
  for (let index = 0; index < 3; index += 1) await f.auth.requestRecovery('missing@example.test', `recovery-ip-${index}`);
  await failure(f.auth.requestRecovery('missing@example.test', 'another-recovery-ip'), 429);
  f.advance(15 * MINUTE + 1);
  assert.equal(await f.auth.requestRecovery('missing@example.test', 'recovery-retry'), undefined);
});

test('unavailable or failing recovery delivery never exposes a token or account existence', async (t) => {
  const f = fixture(t);
  const member = await signup(f.auth);
  const unavailable = new AuthService(f.store, { now: f.now });
  const known = await failure(unavailable.requestRecovery(member.user.email, 'unavailable-known'), 503);
  const unknown = await failure(unavailable.requestRecovery('absent@example.test', 'unavailable-unknown'), 503);
  assert.equal(known.code, unknown.code);
  assert.equal(known.message, unknown.message);
  const failing = new AuthService(f.store, { now: f.now, deliverRecovery: async () => { throw new Error('transport unavailable'); } });
  assert.equal(await failing.requestRecovery(member.user.email, 'transport-failure'), undefined);
  assert.equal(await failing.requestRecovery('other@example.test', 'transport-absent'), undefined);
  assert.equal((f.store.db.prepare('SELECT COUNT(*) AS total FROM auth_recovery').get() as { total: number }).total, 0);
});
