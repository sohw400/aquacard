import { approveTestCustomer } from './test-customer-access';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import type { SandboxCardEvent } from '../shared/api';
import { CardInboxStore } from './card-inbox';
import { CardPaymentStore } from './card-payments';
import { CardOperationsStore, type CardOperationsInput, type CardOperationsReceipt, type CardOperationsReport } from './card-operations';
import { Database } from './database';
import { IssuerOutboxStore } from './issuer-outbox';
import { LedgerError, LedgerStore } from './ledger';
import { grantCardOperationsRole } from './permissions';
import { createTestDatabase } from './test-support';

const NOW = Date.UTC(2026, 10, 19, 5);
const PRIVATE = 'private-merchant-do-not-disclose';

async function fixture(t: TestContext) {
  const base = await createTestDatabase();
  const roles: string[] = [];
  const connections: Database[] = [];
  const password = randomBytes(24).toString('hex');
  let now = NOW;
  const ledger = new LedgerStore(base.database, { now: () => now });
  const cards = new CardPaymentStore(base.database, { now: () => now });
  const inbox = new CardInboxStore(base.database, { now: () => now });
  const issuer = new IssuerOutboxStore(base.database, { now: () => now });
  t.after(async () => {
    await Promise.all(connections.map((database) => database.close()));
    try {
      for (const role of roles) {
        await base.database.query(`DROP OWNED BY "${role}"`);
        await base.database.query(`DROP ROLE "${role}"`);
      }
    } finally { await base.cleanup(); }
  });
  async function operator() {
    const role = `ops_trace_${randomBytes(10).toString('hex')}`;
    await base.database.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    roles.push(role);
    await grantCardOperationsRole(base.database, role);
    const url = new URL(base.connectionString); url.username = role; url.password = password;
    const connectionString = url.toString();
    const database = new Database({ connectionString, schema: base.schema, maxConnections: 2 });
    connections.push(database);
    return { role, connectionString, database, store: new CardOperationsStore(database) };
  }
  const ops = await operator();
  for (const id of ['alice', 'bobby']) {
    await ledger.createUser({ id, email: `${id}-private@example.test`, name: `${id} private name`, tag: id,
      passwordHash: 'private-password-hash', createdAt: NOW - 86_400_000 });
    await approveTestCustomer(ledger.database, id);
    await ledger.creditSandbox({ userId: id, amountWon: 50_000, idempotencyKey: `fund-${id}` });
    await issuer.register({ userId: id, providerCardId: `sandbox-card-private-${id}`, initialStatus: 'active' });
  }
  return {
    ...base, ledger, cards, inbox, issuer, ops, operator, now: () => now, setTime(value: number) { now = value; },
    async lock(userId = 'alice') {
      const card = (await issuer.snapshot(userId)).card; assert.ok(card);
      return issuer.requestStatus({ userId, cardId: card.id, targetStatus: 'locked', expectedVersion: card.version, idempotencyKey: `lock-${randomUUID()}` });
    },
  };
}

