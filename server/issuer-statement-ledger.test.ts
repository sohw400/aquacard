import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { CardPaymentStore } from './card-payments';
import { IssuerOutboxStore } from './issuer-outbox';
import { readIssuerStatementLedger } from './issuer-statement-ledger';
import { LedgerStore } from './ledger';
import { RewardsStore } from './rewards';
import { approveTestCustomer } from './test-customer-access';
import { createTestDatabase } from './test-support';

const start = Date.parse('2025-11-26T00:00:00.000+09:00');
const day = 86_400_000;
const end = start + day;
const card = { paymentId: 'purchase', userId: 'alice' };
const capture = { ...card, kind: 'capture', eventId: 'captured', amountWon: 100, finalCapture: true } as const;

async function fixture(t: TestContext) {
  const { database, cleanup } = await createTestDatabase();
  t.after(cleanup);
  let time = start - 1;
  const options = { now: () => time };
  const ledger = new LedgerStore(database, options);
  await ledger.createUser({ id: 'alice', email: 'alice@example.test', name: '대사 회원', tag: 'alice',
    passwordHash: 'test-only', createdAt: time });
  await approveTestCustomer(database, 'alice');
  await new IssuerOutboxStore(database, options).register({
    userId: 'alice', providerCardId: 'sandbox-card-alice', initialStatus: 'active',
  });
  await ledger.creditSandbox({ userId: 'alice', amountWon: 1_000, idempotencyKey: 'statement-load' });
  return { database, cards: new CardPaymentStore(database, options), rewards: new RewardsStore(database, options),
    at(ms: number) { time = ms; } };
}

test('closed KST day sums principal and rewards by actual posting direction, including partial refunds and replay', async t => {
  const { database, cards, rewards, at } = await fixture(t);
  await rewards.fundBudget({ amountWon: 500, idempotencyKey: 'statement-budget' });
  await rewards.setProgram({ enabled: true, idempotencyKey: 'statement-enabled' });
  await rewards.grant({ userId: 'alice', amountWon: 40, idempotencyKey: 'statement-grant' });
  await cards.apply({ ...card, kind: 'authorize', eventId: 'authorized', amountWon: 110, merchantName: '테스트 가게' });
  at(start);
  await cards.apply(capture);
  at(end - 1);
  await cards.apply({ ...card, kind: 'refund', eventId: 'refund-first', amountWon: 80 });
  at(end);
  await cards.apply({ ...card, kind: 'refund', eventId: 'refund-second', amountWon: 20 });
  await cards.apply(capture);
  const splits = await database.query(`SELECT leg.amount_won FROM journal_entries leg JOIN journals j ON j.id = leg.journal_id
    WHERE leg.account_id = 'system:card_settlement' AND j.card_event_id = 'captured' ORDER BY leg.amount_won`);
  assert.deepEqual(splits.rows.map(row => row.amount_won), ['36', '64']);
  assert.deepEqual(await readIssuerStatementLedger(database, start - day, start), []);
  assert.deepEqual(await readIssuerStatementLedger(database, start, end), [
    { eventId: 'captured', paymentId: 'purchase', kind: 'capture', amountWon: '100' },
    { eventId: 'refund-first', paymentId: 'purchase', kind: 'refund', amountWon: '80' },
  ]);
  assert.deepEqual(await readIssuerStatementLedger(database, end, end + day), [
    { eventId: 'refund-second', paymentId: 'purchase', kind: 'refund', amountWon: '20' },
  ]);
});

test('legacy principal postings use booked amounts and stop on orphan settlement movements', async t => {
  const { database, cards, at } = await fixture(t);
  at(start);
  await cards.apply({ ...card, kind: 'authorize', eventId: 'authorized', amountWon: 100, merchantName: '테스트 가게' });
  await cards.apply(capture);
  // Simulate a receipt diverging from the actual journal in this isolated fixture.
  await database.transaction(async client => {
    await client.query('ALTER TABLE journals DISABLE TRIGGER USER');
    await client.query("UPDATE journals SET amount_won=99 WHERE card_event_id='captured'");
    await client.query('ALTER TABLE journals ENABLE TRIGGER USER');
  });
  assert.deepEqual(await readIssuerStatementLedger(database, start, end), [
    { eventId: 'captured', paymentId: 'purchase', kind: 'capture', amountWon: '99' },
  ]);
  await database.transaction(async client => {
    await client.query('ALTER TABLE journals DISABLE TRIGGER USER');
    await client.query(`UPDATE journals SET to_account_id='system:card_settlement', created_at=$1
      WHERE kind='sandbox_credit'`, [start]);
    await client.query('ALTER TABLE journals ENABLE TRIGGER USER');
  });
  await assert.rejects(readIssuerStatementLedger(database, start, end), { message: 'STATEMENT_LEDGER_INCONSISTENT' });
});

