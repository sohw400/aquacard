import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { CardEventResult, SandboxCardEvent } from '../shared/api';
import { CardInboxStore } from './card-inbox';
import { CardPaymentStore } from './card-payments';
import { Database } from './database';
import { IssuerOutboxStore, type IssuerOutboxOutcome } from './issuer-outbox';
import { LedgerError, LedgerStore } from './ledger';
import { reconcileRewards } from './reward-reconciliation';
import { createTestDatabase } from './test-support';

const NOW = Date.UTC(2026, 10, 19, 5);
type Authorization = Extract<SandboxCardEvent, { kind: 'authorize' }>;

async function fixture(t: TestContext, registered = true) {
  const base = await createTestDatabase();
  const peers: Database[] = [];
  let now = NOW;
  let sequence = 0;
  const stores = (database: Database) => ({ database, cards: new CardPaymentStore(database, { now: () => now }),
    outbox: new IssuerOutboxStore(database, { now: () => now }), inbox: new CardInboxStore(database, { now: () => now }),
    ledger: new LedgerStore(database, { now: () => now }) });
  const main = stores(base.database);
  t.after(async () => { try { await Promise.all(peers.map((peer) => peer.close())); } finally { await base.cleanup(); } });
  for (const id of ['alice', 'bobby']) {
    await main.ledger.createUser({ id, email: `${id}@example.test`, name: '승인 정책 테스트', tag: id,
      passwordHash: 'test-only-hash', createdAt: NOW - 86_400_000 });
    await main.ledger.creditSandbox({ userId: id, amountWon: 50_000, idempotencyKey: `fund-${id}` });
    if (registered) await main.outbox.register({ userId: id, providerCardId: `sandbox-card-${id}`, initialStatus: 'active' });
  }
  return {
    ...main, now: () => now, advance(milliseconds: number) { now += milliseconds; },
    peer() {
      const database = new Database({ connectionString: base.connectionString, schema: base.schema, maxConnections: 1 });
      peers.push(database); return stores(database);
    },
    async statusInput(targetStatus: 'active' | 'locked', userId = 'alice') {
      const card = (await main.outbox.snapshot(userId)).card; assert.ok(card);
      return { userId, cardId: card.id, targetStatus, expectedVersion: card.version, idempotencyKey: `status-${++sequence}` };
    },
    async complete(outcome: IssuerOutboxOutcome = { kind: 'succeeded' }) {
      const claim = await main.outbox.claim(); assert.ok(claim);
      return main.outbox.finish({ id: claim.id, leaseToken: claim.leaseToken, expectedVersion: claim.version, outcome });
    },
  };
}

function authorization(id: string, changes: Partial<Authorization> = {}): Authorization {
  return { kind: 'authorize', eventId: `auth-${id}`, paymentId: `payment-${id}`, userId: 'alice',
    amountWon: 10_000, merchantName: '서울 서점', ...changes };
}
function rejectCode(action: Promise<unknown>, code: string) {
  return assert.rejects(action, (error: unknown) => error instanceof LedgerError && error.code === code);
}
async function money(database: Database) {
  const tables = ['ledger_accounts', 'journals', 'card_payments', 'card_payment_events', 'reward_wallets', 'reward_journals', 'card_reward_allocations'];
  return Object.fromEntries(await Promise.all(tables.map(async (table) => [table,
    (await database.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows] as const)));
}
async function waitForLock(database: Database, pid: number) {
  const until = performance.now() + 2_500;
  while (performance.now() < until) {
    const { rows } = await database.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid]);
    if (rows[0]?.wait_event_type === 'Lock') return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('the competing transaction must wait on the retained authorization/card lock');
}

test('an unmapped member receives a durable policy denial which registration cannot turn into a payment', async (t) => {
  const f = await fixture(t, false); const event = authorization('unmapped'); const before = await money(f.database);
  await rejectCode(f.cards.apply(event), 'CARD_NOT_ISSUED');
  assert.deepEqual(await money(f.database), before);
  const decision = (await f.database.query('SELECT * FROM card_authorization_decisions WHERE event_id=$1', [event.eventId])).rows[0];
  assert.equal(decision.decision, 'declined'); assert.equal(decision.reason, 'CARD_NOT_ISSUED');
  assert.equal(decision.card_id, null); assert.deepEqual(decision.canonical_input, event);
  assert.deepEqual(decision.result, { declined: true, code: 'CARD_NOT_ISSUED' });
  await f.outbox.register({ userId: 'alice', providerCardId: 'sandbox-card-alice', initialStatus: 'active' });
  await rejectCode(f.peer().cards.apply(event), 'CARD_NOT_ISSUED');
  assert.deepEqual((await f.database.query('SELECT * FROM card_authorization_decisions WHERE event_id=$1', [event.eventId])).rows[0], decision);
  assert.deepEqual(await money(f.database), before);
  await f.cards.apply(authorization('registered'));
  await rejectCode(f.cards.apply(authorization('unknown', { userId: 'missing' })), 'USER_NOT_FOUND');
  assert.equal((await f.database.query("SELECT COUNT(*)::int AS n FROM card_authorization_decisions WHERE user_id='missing'")).rows[0].n, 0);
});

