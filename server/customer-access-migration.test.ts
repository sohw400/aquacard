import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { CardInboxStore } from './card-inbox';
import { CardPaymentStore } from './card-payments';
import { CustomerAccessStore } from './customer-access';
import { Database } from './database';
import { IssuerOutboxStore } from './issuer-outbox';
import { LedgerError, LedgerStore } from './ledger';
import { applyMigrations, verifyMigrations } from './migrations';
import { reconcileRewards } from './reward-reconciliation';

test('customer access upgrade blocks existing members without rewriting historical decisions or stranding accepted holds', async () => {
  if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required.');
  const schema = `test_customer_upgrade_${randomBytes(8).toString('hex')}`;
  const database = new Database({ connectionString: process.env.TEST_DATABASE_URL, schema });
  const directory = await mkdtemp(join(tmpdir(), 'aqua-customer-upgrade-'));
  try {
    const migrations = new URL('./migrations/', import.meta.url);
    for (const name of (await readdir(migrations)).filter((name) => /^00[1-8]_.*\.sql$/.test(name))) {
      await copyFile(new URL(name, migrations), join(directory, name));
    }
    await applyMigrations(database, pathToFileURL(directory + '/'));
    const ledger = new LedgerStore(database); const cards = new CardPaymentStore(database);
    const inbox = new CardInboxStore(database); const issuer = new IssuerOutboxStore(database);
    await ledger.createUser({ id: 'legacy', email: 'legacy@example.test', name: '기존 회원', tag: 'legacy', passwordHash: 'test-only-hash', createdAt: 1_000 });
    await ledger.creditSandbox({ userId: 'legacy', amountWon: 30_000, idempotencyKey: 'legacy-principal' });
    await issuer.register({ userId: 'legacy', providerCardId: 'sandbox-card-legacy', initialStatus: 'active' });
    const event = { kind: 'authorize' as const, eventId: 'old-approval', paymentId: 'old-payment', userId: 'legacy', amountWon: 10_000, merchantName: '기존 가맹점' };
    const approved = await cards.apply(event);
    const oldDecision = (await database.query('SELECT * FROM card_authorization_decisions')).rows[0];
    const oldEvents = (await database.query('SELECT * FROM card_payment_events ORDER BY event_id')).rows;
    await inbox.enqueue({ ...event, eventId: 'received-not-approved', paymentId: 'pending-payment' });
    await applyMigrations(database); await verifyMigrations(database);
    assert.deepEqual((await database.query('SELECT * FROM card_payment_events ORDER BY event_id')).rows, oldEvents);
    const upgradedDecision = (await database.query('SELECT * FROM card_authorization_decisions')).rows[0];
    assert.deepEqual(upgradedDecision, { ...oldDecision, customer_status: null, customer_version: null });
    const access = await new CustomerAccessStore(database).snapshot('legacy');
    assert.equal(access.status, 'unverified'); assert.equal(access.version, 1); assert.equal(access.canTransact, false);
    assert.deepEqual(await cards.apply(event), approved);
    await cards.apply({ kind: 'capture', eventId: 'capture-after-upgrade', paymentId: event.paymentId, userId: 'legacy', amountWon: 4_000, finalCapture: false });
    await cards.apply({ kind: 'reverse', eventId: 'release-after-upgrade', paymentId: event.paymentId, userId: 'legacy' });
    await cards.apply({ kind: 'refund', eventId: 'refund-after-upgrade', paymentId: event.paymentId, userId: 'legacy', amountWon: 1_000 });
    await assert.rejects(cards.apply({ ...event, eventId: 'new-unverified', paymentId: 'new-unverified-payment' }),
      (error: unknown) => error instanceof LedgerError && error.code === 'CUSTOMER_ACCESS_REQUIRED');
    const processed = await inbox.processNext(); assert.ok(processed);
    assert.deepEqual([processed.status, processed.errorCode], ['dead_letter', 'CUSTOMER_ACCESS_REQUIRED']);
    const report = await reconcileRewards(database); assert.equal(report.ok, true, JSON.stringify(report.findings));
  } finally {
    try { await database.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    finally { await database.close(); await rm(directory, { recursive: true, force: true }); }
  }
});
