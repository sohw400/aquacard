import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createTestDatabase } from '../server/test-support.ts';
import { Database } from '../server/database.ts';
import { grantApplicationRole, verifyApplicationRole } from '../server/permissions.ts';

// Disposable schema, restricted API login and a compiled connected client.
// No customer account, production database or external provider is involved.
assert.notEqual(process.env.NODE_ENV, 'production', 'Security browser checks require a local sandbox.');
const repo = fileURLToPath(new URL('../', import.meta.url));
const artifacts = new URL('../artifacts/security-server/', import.meta.url);
const port = Number(process.env.AQUA_SECURITY_BROWSER_PORT ?? 3007);
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535, 'Use an unprivileged local browser port.');
const origin = `http://127.0.0.1:${port}`;
const connection = (name) => {
  assert.ok(process.env[name], `Set ${name} before running security browser checks.`);
  const url = new URL(process.env[name]);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Use a local PostgreSQL sandbox.');
  return url;
};
const ownerUrl = connection('TEST_DATABASE_URL');
const apiUrl = connection('DATABASE_URL');
assert.equal(apiUrl.host, ownerUrl.host); assert.equal(apiUrl.pathname, ownerUrl.pathname);
assert.notEqual(apiUrl.username, ownerUrl.username, 'Use separate owner and API logins.');
await access(new URL('../dist-server/index.js', import.meta.url));
await access(new URL('../dist/index.html', import.meta.url));
await mkdir(artifacts, { recursive: true });
const fixture = await createTestDatabase();
const apiDatabase = new Database({ connectionString: apiUrl.href, schema: fixture.schema });
let server;
let browser;
let serverLog = '';
let stopping = false;
const stop = async (child) => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 25_000); timer.unref();
  try { await closed; } finally { clearTimeout(timer); }
};
const interrupt = () => { stopping = true; browser?.kill('SIGTERM'); server?.kill('SIGTERM'); };
process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
try {
  await grantApplicationRole(fixture.database, decodeURIComponent(apiUrl.username));
  await verifyApplicationRole(apiDatabase);
  const env = { ...process.env, NODE_ENV: 'development', DATABASE_SCHEMA: fixture.schema,
    MIGRATION_DATABASE_URL: fixture.connectionString, AQUA_HOST: '127.0.0.1', AQUA_PORT: String(port),
    AQUA_ALLOWED_ORIGINS: origin, AQUA_BASE_URL: origin, AQUA_STATIC_DIR: fileURLToPath(new URL('../dist/', import.meta.url)),
    AQUA_MAIL_DIR: fileURLToPath(new URL('mail/', artifacts)) };
  if (stopping) throw new Error('Security browser checks interrupted.');
  server = spawn(process.execPath, ['dist-server/index.js'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    let complete = false;
    const timer = setTimeout(() => finish(new Error('The compiled security browser API did not start.')), 30_000);
    const finish = (error) => {
      if (complete) return; complete = true;
      clearTimeout(timer); server.off('error', failed); server.off('exit', exited);
      error ? reject(error) : resolve();
    };
    const failed = () => finish(new Error('The compiled security browser API could not be launched.'));
    const exited = () => finish(new Error('The compiled security browser API stopped before listening.'));
    server.on('error', failed); server.on('exit', exited);
    server.stdout.on('data', (chunk) => {
      serverLog = (serverLog + chunk.toString()).slice(-200_000);
      if (serverLog.includes(`Server listening at ${origin}`)) finish();
    });
    server.stderr.on('data', (chunk) => { serverLog = (serverLog + chunk.toString()).slice(-200_000); });
  });
  if (stopping) throw new Error('Security browser checks interrupted.');
  browser = spawn(process.execPath, ['scripts/security-browser-check.mjs'], { cwd: repo, env, stdio: ['ignore', 'inherit', 'inherit'] });
  const [code, signal] = await once(browser, 'exit');
  assert.equal(signal, null, 'Security browser checks interrupted.');
  assert.equal(code, 0, 'Security browser checks did not pass.');
} finally {
  await stop(browser); await stop(server);
  process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
  await writeFile(new URL('api.log', artifacts), serverLog, { mode: 0o600 });
  await apiDatabase.close();
  await fixture.cleanup();
}