function authorization(id: string, amountWon = 10_000): Extract<SandboxCardEvent, { kind: 'authorize' }> {
  return { kind: 'authorize', eventId: `auth-${id}`, paymentId: `payment-${id}`, userId: 'alice', amountWon, merchantName: PRIVATE };
}
function inspection(id: string, kind: 'event' | 'inbox' = 'event'): CardOperationsInput {
  return { requestId: randomUUID(), lookup: { kind, id }, caseReference: 'CASE-2026-001' };
}
function rejectCode(action: Promise<unknown>, code: string) {
  return assert.rejects(action, (error: unknown) => error instanceof LedgerError ? error.code === code : error instanceof Error && error.message === code);
}
async function prepare(database: Database, input: unknown): Promise<CardOperationsReceipt> {
  return database.transaction(async (client) => (await client.query<{ result: CardOperationsReceipt }>(
    'SELECT prepare_card_operations_report($1::jsonb) AS result', [JSON.stringify(input)])).rows[0].result, { isolation: 'repeatable read' });
}
async function financialFingerprint(database: Database) {
  const tables = ['users', 'ledger_accounts', 'journals', 'card_payments', 'card_payment_events', 'card_authorization_decisions',
    'reward_wallets', 'reward_journals', 'card_reward_allocations', 'card_event_inbox', 'card_inbox_attempts', 'issuer_cards', 'issuer_outbox'];
  return Object.fromEntries(await Promise.all(tables.map(async (table) => [table,
    (await database.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows] as const)));
}
function sanitized(report: CardOperationsReport) {
  const output = JSON.stringify(report);
  assert.doesNotMatch(output, /private-merchant|private@example|private name|private-password|sandbox-card-private|merchantName|merchant_name|canonical_input|provider_card_id|providerCardId|request_key|requestKey|idempotency_key|idempotencyKey|lease_token|leaseToken|passwordHash|password_hash/);
  assert.ok(Buffer.byteLength(output) <= 65_536);
}

test('an approved event is traced with safe current settlement data and a committed audit without financial mutation', async (t) => {
  const f = await fixture(t); const event = authorization('approved');
  await f.cards.apply(event);
  await f.cards.apply({ kind: 'capture', eventId: 'partial-approved', paymentId: event.paymentId, userId: event.userId, amountWon: 4_000, finalCapture: false });
  const before = await financialFingerprint(f.database); const input = inspection(event.eventId);
  const receipt = await f.ops.store.prepare(input);
  assert.deepEqual(Object.keys(receipt).sort(), ['duplicate', 'preparedAt', 'requestId']);
  assert.equal(receipt.requestId, input.requestId); assert.equal(receipt.duplicate, false);
  const record = (await f.database.query('SELECT * FROM card_operations_reports WHERE request_id=$1', [input.requestId])).rows[0];
  assert.equal(record.actor, f.ops.role); assert.deepEqual(record.canonical_input, input);
  const report = await f.ops.store.read(input.requestId);
  assert.deepEqual(report, record.result);
  assert.equal(report.found, true); assert.equal(report.correlation, 'consistent');
  assert.equal(report.authorization?.decision, 'approved'); assert.equal(report.authorization?.amountWon, 10_000);
  assert.equal(report.authorization?.cardAtDecision?.confirmedStatus, 'active');
  assert.equal(report.ledgerEvent?.legacyPolicy, false); assert.equal(report.inbox, null);
  assert.equal(report.payment?.capturedWon, 4_000); assert.equal(report.payment?.heldWon, 6_000);
  sanitized(report); assert.deepEqual(await financialFingerprint(f.database), before);
});

test('a policy refusal separates the decision-time lock snapshot from the later issuer command state', async (t) => {
  const f = await fixture(t); const lock = await f.lock(); const event = authorization('declined');
  await rejectCode(f.cards.apply(event), 'CARD_LOCKED');
  const input = inspection(event.eventId); const original = await f.ops.store.trace(input);
  assert.equal(original.correlation, 'single_source'); assert.equal(original.authorization?.decision, 'declined');
  assert.equal(original.authorization?.reason, 'CARD_LOCKED');
  assert.equal(original.authorization?.cardAtDecision?.desiredStatus, 'locked');
  assert.equal(original.authorization?.cardAtDecision?.confirmedStatus, 'active');
  assert.equal(original.issuerCommand?.id, lock.id); assert.equal(original.issuerCommand?.status, 'pending');
  assert.equal(original.payment, null); assert.equal(original.ledgerEvent, null);
  const claim = await f.issuer.claim(); assert.ok(claim);
  await f.issuer.finish({ id: claim.id, leaseToken: claim.leaseToken, expectedVersion: claim.version, outcome: { kind: 'succeeded' } });
  assert.deepEqual(await f.ops.store.trace(input), original, 'the same request must not quietly refresh a forensic snapshot');
  const fresh = await f.ops.store.trace(inspection(event.eventId));
  assert.equal(fresh.issuerCommand?.status, 'succeeded');
  assert.deepEqual(fresh.authorization, original.authorization); sanitized(fresh);
});

test('pending inbox receipt is not an approval and a later final refusal appears only in a new report', async (t) => {
  const f = await fixture(t); const event = authorization('inbox'); await f.lock();
  const receipt = await f.inbox.enqueue(event); const input = inspection(receipt.id, 'inbox');
  const pending = await f.ops.store.trace(input);
  assert.equal(pending.found, true); assert.equal(pending.correlation, 'single_source');
  assert.equal(pending.authorization, null); assert.equal(pending.ledgerEvent, null); assert.equal(pending.payment, null);
  assert.equal(pending.inbox?.status, 'pending'); assert.deepEqual(pending.inbox?.attempts, []);
  await f.inbox.processNext();
  assert.deepEqual(await f.ops.store.read(input.requestId), pending);
  const current = await f.ops.store.trace(inspection(receipt.id, 'inbox'));
  assert.equal(current.authorization?.reason, 'CARD_LOCKED'); assert.equal(current.correlation, 'consistent');
  assert.equal(current.inbox?.status, 'dead_letter'); assert.equal(current.inbox?.retryEligible, false);
  assert.equal(current.inbox?.attempts.length, 1); assert.equal(current.inbox?.attempts[0].errorCode, 'CARD_LOCKED');
  sanitized(current);
});

test('a missing target is audited and frozen even if the target appears later', async (t) => {
  const f = await fixture(t); const event = authorization('not-yet-created'); const input = inspection(event.eventId);
  const missing = await f.ops.store.trace(input);
  assert.equal(missing.found, false); assert.equal(missing.correlation, 'not_found');
  for (const section of ['authorization', 'ledgerEvent', 'inbox', 'payment', 'issuerCommand'] as const) assert.equal(missing[section], null);
  await f.cards.apply(event);
  assert.deepEqual(await f.ops.store.trace(input), missing);
  assert.equal((await f.ops.store.trace(inspection(event.eventId))).found, true);
  assert.equal((await f.database.query('SELECT COUNT(*)::int AS n FROM card_operations_reports')).rows[0].n, 2);
});

test('prepare requires a coherent transaction snapshot and rejects malformed inputs without creating an audit', async (t) => {
  const f = await fixture(t); const valid = inspection('valid-event');
  await rejectCode(f.ops.database.query('SELECT prepare_card_operations_report($1::jsonb)', [JSON.stringify(valid)]), 'OPS_SNAPSHOT_REQUIRED');
  const invalid: unknown[] = [null, [], {}, { ...valid, actor: f.ops.role }, { ...valid, pan: '4111111111111111' },
    { ...valid, requestId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' }, { ...valid, requestId: 'not-a-uuid' },
    { ...valid, lookup: { kind: 'user', id: 'alice' } }, { ...valid, lookup: { ...valid.lookup, merchantName: PRIVATE } },
    { ...valid, lookup: { kind: 'event', id: 'a'.repeat(129) } }, { ...valid, lookup: { kind: 'inbox', id: 'not-a-uuid' } },
    { ...valid, caseReference: 'CASE\nPRIVATE' }, { ...valid, caseReference: '' }, { ...valid, caseReference: 'A'.repeat(20_000) }];
  for (const input of invalid) await rejectCode(prepare(f.ops.database, input), 'INVALID_OPS_REQUEST');
  assert.equal((await f.database.query('SELECT COUNT(*)::int AS n FROM card_operations_reports')).rows[0].n, 0);
});

test('the creator transaction and its savepoints cannot disclose a prepared report or erase a disclosed audit', async (t) => {
  const f = await fixture(t); const event = authorization('disclosure'); await f.cards.apply(event); const input = inspection(event.eventId);
  const client = await f.ops.database.pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ'); await client.query('SAVEPOINT before_prepare');
    const receipt = (await client.query<{ result: CardOperationsReceipt }>('SELECT prepare_card_operations_report($1::jsonb) AS result', [JSON.stringify(input)])).rows[0].result;
    assert.deepEqual(Object.keys(receipt).sort(), ['duplicate', 'preparedAt', 'requestId']);
    await client.query('RELEASE SAVEPOINT before_prepare'); await client.query('SAVEPOINT before_read');
    await rejectCode(client.query('SELECT read_card_operations_report($1)', [input.requestId]), 'OPS_COMMIT_REQUIRED');
    await client.query('ROLLBACK TO SAVEPOINT before_read');
    await rejectCode(f.ops.store.read(input.requestId), 'OPS_REPORT_NOT_FOUND');
    await client.query('ROLLBACK');
    await rejectCode(f.ops.store.read(input.requestId), 'OPS_REPORT_NOT_FOUND');
    assert.equal((await f.database.query('SELECT COUNT(*)::int AS n FROM card_operations_reports')).rows[0].n, 0);
    await f.ops.store.prepare(input);
    await client.query('BEGIN');
    const report = (await client.query<{ result: CardOperationsReport }>('SELECT read_card_operations_report($1) AS result', [input.requestId])).rows[0].result;
    assert.equal(report.authorization?.decision, 'approved'); await client.query('ROLLBACK');
    assert.deepEqual(await f.ops.store.read(input.requestId), report);
    assert.equal((await f.database.query('SELECT COUNT(*)::int AS n FROM card_operations_reports')).rows[0].n, 1);
  } finally { await client.query('ROLLBACK'); client.release(); }
});

test('a committed report can be retrieved in a read-only transaction without allocating a transaction ID', async (t) => {
  const f = await fixture(t); const event = authorization('read-only'); await f.cards.apply(event);
  const input = inspection(event.eventId); const expected = await f.ops.store.trace(input);
  const client = await f.ops.database.pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    assert.equal((await client.query('SELECT pg_current_xact_id_if_assigned() AS xid')).rows[0].xid, null);
    const report = (await client.query<{ result: CardOperationsReport }>('SELECT read_card_operations_report($1) AS result', [input.requestId])).rows[0].result;
    assert.deepEqual(report, expected);
    assert.equal((await client.query('SELECT pg_current_xact_id_if_assigned() AS xid')).rows[0].xid, null);
    await client.query('COMMIT');
  } finally { await client.query('ROLLBACK'); client.release(); }
});

