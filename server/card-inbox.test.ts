import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { Database } from './database';
import { LedgerError, LedgerStore } from './ledger';
import { CardPaymentStore } from './card-payments';
import { CardInboxStore } from './card-inbox';
import { RewardsStore } from './rewards';
import { reconcileRewards } from './reward-reconciliation';
import { createTestDatabase } from './test-support';
import type { SandboxCardEvent } from '../shared/api';

const NOW = Date.UTC(2026, 10, 19, 3);
const DAY = 86_400_000;

async function fixture(t: TestContext, initial = NOW) {
  const base = await createTestDatabase();
  let now = initial;
  let sequence = 0;
  const peers: Database[] = [];
  const options = { now: () => now };
  const stores = (database: Database) => ({ database, ledger: new LedgerStore(database, options),
    cards: new CardPaymentStore(database, options), inbox: new CardInboxStore(database, options), rewards: new RewardsStore(database, options) });
  const main = stores(base.database);
  t.after(async () => { try { await Promise.all(peers.map((database) => database.close())); } finally { await base.cleanup(); } });
  for (const id of ['alice', 'bobby']) await main.ledger.createUser({ id, email: `${id}@example.test`, name: '카드 수신 테스트', tag: id,
    passwordHash: 'test-only-hash', createdAt: NOW - 60 * DAY });
  const key = (prefix: string) => `${prefix}-${++sequence}`;
  return {
    ...main, key, now: () => now, setTime(value: number) { now = value; }, advance(value: number) { now += value; },
    peer() { const database = new Database({ connectionString: base.connectionString, schema: base.schema, maxConnections: 3 }); peers.push(database); return stores(database); },
    fund(amountWon: number, userId = 'alice') { return main.ledger.creditSandbox({ userId, amountWon, idempotencyKey: key('principal') }); },
    async activate(amountWon = 50_000) {
      await main.rewards.fundBudget({ amountWon, idempotencyKey: key('company-budget') });
      await main.rewards.setProgram({ enabled: true, idempotencyKey: key('program') });
    },
  };
}

