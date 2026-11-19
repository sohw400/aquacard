import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createTestDatabase } from '../server/test-support.ts';
import { Database } from '../server/database.ts';
import { grantApplicationRole, grantCardDispatcherRole, verifyApplicationRole, verifyCardDispatcherRole } from '../server/permissions.ts';

// A separate random schema keeps browser accounts, signup limits and commands
// out of both the developer's application schema and the other browser suites.
assert.notEqual(process.env.NODE_ENV, 'production', 'Issuer browser checks require a local sandbox.');
const repo = fileURLToPath(new URL('../', import.meta.url));
const artifacts = new URL('../artifacts/issuer-server/', import.meta.url);
const port = Number(process.env.AQUA_ISSUER_BROWSER_PORT ?? 3006);
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535, 'Use an unprivileged local issuer browser port.');
const origin = `http://127.0.0.1:${port}`;
const connection = (name) => {
  assert.ok(process.env[name], `Set ${name} before running issuer browser checks.`);
  const url = new URL(process.env[name]);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Browser database connections must use the local PostgreSQL sandbox.');
  return url;
};
const ownerUrl = connection('TEST_DATABASE_URL');
const apiUrl = connection('DATABASE_URL');
const dispatcherUrl = connection('DISPATCHER_DATABASE_URL');
for (const url of [apiUrl, dispatcherUrl]) {
  assert.equal(url.host, ownerUrl.host, 'The sandbox database hosts must match.');
  assert.equal(url.pathname, ownerUrl.pathname, 'The sandbox database names must match.');
}
assert.equal(new Set([ownerUrl.username, apiUrl.username, dispatcherUrl.username]).size, 3, 'Use separate owner, API and dispatcher logins.');
await access(new URL('../dist-server/index.js', import.meta.url));
await access(new URL('../dist/index.html', import.meta.url));
await mkdir(artifacts, { recursive: true });
const fixture = await createTestDatabase();
const apiDatabase = new Database({ connectionString: apiUrl.href, schema: fixture.schema });
const dispatcherDatabase = new Database({ connectionString: dispatcherUrl.href, schema: fixture.schema });
let server;
let browser;
let serverLog = '';
let stopping = false;
const stop = async (child) => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 25_000);
  timer.unref();
  try { await closed; } finally { clearTimeout(timer); }
};
const interrupt = () => { stopping = true; browser?.kill('SIGTERM'); server?.kill('SIGTERM'); };
process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
try {
  await grantApplicationRole(fixture.database, decodeURIComponent(apiUrl.username));
  await grantCardDispatcherRole(fixture.database, decodeURIComponent(dispatcherUrl.username));
  await verifyApplicationRole(apiDatabase); await verifyCardDispatcherRole(dispatcherDatabase);
  const env = { ...process.env, NODE_ENV: 'development', DATABASE_SCHEMA: fixture.schema,
    MIGRATION_DATABASE_URL: fixture.connectionString, AQUA_HOST: '127.0.0.1', AQUA_PORT: String(port),
    AQUA_ALLOWED_ORIGINS: origin, AQUA_BASE_URL: origin, AQUA_STATIC_DIR: fileURLToPath(new URL('../dist/', import.meta.url)),
    AQUA_MAIL_DIR: fileURLToPath(new URL('mail/', artifacts)) };
  if (stopping) throw new Error('Issuer browser checks interrupted.');
  server = spawn(process.execPath, ['dist-server/index.js'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  // Observe this child's successful listen, rather than accepting another
  // application's health response if the chosen port was already occupied.
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('The compiled issuer browser API did not start.')), 30_000);
    const finish = (error) => {
      clearTimeout(timer); server.off('error', failed); server.off('exit', exited);
      error ? reject(error) : resolve();
    };
    const failed = () => finish(new Error('The compiled issuer browser API could not be launched.'));
    const exited = () => finish(new Error('The compiled issuer browser API stopped before listening.'));
    server.on('error', failed); server.on('exit', exited);
    server.stdout.on('data', (chunk) => {
      serverLog = (serverLog + chunk.toString()).slice(-200_000);
      if (serverLog.includes(`Server listening at ${origin}`)) finish();
    });
    server.stderr.on('data', (chunk) => { serverLog = (serverLog + chunk.toString()).slice(-200_000); });
  });
  if (stopping) throw new Error('Issuer browser checks interrupted.');
  browser = spawn(process.execPath, ['scripts/issuer-browser-check.mjs'], { cwd: repo, env, stdio: ['ignore', 'inherit', 'inherit'] });
  const [code, signal] = await once(browser, 'exit');
  assert.equal(signal, null, 'Issuer browser checks were interrupted.');
  assert.equal(code, 0, 'Issuer browser checks did not pass.');
} finally {
  await stop(browser); await stop(server);
  process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
  await writeFile(new URL('api.log', artifacts), serverLog, { mode: 0o600 });
  await Promise.all([apiDatabase.close(), dispatcherDatabase.close()]);
  await fixture.cleanup();
}
