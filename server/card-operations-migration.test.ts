import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { CardOperationsStore } from './card-operations';
import { CardPaymentStore } from './card-payments';
import { Database } from './database';
import { LedgerStore } from './ledger';
import { applyMigrations, verifyMigrations } from './migrations';
import { RewardsStore } from './rewards';
import { reconcileRewards } from './reward-reconciliation';

async function financialHistory(database: Database) {
  const tables = ['ledger_accounts', 'journals', 'journal_entries', 'card_payments', 'card_payment_events',
    'reward_wallets', 'reward_journals', 'reward_entries', 'card_reward_allocations', 'reward_cashback_months'];
  return Object.fromEntries(await Promise.all(tables.map(async (table) => [table,
    (await database.query(`SELECT to_jsonb(t) AS record FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows] as const)));
}

test('operations migration traces legacy approvals without inventing policy history and freezes each committed observation', async () => {
  if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required.');
  const schema = `test_ops_upgrade_${randomBytes(10).toString('hex')}`;
  const database = new Database({ connectionString: process.env.TEST_DATABASE_URL, schema });
  const directory = await mkdtemp(join(tmpdir(), 'aqua-ops-upgrade-'));
  try {
    const migrations = new URL('./migrations/', import.meta.url);
    for (const name of (await readdir(migrations)).filter((name) => /^00[1-6]_.*\.sql$/.test(name))) {
      await copyFile(new URL(name, migrations), join(directory, name));
    }
    await applyMigrations(database, pathToFileURL(directory + '/'));
    const ledger = new LedgerStore(database); const cards = new CardPaymentStore(database);
    const rewards = new RewardsStore(database);
    await ledger.createUser({ id: 'legacy', email: 'private-legacy@example.test', name: '기존 결제 회원', tag: 'legacy',
      passwordHash: 'private-legacy-password-hash', createdAt: 1_000 });
    await ledger.creditSandbox({ userId: 'legacy', amountWon: 30_000, idempotencyKey: 'legacy-principal' });
    await rewards.fundBudget({ amountWon: 30_000, idempotencyKey: 'legacy-company-budget' });
    await rewards.setProgram({ enabled: true, idempotencyKey: 'legacy-program' });
    await rewards.grant({ userId: 'legacy', amountWon: 2_000, idempotencyKey: 'legacy-reward-grant' });
    const event = { kind: 'authorize' as const, eventId: 'legacy-approved', paymentId: 'legacy-payment', userId: 'legacy',
      amountWon: 10_000, merchantName: 'private-legacy-merchant' };
    const approved = await cards.apply(event);
    await cards.apply({ kind: 'capture', eventId: 'legacy-partial', paymentId: event.paymentId, userId: 'legacy', amountWon: 4_000, finalCapture: false });
    const beforeUpgrade = await financialHistory(database);

    await applyMigrations(database); await verifyMigrations(database);
    assert.deepEqual(await financialHistory(database), beforeUpgrade);
    assert.deepEqual(await cards.apply(event), approved);
    const operations = new CardOperationsStore(database);
    const input = { requestId: randomUUID(), lookup: { kind: 'event' as const, id: event.eventId }, caseReference: 'CASE-LEGACY' };
    const initial = await operations.trace(input);
    assert.equal(initial.found, true);
    assert.equal(initial.correlation, 'single_source');
    assert.equal(initial.authorization, null, 'a pre-policy approval must not acquire a fabricated policy decision');
    assert.equal(initial.issuerCommand, null);
    assert.equal(initial.inbox, null);
    assert.equal(initial.ledgerEvent?.legacyPolicy, true);
    assert.equal(initial.ledgerEvent.kind, 'authorize');
    assert.equal(initial.ledgerEvent.amountWon, 10_000);
    assert.equal(initial.payment?.status, 'partially_captured');
    assert.deepEqual([initial.payment.authorizedWon, initial.payment.heldWon, initial.payment.capturedWon], [10_000, 6_000, 4_000]);
    assert.doesNotMatch(JSON.stringify(initial), /private-legacy|passwordHash|merchantName|canonical_input|request_key|lease_token/);
    assert.deepEqual(await financialHistory(database), beforeUpgrade, 'inspection must not alter the financial state');
    assert.equal((await database.query('SELECT COUNT(*)::int AS n FROM issuer_cards')).rows[0].n, 0);
    assert.equal((await database.query('SELECT COUNT(*)::int AS n FROM card_authorization_decisions')).rows[0].n, 0);

    await cards.apply({ kind: 'capture', eventId: 'legacy-final', paymentId: event.paymentId, userId: 'legacy', amountWon: 6_000, finalCapture: true });
    await cards.apply({ kind: 'refund', eventId: 'legacy-refund', paymentId: event.paymentId, userId: 'legacy', amountWon: 2_000 });
    assert.deepEqual(await cards.apply(event), approved, 'legacy approval replay retains its original response after settlement');
    const afterSettlement = await financialHistory(database);
    assert.deepEqual(await operations.read(input.requestId), initial);
    assert.deepEqual(await operations.trace(input), initial, 'reusing a report request returns the original observation');
    const current = await operations.trace({ ...input, requestId: randomUUID() });
    assert.equal(current.authorization, null);
    assert.equal(current.ledgerEvent?.legacyPolicy, true);
    assert.equal(current.payment?.status, 'partially_refunded');
    assert.deepEqual([current.payment.heldWon, current.payment.capturedWon, current.payment.refundedWon], [0, 10_000, 2_000]);
    assert.deepEqual(await financialHistory(database), afterSettlement);
    assert.equal((await database.query('SELECT COUNT(*)::int AS n FROM card_operations_reports')).rows[0].n, 2);
    assert.equal((await database.query('SELECT COUNT(*)::int AS n FROM issuer_cards')).rows[0].n, 0);
    assert.equal((await database.query('SELECT COUNT(*)::int AS n FROM card_authorization_decisions')).rows[0].n, 0);
    const reconciliation = await reconcileRewards(database);
    assert.equal(reconciliation.ok, true, JSON.stringify(reconciliation.findings));
  } finally {
    try { await database.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    finally { await database.close(); await rm(directory, { recursive: true, force: true }); }
  }
});
