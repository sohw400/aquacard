import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { CardInboxStore } from './card-inbox';
import { CardOperationsStore } from './card-operations';
import { CardPaymentStore } from './card-payments';
import { CustomerAccessStore } from './customer-access';
import { Database } from './database';
import { IssuerOutboxStore } from './issuer-outbox';
import { LedgerError, LedgerStore } from './ledger';
import { grantApplicationRole, verifyApplicationRole } from './permissions';
import { reconcileRewards } from './reward-reconciliation';
import { createTestDatabase } from './test-support';

const NOW = Date.UTC(2026, 10, 26, 6);
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const rejectCode = (action: Promise<unknown>, code: string) => assert.rejects(action,
  (error: unknown) => error instanceof LedgerError && error.code === code);
const event = (key: string) => ({ kind: 'authorize' as const, eventId: `email-auth-${key}`, paymentId: `email-payment-${key}`,
  userId: 'alice', amountWon: 10_000, merchantName: '서울 서점' });
const transfer = (key: string) => ({ senderId: 'alice', recipientTag: 'bobby', amountWon: 1_000, idempotencyKey: key });

async function fixture(t: TestContext) {
  const base = await createTestDatabase();
  const peers: Database[] = [];
  t.after(async () => { try { await Promise.all(peers.map((peer) => peer.close())); } finally { await base.cleanup(); } });
  const ledger = new LedgerStore(base.database, { now: () => NOW });
  const access = new CustomerAccessStore(base.database, { now: () => NOW });
  const cards = new CardPaymentStore(base.database, { now: () => NOW });
  const issuer = new IssuerOutboxStore(base.database, { now: () => NOW });
  const inbox = new CardInboxStore(base.database, { now: () => NOW });
  for (const id of ['alice', 'bobby']) {
    await ledger.createUser({ id, email: `${id}@example.test`, name: '이메일 정책 테스트', tag: id,
      passwordHash: 'test-only-hash', createdAt: NOW - 86_400_000 });
    await ledger.creditSandbox({ userId: id, amountWon: 30_000, idempotencyKey: `fund-${id}` });
    await issuer.register({ userId: id, providerCardId: `sandbox-card-${id}`, initialStatus: 'active' });
  }
  async function issue(userId: string, options: { email?: string; createdAt?: number; expiresAt?: number } = {}) {
    const token = randomBytes(32).toString('hex');
    await base.database.query('INSERT INTO auth_email_verification(token_hash,user_id,email,created_at,expires_at) VALUES($1,$2,$3,$4,$5)',
      [hash(token), userId, options.email ?? `${userId}@example.test`, options.createdAt ?? NOW, options.expiresAt ?? NOW + 900_000]);
    return token;
  }
  async function confirm(userId: string, token: string, now = NOW) {
    const result = await base.database.query('SELECT confirm_auth_email_verification($1::text,$2::text,$3::bigint) AS verified', [userId, token, now]);
    return Number(result.rows[0].verified);
  }
  let key = 0;
  return { ...base, ledger, access, cards, issuer, inbox, issue, confirm,
    async verify(userId: string) { return confirm(userId, await issue(userId)); },
    async activate(userId: string) {
      return access.transition({ userId, status: 'active', expectedVersion: 1, idempotencyKey: `activate-${++key}`, reason: 'Sandbox policy approval independent of email ownership.' });
    }, peer() {
      const database = new Database({ connectionString: base.connectionString, schema: base.schema, maxConnections: 1 });
      peers.push(database); return database;
    },
  };
}

