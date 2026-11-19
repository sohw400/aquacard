import { approveTestCustomer } from './test-customer-access';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { CardInboxStore } from './card-inbox';
import { CardPaymentStore } from './card-payments';
import { Database } from './database';
import { LedgerError, LedgerStore } from './ledger';
import { applyMigrations, verifyMigrations } from './migrations';
import { RewardsStore } from './rewards';
import { reconcileRewards } from './reward-reconciliation';

test('authorization policy upgrade preserves pre-policy responses and settles old holds without fabricating an issuer card', async () => {
  if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required.');
  const schema = `test_auth_upgrade_${randomBytes(10).toString('hex')}`;
  const database = new Database({ connectionString: process.env.TEST_DATABASE_URL, schema });
  const directory = await mkdtemp(join(tmpdir(), 'aqua-auth-upgrade-'));
  try {
    const migrations = new URL('./migrations/', import.meta.url);
    for (const name of (await readdir(migrations)).filter((name) => /^00[1-6]_.*\.sql$/.test(name))) {
      await copyFile(new URL(name, migrations), join(directory, name));
    }
    await applyMigrations(database, pathToFileURL(directory + '/'));
    const ledger = new LedgerStore(database); const cards = new CardPaymentStore(database);
    const rewards = new RewardsStore(database); const inbox = new CardInboxStore(database);
    await ledger.createUser({ id: 'legacy', email: 'legacy@example.test', name: '기존 카드 회원', tag: 'legacy', passwordHash: 'test-only-hash', createdAt: 1_000 });
    await ledger.creditSandbox({ userId: 'legacy', amountWon: 30_000, idempotencyKey: 'legacy-principal' });
    await rewards.fundBudget({ amountWon: 30_000, idempotencyKey: 'legacy-company-budget' });
    await rewards.setProgram({ enabled: true, idempotencyKey: 'legacy-program' });
    await rewards.grant({ userId: 'legacy', amountWon: 2_000, idempotencyKey: 'legacy-rewards' });
    const event = { kind: 'authorize' as const, eventId: 'legacy-approved', paymentId: 'legacy-payment', userId: 'legacy', amountWon: 10_000, merchantName: '기존 가맹점' };
    const approved = await cards.apply(event);
    await cards.apply({ kind: 'capture', eventId: 'legacy-partial', paymentId: event.paymentId, userId: 'legacy', amountWon: 4_000, finalCapture: false });
    const pending = { ...event, eventId: 'legacy-not-processed', paymentId: 'legacy-pending-payment' };
    await inbox.enqueue(pending);
    const immutable = (await database.query('SELECT event_id,canonical_input,result FROM card_payment_events ORDER BY event_id')).rows;
    await applyMigrations(database); await verifyMigrations(database);
    assert.deepEqual((await database.query('SELECT event_id,canonical_input,result FROM card_payment_events ORDER BY event_id')).rows, immutable);
    assert.deepEqual(await cards.apply(event), approved);
    assert.equal((await database.query('SELECT COUNT(*)::int AS n FROM issuer_cards')).rows[0].n, 0);
    assert.equal((await database.query('SELECT COUNT(*)::int AS n FROM card_authorization_decisions')).rows[0].n, 0);
    await cards.apply({ kind: 'capture', eventId: 'legacy-final', paymentId: event.paymentId, userId: 'legacy', amountWon: 6_000, finalCapture: true });
    await cards.apply({ kind: 'refund', eventId: 'legacy-refund', paymentId: event.paymentId, userId: 'legacy', amountWon: 2_000 });
    assert.deepEqual(await cards.apply(event), approved);
    // The upgraded customer remains blocked until the trusted test fixture explicitly approves it.
    assert.equal((await ledger.snapshot('legacy')).access.status, 'unverified');
    await approveTestCustomer(database, 'legacy');
    await assert.rejects(cards.apply({ ...event, eventId: 'new-after-upgrade', paymentId: 'new-after-upgrade-payment' }),
      (error: unknown) => error instanceof LedgerError && error.code === 'CARD_NOT_ISSUED');
    const processed = await inbox.processNext(); assert.ok(processed);
    assert.deepEqual([processed.status, processed.errorCode], ['dead_letter', 'CARD_NOT_ISSUED'],
      'a pre-upgrade receipt is not a financial approval and must pass current policy when processed');
    assert.equal((await database.query("SELECT COUNT(*)::int AS n FROM card_authorization_decisions WHERE decision='approved'")).rows[0].n, 0);
    assert.equal((await database.query('SELECT COUNT(*)::int AS n FROM issuer_cards')).rows[0].n, 0);
    const report = await reconcileRewards(database); assert.equal(report.ok, true, JSON.stringify(report.findings));
  } finally {
    try { await database.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    finally { await database.close(); await rm(directory, { recursive: true, force: true }); }
  }
});
