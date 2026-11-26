import type { FastifyInstance } from 'fastify';
import type { Database } from './database';

export async function closeHttpService(app: Pick<FastifyInstance, 'close'> | undefined, database: Pick<Database, 'close'> | undefined) {
  try { await app?.close(); }
  finally { await database?.close(); }
}

export function drainOnShutdown(app: FastifyInstance, database: Database) {
  let closing = false;
  async function shutdown() {
    if (closing) return;
    closing = true;
    const deadline = setTimeout(() => process.exit(1), 20_000);
    deadline.unref();
    try { await closeHttpService(app, database); }
    catch { console.error('HTTP service shutdown failed.'); process.exitCode = 1; }
    finally { clearTimeout(deadline); }
  }
  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
}
