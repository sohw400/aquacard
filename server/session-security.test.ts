import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { AuthService } from './auth';
import { Database } from './database';
import { LedgerError, LedgerStore } from './ledger';
import { createTestDatabase } from './test-support';

const NOW = Date.UTC(2026, 10, 19);
const MINUTE = 60_000;
const PASSWORD = 'Aqua-Secure-Session42!';
const REPLACEMENT = 'Aqua-Replaced-Session84!';
const digest = (token: string) => createHash('sha256').update(token).digest('hex');

async function fixture(t: TestContext) {
  const base = await createTestDatabase();
  let now = NOW;
  const mail: string[] = [];
  const peers: Database[] = [];
  const options = { now: () => now, deliverRecovery: async (_email: string, token: string) => { mail.push(token); } };
  const store = new LedgerStore(base.database);
  const auth = new AuthService(store, options);
  t.after(async () => { await Promise.all(peers.map((database) => database.close())); await base.cleanup(); });
  return {
    ...base, store, auth, mail, now: () => now,
    advance: (milliseconds: number) => { now += milliseconds; },
    peer() {
      const database = new Database({ connectionString: base.connectionString, schema: base.schema }); peers.push(database);
      return { database, auth: new AuthService(new LedgerStore(database), options) };
    },
    signup: (tag = 'alice', userAgent?: string) => auth.signup({ email: `${tag}@example.test`, name: '보안 회원', tag, password: PASSWORD }, `signup-${tag}`, { userAgent }),
    login: (tag = 'alice', userAgent?: string) => auth.login({ email: `${tag}@example.test`, password: PASSWORD }, `login-${tag}`, { userAgent }),
  };
}

async function rejectCode(action: Promise<unknown>, code: string) {
  await assert.rejects(action, (error: unknown) => error instanceof LedgerError && error.code === code);
}

