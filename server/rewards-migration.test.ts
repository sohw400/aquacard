import { approveTestCustomer } from './test-customer-access';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { Database } from './database';
import { applyMigrations, verifyMigrations } from './migrations';
import { LedgerStore } from './ledger';
import { CardPaymentStore } from './card-payments';
import { IssuerOutboxStore } from './issuer-outbox';
import { RewardsStore } from './rewards';

test('reward upgrade preserves old card responses and funding, and supports older API signups after migration', async () => {
  if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required.');
  const schema = 'test_reward_upgrade_' + randomBytes(10).toString('hex');
  const database = new Database({ connectionString: process.env.TEST_DATABASE_URL, schema });
  const directory = await mkdtemp(join(tmpdir(), 'aqua-reward-upgrade-'));
  try {
    for (const name of ['001_core.sql', '002_auth.sql', '003_card_payments.sql']) await copyFile(new URL('./migrations/' + name, import.meta.url), join(directory, name));
    await applyMigrations(database, pathToFileURL(directory + '/'));
    const ledger = new LedgerStore(database); const cards = new CardPaymentStore(database);
    await ledger.createUser({ id: 'legacy', email: 'legacy@example.test', name: '기존 회원', tag: 'legacy', passwordHash: 'test-only-hash', createdAt: 1000 });
    await ledger.creditSandbox({ userId: 'legacy', amountWon: 20_000, idempotencyKey: 'legacy-funding' });
    const originalEvent = { kind: 'authorize' as const, eventId: 'legacy-authorize', paymentId: 'legacy-payment', userId: 'legacy', amountWon: 10_000, merchantName: '기존 가맹점' };
    const original = await cards.apply(originalEvent);
    await cards.apply({ kind: 'capture', eventId: 'legacy-part', paymentId: 'legacy-payment', userId: 'legacy', amountWon: 4_000, finalCapture: false });
    const stored = (await database.query('SELECT event_id, canonical_input, result FROM card_payment_events ORDER BY event_id')).rows;
    await applyMigrations(database);
    await verifyMigrations(database);
    assert.deepEqual((await database.query('SELECT event_id, canonical_input, result FROM card_payment_events ORDER BY event_id')).rows, stored);
    assert.deepEqual(await cards.apply(originalEvent), original);
    const rewards = new RewardsStore(database);
    await rewards.fundBudget({ amountWon: 100_000, idempotencyKey: 'migration-budget' });
    await rewards.setProgram({ enabled: true, idempotencyKey: 'migration-program' });
    await rewards.grant({ userId: 'legacy', amountWon: 3_000, idempotencyKey: 'migration-grant' });
    await cards.apply({ kind: 'capture', eventId: 'legacy-final', paymentId: 'legacy-payment', userId: 'legacy', amountWon: 6_000, finalCapture: true });
    await cards.apply({ kind: 'refund', eventId: 'legacy-refund', paymentId: 'legacy-payment', userId: 'legacy', amountWon: 3_000 });
    const legacy = await ledger.snapshot('legacy');
    assert.equal(legacy.balanceWon, 13_000);
    assert.equal(legacy.rewards.availableWon, 3_000, 'old authorization must neither use new rewards nor earn retroactive cashback');
    assert.equal(legacy.rewards.cashback.confirmedWon, 0);
    assert.deepEqual(await cards.apply(originalEvent), original);
    await approveTestCustomer(database, 'legacy');
    await new IssuerOutboxStore(database).register({ userId: 'legacy', providerCardId: 'sandbox-card-legacy', initialStatus: 'active' });
    await cards.apply({ kind: 'authorize', eventId: 'new-reward-authorization', paymentId: 'new-reward-payment', userId: 'legacy', amountWon: 3_000, merchantName: '새 가맹점' });
    assert.equal((await ledger.snapshot('legacy')).balanceWon, 13_000);
    assert.equal((await ledger.snapshot('legacy')).rewards.heldWon, 3_000);
    // A running older API still creates just users + the original spend account.
    await database.transaction(async (client) => {
      await client.query("INSERT INTO users (id,email,name,tag,password_hash,created_at) VALUES ('rollout','rollout@example.test','전환 중 가입','rollout','test-only-hash',1000)");
      await client.query("INSERT INTO ledger_accounts (id,user_id,kind) VALUES ('user:rollout','rollout','user_spend')");
    });
    const fresh = await ledger.snapshot('rollout');
    assert.equal(fresh.rewards.availableWon, 0); assert.equal(fresh.rewards.useFirst, true); assert.equal(fresh.rewards.preferenceVersion, 0);
    assert.deepEqual(await rewards.setPreference({ userId: 'rollout', useFirst: false, expectedVersion: 0, idempotencyKey: 'rollout-pref' }), { useFirst: false, version: 1 });
  } finally {
    try { await database.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    finally { await database.close(); await rm(directory, { recursive: true, force: true }); }
  }
});
