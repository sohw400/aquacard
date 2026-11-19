import { cardServiceDatabase } from './card-service-database';
import { verifyMigrations } from './migrations';
import { verifyCardDispatcherRole } from './permissions';
import { IssuerOutboxStore } from './issuer-outbox';
import { createSandboxIssuerAdapter } from './issuer-adapter';
import { dispatchIssuerOnce, runIssuerDispatcher } from './issuer-dispatcher-loop';

async function run() {
  if (process.env.NODE_ENV === 'production') throw new Error('The sandbox issuer dispatcher is disabled in production.');
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--once')) throw new Error('Use server:issuer:dispatch with no arguments or --once.');
  const adapter = createSandboxIssuerAdapter({
    baseUrl: process.env.AQUA_ISSUER_SANDBOX_URL ?? '', keyId: process.env.AQUA_ISSUER_KEY_ID ?? '', signingKey: process.env.AQUA_ISSUER_SIGNING_KEY ?? '',
  });
  const pollMs = Number(process.env.AQUA_ISSUER_POLL_MS ?? 1000);
  if (!Number.isInteger(pollMs) || pollMs < 250 || pollMs > 60_000) throw new Error('Invalid issuer dispatcher poll interval.');
  const database = await cardServiceDatabase('dispatcher');
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
    await verifyCardDispatcherRole(database);
    const outbox = new IssuerOutboxStore(database);
    if (args[0] === '--once') {
      const result = await dispatchIssuerOnce(outbox, adapter, stop.signal);
      console.log(JSON.stringify({ event: 'issuer_dispatch_once', result }));
      // claim can move an expired command to review without returning a lease.
      // Report the committed result before a separate health read can fail.
      try {
        const health = await outbox.stats();
        console.log(JSON.stringify({ event: 'issuer_outbox_health', ...health }));
        if (health.needsReview !== '0') process.exitCode = 2;
      } catch {
        console.error(JSON.stringify({ event: 'issuer_outbox_health_unavailable' }));
        process.exitCode = 1;
      }
    } else await runIssuerDispatcher(outbox, adapter, { signal: stop.signal, pollMs, report: (event) => console.log(JSON.stringify(event)) });
  } finally {
    try { await database.close(); }
    finally {
      process.off('SIGINT', shutdown); process.off('SIGTERM', shutdown);
      if (forcedExit) clearTimeout(forcedExit);
    }
  }
}

run().catch(() => {
  console.error(JSON.stringify({ event: 'issuer_dispatcher_stopped', code: 'DISPATCHER_UNAVAILABLE', message: 'Check sandbox configuration, database access, dispatcher role and migrations.' }));
  process.exitCode = 1;
});