test('approval binds its card state once and existing capture, reversal, refund and replay survive a later lock', async (t) => {
  const f = await fixture(t); const first = authorization('settle'); const second = authorization('reverse', { amountWon: 5_000 });
  const original = await f.cards.apply(first); await f.cards.apply(second);
  const decision = (await f.database.query('SELECT * FROM card_authorization_decisions WHERE event_id=$1', [first.eventId])).rows[0];
  const card = (await f.outbox.snapshot('alice')).card; assert.ok(card);
  assert.equal(decision.decision, 'approved'); assert.equal(decision.card_id, card.id);
  assert.equal(Number(decision.card_version), card.version); assert.equal(decision.desired_status, 'active');
  assert.equal(decision.confirmed_status, 'active'); assert.deepEqual(decision.result, original);
  assert.equal(Number(decision.event_received_at), NOW); assert.ok(Number.isSafeInteger(Number(decision.decided_at)));
  await f.outbox.requestStatus(await f.statusInput('locked'));
  await rejectCode(f.cards.apply(authorization('after-lock')), 'CARD_LOCKED');
  assert.deepEqual(await f.cards.apply({ ...first, merchantName: ` ${first.merchantName} ` }), original);
  await f.cards.apply({ kind: 'capture', eventId: 'capture-locked', paymentId: first.paymentId, userId: first.userId, amountWon: 6_000, finalCapture: true });
  await f.complete();
  await f.cards.apply({ kind: 'refund', eventId: 'refund-locked', paymentId: first.paymentId, userId: first.userId, amountWon: 2_000 });
  await f.cards.apply({ kind: 'reverse', eventId: 'reverse-locked', paymentId: second.paymentId, userId: second.userId });
  assert.equal((await f.ledger.snapshot('alice')).balanceWon, 46_000);
  assert.deepEqual(await f.cards.apply(first), original);
  assert.deepEqual((await f.database.query('SELECT * FROM card_authorization_decisions WHERE event_id=$1', [first.eventId])).rows[0], decision);
  const report = await reconcileRewards(f.database); assert.equal(report.ok, true, JSON.stringify(report.findings));
});

test('pending or rejected locks block immediately and an active request remains blocked until issuer confirmation', async (t) => {
  const f = await fixture(t);
  await f.outbox.requestStatus(await f.statusInput('locked'));
  assert.equal((await f.outbox.snapshot('alice')).card?.confirmedStatus, 'active');
  const denied = authorization('pending-lock');
  await rejectCode(f.cards.apply(denied), 'CARD_LOCKED');
  await f.complete({ kind: 'rejected', code: 'COMMAND_REJECTED' });
  await rejectCode(f.cards.apply(authorization('rejected-lock')), 'CARD_LOCKED');
  await f.outbox.requestStatus(await f.statusInput('active'));
  const unconfirmed = authorization('active-pending');
  await rejectCode(f.cards.apply(unconfirmed), 'CARD_STATUS_UNCONFIRMED');
  await f.complete({ kind: 'rejected', code: 'COMMAND_REJECTED' });
  await rejectCode(f.cards.apply(authorization('active-rejected')), 'CARD_STATUS_UNCONFIRMED');
  await f.outbox.requestStatus(await f.statusInput('active'));
  await f.complete();
  await f.cards.apply(authorization('active-confirmed'));
  await rejectCode(f.cards.apply(denied), 'CARD_LOCKED');
  await rejectCode(f.cards.apply(unconfirmed), 'CARD_STATUS_UNCONFIRMED');
});

