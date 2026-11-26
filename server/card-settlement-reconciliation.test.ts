import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { SandboxCardEvent } from '../shared/api';
import { CardPaymentStore } from './card-payments';
import { IssuerOutboxStore } from './issuer-outbox';
import { LedgerStore } from './ledger';
import { reconcileRewards } from './reward-reconciliation';
import { RewardsStore } from './rewards';
import { approveTestCustomer } from './test-customer-access';
import { createTestDatabase } from './test-support';

const NOW = Date.UTC(2026, 10, 26);

async function fixture(t: TestContext) {
  const { database, cleanup } = await createTestDatabase();
  t.after(cleanup);
  const options = { now: () => NOW };
  const ledger = new LedgerStore(database, options);
  await ledger.createUser({ id: 'alice', email: 'alice@example.test', name: '대사 회원', tag: 'alice',
    passwordHash: 'test-only', createdAt: NOW });
  await approveTestCustomer(database, 'alice');
  await new IssuerOutboxStore(database, options).register({ userId: 'alice', providerCardId: 'sandbox-card-alice', initialStatus: 'active' });
  await ledger.creditSandbox({ userId: 'alice', amountWon: 1_000, idempotencyKey: 'test-settlement-fund' });
  return { database, ledger, cards: new CardPaymentStore(database, options), rewards: new RewardsStore(database, options) };
}

async function purchase(cards: CardPaymentStore, paymentId: string) {
  const base = { paymentId, userId: 'alice' };
  const events: SandboxCardEvent[] = [
    { ...base, kind: 'authorize', eventId: paymentId + '-auth', amountWon: 100, merchantName: '테스트 가게' },
    { ...base, kind: 'capture', eventId: paymentId + '-cap', amountWon: 100, finalCapture: true },
    { ...base, kind: 'refund', eventId: paymentId + '-refund', amountWon: 30 },
  ];
  for (const event of events) await cards.apply(event);
  return events;
}

test('100 captured and 30 refunded reconcile to 70 for both legacy principal and mixed reward settlement, including replay', async (t) => {
  const { database, cards, rewards, ledger } = await fixture(t);
  const legacyEvents = await purchase(cards, 'principal');
  // With the reward program off, the store uses its version 003 posting path.
  assert.equal((await database.query("SELECT 1 FROM card_reward_allocations WHERE payment_id='principal'")).rowCount, 0);
  const first = await ledger.snapshot('alice');
  for (const event of legacyEvents) await cards.apply(event);
  assert.deepEqual(await ledger.snapshot('alice'), first);
  assert.equal(first.balanceWon, 930);
  assert.equal(first.heldBalanceWon, 0);
  await rewards.fundBudget({ amountWon: 1_000, idempotencyKey: 'settlement-reward-budget' });
  await rewards.setProgram({ enabled: true, idempotencyKey: 'settlement-enable-rewards' });
  await rewards.grant({ userId: 'alice', amountWon: 40, idempotencyKey: 'settlement-grant' });
  await purchase(cards, 'mixed');
  const mixed = (await ledger.snapshot('alice')).cardPayments.find((payment) => payment.id === 'mixed');
  assert.deepEqual([mixed?.funding?.principal.capturedWon, mixed?.funding?.rewards.capturedWon], [60, 40]);
  assert.equal((await database.query("SELECT balance_won FROM ledger_accounts WHERE id='system:card_settlement'")).rows[0].balance_won, '140');
  const report = await reconcileRewards(database);
  assert.deepEqual(report.findings, []);
  assert.equal(report.ok, true);
});

test('opposite projection errors are found per payment even when each net amount and the control balance still match', async (t) => {
  const { database, cards } = await fixture(t);
  await purchase(cards, 'first');
  await purchase(cards, 'second');
  await database.transaction(async (client) => {
    // Only the random fixture schema is altered. Each receipt retains its net 70.
    await client.query('ALTER TABLE card_payments DISABLE TRIGGER USER');
    await client.query(`UPDATE card_payments p SET authorized_won = authorized_won + x.delta,
      captured_won = captured_won + x.delta, refunded_won = refunded_won + x.delta
      FROM (VALUES ('first', 1), ('second', -1)) x(id, delta) WHERE p.id = x.id`);
    await client.query('ALTER TABLE card_payments ENABLE TRIGGER USER');
  });
  const report = await reconcileRewards(database);
  assert.equal(report.ok, false);
  assert.equal(report.findings.some((finding) => finding.code === 'CARD_SETTLEMENT_BALANCE_MISMATCH'), false);
  for (const [reference, delta] of [['first', 1], ['second', -1]] as const) {
    for (const [code, expected] of [
      ['CARD_EVENT_AUTHORIZED_MISMATCH', 100], ['CARD_EVENT_CAPTURED_MISMATCH', 100],
      ['CARD_EVENT_REFUNDED_MISMATCH', 30], ['CARD_SETTLEMENT_CAPTURED_MISMATCH', 100],
      ['CARD_SETTLEMENT_REFUNDED_MISMATCH', 30],
    ] as const) {
      const finding = report.findings.find((finding) => finding.reference === reference && finding.code === code);
      assert.deepEqual(finding, { reference, code, expected: String(expected), actual: String(expected + delta) });
    }
  }
  assert.deepEqual((await reconcileRewards(database)).findings, report.findings);
});