async function waitForLock(database: Database, pid: number) {
  const deadline = performance.now() + 3_000;
  while (performance.now() < deadline) {
    if ((await database.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0]?.wait_event_type === 'Lock') return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('the competing transaction did not wait on the email/customer lock');
}

test('email confirmation is owner-bound, address-bound, single-purpose and retryable without approving customer review', async (t) => {
  const f = await fixture(t);
  const token = await f.issue('alice');
  await assert.rejects(f.confirm('bobby', token), /INVALID_EMAIL_VERIFICATION/);
  await assert.rejects(f.confirm('alice', await f.issue('alice', { email: 'different@example.test' })), /INVALID_EMAIL_VERIFICATION/);
  const recovery = randomBytes(32).toString('hex');
  await f.database.query('INSERT INTO auth_recovery(token_hash,user_id,created_at,expires_at) VALUES($1,$2,$3,$4)', [hash(recovery), 'alice', NOW, NOW + 900_000]);
  await assert.rejects(f.confirm('alice', recovery), /INVALID_EMAIL_VERIFICATION/);
  assert.equal(await f.confirm('alice', token), NOW);
  assert.equal(await f.confirm('alice', token, NOW + 900_001), NOW, 'a committed result survives expiry on the same retained token');
  assert.equal((await f.ledger.snapshot('alice')).user.emailVerifiedAt, NOW);
  assert.equal((await f.access.snapshot('alice')).status, 'unverified');
  assert.equal((await f.access.snapshot('alice')).canTransact, false);
  assert.equal((await f.database.query('SELECT used_at FROM auth_email_verification WHERE token_hash=$1', [hash(token)])).rows[0].used_at, String(NOW));
  await assert.rejects(f.confirm('alice', randomBytes(32).toString('hex')), /INVALID_EMAIL_VERIFICATION/);
});

test('unused expired and future-issued email challenges cannot create proof, and address proof cannot be replaced', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.confirm('alice', await f.issue('alice', { createdAt: NOW - 1_000, expiresAt: NOW })), /INVALID_EMAIL_VERIFICATION/);
  await assert.rejects(f.confirm('alice', await f.issue('alice', { createdAt: NOW + 1, expiresAt: NOW + 1_000 })), /INVALID_EMAIL_VERIFICATION/);
  assert.equal((await f.ledger.snapshot('alice')).user.emailVerifiedAt, null);
  await f.verify('alice');
  await assert.rejects(f.database.query("UPDATE users SET email='changed@example.test' WHERE id='alice'"), /immutable/);
  await assert.rejects(f.database.query("UPDATE users SET email_verified_at=NULL WHERE id='alice'"), /immutable/);
  await assert.rejects(f.database.query('UPDATE users SET email_verified_at=$1 WHERE id=$2', [NOW + 1, 'alice']), /immutable/);
  await assert.rejects(f.database.query(`INSERT INTO users(id,email,name,tag,password_hash,created_at,email_verified_at)
    VALUES('forged','forged@example.test','테스트','forged','test-only',1,2)`), /verified separately/);
});

test('both transfer participants need email ownership in addition to independent customer approval', async (t) => {
  const f = await fixture(t);
  const activation = await f.activate('alice'); await f.activate('bobby');
  assert.equal(activation.canTransact, false);
  await rejectCode(f.ledger.transfer(transfer('no-email')), 'EMAIL_VERIFICATION_REQUIRED');
  await f.verify('alice');
  await rejectCode(f.ledger.transfer(transfer('recipient-no-email')), 'EMAIL_VERIFICATION_REQUIRED');
  await f.verify('bobby');
  assert.equal((await f.access.snapshot('alice')).canTransact, true);
  const history = (await f.database.query("SELECT result FROM customer_access_events WHERE user_id='alice' AND version=2")).rows[0].result;
  assert.deepEqual(history, activation, 'verification does not rewrite the prior customer approval result');
  assert.equal((await f.ledger.transfer(transfer('verified-transfer'))).balanceWon, 29_000);
  const replay = await f.ledger.transfer(transfer('verified-transfer'));
  await f.access.transition({ userId: 'alice', status: 'frozen', expectedVersion: 2, idempotencyKey: 'freeze-after-email', reason: 'Freeze verified customer after successful transfer.' });
  assert.deepEqual(await f.ledger.transfer(transfer('verified-transfer')), replay);
  await rejectCode(f.ledger.transfer(transfer('frozen-verified')), 'CUSTOMER_ACCESS_REQUIRED');
});

test('unverified email causes an immutable version-three card denial and an operator report retains that decision proof', async (t) => {
  const f = await fixture(t); await f.activate('alice');
  const denied = event('denied');
  await rejectCode(f.cards.apply(denied), 'EMAIL_VERIFICATION_REQUIRED');
  const before = (await f.database.query('SELECT * FROM card_authorization_decisions WHERE event_id=$1', [denied.eventId])).rows[0];
  assert.equal(before.policy_version, 3); assert.equal(before.email_verified_at, null);
  assert.equal(before.customer_status, 'active'); assert.equal(before.reason, 'EMAIL_VERIFICATION_REQUIRED');
  await f.verify('alice');
  await rejectCode(f.cards.apply(denied), 'EMAIL_VERIFICATION_REQUIRED');
  assert.deepEqual((await f.database.query('SELECT * FROM card_authorization_decisions WHERE event_id=$1', [denied.eventId])).rows[0], before);
  const accepted = event('accepted');
  assert.equal((await f.cards.apply(accepted)).heldBalanceWon, 10_000);
  const operations = new CardOperationsStore(f.database);
  const old = await operations.trace({ requestId: randomUUID(), lookup: { kind: 'event', id: denied.eventId }, caseReference: 'email-denial-test' });
  const current = await operations.trace({ requestId: randomUUID(), lookup: { kind: 'event', id: accepted.eventId }, caseReference: 'email-approval-test' });
  assert.equal(old.authorization?.customerAtDecision?.emailVerifiedAt, null);
  assert.equal(current.authorization?.customerAtDecision?.emailVerifiedAt, NOW);
});