test('unlocking a confirmed locked card cannot approve until the issuer result succeeds', async (t) => {
  const f = await fixture(t, false);
  await f.outbox.register({ userId: 'alice', providerCardId: 'sandbox-card-alice', initialStatus: 'locked' });
  await f.outbox.requestStatus(await f.statusInput('active'));
  await rejectCode(f.cards.apply(authorization('unlock-pending')), 'CARD_LOCKED');
  const claim = await f.outbox.claim(); assert.ok(claim);
  await rejectCode(f.cards.apply(authorization('unlock-in-flight')), 'CARD_LOCKED');
  const retry = await f.outbox.finish({ id: claim.id, leaseToken: claim.leaseToken, expectedVersion: claim.version,
    outcome: { kind: 'uncertain', code: 'PROVIDER_PENDING' } });
  await rejectCode(f.cards.apply(authorization('unlock-uncertain')), 'CARD_LOCKED');
  f.advance(retry.nextAttemptAt! - f.now());
  await f.complete();
  await f.cards.apply(authorization('unlocked'));
});

test('an active card with an uncertain or exhausted status request stays blocked through operator recovery', async (t) => {
  const f = await fixture(t);
  await f.outbox.requestStatus(await f.statusInput('active'));
  let review: Awaited<ReturnType<IssuerOutboxStore['finish']>> | undefined;
  for (let index = 0; index < 8; index++) {
    const claim = await f.outbox.claim(); assert.ok(claim);
    await rejectCode(f.cards.apply(authorization(`active-uncertain-${index}`)), 'CARD_STATUS_UNCONFIRMED');
    review = await f.outbox.finish({ id: claim.id, leaseToken: claim.leaseToken, expectedVersion: claim.version,
      outcome: { kind: 'uncertain', code: 'PROVIDER_PENDING' } });
    if (review.nextAttemptAt !== null) f.advance(review.nextAttemptAt - f.now());
  }
  assert.ok(review); assert.equal(review.status, 'needs_review');
  await rejectCode(f.cards.apply(authorization('active-needs-review')), 'CARD_STATUS_UNCONFIRMED');
  await f.outbox.requeue({ id: review.id, expectedVersion: review.version, idempotencyKey: 'review-lookup',
    reason: 'Confirm the original issuer operation before permitting new purchases.' });
  await rejectCode(f.cards.apply(authorization('active-reviewed-pending')), 'CARD_STATUS_UNCONFIRMED');
  await f.complete();
  await f.cards.apply(authorization('active-reviewed-confirmed'));
});

test('a declined event ID cannot be reused by another member, payload, or settlement kind', async (t) => {
  const f = await fixture(t); await f.outbox.requestStatus(await f.statusInput('locked'));
  const event = authorization('declined-key'); await rejectCode(f.cards.apply(event), 'CARD_LOCKED');
  const before = await money(f.database);
  for (const replacement of [
    { ...event, userId: 'bobby' }, { ...event, amountWon: 9_999 }, { ...event, paymentId: 'another-payment' },
    { kind: 'reverse' as const, eventId: event.eventId, paymentId: event.paymentId, userId: event.userId },
    { kind: 'capture' as const, eventId: event.eventId, paymentId: event.paymentId, userId: event.userId, amountWon: 1, finalCapture: true },
  ]) await rejectCode(f.cards.apply(replacement), 'IDEMPOTENCY_CONFLICT');
  assert.deepEqual(await money(f.database), before);
  assert.equal((await f.database.query('SELECT COUNT(*)::int AS n FROM card_authorization_decisions')).rows[0].n, 1);
});

test('inbox policy denial commits its decision and terminal attempt without permitting operator requeue or direct retry', async (t) => {
  const f = await fixture(t); const event = authorization('queued');
  const receipt = await f.inbox.enqueue(event);
  f.advance(60_000); await f.outbox.requestStatus(await f.statusInput('locked'));
  const before = await money(f.database);
  const processed = await f.inbox.processNext(); assert.ok(processed);
  assert.deepEqual([processed.id, processed.status, processed.errorCode, processed.attemptCount, processed.nextAttemptAt],
    [receipt.id, 'dead_letter', 'CARD_LOCKED', 1, null]);
  assert.deepEqual(await money(f.database), before);
  const decision = (await f.database.query('SELECT * FROM card_authorization_decisions WHERE event_id=$1', [event.eventId])).rows[0];
  assert.equal(Number(decision.event_received_at), receipt.receivedAt);
  assert.equal(decision.command_status, 'pending');
  assert.equal((await f.database.query('SELECT COUNT(*)::int AS n FROM card_inbox_attempts')).rows[0].n, 1);
  await rejectCode(f.inbox.requeue({ id: receipt.id, expectedVersion: processed.version, idempotencyKey: 'no-decline-requeue',
    reason: 'A lock denial must not become a late approval after unlock.' }), 'INBOX_NOT_RETRYABLE');
  await f.complete(); await f.outbox.requestStatus(await f.statusInput('active')); await f.complete();
  await rejectCode(f.cards.apply(event), 'CARD_LOCKED');
  assert.equal((await f.inbox.enqueue(event)).status, 'dead_letter');
  assert.equal(await f.inbox.processNext(), null);
  await f.cards.apply(authorization('after-queued-denial'));
});