test('two partial refunds with offsetting posting errors are identifiable by their original event IDs', async (t) => {
  const { database, cards } = await fixture(t);
  await purchase(cards, 'receipt');
  await cards.apply({ kind: 'refund', eventId: 'receipt-second-refund', paymentId: 'receipt', userId: 'alice', amountWon: 10 });
  await database.transaction(async (client) => {
    await client.query('ALTER TABLE journals DISABLE TRIGGER USER');
    await client.query(`UPDATE journals SET amount_won = CASE card_event_id WHEN 'receipt-refund' THEN 29 ELSE 11 END
      WHERE card_event_id IN ('receipt-refund', 'receipt-second-refund') AND kind = 'card_refund'`);
    await client.query('ALTER TABLE journals ENABLE TRIGGER USER');
  });
  const report = await reconcileRewards(database);
  assert.deepEqual(report.findings, [
    { code: 'CARD_EVENT_SETTLEMENT_REFUNDED_MISMATCH', reference: 'receipt-refund', expected: '30', actual: '29' },
    { code: 'CARD_EVENT_SETTLEMENT_REFUNDED_MISMATCH', reference: 'receipt-second-refund', expected: '10', actual: '11' },
  ]);
});

test('a zero-value receipt with no authorization and a damaged settlement control balance each generate a finding', async (t) => {
  const { database, cards } = await fixture(t);
  await purchase(cards, 'receipt');
  await database.transaction(async (client) => {
    await client.query('ALTER TABLE card_payments DISABLE TRIGGER USER');
    await client.query(`INSERT INTO card_payments (id, user_id, merchant_name, status, authorized_won, held_won,
      captured_won, released_won, refunded_won, created_at, updated_at)
      VALUES ('missing-auth', 'alice', '테스트 가게', 'cancelled', 0, 0, 0, 0, 0, $1, $1)`, [NOW]);
    await client.query('ALTER TABLE card_payments ENABLE TRIGGER USER');
    await client.query('ALTER TABLE ledger_accounts DISABLE TRIGGER USER');
    await client.query("UPDATE ledger_accounts SET balance_won=71 WHERE id='system:card_settlement'");
    await client.query('ALTER TABLE ledger_accounts ENABLE TRIGGER USER');
  });
  const report = await reconcileRewards(database);
  assert.deepEqual(report.findings.find((finding) => finding.code === 'CARD_EVENT_AUTHORIZATION_COUNT_MISMATCH'),
    { code: 'CARD_EVENT_AUTHORIZATION_COUNT_MISMATCH', reference: 'missing-auth', expected: '1', actual: '0' });
  assert.deepEqual(report.findings.find((finding) => finding.code === 'CARD_SETTLEMENT_BALANCE_MISMATCH'),
    { code: 'CARD_SETTLEMENT_BALANCE_MISMATCH', reference: 'system:card_settlement', expected: '70', actual: '71' });
});

test('equal captures booked against each other’s receipts and malformed event amounts are reported without leaking the input', async (t) => {
  const { database, cards } = await fixture(t);
  await purchase(cards, 'first');
  await purchase(cards, 'second');
  const swapped = await database.transaction(async (client) => {
    await client.query('ALTER TABLE journals DISABLE TRIGGER USER');
    const { rows } = await client.query<{ id: string }>(`UPDATE journals SET card_payment_id =
      CASE card_payment_id WHEN 'first' THEN 'second' ELSE 'first' END
      WHERE kind='card_capture' AND card_payment_id IN ('first', 'second') RETURNING id`);
    await client.query('ALTER TABLE journals ENABLE TRIGGER USER');
    await client.query('ALTER TABLE card_payment_events DISABLE TRIGGER USER');
    await client.query(`UPDATE card_payment_events SET canonical_input = jsonb_set(canonical_input, '{amountWon}', to_jsonb($1::text))
      WHERE event_id='second-refund'`, ['private-malformed-amount']);
    await client.query('ALTER TABLE card_payment_events ENABLE TRIGGER USER');
    return rows.map((row) => row.id).sort();
  });
  const report = await reconcileRewards(database);
  assert.equal(swapped.length, 2);
  assert.deepEqual(report.findings.filter((f) => f.code === 'CARD_SETTLEMENT_EVENT_LINK_MISMATCH').map((f) => f.reference).sort(), swapped);
  assert.ok(report.findings.some((f) => f.code === 'CARD_EVENT_AMOUNT_INVALID' && f.reference === 'second-refund'));
  assert.equal(report.findings.some((f) => f.code === 'CARD_SETTLEMENT_CAPTURED_MISMATCH' || f.code === 'CARD_SETTLEMENT_BALANCE_MISMATCH'), false);
  assert.doesNotMatch(JSON.stringify(report), /private-malformed-amount|alice@example.test|테스트 가게/);
});
