import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { Database } from './database';
import { bootstrapMonitor, stagingCredentials } from './staging-bootstrap-store';

const host = 'stage-db.abcdefghijkl.ap-northeast-2.rds.amazonaws.com';
const adminSecret = { username: 'aqua_admin', password: 'opaque:#&%/P@$$w0rd' };
const monitorSecret = { username: 'aqua_monitor', password: 'monitor@?#$%27/val', dbname: 'aqua', host, port: 5432 };
const env = { NODE_ENV: 'production', DATABASE_CA_FILE: '/etc/aqua/rds-ca.pem', DATABASE_NAME: 'aqua', DATABASE_SCHEMA: 'aqua',
  DATABASE_HOST: host, AQUA_STAGING_DB_ADMIN_JSON: JSON.stringify(adminSecret), MONITOR_DATABASE_SECRET: JSON.stringify(monitorSecret) };

test('staging secret identities must identify the same trusted Seoul endpoint and database', () => {
  const good = stagingCredentials(env);
  assert.equal(good.monitorPassword, monitorSecret.password);
  assert.equal(decodeURIComponent(new URL(good.adminUrl).password), adminSecret.password);
  const wrong = [
    { NODE_ENV: 'test' }, { DATABASE_NAME: 'postgres' }, { DATABASE_SCHEMA: 'public' },
    { DATABASE_HOST: host + '.example.com' }, { DATABASE_CA_FILE: '' },
    { AQUA_STAGING_DB_ADMIN_JSON: JSON.stringify({ ...adminSecret, host: 'other.amazonaws.com' }) },
    { AQUA_STAGING_DB_ADMIN_JSON: JSON.stringify({ ...adminSecret, dbname: 'other' }) },
    { AQUA_STAGING_DB_ADMIN_JSON: 'invalid-secret:do-not-print' },
    { MONITOR_DATABASE_SECRET: JSON.stringify({ ...monitorSecret, username: adminSecret.username }) },
    { MONITOR_DATABASE_SECRET: JSON.stringify({ ...monitorSecret, host: 'other.' + host }) },
    { MONITOR_DATABASE_SECRET: JSON.stringify({ ...monitorSecret, dbname: 'postgres' }) },
    { MONITOR_DATABASE_SECRET: JSON.stringify({ ...monitorSecret, port: 5433 }) },
    { MONITOR_DATABASE_SECRET: JSON.stringify({ ...monitorSecret, password: adminSecret.password }) },
  ];
  for (const change of wrong) assert.throws(() => stagingCredentials({ ...env, ...change }), {
    message: 'Invalid staging bootstrap configuration.',
  });
});

test('a non-superuser bootstraps a fresh database, retries safely and refuses a conflicting monitor login', async t => {
  assert.ok(process.env.TEST_DATABASE_URL);
  const base = new URL(process.env.TEST_DATABASE_URL);
  const suffix = randomBytes(8).toString('hex');
  const databaseName = 'test_stage_' + suffix;
  const adminRole = 'stage_owner_' + suffix;
  const monitorRole = 'stage_watch_' + suffix;
  const adminPassword = randomBytes(28).toString('hex');
  const monitorPassword = 'a?b%20@' + randomBytes(32).toString('hex');
  const identity = { databaseName, adminRole, monitorRole, monitorPassword };
  const control = new Database({ connectionString: base.href, schema: 'public' });
  function dbUrl(user: string, password: string) {
    const url = new URL(base);
    url.pathname = '/' + databaseName;
    url.username = user;
    url.password = encodeURIComponent(password);
    return new Database({ connectionString: url.href, schema: 'aqua', maxConnections: 2 });
  }
  const owner = dbUrl(adminRole, adminPassword);
  const monitor = dbUrl(monitorRole, monitorPassword);
  const incorrect = dbUrl(monitorRole, 'differentPassword');
  t.after(async () => {
    await Promise.all([owner.close(), monitor.close(), incorrect.close()]);
    try {
      await control.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await control.query(`DROP ROLE IF EXISTS "${monitorRole}", "${adminRole}"`);
    } finally { await control.close(); }
  });
  await control.query(`CREATE ROLE "${adminRole}" LOGIN CREATEROLE PASSWORD '${adminPassword}'`);
  await control.query(`CREATE DATABASE "${databaseName}" OWNER "${adminRole}"`);

  // An inherited schema write grant must roll back the new LOGIN and its grants
  // together. Reuse the migrated database after removing the configuration error.
  await owner.query('ALTER DEFAULT PRIVILEGES GRANT INSERT ON TABLES TO PUBLIC');
  await assert.rejects(bootstrapMonitor(owner, monitor, identity), /restricted monitor/);
  assert.equal((await owner.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [monitorRole])).rowCount, 0);
  await owner.query('ALTER DEFAULT PRIVILEGES REVOKE INSERT ON TABLES FROM PUBLIC');
  await owner.query('REVOKE INSERT ON ALL TABLES IN SCHEMA aqua FROM PUBLIC');
  await owner.query(`GRANT CREATE ON DATABASE "${databaseName}" TO PUBLIC`);
  await assert.rejects(bootstrapMonitor(owner, monitor, identity), /restricted monitor/);
  assert.equal((await owner.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [monitorRole])).rowCount, 0);
  await owner.query(`REVOKE CREATE ON DATABASE "${databaseName}" FROM PUBLIC`);
  await Promise.all([bootstrapMonitor(owner, monitor, identity), bootstrapMonitor(owner, monitor, identity)]);
  const verifier = async () => (await control.query('SELECT rolpassword FROM pg_authid WHERE rolname=$1', [monitorRole])).rows[0].rolpassword;
  const first = await verifier();
  assert.match(first, /^SCRAM-SHA-256\$/);
  await bootstrapMonitor(owner, monitor, identity);
  assert.equal(await verifier(), first);
  assert.equal((await monitor.query('SELECT operations_ledger_finding_count() AS issues')).rows[0].issues, '0');
  await assert.rejects(monitor.query('SELECT email FROM users'), /permission denied/);

  // Recreate the previous release's prefix in this disposable fixture. The
  // existing monitor can authenticate, but the new function and its grant do not exist.
  await owner.transaction(async client => {
    await client.query('DROP FUNCTION operations_ledger_finding_count(), internal_ledger_findings()');
    await client.query("DELETE FROM schema_migrations WHERE name='014_ledger_monitor.sql'");
  });
  await bootstrapMonitor(owner, monitor, identity);
  assert.equal((await monitor.query('SELECT operations_ledger_finding_count() AS issues')).rows[0].issues, '0');
  assert.equal(await verifier(), first);

  await assert.rejects(bootstrapMonitor(owner, incorrect, { ...identity, monitorPassword: 'differentPassword' }), {
    code: '28P01',
  });
  await owner.query(`GRANT SELECT(email) ON users TO "${monitorRole}"`);
  await assert.rejects(bootstrapMonitor(owner, monitor, identity), /restricted monitor/);
  assert.equal(await verifier(), first);
  assert.equal((await monitor.query('SELECT email FROM users')).rowCount, 0,
    'Refusing a conflicting pre-existing role must not rewrite its privileges.');
});
