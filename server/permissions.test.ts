import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { Database } from './database';
import { LedgerStore } from './ledger';
import { CardPaymentStore } from './card-payments';
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
    await auth.logout(alice.token);
    assert.equal(await auth.authenticate(alice.token), null);
  } finally {
    await runtime?.close();
    await fixture.database.query(`DROP OWNED BY "${role}"`);
    await fixture.database.query(`DROP ROLE "${role}"`);
    await fixture.cleanup();
  }
});
