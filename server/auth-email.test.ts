import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import type { PoolClient } from 'pg';
import { AuthService } from './auth';
import { Database } from './database';
import { LedgerError, LedgerStore } from './ledger';
import { createTestDatabase } from './test-support';

const NOW = Date.UTC(2026, 10, 26, 5);
const MINUTE = 60_000;
const PASSWORD = 'Aqua-Email-Password42!';
const REPLACEMENT = 'Aqua-Recovered-Password84!';
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
type Mail = { purpose: 'email-verification' | 'password-recovery'; userId: string; email: string; token: string; createdAt: number; expiresAt: number };

async function fixture(t: TestContext) {
  const base = await createTestDatabase();
  await base.database.query('CREATE TABLE test_auth_mail_queue (id UUID PRIMARY KEY, purpose TEXT NOT NULL, token_hash TEXT NOT NULL)');
  let now = NOW;
  let failNext = false;
  const mail: Mail[] = [];
  const peers: Database[] = [];
  // A transactional sink verifies the caller passes its challenge transaction.
  // Raw tokens live only in test memory; this is not an external mail transport.
  const mailQueue = { async enqueue(client: PoolClient, message: Mail) {
    mail.push({ ...message });
    await client.query('INSERT INTO test_auth_mail_queue(id,purpose,token_hash) VALUES ($1,$2,$3)', [randomUUID(), message.purpose, digest(message.token)]);
    if (failNext) { failNext = false; throw new Error('Injected queue persistence failure'); }
  } };
  const options = { now: () => now, mailQueue };
  const store = new LedgerStore(base.database);
  const auth = new AuthService(store, options);
  t.after(async () => { await Promise.all(peers.map((database) => database.close())); await base.cleanup(); });
  return {
    ...base, store, auth, mail, options, now: () => now,
    advance(milliseconds: number) { now += milliseconds; },
    failQueue() { failNext = true; },
    peer() {
      const database = new Database({ connectionString: base.connectionString, schema: base.schema, maxConnections: 1 });
      peers.push(database);
      return { database, auth: new AuthService(new LedgerStore(database), options) };
    },
    signup(tag = 'email.alice') { return auth.signup({ email: `${tag}@example.test`, name: '이메일 검증', tag, password: PASSWORD }, `signup-${tag}`); },
  };
}
async function rejectCode(action: Promise<unknown>, code: string) {
  await assert.rejects(action, (error: unknown) => error instanceof LedgerError && error.code === code);
}
async function waitForLock(database: Database, pid: number) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await database.query<{ waiting: boolean }>('SELECT cardinality(pg_blocking_pids($1)) > 0 AS waiting', [pid])).rows[0].waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('The competing authentication command did not wait for the user lock.');
}

test('email proof starts absent, stores only a token hash, and never grants customer review approval', async (t) => {
  const f = await fixture(t);
  const member = await f.signup();
  assert.equal(member.user.emailVerifiedAt, null);
  assert.deepEqual(await f.auth.emailVerificationSnapshot(member.token, member.user.id), { email: member.user.email, verifiedAt: null, canRequest: true });
  await f.auth.requestEmailVerification(member.token, member.user.id, 'verify-request');
  assert.equal(f.mail.length, 1);
  const message = f.mail[0];
  assert.equal(message.purpose, 'email-verification');
  assert.equal(message.email, member.user.email);
  assert.equal(message.userId, member.user.id);
  assert.match(message.token, /^[a-f0-9]{64}$/);
  assert.equal(message.createdAt, NOW);
  assert.equal(message.expiresAt, NOW + 15 * MINUTE);
  const row = (await f.database.query('SELECT * FROM auth_email_verification WHERE user_id=$1', [member.user.id])).rows[0];
  assert.equal(row.token_hash, digest(message.token));
  assert.ok(!JSON.stringify(row).includes(message.token));
  await f.auth.confirmEmailVerification(member.token, member.user.id, message.token, 'verify-confirm');
  assert.deepEqual(await f.auth.emailVerificationSnapshot(member.token, member.user.id), { email: member.user.email, verifiedAt: NOW, canRequest: false });
  assert.equal((await f.auth.authenticate(member.token))?.emailVerifiedAt, NOW);
  const account = await f.store.snapshot(member.user.id);
  assert.equal(account.access.status, 'unverified');
  assert.equal(account.access.canTransact, false);
  assert.equal(account.balanceWon, 0);
  assert.equal(account.transactions.length, 0);
  assert.equal(Number((await f.database.query('SELECT count(*) FROM auth_sessions WHERE user_id=$1', [member.user.id])).rows[0].count), 1);
  await f.auth.confirmEmailVerification(member.token, member.user.id, message.token, 'confirm-replay');
  await rejectCode(f.auth.confirmEmailVerification(member.token, member.user.id, 'a'.repeat(64), 'invalid-after-success'), 'INVALID_EMAIL_VERIFICATION');
  await f.auth.requestEmailVerification(member.token, member.user.id, 'already-verified-request');
  assert.equal(f.mail.length, 1, 'A verified account must not enqueue another verification notice.');
});