test('concurrent preparation of one request creates one audited snapshot and safely resolves serialization retries', async (t) => {
  const f = await fixture(t); const event = authorization('same-request'); await f.cards.apply(event); const input = inspection(event.eventId);
  const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => f.ops.store.prepare(input)));
  const receipts: CardOperationsReceipt[] = [];
  for (const attempt of attempts) {
    if (attempt.status === 'fulfilled') receipts.push(attempt.value);
    else {
      assert.ok(attempt.reason instanceof LedgerError); assert.equal(attempt.reason.status, 503);
      receipts.push(await f.ops.store.prepare(input));
    }
  }
  assert.equal(receipts.filter((receipt) => !receipt.duplicate).length, 1);
  assert.equal(new Set(receipts.map((receipt) => receipt.preparedAt)).size, 1);
  assert.equal((await f.database.query('SELECT COUNT(*)::int AS n FROM card_operations_reports')).rows[0].n, 1);
  assert.equal((await f.ops.store.read(input.requestId)).authorization?.decision, 'approved');
});

test('one repeatable-read snapshot cannot mix an old inbox receipt with a newly committed financial approval', async (t) => {
  const f = await fixture(t); const event = authorization('snapshot'); const receipt = await f.inbox.enqueue(event);
  const input = inspection(receipt.id, 'inbox'); const client = await f.ops.database.pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await client.query('SELECT COUNT(*) FROM schema_migrations');
    assert.equal((await f.inbox.processNext())?.status, 'applied');
    await client.query('SELECT prepare_card_operations_report($1::jsonb)', [JSON.stringify(input)]);
    await client.query('COMMIT');
  } finally { await client.query('ROLLBACK'); client.release(); }
  const older = await f.ops.store.read(input.requestId);
  assert.equal(older.inbox?.status, 'pending'); assert.equal(older.authorization, null); assert.equal(older.ledgerEvent, null);
  const current = await f.ops.store.trace(inspection(receipt.id, 'inbox'));
  assert.equal(current.inbox?.status, 'applied'); assert.equal(current.authorization?.decision, 'approved');
  assert.equal(current.payment?.heldWon, event.amountWon);
});

