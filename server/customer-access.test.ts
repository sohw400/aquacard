import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import type { CustomerAccessStatus } from '../shared/api';
import { CardInboxStore } from './card-inbox';
import { CardPaymentStore } from './card-payments';
import { CustomerAccessStore } from './customer-access';
import { Database } from './database';
import { IssuerOutboxStore } from './issuer-outbox';
import { LedgerError, LedgerStore } from './ledger';
import { grantApplicationRole, verifyApplicationRole } from './permissions';
import { reconcileRewards } from './reward-reconciliation';
import { createTestDatabase } from './test-support';

const NOW = Date.UTC(2026, 10, 19, 6);
const rejectCode = (action: Promise<unknown>, code: string) => assert.rejects(action,
  (error: unknown) => error instanceof LedgerError && error.code === code);

async function fixture(t: TestContext) {
  const base = await createTestDatabase();
  const peers: Database[] = [];
  t.after(async () => { try { await Promise.all(peers.map((peer) => peer.close())); } finally { await base.cleanup(); } });
  const stores = (database: Database) => ({ database, access: new CustomerAccessStore(database, { now: () => NOW }),
    ledger: new LedgerStore(database, { now: () => NOW }), cards: new CardPaymentStore(database, { now: () => NOW }),
    issuer: new IssuerOutboxStore(database, { now: () => NOW }), inbox: new CardInboxStore(database, { now: () => NOW }) });
  const main = stores(base.database);
  for (const id of ['alice', 'bobby']) {
    await main.ledger.createUser({ id, email: `${id}@example.test`, name: '고객 상태 테스트', tag: id,
      passwordHash: 'test-only-hash', createdAt: NOW - 86_400_000 });
    await main.ledger.creditSandbox({ userId: id, amountWon: 30_000, idempotencyKey: `fund-${id}` });
    await main.issuer.register({ userId: id, providerCardId: `sandbox-card-${id}`, initialStatus: 'active' });
  }
  let key = 0;
  return { ...base, ...main, peer() {
    const database = new Database({ connectionString: base.connectionString, schema: base.schema, maxConnections: 1 });
    peers.push(database); return stores(database);
  }, async change(userId: string, status: CustomerAccessStatus) {
    const current = await main.access.snapshot(userId);
    return main.access.transition({ userId, status, expectedVersion: current.version,
      idempotencyKey: `case-${++key}`, reason: 'Sandbox eligibility decision for this test only.' });
  } };
}
const event = (key: string) => ({ kind: 'authorize' as const, eventId: `auth-${key}`, paymentId: `payment-${key}`,
  userId: 'alice', amountWon: 10_000, merchantName: '서울 서점' });
const transfer = (key: string) => ({ senderId: 'alice', recipientTag: 'bobby', amountWon: 1_000, idempotencyKey: key });

async function waitForLock(database: Database, pid: number) {
  const deadline = performance.now() + 3_000;
  while (performance.now() < deadline) {
    const result = await database.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid]);
    if (result.rows[0]?.wait_event_type === 'Lock') return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('the competing transaction did not wait on the customer policy lock');
}

test('new members default to audited unverified status and both transfer participants must be active', async (t) => {
  const f = await fixture(t);
  const initial = await f.ledger.snapshot('alice');
  assert.deepEqual(initial.access, { status: 'unverified', version: 1, updatedAt: NOW - 86_400_000, canTransact: false });
  await rejectCode(f.ledger.transfer(transfer('blocked-sender')), 'CUSTOMER_ACCESS_REQUIRED');
  await f.change('alice', 'active');
  await rejectCode(f.ledger.transfer(transfer('blocked-recipient')), 'CUSTOMER_ACCESS_REQUIRED');
  await f.change('bobby', 'active');
  assert.equal((await f.ledger.transfer(transfer('allowed'))).balanceWon, 29_000);
  const audit = (await f.database.query('SELECT version,status,source FROM customer_access_events WHERE user_id=$1 ORDER BY version', ['alice'])).rows;
  assert.deepEqual(audit, [{ version: '1', status: 'unverified', source: 'initial' }, { version: '2', status: 'active', source: 'sandbox_operator' }]);
});

