import { databaseFromEnvironment, type Database } from './database';
import { verifyMigrations } from './migrations';
import { reconcileRewards } from './reward-reconciliation';

async function run() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node dist-server/reconcile-rewards.js');
    console.log('Reads the internal monetary and reward ledgers. Exit 0: consistent; 1: discrepancies; 2: check could not complete.');
    return;
  }
  if (args.length) {
    console.error('Usage: node dist-server/reconcile-rewards.js');
    process.exitCode = 2;
    return;
  }
  let database: Database | undefined;
  try {
    database = await databaseFromEnvironment();
    await verifyMigrations(database);
    const report = await reconcileRewards(database);
    console.log(JSON.stringify(report));
    process.exitCode = report.ok ? 0 : 1;
  } catch {
    // SQL and connection errors can contain credentials or customer data. A failed
    // check is distinct from a completed check that found ledger discrepancies.
    console.error(JSON.stringify({ ok: false, code: 'RECONCILIATION_UNAVAILABLE', message: 'The internal ledger check could not complete. Check database access, migrations and the server logs.' }));
    process.exitCode = 2;
  } finally {
    try { await database?.close(); }
    catch { console.error('The reconciliation database connection could not close cleanly.'); process.exitCode = 2; }
  }
}

await run();