test('a request key is scoped to its authenticated login and cannot change lookup or case reference', async (t) => {
  const f = await fixture(t); const other = await f.operator(); const input = inspection('first-event');
  const first = await f.ops.store.trace(input);
  await rejectCode(f.ops.store.prepare({ ...input, caseReference: 'DIFFERENT-CASE' }), 'OPS_REQUEST_CONFLICT');
  await rejectCode(f.ops.store.prepare({ ...input, lookup: { kind: 'event', id: 'another-event' } }), 'OPS_REQUEST_CONFLICT');
  await rejectCode(other.store.read(input.requestId), 'OPS_REPORT_NOT_FOUND');
  const second = await other.store.trace({ ...input, caseReference: 'SECOND-LOGIN-CASE' });
  assert.equal(second.caseReference, 'SECOND-LOGIN-CASE'); assert.deepEqual(await f.ops.store.read(input.requestId), first);
  assert.deepEqual((await f.database.query('SELECT actor FROM card_operations_reports ORDER BY actor')).rows.map((row) => row.actor).sort(), [f.ops.role, other.role].sort());
});

test('a conflicting inbox identity is exposed as conflict without attaching its member to another member payment', async (t) => {
  const f = await fixture(t); const event = authorization('conflict'); await f.cards.apply(event);
  const receipt = await f.inbox.enqueue({ ...event, userId: 'bobby', paymentId: 'different-payment', merchantName: 'different-private-merchant' });
  for (const input of [inspection(event.eventId), inspection(receipt.id, 'inbox')]) {
    const report = await f.ops.store.trace(input);
    assert.equal(report.correlation, 'conflict'); assert.equal(report.authorization?.userId, 'alice');
    assert.equal(report.ledgerEvent?.userId, 'alice'); assert.equal(report.inbox?.userId, 'bobby');
    assert.equal(report.inbox?.paymentId, 'different-payment'); assert.equal(report.payment?.id, event.paymentId);
    assert.equal(report.payment?.userId, 'alice'); sanitized(report);
  }
  await f.inbox.processNext();
  const processed = await f.ops.store.trace(inspection(receipt.id, 'inbox'));
  assert.equal(processed.inbox?.errorCode, 'IDEMPOTENCY_CONFLICT'); assert.equal(processed.inbox?.retryEligible, false);
  const sameCoordinates = authorization('same-coordinates'); await f.cards.apply(sameCoordinates);
  await f.inbox.enqueue({ ...sameCoordinates, merchantName: 'a different private merchant' });
  assert.equal((await f.ops.store.trace(inspection(sameCoordinates.eventId))).correlation, 'conflict',
    'identical member, payment and amount do not make differing canonical event contents consistent');
});