function authorize(paymentId: string, amountWon = 10_000, userId = 'alice'): SandboxCardEvent {
  return { kind: 'authorize', eventId: `authorize-${paymentId}`, paymentId, userId, amountWon, merchantName: '수신 테스트 서점' };
}
function capture(paymentId: string, amountWon = 10_000, eventId = `capture-${paymentId}`, finalCapture = true): SandboxCardEvent {
  return { kind: 'capture', eventId, paymentId, userId: 'alice', amountWon, finalCapture };
}
function refund(paymentId: string, amountWon: number): SandboxCardEvent {
  return { kind: 'refund', eventId: `refund-${paymentId}`, paymentId, userId: 'alice', amountWon };
}
async function rejectCode(action: Promise<unknown>, code: string) {
  await assert.rejects(action, (error: unknown) => error instanceof LedgerError && error.code === code);
}
async function financialFingerprint(database: Database) {
  const tables = ['ledger_accounts', 'journals', 'card_payments', 'card_payment_events', 'reward_wallets', 'reward_cashback_months', 'card_reward_allocations', 'reward_journals', 'reward_cash_plans'];
  const entries = await Promise.all(tables.map(async (table) => [table, (await database.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows] as const));
  return Object.fromEntries(entries);
}
async function cleanBooks(database: Database) {
  const report = await reconcileRewards(database);
  assert.equal(report.ok, true, JSON.stringify(report.findings));
}
async function applied(inbox: CardInboxStore) {
  const result = await inbox.processNext();
  assert.ok(result); assert.equal(result.status, 'applied'); assert.equal(result.errorCode, null);
  return result;
}

test('concurrent duplicate deliveries keep one receipt and cannot move money before processing', { timeout: 20_000 }, async (t) => {
  const f = await fixture(t); const peer = f.peer();
  await f.fund(20_000);
  const event = authorize('concurrent-delivery');
  const before = await financialFingerprint(f.database);
  const receipts = await Promise.all(Array.from({ length: 10 }, (_, index) => (index % 2 ? peer.inbox : f.inbox).enqueue(event)));
  assert.equal(new Set(receipts.map((receipt) => receipt.id)).size, 1);
  assert.equal(receipts.filter((receipt) => !receipt.duplicate).length, 1);
  assert.ok(receipts.every((receipt) => receipt.status === 'pending' && receipt.receivedAt === NOW));
  assert.deepEqual(await financialFingerprint(f.database), before);
  await rejectCode(f.inbox.enqueue({ ...event, merchantName: '내용이 다른 가맹점' } as SandboxCardEvent), 'IDEMPOTENCY_CONFLICT');
  const results = await Promise.all([f.inbox.processNext(), peer.inbox.processNext()]);
  assert.equal(results.filter((result) => result?.status === 'applied').length, 1);
  assert.equal(results.filter((result) => result === null).length, 1);
  const current = await f.ledger.snapshot('alice');
  assert.deepEqual([current.balanceWon, current.heldBalanceWon, current.totalBalanceWon], [10_000, 10_000, 20_000]);
  assert.equal((await f.database.query('SELECT COUNT(*)::int AS count FROM card_inbox_attempts')).rows[0].count, 1);
  assert.equal((await f.database.query('SELECT COUNT(*)::int AS count FROM card_payment_events')).rows[0].count, 1);
  await cleanBooks(f.database);
});

test('a lost reply after commit and a new connection do not repeat the financial event', async (t) => {
  const f = await fixture(t);
  await f.fund(20_000);
  const event = authorize('commit-replay');
  const receipt = await f.inbox.enqueue(event);
  await applied(f.inbox); // Pretend the caller never received this committed response.
  const before = await financialFingerprint(f.database);
  f.advance(DAY);
  const peer = f.peer();
  const again = await peer.inbox.enqueue(event);
  assert.deepEqual(again, { ...receipt, status: 'applied', duplicate: true });
  assert.equal(await peer.inbox.processNext(), null);
  assert.deepEqual(await financialFingerprint(f.database), before);
  const stats = await peer.inbox.stats();
  assert.deepEqual([stats.pending, stats.retry, stats.applied, stats.deadLetter, stats.due, stats.oldestPendingAt], ['0', '0', '1', '0', '0', null]);
});

test('a worker cannot overtake an earlier claimed partial capture with a final capture while another payment can progress', { timeout: 20_000 }, async (t) => {
  const f = await fixture(t); const peer = f.peer();
  await f.fund(20_000); await f.fund(5_000, 'bobby');
  await f.cards.apply(authorize('claimed-partial'));
  const partial = await f.inbox.enqueue(capture('claimed-partial', 4_000, 'claimed-partial-first', false));
  f.advance(1);
  const final = await f.inbox.enqueue(capture('claimed-partial', 6_000, 'claimed-partial-final'));
  f.advance(1);
  const unrelated = await f.inbox.enqueue(authorize('unrelated-payment', 1_000, 'bobby'));
  const claim = await f.database.pool.connect();
  try {
    await claim.query('BEGIN');
    // Hold the first worker's claim before it takes any ledger locks. Otherwise
    // the shared settlement lock could hide incorrect inbox ordering.
    await claim.query("SELECT payment_id FROM card_inbox_lanes WHERE payment_id = 'claimed-partial' FOR NO KEY UPDATE");
    await claim.query('SELECT id FROM card_event_inbox WHERE id = $1 FOR UPDATE', [partial.id]);
    const other = await applied(peer.inbox);
    assert.equal(other.id, unrelated.id, 'an independent payment can progress without applying the later final capture');
    assert.equal(await peer.inbox.processNext(), null, 'the final capture must wait for the claimed partial capture');
    const payment = (await f.ledger.snapshot('alice')).cardPayments[0];
    assert.deepEqual([payment.capturedWon, payment.heldWon, payment.releasedWon], [0, 10_000, 0]);
    assert.equal((await f.ledger.snapshot('bobby')).heldBalanceWon, 1_000);
  } finally { try { await claim.query('ROLLBACK'); } finally { claim.release(); } }
  assert.equal((await applied(f.inbox)).id, partial.id);
  assert.equal((await applied(peer.inbox)).id, final.id);
  const current = await f.ledger.snapshot('alice');
  assert.deepEqual([current.balanceWon, current.cardPayments[0].capturedWon, current.cardPayments[0].releasedWon], [10_000, 10_000, 0]);
  await cleanBooks(f.database);
});

test('partial and final captures accepted in the same millisecond retain arrival order regardless of opaque receipt IDs', async (t) => {
  const f = await fixture(t); await f.fund(20_000);
  await f.cards.apply(authorize('same-millisecond'));
  // Control only opaque IDs in this isolated schema, not the financial command.
  // Descending IDs make a timestamp+UUID ordering regression deterministic.
  await f.database.query("ALTER TABLE card_event_inbox ALTER COLUMN id SET DEFAULT 'ffffffff-ffff-4fff-8fff-ffffffffffff'");
  const first = await f.inbox.enqueue(capture('same-millisecond', 4_000, 'same-ms-partial', false));
  await f.database.query("ALTER TABLE card_event_inbox ALTER COLUMN id SET DEFAULT '00000000-0000-4000-8000-000000000000'");
  const last = await f.inbox.enqueue(capture('same-millisecond', 6_000, 'same-ms-final'));
  await f.database.query('ALTER TABLE card_event_inbox ALTER COLUMN id SET DEFAULT gen_random_uuid()::text');
  assert.equal(first.receivedAt, last.receivedAt);
  assert.equal((await applied(f.inbox)).id, first.id);
  let current = await f.ledger.snapshot('alice');
  assert.deepEqual([current.cardPayments[0].capturedWon, current.cardPayments[0].heldWon], [4_000, 6_000]);
  assert.equal((await applied(f.inbox)).id, last.id);
  current = await f.ledger.snapshot('alice');
  assert.deepEqual([current.balanceWon, current.cardPayments[0].capturedWon, current.cardPayments[0].releasedWon], [10_000, 10_000, 0]);
  await cleanBooks(f.database);
});

for (const closing of ['capture', 'reverse'] as const) test(`a later ${closing} cannot pass a partial capture in backoff or dead letter`, async (t) => {
  const f = await fixture(t); const paymentId = `partial-blocks-${closing}`;
  await f.fund(20_000); await f.cards.apply(authorize(paymentId));
  const partialEventId = `blocked-partial-${closing}`;
  const partial = await f.inbox.enqueue(capture(paymentId, 4_000, partialEventId, false));
  await f.database.query(`CREATE FUNCTION test_block_partial_capture() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.event_id = '${partialEventId}' THEN RAISE EXCEPTION 'fixture partial capture failure'; END IF; RETURN NULL; END; $$;
    CREATE CONSTRAINT TRIGGER test_partial_capture_failure AFTER INSERT ON card_payment_events
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION test_block_partial_capture()`);
  let failed = await f.inbox.processNext();
  assert.equal(failed?.status, 'retry'); assert.equal(failed?.id, partial.id);
  f.advance(1);
  const closingEvent: SandboxCardEvent = closing === 'capture'
    ? capture(paymentId, 6_000, `blocked-final-${closing}`)
    : { kind: 'reverse', paymentId, eventId: `blocked-reverse-${closing}`, userId: 'alice' };
  const later = await f.inbox.enqueue(closingEvent);
  assert.equal(await f.inbox.processNext(), null, 'waiting for retry must not make the later closing event eligible');
  for (let attempt = 2; attempt <= 8; attempt++) {
    f.setTime(failed!.nextAttemptAt!);
    failed = await f.inbox.processNext(); assert.ok(failed);
    assert.equal(failed.id, partial.id); assert.equal(failed.attemptCount, attempt);
  }
  assert.equal(failed?.status, 'dead_letter');
  assert.equal(await f.inbox.processNext(), null, 'a failed earlier capture requires review before a closing event can proceed');
  const waiting = (await f.database.query('SELECT status,attempt_count FROM card_event_inbox WHERE id = $1', [later.id])).rows[0];
  assert.deepEqual(waiting, { status: 'pending', attempt_count: '0' });
  const before = (await f.ledger.snapshot('alice')).cardPayments[0];
  assert.deepEqual([before.capturedWon, before.heldWon, before.releasedWon], [0, 10_000, 0]);
  await f.database.query('DROP TRIGGER test_partial_capture_failure ON card_payment_events');
  await f.inbox.requeue({ id: partial.id, expectedVersion: failed!.version, idempotencyKey: `review-partial-${closing}`, reason: 'Verified and resolved the earlier partial capture processing failure.' });
  assert.equal((await applied(f.inbox)).id, partial.id);
  assert.equal((await applied(f.inbox)).id, later.id);
  const current = await f.ledger.snapshot('alice');
  assert.deepEqual([current.balanceWon, current.cardPayments[0].capturedWon, current.cardPayments[0].releasedWon],
    closing === 'capture' ? [10_000, 10_000, 0] : [16_000, 4_000, 6_000]);
  await cleanBooks(f.database);
});

test('capture and refund arriving before authorization retry without dropping or inventing financial entries', async (t) => {
  const f = await fixture(t);
  await f.fund(20_000);
  const paymentId = 'out-of-order';
  const captureReceipt = await f.inbox.enqueue(capture(paymentId, 6_000));
  const first = await f.inbox.processNext();
  assert.equal(first?.status, 'retry'); assert.equal(first?.errorCode, 'CARD_PAYMENT_NOT_FOUND');
  assert.equal((await f.ledger.snapshot('alice')).balanceWon, 20_000);
  f.advance(1);
  const refundReceipt = await f.inbox.enqueue(refund(paymentId, 2_000));
  const second = await f.inbox.processNext();
  assert.equal(second?.status, 'retry'); assert.equal(second?.errorCode, 'CARD_PAYMENT_NOT_FOUND');
  f.advance(1);
  await f.inbox.enqueue(authorize(paymentId));
  await applied(f.inbox);
  f.setTime(Math.max(first!.nextAttemptAt!, second!.nextAttemptAt!));
  const captured = await applied(f.inbox); assert.equal(captured.id, captureReceipt.id);
  const refunded = await applied(f.inbox); assert.equal(refunded.id, refundReceipt.id);
  const current = await f.ledger.snapshot('alice');
  assert.deepEqual([current.balanceWon, current.heldBalanceWon, current.cardPayments[0].capturedWon, current.cardPayments[0].refundedWon], [16_000, 0, 6_000, 2_000]);
  assert.equal((await f.database.query('SELECT COUNT(*)::int AS count FROM card_payment_events')).rows[0].count, 3);
  assert.equal((await f.database.query('SELECT COUNT(*)::int AS count FROM card_inbox_attempts')).rows[0].count, 5);
  await cleanBooks(f.database);
});

test('a refund received after authorization but before capture waits for the missing financial state', async (t) => {
  const f = await fixture(t); await f.fund(20_000);
  await f.inbox.enqueue(authorize('refund-precedes-capture')); await applied(f.inbox);
  await f.inbox.enqueue(refund('refund-precedes-capture', 3_000));
  const failed = await f.inbox.processNext();
  assert.equal(failed?.status, 'retry'); assert.equal(failed?.errorCode, 'CARD_STATE_CONFLICT');
  assert.deepEqual([(await f.ledger.snapshot('alice')).balanceWon, (await f.ledger.snapshot('alice')).heldBalanceWon], [10_000, 10_000]);
  f.advance(1); await f.inbox.enqueue(capture('refund-precedes-capture')); await applied(f.inbox);
  f.setTime(failed!.nextAttemptAt!); await applied(f.inbox);
  assert.equal((await f.ledger.snapshot('alice')).balanceWon, 13_000);
  await cleanBooks(f.database);
});

test('insufficient customer funds are terminal and later funding cannot revive the declined authorization', async (t) => {
  const f = await fixture(t); await f.fund(5_000);
  const receipt = await f.inbox.enqueue(authorize('terminal-balance'));
  const rejected = await f.inbox.processNext();
  assert.equal(rejected?.status, 'dead_letter'); assert.equal(rejected?.errorCode, 'INSUFFICIENT_FUNDS');
  assert.equal(rejected?.attemptCount, 1); assert.equal(rejected?.nextAttemptAt, null);
  await f.fund(5_000); f.advance(DAY);
  assert.equal(await f.inbox.processNext(), null);
  await rejectCode(f.inbox.requeue({ id: receipt.id, expectedVersion: rejected!.version, idempotencyKey: 'cannot-reapprove-decline', reason: 'Customer has added funds after the original decline.' }), 'INBOX_NOT_RETRYABLE');
  assert.deepEqual([(await f.ledger.snapshot('alice')).balanceWon, (await f.ledger.snapshot('alice')).heldBalanceWon], [10_000, 0]);
  assert.equal((await f.database.query('SELECT COUNT(*)::int AS count FROM card_payment_events')).rows[0].count, 0);
});

test('company budget failures retry and retain the authorization receipt month across Korean midnight', async (t) => {
  const beforeMidnight = Date.UTC(2026, 10, 30, 14, 59, 59);
  const f = await fixture(t, beforeMidnight); await f.fund(10_000);
  await f.rewards.setProgram({ enabled: true, idempotencyKey: 'on-before-midnight' });
  const event = authorize('month-preserved');
  const receipt = await f.inbox.enqueue(event);
  const delayed = await f.inbox.processNext();
  assert.equal(delayed?.status, 'retry'); assert.equal(delayed?.errorCode, 'REWARD_BUDGET_UNAVAILABLE');
  assert.equal((await f.ledger.snapshot('alice')).heldBalanceWon, 0);
  f.advance(2_000);
  await f.rewards.fundBudget({ amountWon: 1_000, idempotencyKey: 'budget-after-midnight' });
  await applied(f.inbox);
  await f.inbox.enqueue(capture('month-preserved')); await applied(f.inbox);
  const current = await f.ledger.snapshot('alice');
  assert.equal(current.cardPayments[0].createdAt, beforeMidnight);
  assert.equal(current.cardPayments[0].cashback?.month, '2026-11');
  assert.equal(current.cardPayments[0].cashback?.awardedWon, 100);
  assert.equal(current.rewards.cashback.month, '2026-12'); assert.equal(current.rewards.cashback.confirmedWon, 0);
  assert.equal(current.rewards.availableWon, 100);
  const again = await f.inbox.enqueue(event);
  assert.equal(again.id, receipt.id); assert.equal(again.receivedAt, beforeMidnight); assert.equal(again.duplicate, true);
  await cleanBooks(f.database);
});

test('exhausted retries require an audited versioned operator requeue and preserve every attempt', async (t) => {
  const f = await fixture(t); await f.fund(20_000);
  const receipt = await f.inbox.enqueue(capture('review-after-exhaustion'));
  let failed: Awaited<ReturnType<CardInboxStore['processNext']>> = null;
  for (let attempt = 1; attempt <= 8; attempt++) {
    failed = await f.inbox.processNext(); assert.ok(failed);
    assert.equal(failed.attemptCount, attempt); assert.equal(failed.cycleAttempts, attempt);
    assert.equal(failed.status, attempt === 8 ? 'dead_letter' : 'retry');
    if (attempt < 8) {
      assert.ok(failed.nextAttemptAt! > f.now());
      assert.equal(await f.inbox.processNext(), null, 'backoff must not be bypassed by immediately polling again');
      f.setTime(failed.nextAttemptAt!);
    }
  }
  const input = { id: receipt.id, expectedVersion: failed!.version, idempotencyKey: 'review-retry-001', reason: 'Verified the missing authorization before replaying the capture.' };
  await rejectCode(f.inbox.requeue({ ...input, expectedVersion: failed!.version - 1, idempotencyKey: 'stale-review' }), 'INBOX_VERSION_CHANGED');
  const requeued = await f.inbox.requeue(input);
  assert.equal(requeued.status, 'pending'); assert.equal(requeued.version, failed!.version + 1);
  assert.deepEqual(await f.peer().inbox.requeue(input), requeued);
  await rejectCode(f.inbox.requeue({ ...input, reason: 'Different operator review must not reuse the original key.' }), 'IDEMPOTENCY_CONFLICT');
  await rejectCode(f.inbox.requeue({ ...input, expectedVersion: requeued.version, idempotencyKey: 'already-pending' }), 'INBOX_STATE_CONFLICT');
  await f.cards.apply(authorize('review-after-exhaustion'));
  const result = await applied(f.inbox);
  assert.equal(result.attemptCount, 9); assert.equal(result.cycleAttempts, 1);
  assert.deepEqual(await f.inbox.requeue(input), requeued, 'late replay returns its first operator result without scheduling another attempt');
  assert.equal(await f.inbox.processNext(), null);
  const audit = (await f.database.query('SELECT * FROM card_inbox_requeues')).rows;
  assert.equal(audit.length, 1); assert.equal(audit[0].reason, input.reason);
  assert.equal(audit[0].actor, (await f.database.query('SELECT session_user AS actor')).rows[0].actor);
  assert.equal((await f.database.query('SELECT COUNT(*)::int AS count FROM card_inbox_attempts')).rows[0].count, 9);
  assert.equal((await f.ledger.snapshot('alice')).balanceWon, 10_000);
  await cleanBooks(f.database);
});

test('a deferred ledger failure rolls back principal, reward and company changes while retaining a safe retry record', async (t) => {
  const f = await fixture(t); await f.fund(7_000); await f.activate();
  await f.rewards.grant({ userId: 'alice', amountWon: 3_000, idempotencyKey: 'rollback-grant' });
  await f.inbox.enqueue(authorize('deferred-rollback'));
  const before = await financialFingerprint(f.database);
  // Fixture-local failure after posting, not a mocked card command. The worker
  // must check deferred constraints inside its financial savepoint.
  await f.database.query(`CREATE FUNCTION test_fail_inbox_commit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'private-issuer-debug-must-not-be-persisted'; END; $$;
    CREATE CONSTRAINT TRIGGER test_inbox_deferred_failure AFTER INSERT ON card_payment_events
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION test_fail_inbox_commit()`);
  const failed = await f.inbox.processNext();
  assert.equal(failed?.status, 'retry'); assert.equal(failed?.errorCode, 'INTERNAL_ERROR');
  assert.deepEqual(await financialFingerprint(f.database), before);
  assert.doesNotMatch(JSON.stringify((await f.database.query('SELECT * FROM card_inbox_attempts')).rows), /private-issuer-debug/);
  await f.database.query('DROP TRIGGER test_inbox_deferred_failure ON card_payment_events');
  f.setTime(failed!.nextAttemptAt!); await applied(f.inbox);
  const current = await f.ledger.snapshot('alice');
  assert.deepEqual([current.balanceWon, current.heldBalanceWon, current.rewards.availableWon, current.rewards.heldWon], [0, 7_000, 0, 3_000]);
  assert.equal((await f.database.query('SELECT COUNT(*)::int AS count FROM card_payment_events')).rows[0].count, 1);
  await cleanBooks(f.database);
});

test('terminating a worker after posting but before commit rolls back both ledger and inbox and releases its claim', { timeout: 20_000 }, async (t) => {
  const f = await fixture(t); const peer = f.peer(); await f.fund(20_000);
  const receipt = await f.inbox.enqueue(authorize('worker-termination'));
  const client = await f.database.pool.connect();
  client.on('error', () => {}); // The intentional server-side termination emits an idle error.
  try {
    const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
    await client.query('BEGIN');
    const inFlight = await client.query('SELECT process_card_inbox($1::bigint) AS result', [f.now()]);
    assert.equal(inFlight.rows[0].result.status, 'applied');
    assert.equal(await peer.inbox.processNext(), null, 'SKIP LOCKED must not wait for or duplicate the in-flight event');
    const visible = await peer.ledger.snapshot('alice');
    assert.deepEqual([visible.balanceWon, visible.heldBalanceWon], [20_000, 0], 'uncommitted postings cannot appear in another connection');
    assert.equal((await f.database.query('SELECT pg_terminate_backend($1) AS stopped', [pid])).rows[0].stopped, true);
    await assert.rejects(client.query('COMMIT'));
  } finally { client.release(true); }
  assert.equal((await f.database.query('SELECT COUNT(*)::int AS count FROM card_inbox_attempts')).rows[0].count, 0);
  const result = await applied(peer.inbox);
  assert.equal(result.id, receipt.id); assert.equal(result.attemptCount, 1);
  assert.deepEqual([(await peer.ledger.snapshot('alice')).balanceWon, (await peer.ledger.snapshot('alice')).heldBalanceWon], [10_000, 10_000]);
  assert.equal((await f.database.query('SELECT COUNT(*)::int AS count FROM card_payment_events')).rows[0].count, 1);
  await cleanBooks(f.database);
});

test('inbox processing reuses an already posted event without rewriting its original response', async (t) => {
  const f = await fixture(t); await f.fund(15_000);
  const event = authorize('prior-direct-command');
  const original = await f.cards.apply(event);
  await f.cards.apply(capture('prior-direct-command', 6_000));
  const before = await financialFingerprint(f.database);
  f.advance(DAY);
  const receipt = await f.inbox.enqueue(event); await applied(f.inbox);
  assert.deepEqual((await f.database.query('SELECT result FROM card_event_inbox WHERE id = $1', [receipt.id])).rows[0].result, original);
  assert.deepEqual(await financialFingerprint(f.database), before);
  assert.equal((await f.ledger.snapshot('alice')).balanceWon, 9_000);
});

test('a conflicting preexisting card event is terminal and cannot be repaired by replacing accepted content', async (t) => {
  const f = await fixture(t); await f.fund(20_000);
  const event = authorize('existing-event-conflict'); await f.cards.apply(event);
  const before = await financialFingerprint(f.database);
  const changed = { ...event, amountWon: 11_000 } as SandboxCardEvent;
  const receipt = await f.inbox.enqueue(changed);
  const failed = await f.inbox.processNext();
  assert.equal(failed?.status, 'dead_letter'); assert.equal(failed?.errorCode, 'IDEMPOTENCY_CONFLICT');
  await rejectCode(f.inbox.enqueue(event), 'IDEMPOTENCY_CONFLICT');
  await rejectCode(f.inbox.requeue({ id: receipt.id, expectedVersion: failed!.version, idempotencyKey: 'invalid-event-review', reason: 'Attempting to replay a conflicting immutable issuer event.' }), 'INBOX_NOT_RETRYABLE');
  assert.deepEqual(await financialFingerprint(f.database), before);
});

test('accepted event identity and attempt history cannot be edited or erased', async (t) => {
  const f = await fixture(t); await f.fund(20_000);
  const receipt = await f.inbox.enqueue(authorize('immutable-receipt')); await applied(f.inbox);
  await assert.rejects(f.database.query("UPDATE card_event_inbox SET canonical_input = jsonb_set(canonical_input, '{amountWon}', '1') WHERE id = $1", [receipt.id]));
  await assert.rejects(f.database.query('UPDATE card_event_inbox SET received_at = received_at + 1 WHERE id = $1', [receipt.id]));
  await assert.rejects(f.database.query("UPDATE card_inbox_attempts SET error_code = 'FORGED'"));
  await assert.rejects(f.database.query('DELETE FROM card_inbox_attempts'));
  await assert.rejects(f.database.query('TRUNCATE card_event_inbox CASCADE'));
  assert.equal((await f.database.query('SELECT COUNT(*)::int AS count FROM card_event_inbox')).rows[0].count, 1);
  assert.equal((await f.database.query('SELECT COUNT(*)::int AS count FROM card_inbox_attempts')).rows[0].count, 1);
  await cleanBooks(f.database);
});
