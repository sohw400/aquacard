import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { CardInboxStore } from './card-inbox';
import { CardOperationsStore } from './card-operations';
import { CardPaymentStore } from './card-payments';
import { CustomerAccessStore } from './customer-access';
import { Database } from './database';
import { IssuerOutboxStore } from './issuer-outbox';
import { LedgerError, LedgerStore } from './ledger';
import { applyMigrations, verifyMigrations } from './migrations';
import { reconcileRewards } from './reward-reconciliation';

const NOW = Date.UTC(2026, 10, 26);

test('email policy upgrade requires new proof without rewriting customer decisions, card approvals, receipts or committed operations reports', async () => {
  if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required.');
  const schema = `test_email_upgrade_${randomBytes(8).toString('hex')}`;
  const database = new Database({ connectionString: process.env.TEST_DATABASE_URL, schema });
  const directory = await mkdtemp(join(tmpdir(), 'aqua-email-upgrade-'));
  try {
    const migrations = new URL('./migrations/', import.meta.url);
    for (const name of (await readdir(migrations)).filter((name) => /^\d{3}_.*\.sql$/.test(name) && Number(name.slice(0, 3)) <= 10)) {
      await copyFile(new URL(name, migrations), join(directory, name));
    }
    await applyMigrations(database, pathToFileURL(directory + '/'));
    const ledger = new LedgerStore(database, { now: () => NOW });
    const access = new CustomerAccessStore(database, { now: () => NOW });
    const cards = new CardPaymentStore(database, { now: () => NOW });
    const inbox = new CardInboxStore(database, { now: () => NOW });
    const issuer = new IssuerOutboxStore(database, { now: () => NOW });
    const operations = new CardOperationsStore(database);
    for (const id of ['legacy', 'bobby']) {
      await ledger.createUser({ id, email: `${id}@example.test`, name: '기존 회원', tag: id, passwordHash: 'test-only-hash', createdAt: 1_000 });
      await access.transition({ userId: id, status: 'active', expectedVersion: 1, idempotencyKey: `old-review-${id}`, reason: 'Historical customer approval before email ownership requirement.' });
      await ledger.creditSandbox({ userId: id, amountWon: 30_000, idempotencyKey: `legacy-principal-${id}` });
    }
    await issuer.register({ userId: 'legacy', providerCardId: 'sandbox-card-legacy', initialStatus: 'active' });
    const event = { kind: 'authorize' as const, eventId: 'old-approval', paymentId: 'old-payment', userId: 'legacy', amountWon: 10_000, merchantName: '기존 가맹점' };
    const approved = await cards.apply(event);
    const transfer = { senderId: 'legacy', recipientTag: 'bobby', amountWon: 1_000, idempotencyKey: 'old-transfer' };
    const sent = await ledger.transfer(transfer);
    const oldDecision = (await database.query('SELECT * FROM card_authorization_decisions')).rows[0];
    const oldCustomerEvents = (await database.query('SELECT * FROM customer_access_events ORDER BY user_id,version')).rows;
    const oldOpsInput = { requestId: randomUUID(), lookup: { kind: 'event' as const, id: event.eventId }, caseReference: 'before-email-policy' };
    const oldReport = await operations.trace(oldOpsInput);
    await inbox.enqueue({ ...event, eventId: 'received-before-proof', paymentId: 'pending-email-payment' });

    await applyMigrations(database); await verifyMigrations(database);
    assert.deepEqual((await database.query('SELECT * FROM customer_access_events ORDER BY user_id,version')).rows, oldCustomerEvents);
    assert.deepEqual((await database.query('SELECT * FROM card_authorization_decisions')).rows[0], { ...oldDecision, email_verified_at: null });
    assert.deepEqual(await operations.trace(oldOpsInput), oldReport, 'committed report payload is immutable');
    assert.deepEqual(await cards.apply(event), approved);
    assert.deepEqual(await ledger.transfer(transfer), sent);
    assert.equal((await ledger.snapshot('legacy')).user.emailVerifiedAt, null);
    assert.equal((await access.snapshot('legacy')).status, 'active');
    assert.equal((await access.snapshot('legacy')).canTransact, false);
    await assert.rejects(ledger.transfer({ ...transfer, idempotencyKey: 'new-unverified-transfer' }),
      (error: unknown) => error instanceof LedgerError && error.code === 'EMAIL_VERIFICATION_REQUIRED');
    await cards.apply({ kind: 'capture', eventId: 'capture-after-email-upgrade', paymentId: event.paymentId, userId: 'legacy', amountWon: 4_000, finalCapture: false });
    await cards.apply({ kind: 'reverse', eventId: 'release-after-email-upgrade', paymentId: event.paymentId, userId: 'legacy' });
    await cards.apply({ kind: 'refund', eventId: 'refund-after-email-upgrade', paymentId: event.paymentId, userId: 'legacy', amountWon: 1_000 });
    const denied = await inbox.processNext(); assert.ok(denied);
    assert.deepEqual([denied.status, denied.errorCode], ['dead_letter', 'EMAIL_VERIFICATION_REQUIRED']);
    const freshOldReport = await operations.trace({ ...oldOpsInput, requestId: randomUUID() });
    assert.deepEqual(freshOldReport.authorization?.customerAtDecision, { status: 'active', version: 2 });

    const token = randomBytes(32).toString('hex');
    await database.query('INSERT INTO auth_email_verification(token_hash,user_id,email,created_at,expires_at) VALUES($1,$2,$3,$4,$5)',
      [createHash('sha256').update(token).digest('hex'), 'legacy', 'legacy@example.test', NOW, NOW + 900_000]);
    await database.query('SELECT confirm_auth_email_verification($1::text,$2::text,$3::bigint)', ['legacy', token, NOW]);
    assert.equal((await access.snapshot('legacy')).canTransact, true);
    assert.equal((await cards.apply({ ...event, eventId: 'new-verified', paymentId: 'new-verified-payment' })).heldBalanceWon, 10_000);
    assert.deepEqual((await database.query('SELECT * FROM customer_access_events ORDER BY user_id,version')).rows, oldCustomerEvents);
    const reconciled = await reconcileRewards(database); assert.equal(reconciled.ok, true, JSON.stringify(reconciled.findings));
  } finally {
    try { await database.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    finally { await database.close(); await rm(directory, { recursive: true, force: true }); }
  }
});
