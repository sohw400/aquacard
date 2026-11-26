import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { Database } from './database';
import { isMonitorEnvironment, monitorResult } from './operations-monitor-metrics';
import { grantMonitorRole } from './permissions';
import type { QueueHealth } from './queue-health';
import { reconcileRewards } from './reward-reconciliation';
import { createTestDatabase } from './test-support';

function runCli(env: NodeJS.ProcessEnv, args: string[] = []) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'server/operations-monitor.ts', ...args], {
    env: { ...process.env, NODE_ENV: 'development', AQUA_MONITOR_ENVIRONMENT: 'test-ops', ...env },
    encoding: 'utf8', timeout: 25_000,
  });
  assert.ifError(result.error);
  return result;
}

test('only explicit deployment identifiers can become CloudWatch dimensions', () => {
  for (const value of ['a', 'us-east-1', 'a'.repeat(32)]) assert.equal(isMonitorEnvironment(value), true);
  for (const value of [undefined, '', '-qa', 'ops-', 'a'.repeat(33), 'Private@example.test']) assert.equal(isMonitorEnvironment(value), false);
  const bad = runCli({ AQUA_MONITOR_ENVIRONMENT: 'Private@example.test' });
  assert.equal(bad.status, 2);
  assert.equal(bad.stdout, '');
  assert.doesNotMatch(bad.stderr, /Private@example/);
  const missing = runCli({ MONITOR_DATABASE_URL: '', DATABASE_URL: 'private-placeholder', OPERATIONS_DATABASE_URL: 'private-operations' });
  assert.equal(missing.status, 2);
  const event = JSON.parse(missing.stdout);
  assert.deepEqual(event.failedChecks, ['connection']);
  assert.equal(event.MonitorHealthy, 0);
  assert.equal(Object.hasOwn(event, 'LedgerFindings'), false);
  assert.doesNotMatch(missing.stdout + missing.stderr, /private-/);
});

test('incomplete checks preserve independent incident metrics and report a separate execution failure', () => {
  const queues: QueueHealth = {
    cardInbox: { dueCount: 2, oldestDueSeconds: 301, recentFailures: 0, needsReview: 0, blockedCount: 3 },
    issuerOutbox: { dueCount: 0, oldestDueSeconds: 0, recentFailures: 0, needsReview: 1, blockedCount: 0 },
    authMail: { dueCount: 1, oldestDueSeconds: 24, recentFailures: 1, needsReview: 0, blockedCount: 0 },
  };
  const queueOnly = monitorResult('test-ops', { queues, failedChecks: ['ledger'] });
  assert.equal(queueOnly.exitCode, 2);
  const event = JSON.parse(JSON.stringify(queueOnly.event));
  assert.equal(event.MonitorHealthy, 0);
  assert.equal(Object.hasOwn(event, 'LedgerFindings'), false);
  assert.equal(event.CardInboxOldestDueSeconds, 301);
  assert.equal(event.CardInboxBlockedCount, 3);
  assert.equal(event.IssuerOutboxReviewCount, 1);
  assert.equal(event.AuthMailFailureCount, 1);
  assert.deepEqual(event._aws.CloudWatchMetrics[0].Dimensions, [['Environment']]);
  assert.equal(event._aws.CloudWatchMetrics[0].Namespace, 'AquaCard/Operations');
  assert.equal(event._aws.CloudWatchMetrics[0].Metrics.find((item: { Name: string }) => item.Name === 'CardInboxOldestDueSeconds').Unit, 'Seconds');
  const complete = monitorResult('test-ops', { queues, ledgerFindings: 0, failedChecks: [] });
  assert.equal(complete.exitCode, 1);
  const ledgerOnly = monitorResult('test-ops', { ledgerFindings: 2, failedChecks: ['queues'] });
  assert.equal(ledgerOnly.exitCode, 2);
  assert.equal(Object.hasOwn(ledgerOnly.event, 'CardInboxDueCount'), false);
});

test('scheduled CLI reports the same internal discrepancies as the operator, with only aggregate read access', async (t) => {
  const f = await createTestDatabase();
  const role = 'test_monitor_' + randomBytes(8).toString('hex');
  const password = randomBytes(24).toString('hex');
  const monitorUrl = new URL(f.connectionString);
  monitorUrl.username = role;
  monitorUrl.password = password;
  let monitor: Database | undefined;
  await f.database.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`);
  t.after(async () => {
    try {
      await monitor?.close();
      await f.database.query(`DROP OWNED BY "${role}"`);
      await f.database.query(`DROP ROLE "${role}"`);
    } finally { await f.cleanup(); }
  });
  await grantMonitorRole(f.database, role);
  monitor = new Database({ schema: f.schema, connectionString: monitorUrl.toString() });
  for (const sql of ['SELECT * FROM internal_ledger_findings()', 'SELECT * FROM ledger_accounts',
    'SELECT * FROM card_payment_events', "SELECT read_card_operations_report('no-case')"]) {
    await assert.rejects(monitor.query(sql), /permission denied/);
  }
  const env = { MONITOR_DATABASE_URL: monitorUrl.toString(), DATABASE_SCHEMA: f.schema };
  const clean = runCli(env);
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  const healthy = JSON.parse(clean.stdout);
  assert.equal(healthy.MonitorHealthy, 1);
  assert.equal(healthy.LedgerFindings, 0);
  assert.equal(healthy.Environment, 'test-ops');
  assert.equal(healthy.CardInboxDueCount, 0);
  assert.equal(healthy.IssuerOutboxReviewCount, 0);
  assert.equal(healthy.AuthMailOldestDueSeconds, 0);

  // Change a projection only in this disposable schema. The report must flag
  // both checks and the monitor must not log the affected account reference.
  await f.database.transaction(async (client) => {
    await client.query('ALTER TABLE ledger_accounts DISABLE TRIGGER USER');
    await client.query("UPDATE ledger_accounts SET balance_won = 1 WHERE id = 'system:card_settlement'");
    await client.query('ALTER TABLE ledger_accounts ENABLE TRIGGER USER');
  });
  const detailed = await reconcileRewards(f.database);
  assert.equal(detailed.findingCount, '2');
  const discrepancy = runCli(env);
  assert.equal(discrepancy.status, 1);
  assert.equal(JSON.parse(discrepancy.stdout).LedgerFindings, Number(detailed.findingCount));
  assert.equal(JSON.parse(discrepancy.stdout).MonitorHealthy, 1);
  assert.doesNotMatch(discrepancy.stdout + discrepancy.stderr, /system:|expected|actual|card_settlement|reference/);

  // Preserve this successfully discovered ledger issue when queue collection fails.
  await f.database.query(`CREATE OR REPLACE FUNCTION read_queue_health(p_now bigint) RETURNS JSONB
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
    BEGIN RAISE EXCEPTION 'private-queue-error'; END; $$`);
  const partial = runCli(env);
  const partiallyHealthy = JSON.parse(partial.stdout);
  assert.equal(partial.status, 2);
  assert.equal(partiallyHealthy.MonitorHealthy, 0);
  assert.deepEqual(partiallyHealthy.failedChecks, ['queues']);
  assert.equal(partiallyHealthy.LedgerFindings, 2);
  assert.equal(Object.hasOwn(partiallyHealthy, 'CardInboxDueCount'), false);
  assert.doesNotMatch(partial.stdout + partial.stderr, /private-queue-error/);

  const privileged = runCli({ ...env, MONITOR_DATABASE_URL: f.connectionString });
  assert.equal(privileged.status, 2);
  assert.deepEqual(JSON.parse(privileged.stdout).failedChecks, ['role']);
});
