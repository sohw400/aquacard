import { readFile } from 'node:fs/promises';
import { Database } from './database';
import { verifyMigrations } from './migrations';
import { verifyAuthMailRole } from './permissions';
import { AuthMailOutbox, authMailKeyringFromEnvironment } from './auth-mail';
import { authMailTransportFromEnvironment } from './auth-mail-transport';
import { dispatchAuthMailOnce, runAuthMailWorker } from './auth-mail-dispatch';

async function run() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--once')) throw new Error('Use server:mail:worker with no arguments or --once.');
  if (!process.env.AUTH_MAIL_DATABASE_URL) throw new Error('Set a separate AUTH_MAIL_DATABASE_URL for the delivery worker.');
  const keyring = authMailKeyringFromEnvironment();
  if (!keyring) throw new Error('Configure the auth mail encryption keyring before starting the delivery worker.');
  const pollMs = Number(process.env.AQUA_AUTH_MAIL_POLL_MS ?? 1000);
  if (!Number.isInteger(pollMs) || pollMs < 250 || pollMs > 60_000) throw new Error('Invalid auth mail polling interval.');
  process.umask(0o077);
  const transport = await authMailTransportFromEnvironment();
  const database = new Database({ connectionString: process.env.AUTH_MAIL_DATABASE_URL, schema: process.env.DATABASE_SCHEMA,
    maxConnections: 2, production: process.env.NODE_ENV === 'production',
    ca: process.env.DATABASE_CA_FILE ? await readFile(process.env.DATABASE_CA_FILE, 'utf8') : undefined });
  const stop = new AbortController();
  let forcedExit: NodeJS.Timeout | undefined;
  const shutdown = () => {
    if (stop.signal.aborted) return;
    stop.abort(); forcedExit = setTimeout(() => process.exit(1), 20_000); forcedExit.unref();
  };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
  try {
    await verifyMigrations(database); await verifyAuthMailRole(database);
    console.log(JSON.stringify({ event: 'auth_mail_worker_started' }));
    const outbox = new AuthMailOutbox(database);
    if (args[0] === '--once') {
      const result = await dispatchAuthMailOnce(outbox, transport, database.schema, keyring, stop.signal);
      console.log(JSON.stringify({ event: 'auth_mail_once', result }));
      if (result?.status === 'failed') process.exitCode = 2;
    } else await runAuthMailWorker(outbox, transport, database.schema, keyring,
      { signal: stop.signal, pollMs, report: (event) => console.log(JSON.stringify(event)) });
  } finally {
    try { transport.close?.(); await database.close(); }
    finally {
      process.off('SIGINT', shutdown); process.off('SIGTERM', shutdown);
      if (forcedExit) clearTimeout(forcedExit);
    }
  }
}
run().catch(() => {
  console.error(JSON.stringify({ event: 'auth_mail_worker_stopped', code: 'MAIL_WORKER_UNAVAILABLE', message: 'Check mail configuration, encryption keys, database role and migrations.' }));
  process.exitCode = 1;
});