test('session lists expose only owned public identifiers and coarse device labels, and last activity is throttled without extending expiry', async (t) => {
  const f = await fixture(t);
  const alice = await f.signup('alice', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1 private-marker');
  f.advance(MINUTE);
  await f.login('alice', 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Edg/130.0 sensitive-id');
  await f.signup('bobby', '<script>private-unknown</script>');
  const first = await f.auth.listSessions(alice.token, alice.user.id);
  assert.equal(first.sessions.length, 2);
  assert.equal(first.sessions[0].current, true);
  assert.equal(first.sessions[0].deviceLabel, 'iPhone · Safari');
  assert.equal(first.sessions[1].deviceLabel, 'Windows · Edge');
  assert.deepEqual(Object.keys(first.sessions[0]).sort(), ['createdAt', 'current', 'deviceLabel', 'expiresAt', 'id', 'lastSeenAt']);
  assert.match(first.sessions[0].id, /^[a-f0-9-]{36}$/);
  assert.doesNotMatch(JSON.stringify(first), /token|hash|private-marker|sensitive-id|bobby|password/i);
  const raw = (await f.database.query('SELECT * FROM auth_sessions WHERE token_hash = $1', [digest(alice.token)])).rows[0];
  assert.notEqual(raw.session_id, alice.token);
  assert.notEqual(raw.session_id, raw.token_hash);
  assert.equal(first.reauthenticatedUntil, NOW + 5 * MINUTE);

  await f.auth.authenticate(alice.token);
  assert.equal((await f.auth.listSessions(alice.token, alice.user.id)).sessions[0].lastSeenAt, NOW);
  f.advance(4 * MINUTE);
  await f.auth.authenticate(alice.token);
  const later = await f.auth.listSessions(alice.token, alice.user.id);
  assert.equal(later.sessions[0].lastSeenAt, NOW + 5 * MINUTE);
  assert.equal(later.sessions[0].expiresAt, first.sessions[0].expiresAt);
  assert.equal(later.reauthenticatedUntil, null);
});

test('public session IDs never authorize another owner and revoking the current session invalidates its bearer token', async (t) => {
  const f = await fixture(t);
  const alice = await f.signup(); const bob = await f.signup('bobby');
  const mine = (await f.auth.listSessions(alice.token, alice.user.id)).sessions[0];
  const theirs = (await f.auth.listSessions(bob.token, bob.user.id)).sessions[0];
  await rejectCode(f.auth.listSessions(alice.token, bob.user.id), 'AUTH_REQUIRED');
  await rejectCode(f.auth.revokeSession(alice.token, alice.user.id, theirs.id), 'SESSION_NOT_FOUND');
  await rejectCode(f.auth.revokeSession(alice.token, bob.user.id, theirs.id), 'AUTH_REQUIRED');
  await rejectCode(f.auth.revokeSession(alice.token, alice.user.id, randomUUID()), 'SESSION_NOT_FOUND');
  await rejectCode(f.auth.revokeSession(alice.token, alice.user.id, alice.token), 'INVALID_SESSION');
  assert.equal((await f.auth.authenticate(bob.token))?.id, bob.user.id);
  assert.deepEqual(await f.auth.revokeSession(alice.token, alice.user.id, mine.id.toUpperCase()), { revokedCurrent: true });
  assert.equal(await f.auth.authenticate(alice.token), null);
  await rejectCode(f.auth.listSessions(alice.token, alice.user.id), 'AUTH_REQUIRED');
});

test('remote revocation requires recent password verification on the calling session and does not refresh peers', async (t) => {
  const f = await fixture(t);
  const first = await f.signup(); const second = await f.login(); const third = await f.login();
  f.advance(5 * MINUTE);
  const target = (await f.auth.listSessions(second.token, first.user.id)).sessions.find((row) => row.current)!;
  await rejectCode(f.auth.revokeSession(first.token, first.user.id, target.id), 'REAUTHENTICATION_REQUIRED');
  await rejectCode(f.auth.revokeOtherSessions(first.token, first.user.id), 'REAUTHENTICATION_REQUIRED');
  await rejectCode(f.auth.reauthenticate(first.token, first.user.id, REPLACEMENT, 'wrong-password'), 'INVALID_PASSWORD');
  assert.equal((await f.auth.listSessions(first.token, first.user.id)).reauthenticatedUntil, null);
  assert.deepEqual(await f.auth.reauthenticate(first.token, first.user.id, PASSWORD, 'valid-password'), { reauthenticatedUntil: f.now() + 5 * MINUTE });
  assert.equal((await f.auth.listSessions(second.token, first.user.id)).reauthenticatedUntil, null);
  assert.deepEqual(await f.auth.revokeSession(first.token, first.user.id, target.id), { revokedCurrent: false });
  assert.equal(await f.auth.authenticate(second.token), null);
  assert.equal((await f.auth.authenticate(third.token))?.id, first.user.id);
  assert.deepEqual(await f.auth.revokeOtherSessions(first.token, first.user.id), { revokedCount: 1 });
  assert.deepEqual(await f.auth.revokeOtherSessions(first.token, first.user.id), { revokedCount: 0 });
  assert.equal((await f.auth.authenticate(first.token))?.id, first.user.id);
});

test('revoked and expired callers cannot manage or reauthenticate sessions even with the account password', async (t) => {
  const f = await fixture(t);
  const first = await f.signup(); const second = await f.login();
  await f.auth.revokeOtherSessions(second.token, second.user.id);
  await rejectCode(f.auth.revokeOtherSessions(first.token, first.user.id), 'AUTH_REQUIRED');
  await rejectCode(f.auth.reauthenticate(first.token, first.user.id, PASSWORD, 'revoked-reauth'), 'AUTH_REQUIRED');
  await rejectCode(f.auth.requireRecentAuthentication(first.token, first.user.id), 'AUTH_REQUIRED');
  f.advance(7 * 24 * 60 * MINUTE);
  await rejectCode(f.auth.listSessions(second.token, second.user.id), 'AUTH_REQUIRED');
  await rejectCode(f.auth.revokeOtherSessions(second.token, second.user.id), 'AUTH_REQUIRED');
  await rejectCode(f.auth.reauthenticate(second.token, second.user.id, PASSWORD, 'expired-reauth'), 'AUTH_REQUIRED');
});

test('reauthentication attempts share an account budget across sessions and API instances', async (t) => {
  const f = await fixture(t);
  const first = await f.signup(); const second = await f.login(); const peer = f.peer();
  f.advance(5 * MINUTE);
  const attempts = await Promise.allSettled(Array.from({ length: 8 }, (_, index) =>
    (index % 2 ? f.auth : peer.auth).reauthenticate(index % 2 ? first.token : second.token, first.user.id, REPLACEMENT, `reauth-ip-${index}`)));
  const errors = attempts.map((result) => { assert.equal(result.status, 'rejected'); return (result as PromiseRejectedResult).reason as LedgerError; });
  assert.equal(errors.filter((error) => error.code === 'INVALID_PASSWORD').length, 5);
  assert.equal(errors.filter((error) => error.code === 'RATE_LIMITED').length, 3);
  await rejectCode(f.auth.reauthenticate(first.token, first.user.id, PASSWORD, 'correct-but-limited'), 'RATE_LIMITED');
  f.advance(5 * MINUTE);
  assert.equal((await peer.auth.reauthenticate(first.token, first.user.id, PASSWORD, 'after-window')).reauthenticatedUntil, f.now() + 5 * MINUTE);
});

test('reauthentication cannot revive a session or bless a stale password snapshot after reset', async (t) => {
  const f = await fixture(t);
  const member = await f.signup(); const peer = f.peer();
  await f.auth.requestRecovery(member.user.email, 'request-reset');
  f.advance(5 * MINUTE);
  const originalQuery = f.database.query.bind(f.database);
  let markRead!: () => void; let releaseRead!: () => void;
  const hasRead = new Promise<void>((resolve) => { markRead = resolve; });
  const canContinue = new Promise<void>((resolve) => { releaseRead = resolve; });
  f.database.query = async <T extends QueryResultRow = QueryResultRow>(sql: string, values?: unknown[]) => {
    const result = await originalQuery<T>(sql, values);
    if (sql.includes('FROM auth_sessions s JOIN users u') && sql.includes('s.user_id = $2')) {
      markRead(); await canContinue;
    }
    return result;
  };
  const pending = f.auth.reauthenticate(member.token, member.user.id, PASSWORD, 'during-reset');
  await hasRead;
  try { await peer.auth.resetPassword(f.mail[0], REPLACEMENT, 'reset-other-process'); }
  finally { releaseRead(); }
  await rejectCode(pending, 'AUTH_REQUIRED');
  assert.equal(await peer.auth.authenticate(member.token), null);
  const loggedIn = await peer.auth.login({ email: member.user.email, password: REPLACEMENT }, 'replacement-login');
  assert.equal((await peer.auth.listSessions(loggedIn.token, member.user.id)).sessions.length, 1);
});

test('a caller revoked while waiting for the user lock cannot revoke a newer session', async (t) => {
  const f = await fixture(t);
  const first = await f.signup(); const second = await f.login(); const peer = f.peer();
  const blocker = await f.database.pool.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [first.user.id]);
    const pending = peer.auth.revokeOtherSessions(first.token, first.user.id);
    // The pending operation either has not reached the lock or waits for it; in both
    // cases it must re-read its session after this transaction commits.
    await blocker.query('DELETE FROM auth_sessions WHERE token_hash = $1', [digest(first.token)]);
    await blocker.query('COMMIT');
    await rejectCode(pending, 'AUTH_REQUIRED');
    assert.equal((await f.auth.authenticate(second.token))?.id, second.user.id);
  } finally { await blocker.query('ROLLBACK'); blocker.release(); }
});

test('session issuance bounds device history and revoke-others preserves only the current login', async (t) => {
  const f = await fixture(t);
  const first = await f.signup();
  // Seed realistic prior device sessions without spending password-guessing budgets.
  for (let index = 1; index <= 21; index++) {
    await f.database.query(`INSERT INTO auth_sessions
      (token_hash,user_id,created_at,expires_at,last_seen_at,reauthenticated_at)
      VALUES ($1,$2,$3,$4,$3,NULL)`, [digest(`fixture-session-${index}`), first.user.id, NOW + index, NOW + 7 * 24 * 60 * MINUTE]);
  }
  f.advance(MINUTE);
  const newest = await f.login();
  const listed = await f.auth.listSessions(newest.token, newest.user.id);
  assert.equal(listed.sessions.length, 20);
  assert.equal(listed.sessions[0].current, true);
  assert.equal(await f.auth.authenticate(first.token), null);
  assert.deepEqual(await f.auth.revokeOtherSessions(newest.token, newest.user.id), { revokedCount: 19 });
  assert.equal((await f.auth.listSessions(newest.token, newest.user.id)).sessions.length, 1);
});