test('customer policy changes are versioned, idempotent, immutable and closed is terminal', async (t) => {
  const f = await fixture(t);
  const input = { userId: 'alice', status: 'pending_review' as const, expectedVersion: 1,
    idempotencyKey: 'review-case', reason: 'Review submitted by trusted sandbox fixture.' };
  const result = await f.access.transition(input);
  assert.deepEqual(await f.peer().access.transition(input), result);
  await rejectCode(f.access.transition({ ...input, reason: 'Different review reason must conflict.' }), 'IDEMPOTENCY_CONFLICT');
  await rejectCode(f.access.transition({ ...input, idempotencyKey: 'stale-case', status: 'active' }), 'CUSTOMER_ACCESS_VERSION_CHANGED');
  await f.change('alice', 'closed');
  await rejectCode(f.change('alice', 'active'), 'CUSTOMER_ACCESS_TRANSITION_INVALID');
  assert.deepEqual(await f.access.transition(input), result, 'replay is historical even after a terminal restriction');
  await assert.rejects(f.database.query("UPDATE customer_access SET status='active' WHERE user_id='alice'"), /audited transition/);
  await assert.rejects(f.database.query("UPDATE customer_access_events SET reason='A fabricated reason for history.'"), /immutable/);
  await assert.rejects(f.database.query('DELETE FROM customer_access_events'), /immutable/);
  await assert.rejects(f.database.query('TRUNCATE customer_access CASCADE'), /immutable/);
});

test('failed customer audit write rolls back its status and version atomically', async (t) => {
  const f = await fixture(t);
  await f.database.query(`CREATE FUNCTION test_break_customer_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.version>1 THEN RAISE EXCEPTION 'test audit failure'; END IF; RETURN NEW; END; $$`);
  await f.database.query('CREATE TRIGGER z_test_customer_audit BEFORE INSERT ON customer_access_events FOR EACH ROW EXECUTE FUNCTION test_break_customer_audit()');
  await assert.rejects(f.change('alice', 'active'), /test audit failure/);
  assert.equal((await f.access.snapshot('alice')).version, 1);
  assert.equal((await f.database.query("SELECT count(*)::int AS n FROM customer_access_events WHERE user_id='alice'")).rows[0].n, 1);
});

test('completed transfers replay after restriction without another debit while new requests fail', async (t) => {
  const f = await fixture(t);
  await f.change('alice', 'active'); await f.change('bobby', 'active');
  const result = await f.ledger.transfer(transfer('original-transfer'));
  await f.change('alice', 'frozen'); await f.change('bobby', 'restricted');
  assert.deepEqual(await f.peer().ledger.transfer(transfer('original-transfer')), result);
  await rejectCode(f.ledger.transfer(transfer('new-transfer')), 'CUSTOMER_ACCESS_REQUIRED');
  await rejectCode(f.ledger.transfer({ ...transfer('original-transfer'), amountWon: 2_000 }), 'IDEMPOTENCY_CONFLICT');
  assert.equal((await f.ledger.snapshot('alice')).balanceWon, 29_000);
});

test('unverified card approvals become durable denials and cannot turn into purchases after activation', async (t) => {
  const f = await fixture(t); const denied = event('unverified');
  await rejectCode(f.cards.apply(denied), 'CUSTOMER_ACCESS_REQUIRED');
  const decision = (await f.database.query('SELECT * FROM card_authorization_decisions WHERE event_id=$1', [denied.eventId])).rows[0];
  assert.equal(decision.policy_version, 2); assert.equal(decision.customer_status, 'unverified');
  assert.equal(decision.customer_version, '1'); assert.equal(decision.reason, 'CUSTOMER_ACCESS_REQUIRED');
  assert.equal((await f.ledger.snapshot('alice')).heldBalanceWon, 0);
  await f.change('alice', 'active');
  await rejectCode(f.peer().cards.apply(denied), 'CUSTOMER_ACCESS_REQUIRED');
  assert.equal((await f.cards.apply(event('active'))).heldBalanceWon, 10_000);
});

