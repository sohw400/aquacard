import { readFile } from 'node:fs/promises';
import { Database } from './database';
import { bootstrapMonitor, stagingCredentials } from './staging-bootstrap-store';

async function run() {
  if (process.argv.length !== 2) throw new Error('Unexpected arguments.');
  const credentials = stagingCredentials(process.env);
  const options = { schema: 'aqua', production: true, ca: await readFile(credentials.caFile, 'utf8'), maxConnections: 1 };
  const owner = new Database({ ...options, connectionString: credentials.adminUrl });
  const monitor = new Database({ ...options, connectionString: credentials.monitorUrl });
  try {
    await bootstrapMonitor(owner, monitor, { databaseName: 'aqua', adminRole: 'aqua_admin', monitorRole: 'aqua_monitor',
      monitorPassword: credentials.monitorPassword });
  } finally { await Promise.all([owner.close(), monitor.close()]); }
}
try {
  await run();
  console.log(JSON.stringify({ stagingMonitorBootstrap: 'complete' }));
} catch {
  // PostgreSQL errors may include connection information or password verifiers.
  console.error(JSON.stringify({ stagingMonitorBootstrap: 'failed' }));
  process.exitCode = 1;
}