test('the latest twenty inbox attempts are bounded and ordered without exposing operator reasons', async (t) => {
  const f = await fixture(t);
  const receipt = await f.inbox.enqueue({ kind: 'capture', eventId: 'missing-predecessor', paymentId: 'missing-payment', userId: 'alice', amountWon: 1_000, finalCapture: true });
  let result;
  for (let cycle = 0; cycle < 3; cycle++) {
    for (let attempt = 0; attempt < 8; attempt++) {
      result = await f.inbox.processNext(); assert.ok(result);
      if (result.nextAttemptAt !== null) f.setTime(result.nextAttemptAt);
    }
    assert.equal(result?.status, 'dead_letter');
    if (cycle < 2) await f.inbox.requeue({ id: receipt.id, expectedVersion: result!.version,
      idempotencyKey: `requeue-${cycle}`, reason: 'private-operator-reason-do-not-disclose' });
  }
  const before = await financialFingerprint(f.database);
  const report = await f.ops.store.trace(inspection(receipt.id, 'inbox'));
  assert.equal(report.inbox?.attemptCount, 24); assert.equal(report.inbox?.attemptsTruncated, true);
  assert.equal(report.inbox?.attemptLimit, 20); assert.equal(report.inbox?.retryEligible, true);
  assert.deepEqual(report.inbox?.attempts.map((attempt) => attempt.attemptNo), Array.from({ length: 20 }, (_, index) => 24 - index));
  assert.equal(report.ledgerEvent, null); assert.equal(report.payment, null);
  assert.doesNotMatch(JSON.stringify(report), /private-operator-reason/);
  assert.deepEqual(await financialFingerprint(f.database), before);
});