test('closed one-day bounds apply to both the reader and direct function calls', async t => {
  const { database, cleanup } = await createTestDatabase();
  t.after(cleanup);
  const readSql = (a: number | null, b: number | null) =>
    database.query('SELECT * FROM issuer_statement_postings($1, $2)', [a, b]);
  for (const [a, b] of [[start, end - 1], [start + 1, end + 1], [end, start], [start - day, end]]) {
    await assert.rejects(readIssuerStatementLedger(database, a, b), { message: 'STATEMENT_WINDOW_INVALID' });
    await assert.rejects(readSql(a, b), { code: '22023' });
  }
  await assert.rejects(readSql(null, end), { code: '22023' });
  const today = Math.floor((Date.now() + 32_400_000) / day) * day - 32_400_000;
  await assert.rejects(readSql(today, today + day), { code: '22023' });
  assert.deepEqual(await readIssuerStatementLedger(database, -32_400_000, day - 32_400_000), []);
});

test('unsafe opaque references are withheld from direct SQL and client reports', async t => {
  const { database, cards, at } = await fixture(t);
  at(start);
  await cards.apply({ ...card, kind: 'authorize', eventId: 'authorized', amountWon: 100, merchantName: '테스트 가게' });
  await cards.apply({ ...capture, eventId: 'local-9999-0000-1111-2222' });
  const day = await readIssuerStatementLedger(database, start, end);
  assert.equal(day.length, 1);
  assert.match(day[0].eventId, /^~e1\.[a-f0-9]{64}$/);
  assert.equal(day[0].paymentId, 'purchase');
  const direct = (await database.query('SELECT * FROM issuer_statement_postings($1,$2)', [start, end])).rows;
  assert.equal(direct[0].event_id, day[0].eventId);
  assert.doesNotMatch(JSON.stringify(direct), /9999-0000/);
});

test('conflicting directions stay separate and an isolated wrong event link blocks a match', async t => {
  const { database, cards, at } = await fixture(t);
  at(start);
  await cards.apply({ ...card, kind: 'authorize', eventId: 'authorized', amountWon: 100, merchantName: '테스트 가게' });
  await cards.apply(capture);
  await cards.apply({ ...card, kind: 'refund', eventId: 'refund', amountWon: 30 });
  async function changeRefundEvent(eventId: string) {
    await database.transaction(async client => {
      await client.query('ALTER TABLE journals DISABLE TRIGGER USER');
      await client.query("UPDATE journals SET card_event_id=$1 WHERE kind='card_refund'", [eventId]);
      await client.query('ALTER TABLE journals ENABLE TRIGGER USER');
    });
  }
  await changeRefundEvent('captured');
  assert.deepEqual(await readIssuerStatementLedger(database, start, end), [
    { eventId: 'captured', paymentId: 'purchase', kind: 'capture', amountWon: '100' },
    { eventId: 'captured', paymentId: 'purchase', kind: 'refund', amountWon: '30' },
  ]);
  await changeRefundEvent('authorized');
  await assert.rejects(readIssuerStatementLedger(database, start, end), { message: 'STATEMENT_LEDGER_INCONSISTENT' });
});

test('10,000 postings are complete and 10,001 fail the entire day', async t => {
  const { database, cards, at } = await fixture(t);
  at(start);
  await cards.apply({ ...card, kind: 'authorize', eventId: 'authorized', amountWon: 100, merchantName: '테스트 가게' });
  await cards.apply(capture);
  // Bulk-load copies of the real capture into the disposable schema for the row-limit check.
  await database.query('ALTER TABLE card_payment_events DISABLE TRIGGER USER');
  await database.query('ALTER TABLE journals DISABLE TRIGGER USER');
  async function addCaptures(first: number, last: number) {
    await database.transaction(async client => {
      await client.query(`INSERT INTO card_payment_events(event_id, payment_id, user_id, kind, canonical_input, result, created_at)
        SELECT 'batch-' || n, e.payment_id, e.user_id, e.kind, e.canonical_input, e.result, e.created_at
        FROM card_payment_events e CROSS JOIN generate_series($1::int,$2::int) n WHERE e.event_id='captured'`, [first, last]);
      await client.query(`INSERT INTO journals(id, kind, from_account_id, to_account_id, amount_won, sender_id, recipient_id,
          sender_name, sender_tag, recipient_name, recipient_tag, request_owner_id, idempotency_key, request_payload,
          balance_after_won, created_at, card_payment_id, card_event_id)
        SELECT 'posting-' || n, j.kind, j.from_account_id, j.to_account_id, j.amount_won, j.sender_id, j.recipient_id,
          j.sender_name, j.sender_tag, j.recipient_name, j.recipient_tag, j.request_owner_id, '$card:batch-' || n,
          j.request_payload, j.balance_after_won, j.created_at, j.card_payment_id, 'batch-' || n
        FROM journals j CROSS JOIN generate_series($1::int,$2::int) n WHERE j.card_event_id='captured'`, [first, last]);
    });
  }
  await addCaptures(1, 9999);
  const { rows } = await database.query('SELECT count(*) AS count FROM issuer_statement_postings($1, $2)', [start, end]);
  assert.equal(rows[0].count, '10000');
  await addCaptures(10000, 10000);
  await assert.rejects(readIssuerStatementLedger(database, start, end), { message: 'STATEMENT_LEDGER_CAPACITY' });
});
