import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApiServer } from './http';
import { LedgerStore } from './ledger';

const production = process.env.NODE_ENV === 'production';
const dbPath = resolve(process.env.AQUA_DB_PATH ?? 'data/aqua.sqlite');
const host = process.env.AQUA_HOST ?? '127.0.0.1';
const port = Number(process.env.AQUA_PORT ?? 3001);
const origins = (process.env.AQUA_ALLOWED_ORIGINS ?? (production ? '' : 'http://localhost:5173,http://127.0.0.1:5173')).split(',').map((value) => value.trim()).filter(Boolean);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('AQUA_PORT must be a valid port.');
if (!origins.length || origins.some((origin) => {
  try { const url = new URL(origin); return url.origin !== origin || !['http:', 'https:'].includes(url.protocol) || (production && url.protocol !== 'https:'); }
  catch { return true; }
})) throw new Error('Set AQUA_ALLOWED_ORIGINS to exact origins; production requires HTTPS.');

// These files contain authentication records. Keep new database, WAL and mailbox files owner-only.
process.umask(0o077);
await mkdir(dirname(dbPath), { recursive: true, mode: 0o700 });
const store = new LedgerStore(dbPath);
const mailDirectory = resolve(process.env.AQUA_MAIL_DIR ?? 'data/mail');
const server = createApiServer(store, {
  allowedOrigins: origins,
  secureCookies: production,
  staticDir: process.env.AQUA_STATIC_DIR,
  deliverRecovery: production ? undefined : async (email, token) => {
    await mkdir(mailDirectory, { recursive: true, mode: 0o700 });
    await writeFile(resolve(mailDirectory, `${Date.now()}-${randomUUID()}.json`), JSON.stringify({ to: email, purpose: 'password-recovery', token, expiresInMinutes: 15 }, null, 2), { mode: 0o600, flag: 'wx' });
  },
});

server.listen(port, host, () => console.log(`Aqua sandbox API listening on http://${host}:${port}`));
let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  server.close(() => { store.close(); process.exitCode = 0; });
  server.closeIdleConnections();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