test('a direct policy denial is preserved when the same event later arrives through the inbox', async (t) => {
  const f = await fixture(t, false); const event = authorization('direct-first');
  await rejectCode(f.cards.apply(event), 'CARD_NOT_ISSUED');
  await f.outbox.register({ userId: 'alice', providerCardId: 'sandbox-card-alice', initialStatus: 'active' });
  await f.inbox.enqueue(event);
  const result = await f.inbox.processNext(); assert.ok(result);
  assert.deepEqual([result.status, result.errorCode], ['dead_letter', 'CARD_NOT_ISSUED']);
  assert.equal((await f.database.query('SELECT COUNT(*)::int AS n FROM card_authorization_decisions')).rows[0].n, 1);
  assert.equal((await f.database.query('SELECT COUNT(*)::int AS n FROM card_payment_events')).rows[0].n, 0);
});

test('concurrent identical authorizations create exactly one approved decision and one hold', async (t) => {
  const f = await fixture(t); const peer = f.peer(); const event = authorization('concurrent');
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => (index % 2 ? peer.cards : f.cards).apply(event)));
  for (const result of results) assert.deepEqual(result, results[0]);
  assert.equal((await f.ledger.snapshot('alice')).balanceWon, 40_000);
  assert.equal((await f.database.query('SELECT COUNT(*)::int AS n FROM card_authorization_decisions')).rows[0].n, 1);
  assert.equal((await f.database.query('SELECT COUNT(*)::int AS n FROM card_payment_events')).rows[0].n, 1);
});

test('a lock which commits first makes the waiting authorization decline without a financial write', async (t) => {
  const f = await fixture(t); const peer = f.peer(); const input = await f.statusInput('locked');
  const client = await f.database.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT request_issuer_card_status($1::jsonb,$2::bigint)', [JSON.stringify(input), f.now()]);
    const pid = (await peer.database.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
    const waiting = rejectCode(peer.cards.apply(authorization('lock-wins')), 'CARD_LOCKED');
    await waitForLock(f.database, pid); await client.query('COMMIT'); await waiting;
    assert.equal((await f.ledger.snapshot('alice')).balanceWon, 50_000);
    assert.equal((await f.database.query('SELECT COUNT(*)::int AS n FROM card_payment_events')).rows[0].n, 0);
  } finally { await client.query('ROLLBACK'); client.release(); }
});