test('email-policy inbox denials stay terminal and cannot be retried into approvals', async (t) => {
  const f = await fixture(t); await f.activate('alice');
  const received = await f.inbox.enqueue(event('inbox'));
  const denied = await f.inbox.processNext(); assert.ok(denied);
  assert.equal(denied.status, 'dead_letter'); assert.equal(denied.errorCode, 'EMAIL_VERIFICATION_REQUIRED');
  await f.verify('alice');
  await assert.rejects(f.inbox.requeue({ id: received.id, expectedVersion: denied.version, idempotencyKey: 'retry-email-denial', reason: 'A final email-policy denial must not be requeued.' }));
  assert.equal(await f.inbox.processNext(), null);
  assert.equal((await f.ledger.snapshot('alice')).heldBalanceWon, 0);
});

test('email ownership blocks unlocks but safety locks and valid raw posting checks remain available', async (t) => {
  const f = await fixture(t); await f.activate('alice'); await f.activate('bobby');
  const card = (await f.issuer.snapshot('alice')).card!;
  await f.issuer.requestStatus({ userId: 'alice', cardId: card.id, targetStatus: 'locked', expectedVersion: card.version, idempotencyKey: 'email-safety-lock' });
  const claim = (await f.issuer.claim())!;
  await f.issuer.finish({ id: claim.id, leaseToken: claim.leaseToken, expectedVersion: claim.version, outcome: { kind: 'succeeded' } });
  const locked = (await f.issuer.snapshot('alice')).card!;
  await rejectCode(f.issuer.requestStatus({ userId: 'alice', cardId: card.id, targetStatus: 'active', expectedVersion: locked.version, idempotencyKey: 'email-unlock-denied' }), 'EMAIL_VERIFICATION_REQUIRED');
  await assert.rejects(f.database.query('SELECT apply_sandbox_card_event_financial_004($1::jsonb,$2::bigint)', [JSON.stringify(event('raw')), NOW]), /EMAIL_VERIFICATION_REQUIRED/);
  await assert.rejects(f.database.query(`INSERT INTO journals(id,kind,from_account_id,to_account_id,amount_won,sender_id,recipient_id,
    sender_name,sender_tag,recipient_name,recipient_tag,request_owner_id,idempotency_key,request_payload,balance_after_won,created_at)
    VALUES('raw-email','member_transfer','user:alice','user:bobby',1000,'alice','bobby','고객','alice','고객','bobby','alice','raw-email','raw',29000,$1)`, [NOW]), /EMAIL_VERIFICATION_REQUIRED/);
  assert.equal((await f.ledger.snapshot('alice')).balanceWon, 30_000);
});

test('a committed email verification is visible to an authorization waiting on the same member', async (t) => {
  const f = await fixture(t); await f.activate('alice');
  const token = await f.issue('alice');
  const peer = f.peer(); const [{ pid }] = (await peer.query('SELECT pg_backend_pid() AS pid')).rows;
  const client = await f.database.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT confirm_auth_email_verification($1::text,$2::text,$3::bigint)', ['alice', token, NOW]);
    const accepted = new CardPaymentStore(peer, { now: () => NOW }).apply(event('wait-for-verification'));
    await waitForLock(f.database, pid);
    await client.query('COMMIT');
    assert.equal((await accepted).heldBalanceWon, 10_000);
  } finally { await client.query('ROLLBACK'); client.release(); }
  const report = await reconcileRewards(f.database); assert.equal(report.ok, true, JSON.stringify(report.findings));
});

test('customer review and email confirmation in one owner transaction preserve their historical audit result', async (t) => {
  const f = await fixture(t); const token = await f.issue('alice');
  await f.database.transaction(async (client) => {
    const result = await client.query('SELECT operator_set_customer_access($1::jsonb,$2::bigint) AS result', [JSON.stringify({
      userId: 'alice', status: 'active', expectedVersion: 1, idempotencyKey: 'approval-before-proof', reason: 'Independent customer approval before email confirmation.' }), NOW]);
    assert.equal(result.rows[0].result.canTransact, false);
    await client.query('SELECT confirm_auth_email_verification($1::text,$2::text,$3::bigint)', ['alice', token, NOW]);
  });
  assert.equal((await f.access.snapshot('alice')).canTransact, true);
  assert.equal((await f.database.query("SELECT result->'canTransact' AS value FROM customer_access_events WHERE user_id='alice' AND version=2")).rows[0].value, false);
});