test('verification requires the token owner session and tokens cannot cross recovery and verification purposes', async (t) => {
  const f = await fixture(t);
  const alice = await f.signup(); const bob = await f.signup('email.bobby');
  await f.auth.requestEmailVerification(alice.token, alice.user.id, 'owner-request');
  const verification = f.mail[0].token;
  await f.auth.requestRecovery(alice.user.email, 'recovery-request');
  const recovery = f.mail.find((message) => message.purpose === 'password-recovery')!.token;
  await rejectCode(f.auth.confirmEmailVerification(bob.token, bob.user.id, verification, 'foreign-owner'), 'INVALID_EMAIL_VERIFICATION');
  await rejectCode(f.auth.confirmEmailVerification(alice.token, bob.user.id, verification, 'changed-account'), 'AUTH_REQUIRED');
  await rejectCode(f.auth.confirmEmailVerification(alice.token, alice.user.id, recovery, 'wrong-purpose'), 'INVALID_EMAIL_VERIFICATION');
  await rejectCode(f.auth.resetPassword(verification, REPLACEMENT, 'wrong-reset-purpose'), 'INVALID_RECOVERY');
  assert.equal((await f.auth.authenticate(alice.token))?.emailVerifiedAt, null);
  await f.auth.logout(alice.token);
  await rejectCode(f.auth.requestEmailVerification(alice.token, alice.user.id, 'revoked-request'), 'AUTH_REQUIRED');
  await rejectCode(f.auth.confirmEmailVerification(alice.token, alice.user.id, verification, 'revoked-confirm'), 'AUTH_REQUIRED');
  assert.equal(f.mail.length, 2);
});

test('replacement invalidates the old verification code and expired unused codes cannot prove email ownership', async (t) => {
  const f = await fixture(t);
  const member = await f.signup();
  await f.auth.requestEmailVerification(member.token, member.user.id, 'first-verification');
  const old = f.mail[0].token;
  f.advance(MINUTE);
  await f.auth.requestEmailVerification(member.token, member.user.id, 'replacement-verification');
  const current = f.mail[1].token;
  assert.notEqual(current, old);
  await rejectCode(f.auth.confirmEmailVerification(member.token, member.user.id, old, 'superseded-code'), 'INVALID_EMAIL_VERIFICATION');
  f.advance(15 * MINUTE);
  await rejectCode(f.auth.confirmEmailVerification(member.token, member.user.id, current, 'expired-code'), 'INVALID_EMAIL_VERIFICATION');
  assert.equal((await f.auth.authenticate(member.token))?.emailVerifiedAt, null);
});

