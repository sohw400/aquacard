import { isIP } from 'node:net';
import { createApiServer, trustStagingLoadBalancer } from './http';
import { LedgerStore } from './ledger';
import { databaseFromEnvironment } from './database';
import { verifyMigrations } from './migrations';
import { verifyApplicationRole } from './permissions';
import { closeHttpService, drainOnShutdown } from './http-shutdown';
import { authMailQueueFromEnvironment, type AuthMailQueue } from './auth-mail';

const staging = process.env.NODE_ENV === 'staging';
const hardened = staging || process.env.NODE_ENV === 'production';
const host = process.env.AQUA_HOST ?? '127.0.0.1';
const port = Number(process.env.AQUA_PORT ?? 3001);
const origins = (process.env.AQUA_ALLOWED_ORIGINS ?? (hardened ? '' : 'http://localhost:5173,http://127.0.0.1:5173')).split(',').map((value) => value.trim()).filter(Boolean);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('AQUA_PORT must be a valid port.');
if (!origins.length || origins.some((origin) => {
  try { const url = new URL(origin); return url.origin !== origin || !['http:', 'https:'].includes(url.protocol) || (hardened && url.protocol !== 'https:'); }
  catch { return true; }
})) throw new Error('Set AQUA_ALLOWED_ORIGINS to exact origins; staging and production require HTTPS.');
const trustedProxies = (process.env.AQUA_TRUSTED_PROXIES ?? '').split(',').map((value) => value.trim()).filter(Boolean);
if (trustedProxies.some((value) => {
  const [address, mask, extra] = value.split('/');
  const family = isIP(address);
  return !family || extra !== undefined || (mask !== undefined && (!/^\d+$/.test(mask) || Number(mask) > (family === 4 ? 32 : 128)));
})) throw new Error('AQUA_TRUSTED_PROXIES must contain explicit proxy IPs or CIDRs.');

process.umask(0o077);
const database = await databaseFromEnvironment();
let mailQueue: AuthMailQueue | undefined;
try {
  await verifyMigrations(database);
  if (hardened) await verifyApplicationRole(database);
  mailQueue = authMailQueueFromEnvironment(database.schema);
}
catch (error) { await database.close(); throw error; }
const store = new LedgerStore(database);
const app = createApiServer(store, {
  allowedOrigins: origins,
  secureCookies: hardened,
  exposeOpenApi: !hardened,
  // The staging edge is the task's only allowed caller and appends the real peer
  // to X-Forwarded-For. Stop at that one hop even if the client supplies a chain.
  trustedProxies: staging && process.env.AQUA_STAGING_ALB === 'true' ? trustStagingLoadBalancer : trustedProxies,
  staticDir: process.env.AQUA_STATIC_DIR,
  mailQueue,
});
try { await app.listen({ port, host }); }
catch (error) { await closeHttpService(app, database); throw error; }
drainOnShutdown(app, database);
