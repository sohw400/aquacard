import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test, { type TestContext } from 'node:test';
import { CardPaymentStore } from './card-payments';
import { LedgerStore } from './ledger';
import { RewardsStore } from './rewards';
import { reconcileRewards } from './reward-reconciliation';
import { createTestDatabase } from './test-support';

const NOW = Date.UTC(2026, 10, 19, 3);

async function fixture(t: TestContext) {
  const context = await createTestDatabase();
  t.after(context.cleanup);
  const options = { now: () => NOW };
  const ledger = new LedgerStore(context.database, options);
  const rewards = new RewardsStore(context.database, options);
  const cards = new CardPaymentStore(context.database, options);
  await ledger.createUser({ id: 'alice', email: 'alice@example.test', name: '대사 테스트', tag: 'alice', passwordHash: 'test-only-hash', createdAt: NOW - 90 * 86_400_000 });
  return { ...context, ledger, rewards, cards };
}

test('internal reconciliation remains consistent through funded holds and cumulative capture/refund rounding', async (t) => {
  const f = await fixture(t);
  assert.equal((await reconcileRewards(f.database)).ok, true);
  await f.ledger.creditSandbox({ userId: 'alice', amountWon: 100_000, idempotencyKey: 'audit-principal-fund' });
  await f.rewards.fundBudget({ amountWon: 100_000, idempotencyKey: 'audit-budget-fund' });
  await f.rewards.setProgram({ enabled: true, idempotencyKey: 'audit-program-enable' });
  await f.rewards.grant({ userId: 'alice', amountWon: 3_001, idempotencyKey: 'audit-reward-grant' });
  await f.cards.apply({ kind: 'authorize', eventId: 'audit-authorize', paymentId: 'audit-payment', userId: 'alice', amountWon: 10_001, merchantName: '대사 테스트 서점' });
  assert.equal((await reconcileRewards(f.database)).ok, true);
  await f.cards.apply({ kind: 'capture', eventId: 'audit-capture-rounding', paymentId: 'audit-payment', userId: 'alice', amountWon: 1, finalCapture: false });
  assert.equal((await reconcileRewards(f.database)).ok, true);
  await f.cards.apply({ kind: 'capture', eventId: 'audit-capture', paymentId: 'audit-payment', userId: 'alice', amountWon: 6_000, finalCapture: true });
  assert.equal((await reconcileRewards(f.database)).ok, true);
  await f.cards.apply({ kind: 'refund', eventId: 'audit-refund-rounding', paymentId: 'audit-payment', userId: 'alice', amountWon: 1 });
  assert.equal((await reconcileRewards(f.database)).ok, true);
  await f.cards.apply({ kind: 'refund', eventId: 'audit-refund', paymentId: 'audit-payment', userId: 'alice', amountWon: 3_000 });
  const before = await f.ledger.snapshot('alice');
  const report = await reconcileRewards(f.database);
  assert.equal(report.ok, true, JSON.stringify(report.findings));
  assert.equal(report.findingCount, '0');
  assert.deepEqual(report.findings, []);
  assert.match(report.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(await f.ledger.snapshot('alice'), before, 'reconciliation must not repair or mutate the ledger');
  assert.equal(before.balanceWon, 97_900);
  assert.equal(before.rewards.availableWon, 2_122);
});

test('uncollected cashback adjustment is reconciled separately from protected reward holds and principal', async (t) => {
  const f = await fixture(t);
  await f.ledger.creditSandbox({ userId: 'alice', amountWon: 10_000, idempotencyKey: 'audit-debt-principal' });
  await f.rewards.fundBudget({ amountWon: 10_000, idempotencyKey: 'audit-debt-budget' });
  await f.rewards.setProgram({ enabled: true, idempotencyKey: 'audit-debt-enable' });
  await f.cards.apply({ kind: 'authorize', eventId: 'audit-debt-authorize', paymentId: 'audit-debt-payment', userId: 'alice', amountWon: 10_000, merchantName: '대사 테스트 서점' });
  await f.cards.apply({ kind: 'capture', eventId: 'audit-debt-capture', paymentId: 'audit-debt-payment', userId: 'alice', amountWon: 10_000, finalCapture: true });
  await f.cards.apply({ kind: 'authorize', eventId: 'audit-earned-authorize', paymentId: 'audit-earned-payment', userId: 'alice', amountWon: 100, merchantName: '리워드 사용 테스트' });
  await f.cards.apply({ kind: 'refund', eventId: 'audit-debt-refund', paymentId: 'audit-debt-payment', userId: 'alice', amountWon: 10_000 });
  const held = await f.ledger.snapshot('alice');
  assert.equal(held.balanceWon, 10_000);
  assert.equal(held.rewards.availableWon, 0);
  assert.equal(held.rewards.heldWon, 100);
  assert.equal(held.rewards.adjustmentDueWon, 100);
  assert.equal((await reconcileRewards(f.database)).ok, true);
  await f.cards.apply({ kind: 'reverse', eventId: 'audit-earned-reverse', paymentId: 'audit-earned-payment', userId: 'alice' });
  const released = await f.ledger.snapshot('alice');
  assert.equal(released.balanceWon, 10_000);
  assert.equal(released.rewards.availableWon, 0);
  assert.equal(released.rewards.heldWon, 0);
  assert.equal(released.rewards.adjustmentDueWon, 0);
  assert.equal((await reconcileRewards(f.database)).ok, true);
});

test('reconciliation detects damaged reward and quota projections without repairing them and bounds its report', async (t) => {
  const f = await fixture(t);
  await f.ledger.creditSandbox({ userId: 'alice', amountWon: 10_000, idempotencyKey: 'audit-drift-principal' });
  await f.rewards.fundBudget({ amountWon: 10_000, idempotencyKey: 'audit-drift-budget' });
  await f.rewards.setProgram({ enabled: true, idempotencyKey: 'audit-drift-enable' });
  await f.rewards.grant({ userId: 'alice', amountWon: 3_000, idempotencyKey: 'audit-drift-grant' });
  await f.cards.apply({ kind: 'authorize', eventId: 'audit-drift-authorize', paymentId: 'audit-drift-payment', userId: 'alice', amountWon: 10_000, merchantName: '대사 테스트' });
  assert.equal((await reconcileRewards(f.database)).ok, true);
  const runCli = () => spawnSync(process.execPath, ['--import', 'tsx', 'server/reconcile-rewards.ts'], {
    env: { ...process.env, DATABASE_URL: f.connectionString, DATABASE_SCHEMA: f.schema, NODE_ENV: 'development' },
    encoding: 'utf8', timeout: 10_000,
  });
  const cleanCli = runCli();
  assert.equal(cleanCli.status, 0, cleanCli.stderr);
  assert.equal(JSON.parse(cleanCli.stdout).ok, true);

  // Only the schema owned by this fixture is damaged. Owner privileges let this
  // simulate historical corruption that the ordinary application role cannot do.
  await f.database.transaction(async (client) => {
    await client.query('ALTER TABLE reward_wallets DISABLE TRIGGER USER');
    await client.query("UPDATE reward_wallets SET available_won = available_won + 1 WHERE user_id = 'alice'");
    await client.query('ALTER TABLE reward_wallets ENABLE TRIGGER USER');
    await client.query('ALTER TABLE reward_cashback_months DISABLE TRIGGER USER');
    await client.query("UPDATE reward_cashback_months SET reserved_won = reserved_won + 1 WHERE user_id = 'alice'");
    await client.query('ALTER TABLE reward_cashback_months ENABLE TRIGGER USER');
  });

  const report = await reconcileRewards(f.database);
  assert.equal(report.ok, false);
  assert.ok(report.findings.some((f) => f.code === 'REWARD_AVAILABLE_MISMATCH' && f.expected === '0' && f.actual === '1'));
  assert.ok(report.findings.some((f) => f.code === 'REWARD_BACKING_MISMATCH' && f.expected === '3001' && f.actual === '3000'));
  assert.ok(report.findings.some((f) => f.code === 'CASHBACK_MONTH_RESERVED_MISMATCH' && f.expected === '70' && f.actual === '71'));
  const limited = await reconcileRewards(f.database, { maxFindings: 2 });
  assert.equal(limited.ok, false);
  assert.equal(limited.findings.length, 2);
  assert.equal(limited.findingCount, report.findingCount);
  assert.equal(limited.findingsTruncated, true);
  assert.deepEqual(limited.findings, report.findings.slice(0, 2));
  assert.doesNotMatch(JSON.stringify(report), /alice@example|test-only-hash|password|merchantName/);
  assert.deepEqual((await reconcileRewards(f.database)).findings, report.findings, 'audit must leave corruption intact for a separate operator repair process');
  const driftCli = runCli();
  assert.equal(driftCli.status, 1, driftCli.stderr);
  assert.equal(JSON.parse(driftCli.stdout).findingCount, report.findingCount);
  await assert.rejects(reconcileRewards(f.database, { maxFindings: 0 }), /maxFindings/);
  await assert.rejects(reconcileRewards(f.database, { maxFindings: 1_001 }), /maxFindings/);
});

test('monetary discrepancies retain exact decimal amounts beyond JavaScript integer precision', async (t) => {
  const f = await fixture(t);
  await f.ledger.createUser({ id: 'bob', email: 'bob@example.test', name: '정밀도 테스트', tag: 'bob', passwordHash: 'test-only-hash', createdAt: NOW });
  await f.ledger.creditSandbox({ userId: 'alice', amountWon: Number.MAX_SAFE_INTEGER, idempotencyKey: 'audit-large-alice' });
  await f.ledger.creditSandbox({ userId: 'bob', amountWon: Number.MAX_SAFE_INTEGER, idempotencyKey: 'audit-large-bob' });
  assert.equal((await reconcileRewards(f.database)).ok, true);
  await f.database.transaction(async (client) => {
    await client.query('ALTER TABLE ledger_accounts DISABLE TRIGGER USER');
    await client.query("UPDATE ledger_accounts SET balance_won = balance_won - 1 WHERE id = 'system:sandbox'");
    await client.query('ALTER TABLE ledger_accounts ENABLE TRIGGER USER');
  });
  const report = await reconcileRewards(f.database);
  assert.equal(report.ok, false);
  assert.deepEqual(report.findings, [{ code: 'MONETARY_BALANCE_MISMATCH', reference: 'system:sandbox', expected: '-18014398509481982', actual: '-18014398509481983' }]);
});

test('reconciliation CLI distinguishes configuration failure from a completed clean report without leaking credentials', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'server/reconcile-rewards.ts'], {
    env: { ...process.env, DATABASE_URL: 'postgresql://private-user:private-password@127.0.0.1:1/unused', NODE_ENV: 'development' },
    encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /RECONCILIATION_UNAVAILABLE/);
  assert.doesNotMatch(result.stderr, /private-user|private-password|postgresql:/);
});