test('report history rejects direct mutation and preparation sanitizes unexpected database error details before disclosure', async (t) => {
  const f = await fixture(t); const event = authorization('audit-guard'); await f.cards.apply(event);
  const input = inspection(event.eventId); await f.ops.store.trace(input);
  const before = (await f.database.query('SELECT * FROM card_operations_reports')).rows;
  for (const statement of ['UPDATE card_operations_reports SET prepared_at=prepared_at+1', 'DELETE FROM card_operations_reports',
    'TRUNCATE card_operations_reports', 'INSERT INTO card_operations_reports SELECT * FROM card_operations_reports ON CONFLICT DO NOTHING']) {
    await assert.rejects(f.database.query(statement));
  }
  assert.deepEqual((await f.database.query('SELECT * FROM card_operations_reports')).rows, before);
  await f.database.query(`CREATE FUNCTION test_ops_private_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='PRIVATE_ERROR_MESSAGE', DETAIL=NEW.result::text, HINT='PRIVATE_ERROR_HINT'; END; $$;
    CREATE TRIGGER test_ops_private_failure BEFORE INSERT ON card_operations_reports FOR EACH ROW EXECUTE FUNCTION test_ops_private_failure()`);
  const failing = inspection(event.eventId);
  await assert.rejects(prepare(f.ops.database, failing), (error: unknown) => {
    assert.ok(error instanceof Error); assert.equal(error.message, 'OPS_UNAVAILABLE');
    assert.doesNotMatch(JSON.stringify(error), /PRIVATE_ERROR|payment-audit-guard|auth-audit-guard|authorization|preparedAt|cardAtDecision/);
    return true;
  });
  await rejectCode(f.ops.store.read(failing.requestId), 'OPS_REPORT_NOT_FOUND');
  assert.deepEqual((await f.database.query('SELECT * FROM card_operations_reports')).rows, before);
});

test('inspection preserves exact safe integer amounts at the financial boundary', async (t) => {
  const f = await fixture(t);
  await f.ledger.creditSandbox({ userId: 'alice', amountWon: Number.MAX_SAFE_INTEGER - 50_000, idempotencyKey: 'fund-safe-limit' });
  const event = authorization('safe-limit', Number.MAX_SAFE_INTEGER); await f.cards.apply(event);
  const report = await f.ops.store.trace(inspection(event.eventId));
  assert.equal(report.authorization?.amountWon, Number.MAX_SAFE_INTEGER);
  assert.equal(report.ledgerEvent?.amountWon, Number.MAX_SAFE_INTEGER);
  assert.equal(report.payment?.authorizedWon, Number.MAX_SAFE_INTEGER); assert.equal(report.payment?.heldWon, Number.MAX_SAFE_INTEGER);
});

test('the CLI prepares with its restricted login and a separate process reads the same committed report', async (t) => {
  const f = await fixture(t); const event = authorization('cli'); const inbox = await f.inbox.enqueue(event);
  await f.inbox.processNext(); const input = inspection(event.eventId);
  const env = { ...process.env, NODE_ENV: 'development', OPERATIONS_DATABASE_URL: f.ops.connectionString,
    DATABASE_URL: 'postgresql://must-not-use:private@127.0.0.1:1/unused', MIGRATION_DATABASE_URL: '', DATABASE_SCHEMA: f.schema };
  const run = (args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'server/card-operations-operator.ts', ...args],
    { env, encoding: 'utf8', timeout: 10_000 });
  const trace = run(['trace-event', event.eventId, input.requestId, input.caseReference]);
  assert.equal(trace.status, 0, trace.stderr); const report = JSON.parse(trace.stdout) as CardOperationsReport;
  assert.equal(report.authorization?.decision, 'approved'); assert.equal(report.inbox?.id, inbox.id); sanitized(report);
  const read = run(['read', input.requestId]); assert.equal(read.status, 0, read.stderr);
  assert.deepEqual(JSON.parse(read.stdout), report);
  const replay = run(['trace-event', event.eventId, input.requestId, input.caseReference]); assert.equal(replay.status, 0, replay.stderr);
  assert.deepEqual(JSON.parse(replay.stdout), report);
  const inboxTrace = run(['trace-inbox', inbox.id, randomUUID(), input.caseReference]); assert.equal(inboxTrace.status, 0, inboxTrace.stderr);
  assert.equal((JSON.parse(inboxTrace.stdout) as CardOperationsReport).inbox?.status, 'applied');
  assert.deepEqual((await f.database.query('SELECT DISTINCT actor FROM card_operations_reports')).rows, [{ actor: f.ops.role }]);
  assert.doesNotMatch(trace.stdout + trace.stderr + read.stdout + read.stderr, /must-not-use|private@127|postgresql:\/\//);
});