test('an authorization which commits first keeps its approved result while the waiting lock blocks subsequent purchases', async (t) => {
  const f = await fixture(t); const peer = f.peer(); const input = await f.statusInput('locked');
  const client = await f.database.pool.connect(); const event = authorization('approval-wins');
  try {
    await client.query('BEGIN');
    const original = (await client.query<{ result: CardEventResult }>('SELECT apply_sandbox_card_event($1::jsonb,$2::bigint) AS result',
      [JSON.stringify(event), f.now()])).rows[0].result;
    const pid = (await peer.database.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
    const pending = peer.outbox.requestStatus(input); const waiting = pending.catch((error: unknown) => { throw error; });
    await waitForLock(f.database, pid); await client.query('COMMIT'); await waiting;
    assert.deepEqual(await f.cards.apply(event), original);
    await rejectCode(f.cards.apply(authorization('after-approval-wins')), 'CARD_LOCKED');
    assert.equal((await f.ledger.snapshot('alice')).balanceWon, 40_000);
  } finally { await client.query('ROLLBACK'); client.release(); }
});

test('competing approval and decline for one event ID choose one immutable canonical request across members', async (t) => {
  const f = await fixture(t); const peer = f.peer(); await f.outbox.requestStatus(await f.statusInput('locked', 'bobby'));
  const active = authorization('cross-member'); const locked = { ...active, userId: 'bobby' };
  const outcomes = await Promise.allSettled([f.cards.apply(active), peer.cards.apply(locked)]);
  const decisions = (await f.database.query('SELECT * FROM card_authorization_decisions')).rows;
  assert.equal(decisions.length, 1);
  const conflicts = outcomes.filter((outcome) => outcome.status === 'rejected' && outcome.reason instanceof LedgerError && outcome.reason.code === 'IDEMPOTENCY_CONFLICT');
  assert.equal(conflicts.length, 1);
  const approved = decisions[0].decision === 'approved';
  assert.equal((await f.database.query('SELECT COUNT(*)::int AS n FROM card_payment_events')).rows[0].n, approved ? 1 : 0);
  assert.equal((await f.ledger.snapshot('alice')).balanceWon, approved ? 40_000 : 50_000);
  assert.equal((await f.ledger.snapshot('bobby')).balanceWon, 50_000);
  if (approved) assert.deepEqual(decisions[0].canonical_input, active);
  else assert.deepEqual(decisions[0].canonical_input, locked);
});

test('failed financial writes and failed decision inserts roll back the approval, hold and event atomically', async (t) => {
  const f = await fixture(t); const insufficient = authorization('insufficient', { amountWon: 60_000 });
  await rejectCode(f.cards.apply(insufficient), 'INSUFFICIENT_FUNDS');
  assert.equal((await f.database.query('SELECT COUNT(*)::int AS n FROM card_authorization_decisions')).rows[0].n, 0);
  await f.ledger.creditSandbox({ userId: 'alice', amountWon: 20_000, idempotencyKey: 'more-funds' });
  await f.cards.apply(insufficient);
  const before = await money(f.database); const event = authorization('audit-failure', { amountWon: 1_000 });
  await f.database.query(`CREATE FUNCTION test_reject_authorization_decision() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'fixture fails before decision commit'; END; $$;
    CREATE TRIGGER test_reject_decision BEFORE INSERT ON card_authorization_decisions FOR EACH ROW EXECUTE FUNCTION test_reject_authorization_decision()`);
  await assert.rejects(f.cards.apply(event));
  assert.deepEqual(await money(f.database), before);
  assert.equal((await f.database.query('SELECT COUNT(*)::int AS n FROM card_authorization_decisions WHERE event_id=$1', [event.eventId])).rows[0].n, 0);
  await f.database.query('DROP TRIGGER test_reject_decision ON card_authorization_decisions');
  await f.cards.apply(event);
});

test('authorization audit cannot be edited, deleted, truncated, copied or bypassed through the old financial helper', async (t) => {
  const f = await fixture(t); await f.cards.apply(authorization('immutable'));
  const before = (await f.database.query('SELECT * FROM card_authorization_decisions')).rows;
  for (const sql of [
    "UPDATE card_authorization_decisions SET reason='CARD_LOCKED'",
    'DELETE FROM card_authorization_decisions', 'TRUNCATE card_authorization_decisions CASCADE',
    'INSERT INTO card_authorization_decisions SELECT * FROM card_authorization_decisions ON CONFLICT DO NOTHING',
  ]) await assert.rejects(f.database.query(sql));
  const finances = await money(f.database);
  await assert.rejects(f.database.transaction((client) => client.query('SELECT apply_sandbox_card_event_financial_004($1::jsonb,$2::bigint)',
    [JSON.stringify(authorization('helper-bypass')), f.now()])));
  assert.deepEqual(await money(f.database), finances);
  assert.deepEqual((await f.database.query('SELECT * FROM card_authorization_decisions')).rows, before);
});

test('deferred integrity forbids a private financial helper from reusing a declined event ID for settlement', async (t) => {
  const f = await fixture(t); const approved = authorization('private-approved'); await f.cards.apply(approved);
  await f.outbox.requestStatus(await f.statusInput('locked'));
  const declined = authorization('private-declined'); await rejectCode(f.cards.apply(declined), 'CARD_LOCKED');
  const before = await money(f.database);
  const collision = { kind: 'capture', eventId: declined.eventId, paymentId: approved.paymentId, userId: approved.userId,
    amountWon: 1_000, finalCapture: false };
  for (const helper of ['apply_sandbox_card_event_financial_004', 'apply_sandbox_card_event_legacy_003']) {
    await assert.rejects(f.database.transaction((client) => client.query(`SELECT ${helper}($1::jsonb,$2::bigint)`,
      [JSON.stringify(collision), f.now()])), (error: unknown) => error instanceof Error && error.message === 'CARD_AUTHORIZATION_INCOMPLETE');
    assert.deepEqual(await money(f.database), before);
  }
  await rejectCode(f.cards.apply(declined), 'CARD_LOCKED');
});