test('a failed verification enqueue rolls back replacement and preserves the earlier usable challenge', async (t) => {
  const f = await fixture(t);
  const member = await f.signup();
  await f.auth.requestEmailVerification(member.token, member.user.id, 'before-queue-failure');
  const prior = f.mail[0].token;
  f.advance(MINUTE); f.failQueue();
  await rejectCode(f.auth.requestEmailVerification(member.token, member.user.id, 'failed-queue'), 'EMAIL_VERIFICATION_UNAVAILABLE');
  const rows = (await f.database.query('SELECT token_hash FROM auth_email_verification WHERE user_id=$1', [member.user.id])).rows;
  assert.deepEqual(rows.map((row) => row.token_hash), [digest(prior)]);
  assert.equal(Number((await f.database.query('SELECT count(*) FROM test_auth_mail_queue')).rows[0].count), 1);
  await f.auth.confirmEmailVerification(member.token, member.user.id, prior, 'preserved-verification');
  assert.equal((await f.auth.authenticate(member.token))?.emailVerifiedAt, f.now());
});

test('recovery enqueue failure remains generic and rolls back without destroying a prior recovery code', async (t) => {
  const f = await fixture(t);
  const member = await f.signup();
  await f.auth.requestRecovery(member.user.email, 'first-recovery');
  const prior = f.mail[0].token;
  f.advance(MINUTE); f.failQueue();
  await f.auth.requestRecovery(member.user.email, 'failed-recovery-queue');
  await f.auth.requestRecovery('unknown@example.test', 'unknown-recovery');
  assert.deepEqual((await f.database.query('SELECT token_hash FROM auth_recovery WHERE user_id=$1', [member.user.id])).rows.map((row) => row.token_hash), [digest(prior)]);
  assert.equal(Number((await f.database.query('SELECT count(*) FROM test_auth_mail_queue')).rows[0].count), 1);
  await f.auth.resetPassword(prior, REPLACEMENT, 'preserved-recovery');
  assert.equal(await f.auth.authenticate(member.token), null);
  assert.equal((await f.auth.login({ email: member.user.email, password: REPLACEMENT }, 'new-password-login')).user.id, member.user.id);
});

test('already issued verification and recovery codes remain usable when issuance is disabled', async (t) => {
  const f = await fixture(t);
  const member = await f.signup();
  await f.auth.requestEmailVerification(member.token, member.user.id, 'before-mail-outage');
  const verification = f.mail[0].token;
  await f.auth.requestRecovery(member.user.email, 'before-recovery-outage');
  const recovery = f.mail[1].token;
  const unavailable = new AuthService(f.store, { now: f.now });
  assert.equal((await unavailable.emailVerificationSnapshot(member.token, member.user.id)).canRequest, false);
  await rejectCode(unavailable.requestEmailVerification(member.token, member.user.id, 'disabled-verification'), 'EMAIL_VERIFICATION_UNAVAILABLE');
  await unavailable.confirmEmailVerification(member.token, member.user.id, verification, 'confirm-during-outage');
  assert.equal((await unavailable.authenticate(member.token))?.emailVerifiedAt, NOW);
  await unavailable.resetPassword(recovery, REPLACEMENT, 'reset-during-outage');
  assert.equal(await unavailable.authenticate(member.token), null);
  const next = await unavailable.login({ email: member.user.email, password: REPLACEMENT }, 'login-after-outage');
  assert.equal(next.user.emailVerifiedAt, NOW, 'Resetting the password does not undo established ownership of an immutable email.');
  assert.equal(Number((await f.database.query('SELECT count(*) FROM auth_email_verification WHERE user_id=$1', [member.user.id])).rows[0].count), 0);
});

test('concurrent verification retries converge on one email proof without extending its original timestamp', async (t) => {
  const f = await fixture(t);
  const member = await f.signup();
  await f.auth.requestEmailVerification(member.token, member.user.id, 'parallel-request');
  const token = f.mail[0].token;
  const peer = f.peer();
  await Promise.all([
    f.auth.confirmEmailVerification(member.token, member.user.id, token, 'first-confirm'),
    peer.auth.confirmEmailVerification(member.token, member.user.id, token, 'second-confirm'),
  ]);
  f.advance(20 * MINUTE);
  await peer.auth.confirmEmailVerification(member.token, member.user.id, token, 'expired-consumed-replay');
  assert.equal((await f.auth.authenticate(member.token))?.emailVerifiedAt, NOW);
  assert.equal(Number((await f.database.query('SELECT used_at FROM auth_email_verification WHERE user_id=$1', [member.user.id])).rows[0].used_at), NOW);
});