test('a failed challenge consumption rolls back the verified marker and remains retryable', async (t) => {
  const f = await fixture(t); const token = await f.issue('alice');
  await f.database.query(`CREATE FUNCTION test_fail_email_consumption() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'test email consumption failure'; END; $$`);
  await f.database.query('CREATE TRIGGER test_fail_email_consumption BEFORE UPDATE ON auth_email_verification FOR EACH ROW EXECUTE FUNCTION test_fail_email_consumption()');
  await assert.rejects(f.confirm('alice', token), /test email consumption failure/);
  assert.equal((await f.ledger.snapshot('alice')).user.emailVerifiedAt, null);
  assert.equal((await f.database.query('SELECT used_at FROM auth_email_verification WHERE token_hash=$1', [hash(token)])).rows[0].used_at, null);
  await f.database.query('DROP TRIGGER test_fail_email_consumption ON auth_email_verification');
  assert.equal(await f.confirm('alice', token), NOW);
});

test('email proof arriving after a pending freeze does not reactivate customer access', async (t) => {
  const f = await fixture(t); await f.activate('alice'); const token = await f.issue('alice');
  const peer = f.peer(); const [{ pid }] = (await peer.query('SELECT pg_backend_pid() AS pid')).rows;
  const client = await f.database.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT operator_set_customer_access($1::jsonb,$2::bigint)', [JSON.stringify({
      userId: 'alice', status: 'frozen', expectedVersion: 2, idempotencyKey: 'freeze-before-proof', reason: 'Customer freeze is independent of email ownership.' }), NOW]);
    const confirmation = peer.query('SELECT confirm_auth_email_verification($1::text,$2::text,$3::bigint) AS verified', ['alice', token, NOW]);
    await waitForLock(f.database, pid);
    await client.query('COMMIT');
    assert.equal(Number((await confirmation).rows[0].verified), NOW);
  } finally { await client.query('ROLLBACK'); client.release(); }
  const access = await f.access.snapshot('alice');
  assert.equal(access.status, 'frozen'); assert.equal(access.canTransact, false);
  await rejectCode(f.cards.apply(event('frozen-proof')), 'CUSTOMER_ACCESS_REQUIRED');
});

test('restricted runtime cleanup expires bounded unused challenges without consuming proof or blocking locked rows', async (t) => {
  const f = await fixture(t);
  const role = `email_cleanup_${randomBytes(8).toString('hex')}`;
  const password = randomBytes(24).toString('hex');
  let runtime: Database | undefined;
  try {
    await f.database.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    await grantApplicationRole(f.database, role);
    const url = new URL(f.connectionString); url.username = role; url.password = password;
    runtime = new Database({ connectionString: url.toString(), schema: f.schema });
    await verifyApplicationRole(runtime);
    await assert.rejects(runtime.query('UPDATE auth_email_verification SET used_at=created_at'), /permission denied/);
    await f.database.query(`INSERT INTO auth_email_verification(token_hash,user_id,email,created_at,expires_at)
      SELECT encode(sha256(convert_to('cleanup-'||n::text,'UTF8')),'hex'),'alice','alice@example.test',$1,$2
      FROM generate_series(1,501) AS n`, [NOW - 1_000, NOW - 1]);
    const future = await f.issue('alice');
    const consumed = await f.issue('alice', { createdAt: NOW - 1_000, expiresAt: NOW + 1 });
    await f.confirm('alice', consumed);
    const cleanup = async (now = NOW + 2) => Number((await runtime!.query('SELECT cleanup_auth_email_verification($1::bigint) AS removed', [now])).rows[0].removed);
    await assert.rejects(cleanup(-1), /INVALID_CLOCK/);
    assert.equal(await cleanup(), 256);
    assert.equal(await cleanup(), 245);
    assert.equal(await cleanup(), 0);
    assert.equal((await f.database.query('SELECT count(*)::int AS n FROM auth_email_verification WHERE token_hash IN ($1,$2)', [hash(future), hash(consumed)])).rows[0].n, 2);
    const locked = await f.issue('alice', { createdAt: NOW - 1_000, expiresAt: NOW - 1 });
    const client = await f.database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT token_hash FROM auth_email_verification WHERE token_hash=$1 FOR UPDATE', [hash(locked)]);
      assert.equal(await cleanup(), 0);
      await client.query('COMMIT');
    } finally { await client.query('ROLLBACK'); client.release(); }
    assert.equal(await cleanup(), 1);
    await assert.rejects(runtime.query('UPDATE users SET email_verified_at=NULL WHERE id=$1', ['alice']), /permission denied/);
  } finally {
    await runtime?.close();
    await f.database.query(`DROP OWNED BY "${role}"`);
    await f.database.query(`DROP ROLE "${role}"`);
  }
});
