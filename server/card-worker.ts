import { cardServiceDatabase } from './card-service-database';
import { verifyMigrations } from './migrations';
import { verifyCardWorkerRole } from './permissions';
import { CardInboxStore } from './card-inbox';
import { runCardWorker } from './card-worker-loop';

async function run() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--once')) throw new Error('Use server:card:worker with no arguments or --once.');
  if (!process.env.WORKER_DATABASE_URL) throw new Error('Set WORKER_DATABASE_URL to the separate card worker login.');
  const pollMs = Number(process.env.AQUA_CARD_WORKER_POLL_MS ?? 1000);
  if (!Number.isInteger(pollMs) || pollMs < 250 || pollMs > 60_000) throw new Error('Invalid worker poll interval.');
  const database = await cardServiceDatabase('worker');
  const stop = new AbortController();
  let forcedExit: NodeJS.Timeout | undefined;
  const shutdown = () => {
    if (stop.signal.aborted) return;
    stop.abort();
    forcedExit = setTimeout(() => process.exit(1), 20_000);
    forcedExit.unref();
  };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
  try {
    await verifyMigrations(database);
    await verifyCardWorkerRole(database);
    const inbox = new CardInboxStore(database);
    if (args[0] === '--once') {
      if (stop.signal.aborted) return;
      const result = await inbox.processNext();
      const expiry = await inbox.expireHold();
      console.log(JSON.stringify({ event: 'card_inbox_once', result, holdExpired: expiry !== null }));
      if (result?.status === 'dead_letter') process.exitCode = 2;
    } else {
      await runCardWorker(inbox, { signal: stop.signal, pollMs, report: (event) => console.log(JSON.stringify(event)) });
    }
  } finally {
    try { await database.close(); }
    finally {
      process.off('SIGINT', shutdown); process.off('SIGTERM', shutdown);
      if (forcedExit) clearTimeout(forcedExit);
    }
  }
}

run().catch(() => {
  console.error(JSON.stringify({ event: 'card_worker_stopped', code: 'WORKER_UNAVAILABLE', message: 'Check worker configuration, database access, role grants and migrations.' }));
  process.exitCode = 1;
});
