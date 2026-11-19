import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { CustomerAccessStore } from './customer-access';
import { Database } from './database';
import { LedgerError, LedgerStore } from './ledger';
import { createTestDatabase } from './test-support';

const execute = promisify(execFile);
const cli = ['--import', 'tsx', 'server/customer-access-operator.ts'];

test('sandbox customer state changes are rejected in production before opening a database connection', async () => {
  const prior = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    const store = new CustomerAccessStore(undefined as unknown as Database);
    await assert.rejects(store.transition({ userId: 'alice', status: 'active', expectedVersion: 1,
      idempotencyKey: 'production-attempt', reason: 'This production attempt must be rejected.' }),
    (error: unknown) => error instanceof LedgerError && error.code === 'SANDBOX_DISABLED');
  } finally {
    if (prior === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prior;
  }
  await assert.rejects(execute(process.execPath, [...cli, 'set', 'alice', 'active', '1', 'production-attempt', 'This production attempt must be rejected.'], {
    env: { ...process.env, NODE_ENV: 'production', DATABASE_URL: 'invalid', MIGRATION_DATABASE_URL: 'invalid' },
  }), (error: unknown) => {
    const result = error as { code: number; stderr: string; stdout: string };
    assert.equal(result.code, 1); assert.match(result.stderr, /disabled in production/); assert.equal(result.stdout, ''); return true;
  });
});

test('trusted sandbox CLI records one audited state change and replays without another transition', async () => {
  const fixture = await createTestDatabase();
  try {
    await new LedgerStore(fixture.database).createUser({ id: 'cli-member', email: 'cli@example.test', name: 'CLI 고객', tag: 'cli.member',
      passwordHash: 'test-only-hash', createdAt: 1_000 });
    const env = { ...process.env, NODE_ENV: 'development', DATABASE_URL: fixture.connectionString,
      MIGRATION_DATABASE_URL: fixture.connectionString, DATABASE_SCHEMA: fixture.schema };
    const args = [...cli, 'set', 'cli-member', 'active', '1', 'cli-approval', 'Sandbox fixture approval with case reference.'];
    const first = JSON.parse((await execute(process.execPath, args, { env })).stdout);
    const second = JSON.parse((await execute(process.execPath, args, { env })).stdout);
    assert.equal(first.mode, 'sandbox'); assert.equal(first.status, 'active'); assert.equal(first.version, 2);
    assert.deepEqual(second, first);
    const current = JSON.parse((await execute(process.execPath, [...cli, 'status', 'cli-member'], { env })).stdout);
    assert.deepEqual(current, first);
    const history = (await fixture.database.query("SELECT version,source,reason FROM customer_access_events WHERE user_id='cli-member' ORDER BY version")).rows;
    assert.equal(history.length, 2); assert.equal(history[1].source, 'sandbox_operator');
    assert.equal(history[1].reason, 'Sandbox fixture approval with case reference.');
  } finally { await fixture.cleanup(); }
});
