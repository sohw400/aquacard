import { writeSync } from 'node:fs';
import { cardServiceDatabase } from './card-service-database';
import type { Database } from './database';
import { verifyMigrations } from './migrations';
import { isMonitorEnvironment, monitorResult, type MonitorObservation } from './operations-monitor-metrics';
import { verifyMonitorRole } from './permissions';
import { readQueueHealth } from './queue-health';

async function ledgerFindingCount(database: Database): Promise<number> {
  return database.transaction(async (client) => {
    await client.query('SET TRANSACTION READ ONLY');
    await client.query("SET LOCAL statement_timeout = '30s'");
    const { rows } = await client.query<{ finding_count: string }>('SELECT operations_ledger_finding_count()::text AS finding_count');
    const raw = rows[0]?.finding_count;
    if (!raw || !/^(0|[1-9][0-9]*)$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
      throw new Error('Invalid aggregate count.');
    }
    return Number(raw);
  }, { isolation: 'repeatable read' });
}

const usage = 'Usage: node dist-server/operations-monitor.js';
async function run() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log(usage);
    console.log('Set AQUA_MONITOR_ENVIRONMENT and either MONITOR_DATABASE_URL or MONITOR_DATABASE_SECRET. Exit 0 for completed checks, 1 for ledger findings, review or recent failures, 2 for incomplete checks. Queue age thresholds are applied by CloudWatch.');
    return;
  }
  const environment = process.env.AQUA_MONITOR_ENVIRONMENT;
  if (args.length || !isMonitorEnvironment(environment)) {
    console.error(usage + '\nSet AQUA_MONITOR_ENVIRONMENT to a lowercase deployment name (1 to 32 characters).');
    process.exitCode = 2;
    return;
  }

  const observation: MonitorObservation = { failedChecks: [] };
  // PostgreSQL limits individual statements. Also bound the process if the
  // network drops mid-query or an idle socket never completes shutdown.
  const deadline = setTimeout(() => {
    observation.failedChecks.push('deadline');
    writeSync(1, JSON.stringify(monitorResult(environment, observation).event) + '\n');
    process.exit(2);
  }, 75_000);
  let database: Database | undefined;
  let preflight: 'connection' | 'migrations' | 'role' = 'connection';
  try {
    database = await cardServiceDatabase('monitor');
    preflight = 'migrations';
    await verifyMigrations(database);
    preflight = 'role';
    await verifyMonitorRole(database);
    // Preserve findings from each independent check when another query fails.
    await Promise.all([
      database.query<{ health: { budgetLow: boolean; unfunded24h: number } }>('SELECT reward_budget_health($1) AS health', [Date.now()])
        .then(({ rows }) => {
          const value = rows[0]?.health;
          if (!value || typeof value.budgetLow !== 'boolean' || !Number.isSafeInteger(value.unfunded24h) || value.unfunded24h < 0) throw new Error('Invalid reward budget signal.');
          observation.budget = value;
        }).catch(() => { observation.failedChecks.push('budget'); }),
      ledgerFindingCount(database).then((count) => { observation.ledgerFindings = count; },
        () => { observation.failedChecks.push('ledger'); }),
      readQueueHealth(database).then((queues) => { observation.queues = queues; },
        () => { observation.failedChecks.push('queues'); }),
    ]);
  } catch {
    observation.failedChecks.push(preflight);
  } finally {
    try { await database?.close(); }
    catch { observation.failedChecks.push('shutdown'); }
    clearTimeout(deadline);
  }
  const { event, exitCode } = monitorResult(environment, observation);
  console.log(JSON.stringify(event));
  process.exitCode = exitCode;
}

await run();