test('a session revoked while verification waits for its owner lock cannot consume the challenge', async (t) => {
  const f = await fixture(t);
  const member = await f.signup();
  await f.auth.requestEmailVerification(member.token, member.user.id, 'waiting-request');
  const peer = f.peer();
  const pid = (await peer.database.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
  const blocker = await f.database.pool.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [member.user.id]);
    const waiting = peer.auth.confirmEmailVerification(member.token, member.user.id, f.mail[0].token, 'waiting-confirm');
    const checked = rejectCode(waiting, 'AUTH_REQUIRED');
    await waitForLock(f.database, pid);
    await blocker.query('DELETE FROM auth_sessions WHERE user_id=$1', [member.user.id]);
    await blocker.query('COMMIT');
    await checked;
    assert.equal((await f.store.getUserById(member.user.id))!.emailVerifiedAt, null);
    assert.equal((await f.database.query('SELECT used_at FROM auth_email_verification WHERE user_id=$1', [member.user.id])).rows[0].used_at, null);
  } finally { await blocker.query('ROLLBACK'); blocker.release(); }
});

test('a password reset that acquires the owner lock first invalidates a waiting verification and all sessions', async (t) => {
  const f = await fixture(t);
  const member = await f.signup();
  await f.auth.requestEmailVerification(member.token, member.user.id, 'before-reset-verification');
  await f.auth.requestRecovery(member.user.email, 'before-reset-recovery');
  const verification = f.mail[0].token, recovery = f.mail[1].token;
  const reset = f.peer(), confirm = f.peer();
  const resetPid = (await reset.database.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
  const confirmPid = (await confirm.database.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
  const blocker = await f.database.pool.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [member.user.id]);
    const resetting = reset.auth.resetPassword(recovery, REPLACEMENT, 'race-reset');
    await waitForLock(f.database, resetPid);
    const confirming = rejectCode(confirm.auth.confirmEmailVerification(member.token, member.user.id, verification, 'race-confirm'), 'AUTH_REQUIRED');
    await waitForLock(f.database, confirmPid);
    await blocker.query('COMMIT');
    await resetting; await confirming;
    assert.equal((await f.store.getUserById(member.user.id))!.emailVerifiedAt, null);
    assert.equal(Number((await f.database.query('SELECT count(*) FROM auth_email_verification')).rows[0].count), 0);
    assert.equal(Number((await f.database.query('SELECT count(*) FROM auth_sessions')).rows[0].count), 0);
  } finally { await blocker.query('ROLLBACK'); blocker.release(); }
});

test('verification resend limits are shared across sessions and API instances before queueing more mail', async (t) => {
  const f = await fixture(t);
  const member = await f.signup();
  const second = await f.auth.login({ email: member.user.email, password: PASSWORD }, 'second-verification-session');
  const peer = f.peer();
  const attempts = await Promise.allSettled(Array.from({ length: 8 }, (_, index) =>
    (index % 2 ? f.auth : peer.auth).requestEmailVerification(index % 2 ? member.token : second.token, member.user.id, `verification-ip-${index}`)));
  assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 3);
  const failures = attempts.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  assert.equal(failures.length, 5);
  assert.ok(failures.every((result) => result.reason instanceof LedgerError && result.reason.code === 'RATE_LIMITED'));
  assert.equal(f.mail.length, 3);
  assert.equal(Number((await f.database.query('SELECT count(*) FROM auth_email_verification WHERE user_id=$1', [member.user.id])).rows[0].count), 1);
  assert.equal(Number((await f.database.query('SELECT count(*) FROM test_auth_mail_queue')).rows[0].count), 3);
  f.advance(15 * MINUTE);
  await peer.auth.requestEmailVerification(member.token, member.user.id, 'verification-after-window');
  assert.equal(f.mail.length, 4);
});