test('policy-denied inbox attempts are terminal, audited and cannot be reprocessed after activation', async (t) => {
  const f = await fixture(t);
  const receipt = await f.inbox.enqueue(event('inbox'));
  const result = await f.inbox.processNext(); assert.ok(result);
  assert.equal(result.status, 'dead_letter'); assert.equal(result.errorCode, 'CUSTOMER_ACCESS_REQUIRED');
  await f.change('alice', 'active');
  assert.equal(await f.inbox.processNext(), null);
  await assert.rejects(f.inbox.requeue({ id: receipt.id, expectedVersion: result.version, idempotencyKey: 'requeue-denial', reason: 'Trying to retry a final policy denial.' }));
  assert.equal((await f.ledger.snapshot('alice')).heldBalanceWon, 0);
});

test('freezing blocks new approvals while accepted settlement, refunds and safety locks remain available', async (t) => {
  const f = await fixture(t);
  await f.change('alice', 'active');
  const original = event('accepted'); const approval = await f.cards.apply(original);
  await f.change('alice', 'frozen');
  await rejectCode(f.cards.apply(event('after-freeze')), 'CUSTOMER_ACCESS_REQUIRED');
  assert.deepEqual(await f.cards.apply(original), approval);
  await f.cards.apply({ kind: 'capture', eventId: 'capture-frozen', paymentId: original.paymentId, userId: 'alice', amountWon: 4_000, finalCapture: false });
  await f.cards.apply({ kind: 'reverse', eventId: 'reverse-frozen', paymentId: original.paymentId, userId: 'alice' });
  await f.cards.apply({ kind: 'refund', eventId: 'refund-frozen', paymentId: original.paymentId, userId: 'alice', amountWon: 1_000 });
  const card = (await f.issuer.snapshot('alice')).card!;
  await f.issuer.requestStatus({ userId: 'alice', cardId: card.id, targetStatus: 'locked', expectedVersion: card.version, idempotencyKey: 'safety-lock' });
  const claim = (await f.issuer.claim())!;
  await f.issuer.finish({ id: claim.id, leaseToken: claim.leaseToken, expectedVersion: claim.version, outcome: { kind: 'succeeded' } });
  const locked = (await f.issuer.snapshot('alice')).card!;
  await rejectCode(f.issuer.requestStatus({ userId: 'alice', cardId: card.id, targetStatus: 'active', expectedVersion: locked.version, idempotencyKey: 'unsafe-unlock' }), 'CUSTOMER_ACCESS_REQUIRED');
  const report = await reconcileRewards(f.database); assert.equal(report.ok, true, JSON.stringify(report.findings));
});

test('a freeze committed before an authorization makes the waiting approval decline', async (t) => {
  const f = await fixture(t); await f.change('alice', 'active');
  const peer = f.peer(); const [{ pid }] = (await peer.database.query('SELECT pg_backend_pid() AS pid')).rows;
  const client = await f.database.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT operator_set_customer_access($1::jsonb,$2::bigint)', [JSON.stringify({ userId: 'alice', status: 'frozen', expectedVersion: 2, idempotencyKey: 'freeze-first', reason: 'Freeze before competing card authorization.' }), NOW]);
    const rejected = rejectCode(peer.cards.apply(event('freeze-race')), 'CUSTOMER_ACCESS_REQUIRED');
    await waitForLock(f.database, pid);
    await client.query('COMMIT'); await rejected;
  } finally { await client.query('ROLLBACK'); client.release(); }
  assert.equal((await f.ledger.snapshot('alice')).heldBalanceWon, 0);
});

test('an accepted approval holds the access policy until commit and a waiting freeze affects only later requests', async (t) => {
  const f = await fixture(t); await f.change('alice', 'active');
  const peer = f.peer(); const [{ pid }] = (await peer.database.query('SELECT pg_backend_pid() AS pid')).rows;
  const client = await f.database.pool.connect(); const accepted = event('approve-race');
  try {
    await client.query('BEGIN');
    await client.query('SELECT apply_sandbox_card_event($1::jsonb,$2::bigint)', [JSON.stringify(accepted), NOW]);
    const freeze = peer.access.transition({ userId: 'alice', status: 'frozen', expectedVersion: 2, idempotencyKey: 'freeze-after', reason: 'Freeze after an accepted authorization.' });
    await waitForLock(f.database, pid);
    await client.query('COMMIT'); await freeze;
  } finally { await client.query('ROLLBACK'); client.release(); }
  assert.equal((await f.cards.apply(accepted)).heldBalanceWon, 10_000);
  await rejectCode(f.cards.apply(event('after-race')), 'CUSTOMER_ACCESS_REQUIRED');
});

