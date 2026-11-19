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

test('upgrading an existing transfer database preserves funded accounts and creates empty card hold accounts', async () => {
  if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required.');
  const schema = 'test_card_upgrade_' + randomBytes(10).toString('hex');
  const database = new Database({ connectionString: process.env.TEST_DATABASE_URL, schema });
  const directory = await mkdtemp(join(tmpdir(), 'aqua-card-upgrade-'));
  try {
    for (const name of ['001_core.sql', '002_auth.sql']) await copyFile(new URL('./migrations/' + name, import.meta.url), join(directory, name));
    await applyMigrations(database, pathToFileURL(directory + '/'));
    await database.transaction(async (client) => {
      await client.query("INSERT INTO users (id,email,name,tag,password_hash,created_at) VALUES ('legacy','legacy@example.test','기존 회원','legacy','test-only-hash',1000)");
      await client.query("INSERT INTO ledger_accounts (id,user_id,kind) VALUES ('user:legacy','legacy','user_spend')");
      await client.query(`INSERT INTO journals (id,kind,from_account_id,to_account_id,amount_won,sender_id,recipient_id,
        sender_name,sender_tag,recipient_name,recipient_tag,request_owner_id,idempotency_key,request_payload,balance_after_won,created_at)
        VALUES ('legacy-credit','sandbox_credit','system:sandbox','user:legacy',20000,NULL,'legacy',
          '테스트 충전','sandbox','기존 회원','legacy','legacy','legacy-credit-key','legacy-payload',20000,1001)`);
    });
    const history = (await database.query('SELECT id, kind, amount_won, idempotency_key, request_payload FROM journals ORDER BY id')).rows;
    await applyMigrations(database);
    await verifyMigrations(database);
    assert.deepEqual((await database.query('SELECT id, kind, amount_won, idempotency_key, request_payload FROM journals ORDER BY id')).rows, history);
    const store = new LedgerStore(database);
    const before = await store.snapshot('legacy');
    assert.equal(before.balanceWon, 20_000);
    assert.equal(before.heldBalanceWon, 0);
    assert.equal(before.totalBalanceWon, 20_000);
    assert.deepEqual(before.cardPayments, []);
    assert.equal(before.transactions[0].id, 'legacy-credit');
    const cards = new CardPaymentStore(database);
    await cards.apply({ kind: 'authorize', eventId: 'legacy-authorization', paymentId: 'legacy-payment', userId: 'legacy', amountWon: 7_000, merchantName: '테스트 가맹점' });
    const after = await store.snapshot('legacy');
    assert.equal(after.balanceWon, 13_000);
    assert.equal(after.heldBalanceWon, 7_000);
    assert.equal(after.totalBalanceWon, 20_000);
    await applyMigrations(database);
    assert.deepEqual(await store.snapshot('legacy'), after, 'rerunning the migration must not reset existing holds');
    // During a rolling deployment an older API still inserts only the spend account.
    await database.transaction(async (client) => {
      await client.query("INSERT INTO users (id,email,name,tag,password_hash,created_at) VALUES ('rollout','rollout@example.test','전환 중 가입','rollout','test-only-hash',1000)");
      await client.query("INSERT INTO ledger_accounts (id,user_id,kind) VALUES ('user:rollout','rollout','user_spend')");
    });
    assert.equal((await store.snapshot('rollout')).heldBalanceWon, 0);
    await store.creditSandbox({ userId: 'rollout', amountWon: 5_000, idempotencyKey: 'rollout-credit' });
    await cards.apply({ kind: 'authorize', eventId: 'rollout-authorization', paymentId: 'rollout-payment', userId: 'rollout', amountWon: 2_000, merchantName: '테스트 가맹점' });
    assert.equal((await store.snapshot('rollout')).balanceWon, 3_000);
    assert.equal((await store.snapshot('rollout')).heldBalanceWon, 2_000);
  } finally {
    try { await database.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    finally { await database.close(); await rm(directory, { recursive: true, force: true }); }
  }
});
