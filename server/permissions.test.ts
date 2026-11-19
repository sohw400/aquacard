import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { Database } from './database';
import { LedgerStore } from './ledger';
import { CardPaymentStore } from './card-payments';
import { RewardsStore } from './rewards';
import { AuthService } from './auth';
import { grantApplicationRole, verifyApplicationRole } from './permissions';
import { verifyMigrations } from './migrations';
import { createTestDatabase } from './test-support';

test('a restricted runtime role can authenticate and post transfers but cannot edit balances, history or migrations', async () => {
  const fixture = await createTestDatabase();
  const role = 'app_' + randomBytes(10).toString('hex');
  const password = randomBytes(24).toString('hex');
  let runtime: Database | undefined;
  try {
    // Both identifiers and the generated password contain only known safe ASCII characters.
    await fixture.database.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    await grantApplicationRole(fixture.database, role);
    const url = new URL(fixture.connectionString); url.username = role; url.password = password;
    runtime = new Database({ connectionString: url.toString(), schema: fixture.schema });
    await verifyApplicationRole(runtime);
    await verifyMigrations(runtime);
    await assert.rejects(verifyApplicationRole(fixture.database), /restricted application/);
    const store = new LedgerStore(runtime);
    const auth = new AuthService(store);
    const alice = await auth.signup({ name: '테스트회원', tag: 'alice', email: 'alice@example.test', password: 'Runtime-password-42' }, 'test-ip');
    const bob = await auth.signup({ name: '받는회원', tag: 'bobby', email: 'bob@example.test', password: 'Runtime-password-42' }, 'test-ip');
    await new LedgerStore(fixture.database).creditSandbox({ userId: alice.user.id, amountWon: 20_000, idempotencyKey: 'restricted-role-seed' });
    const result = await store.transfer({ senderId: alice.user.id, recipientTag: 'bobby', amountWon: 7_000, idempotencyKey: 'restricted-role-transfer' });
    assert.equal(result.balanceWon, 13_000);
    assert.equal((await store.snapshot(bob.user.id)).balanceWon, 7_000);
    assert.equal((await auth.authenticate(alice.token))?.id, alice.user.id);
    await assert.rejects(runtime.query('UPDATE ledger_accounts SET balance_won = 9000'), /permission denied/);
    await assert.rejects(runtime.query('UPDATE ledger_accounts SET id = id'), /immutable/);
    await assert.rejects(runtime.query('DELETE FROM journals'), /permission denied/);
    await assert.rejects(runtime.query('TRUNCATE journals'), /permission denied/);
    await assert.rejects(runtime.query("UPDATE schema_migrations SET checksum = 'forged'"), /permission denied/);
    await assert.rejects(runtime.query('CREATE TABLE forged_table (id TEXT)'), /permission denied/);
    assert.equal((await store.snapshot(alice.user.id)).balanceWon, 13_000);
    const cards = new CardPaymentStore(runtime);
    await cards.apply({ kind: 'authorize', userId: alice.user.id, paymentId: 'limited-payment', eventId: 'limited-authorize', amountWon: 6_000, merchantName: '테스트 가맹점' });
    assert.equal((await store.snapshot(alice.user.id)).balanceWon, 7_000);
    assert.equal((await store.snapshot(alice.user.id)).heldBalanceWon, 6_000);
    await cards.apply({ kind: 'capture', userId: alice.user.id, paymentId: 'limited-payment', eventId: 'limited-capture', amountWon: 4_000, finalCapture: true });
    await cards.apply({ kind: 'refund', userId: alice.user.id, paymentId: 'limited-payment', eventId: 'limited-refund', amountWon: 1_000 });
    assert.equal((await store.snapshot(alice.user.id)).balanceWon, 10_000);
    for (const table of ['card_payments', 'card_payment_events']) {
      await assert.rejects(runtime.query(`DELETE FROM ${table}`), /permission denied/);
      await assert.rejects(runtime.query(`TRUNCATE ${table}`), /permission denied/);
    }
    await assert.rejects(runtime.query('UPDATE card_payments SET captured_won = 0'), /permission denied/);
    const original = (await runtime.query("SELECT * FROM journals WHERE kind LIKE 'card_%' LIMIT 1")).rows[0];
    assert.ok(original);
    const forged = { ...original, id: 'forged-card-journal', idempotency_key: 'forged-card-journal' };
    const columns = Object.keys(forged);
    const insertForged = `INSERT INTO journals (${columns.map((key) => '"' + key + '"').join(',')}) VALUES (${columns.map((_, index) => '$' + (index + 1)).join(',')})`;
    await assert.rejects(runtime.query(insertForged, Object.values(forged)));
    // Custom PostgreSQL settings are caller-controlled and cannot authorize a journal.
    await assert.rejects(runtime.transaction(async (client) => {
      await client.query("SELECT set_config('aqua.card_event_id', $1, true)", [original.card_event_id]);
      await client.query(insertForged, Object.values(forged));
    }));
    assert.equal((await store.snapshot(alice.user.id)).balanceWon, 10_000);
    assert.equal((await store.snapshot(alice.user.id)).heldBalanceWon, 0);
    // Corporate funding has no customer owner. That exception must not weaken
    // legacy transfer idempotency: NULL must remain forbidden for customer journals.
    const transferOriginal = (await runtime.query("SELECT * FROM journals WHERE kind = 'member_transfer' LIMIT 1")).rows[0];
    const ownerless = { ...transferOriginal, id: 'ownerless-transfer', idempotency_key: 'ownerless-transfer', request_owner_id: null, amount_won: '1000', balance_after_won: '9000' };
    const ownerlessColumns = Object.keys(ownerless);
    await assert.rejects(runtime.query(`INSERT INTO journals (${ownerlessColumns.map((key) => '"' + key + '"').join(',')}) VALUES (${ownerlessColumns.map((_, index) => '$' + (index + 1)).join(',')})`, Object.values(ownerless)), /journals_owner_guard/);
    assert.equal((await store.snapshot(alice.user.id)).balanceWon, 10_000);
    const operatorRewards = new RewardsStore(fixture.database);
    await operatorRewards.fundBudget({ amountWon: 100_000, idempotencyKey: 'restricted-company-budget' });
    await operatorRewards.setProgram({ enabled: true, idempotencyKey: 'restricted-program-on' });
    await operatorRewards.grant({ userId: alice.user.id, amountWon: 3_000, idempotencyKey: 'restricted-grant' });
    const rewards = new RewardsStore(runtime);
    assert.equal((await rewards.snapshot(alice.user.id)).availableWon, 3_000);
    assert.deepEqual(await rewards.setPreference({ userId: alice.user.id, useFirst: false, expectedVersion: 0, idempotencyKey: 'restricted-preference' }), { useFirst: false, version: 1 });
    for (const name of ['operator_fund_reward_budget', 'operator_set_reward_program', 'operator_grant_rewards', 'apply_sandbox_card_event_legacy_003']) {
      await assert.rejects(runtime.query(`SELECT ${name}('{}'::jsonb, 1000::bigint)`), /permission denied/);
    }
    for (const table of ['reward_wallets', 'reward_journals', 'reward_commands', 'reward_cash_plans', 'reward_cashback_months', 'card_reward_allocations', 'reward_program']) {
      await assert.rejects(runtime.query(`DELETE FROM ${table}`), /permission denied/);
      await assert.rejects(runtime.query(`TRUNCATE ${table}`), /permission denied/);
    }
    await assert.rejects(runtime.query('DELETE FROM reward_history'), /permission denied/);
    await assert.rejects(runtime.query('UPDATE reward_wallets SET available_won = 5000'), /permission denied/);
    await cards.apply({ kind: 'authorize', userId: alice.user.id, paymentId: 'funded-card', eventId: 'funded-authorize', amountWon: 2_000, merchantName: '리워드 가맹점' });
    await cards.apply({ kind: 'capture', userId: alice.user.id, paymentId: 'funded-card', eventId: 'funded-capture', amountWon: 1_000, finalCapture: true });
    assert.equal((await store.snapshot(alice.user.id)).balanceWon, 9_000);
    assert.equal((await rewards.snapshot(alice.user.id)).availableWon, 3_010);
    const rewardOriginal = (await runtime.query("SELECT * FROM journals WHERE reward_plan_id IS NOT NULL LIMIT 1")).rows[0];
    assert.ok(rewardOriginal);
    const rewardForged = { ...rewardOriginal, id: 'forged-reward-journal', idempotency_key: 'forged-reward-journal' };
    const rewardColumns = Object.keys(rewardForged);
    await assert.rejects(runtime.transaction(async (client) => {
      await client.query("SELECT set_config('aqua.reward_command_id', $1, true), set_config('aqua.card_event_id', $2, true)", [rewardOriginal.reward_command_id ?? '', rewardOriginal.card_event_id ?? '']);
      await client.query(`INSERT INTO journals (${rewardColumns.map((key) => '"' + key + '"').join(',')}) VALUES (${rewardColumns.map((_, index) => '$' + (index + 1)).join(',')})`, Object.values(rewardForged));
    }));
    await verifyApplicationRole(runtime);
    await fixture.database.query(`GRANT EXECUTE ON FUNCTION reward_post_cash(text,text,text,bigint,bigint) TO "${role}"`);
    await assert.rejects(verifyApplicationRole(runtime), /private ledger helper/);
    await fixture.database.query(`REVOKE EXECUTE ON FUNCTION reward_post_cash(text,text,text,bigint,bigint) FROM "${role}"`);
    await auth.logout(alice.token);
    assert.equal(await auth.authenticate(alice.token), null);
  } finally {
    await runtime?.close();
    await fixture.database.query(`DROP OWNED BY "${role}"`);
    await fixture.database.query(`DROP ROLE "${role}"`);
    await fixture.cleanup();
  }
});
