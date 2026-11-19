import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { LedgerError, LedgerStore } from './ledger';
import { RewardsStore } from './rewards';
import { createTestDatabase } from './test-support';

test('reward budget, activation and grant commands refuse production before using operator credentials', () => {
  for (const args of [['budget', '100000', 'test-budget'], ['program', 'on', 'test-program'], ['grant', 'test@example.test', '1000', 'test-grant']]) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'server/rewards-operator.ts', ...args], {
      env: { ...process.env, NODE_ENV: 'production', MIGRATION_DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/unused' }, encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(result.status, 1); assert.equal(result.stdout, '');
    assert.match(result.stderr, /disabled in production/);
    assert.doesNotMatch(result.stderr, /ECONNREFUSED|unused:unused/);
  }
});

test('an operator grant key cannot be reused for a different recipient', async (t) => {
  const fixture = await createTestDatabase();
  t.after(fixture.cleanup);
  const ledger = new LedgerStore(fixture.database); const rewards = new RewardsStore(fixture.database);
  for (const id of ['alice', 'bobby']) await ledger.createUser({ id, email: `${id}@example.test`, name: '테스트 회원', tag: id, passwordHash: 'test-only-hash', createdAt: 1000 });
  await rewards.fundBudget({ amountWon: 1000, idempotencyKey: 'operator-budget' });
  await rewards.setProgram({ enabled: true, idempotencyKey: 'operator-on' });
  const request = { userId: 'alice', amountWon: 100, idempotencyKey: 'operator-grant-intent' };
  const original = await rewards.grant(request);
  await assert.rejects(rewards.grant({ ...request, userId: 'bobby' }), (error: unknown) => error instanceof LedgerError && error.code === 'IDEMPOTENCY_CONFLICT');
  assert.deepEqual(await rewards.grant(request), original);
  assert.equal((await rewards.snapshot('alice')).availableWon, 100);
  assert.equal((await rewards.snapshot('bobby')).availableWon, 0);
});