test('the runtime can read and enforce policy but cannot approve, forge or grant itself trusted access', async (t) => {
  const f = await fixture(t);
  const role = `customer_runtime_${randomBytes(8).toString('hex')}`; const password = randomBytes(24).toString('hex');
  let runtime: Database | undefined;
  try {
    await f.database.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    await grantApplicationRole(f.database, role);
    const url = new URL(f.connectionString); url.username = role; url.password = password;
    runtime = new Database({ connectionString: url.toString(), schema: f.schema });
    await verifyApplicationRole(runtime);
    assert.equal((await new CustomerAccessStore(runtime).snapshot('alice')).status, 'unverified');
    for (const sql of ["UPDATE customer_access SET status='active'", "DELETE FROM customer_access_events", "TRUNCATE customer_access",
      "SELECT operator_set_customer_access('{}'::jsonb,1000::bigint)", "SELECT customer_initialize_access('alice',1000::bigint)"]) {
      await assert.rejects(runtime.query(sql), /permission denied/);
    }
    await f.database.query(`GRANT EXECUTE ON FUNCTION operator_set_customer_access(jsonb,bigint) TO "${role}"`);
    await assert.rejects(verifyApplicationRole(runtime), /private ledger helper/);
  } finally {
    await runtime?.close();
    await f.database.query(`DROP OWNED BY "${role}"`);
    await f.database.query(`DROP ROLE "${role}"`);
  }
});


test('raw member postings and private card financial helpers cannot bypass customer restrictions', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.database.query('SELECT apply_sandbox_card_event_financial_004($1::jsonb,$2::bigint)',
    [JSON.stringify(event('private-helper')), NOW]), /CUSTOMER_ACCESS_REQUIRED/);
  await assert.rejects(f.database.query(`INSERT INTO journals(id,kind,from_account_id,to_account_id,amount_won,sender_id,recipient_id,
    sender_name,sender_tag,recipient_name,recipient_tag,request_owner_id,idempotency_key,request_payload,balance_after_won,created_at)
    VALUES('raw-transfer','member_transfer','user:alice','user:bobby',1000,'alice','bobby','고객','alice','고객','bobby','alice','raw-transfer','raw',29000,$1)`, [NOW]), /CUSTOMER_ACCESS_REQUIRED/);
  assert.equal((await f.ledger.snapshot('alice')).balanceWon, 30_000);
  assert.equal((await f.database.query('SELECT count(*)::int AS n FROM card_payment_events')).rows[0].n, 0);
});

test('a recipient restriction committed before a transfer prevents both ledger legs', async (t) => {
  const f = await fixture(t); await f.change('alice', 'active'); await f.change('bobby', 'active');
  const peer = f.peer(); const [{ pid }] = (await peer.database.query('SELECT pg_backend_pid() AS pid')).rows;
  const client = await f.database.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT operator_set_customer_access($1::jsonb,$2::bigint)', [JSON.stringify({ userId: 'bobby', status: 'restricted', expectedVersion: 2, idempotencyKey: 'restrict-recipient-first', reason: 'Restrict recipient before an incoming transfer.' }), NOW]);
    const rejected = rejectCode(peer.ledger.transfer(transfer('recipient-freeze-race')), 'CUSTOMER_ACCESS_REQUIRED');
    await waitForLock(f.database, pid);
    await client.query('COMMIT'); await rejected;
  } finally { await client.query('ROLLBACK'); client.release(); }
  assert.equal((await f.ledger.snapshot('alice')).balanceWon, 30_000);
  assert.equal((await f.ledger.snapshot('bobby')).balanceWon, 30_000);
});
