import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import Fastify from 'fastify';
import { Database } from './database';
import { CardInboxStore } from './card-inbox';
import { createCardIngress } from './card-ingress-http';
import { createApiServer } from './http';
import { closeHttpService } from './http-shutdown';
import { LedgerStore } from './ledger';
import { verifyMigrations } from './migrations';
import { grantApplicationRole, grantCardIngressRole } from './permissions';
import { createReadinessProbe } from './readiness';
import { createTestDatabase } from './test-support';

test('API and ingress stay live while routing excludes a read-only or mismatched database, then recovers', async (t) => {
  const fixture = await createTestDatabase();
  const pool = new Database({ connectionString: fixture.connectionString, schema: fixture.schema, maxConnections: 1 });
  const api = createApiServer(new LedgerStore(pool), { allowedOrigins: [], logger: false });
  const ingress = createCardIngress(new CardInboxStore(pool), { keys: { test: Buffer.alloc(32, 1).toString('base64url') }, logger: false });
  t.after(async () => {
    try { await Promise.all([api.close(), ingress.close()]); }
    finally { await pool.close(); await fixture.cleanup(); }
  });

  async function assertRoutes(expected: 200 | 503) {
    for (const [app, root] of [[api, '/api'], [ingress, '']] as const) {
      const health = await app.inject({ url: root + '/health' });
      assert.equal(health.statusCode, expected, health.body);
      if (expected === 200) assert.deepEqual(health.json(), { status: 'ok', mode: 'sandbox' });
      else assert.equal(health.json().error.code, root ? 'DATABASE_UNAVAILABLE' : 'INGRESS_UNAVAILABLE');
      const live = await app.inject({ url: root + '/live' });
      assert.equal(live.statusCode, 200);
      assert.deepEqual(live.json(), { status: 'ok' });
      assert.equal(live.headers['cache-control'], 'no-store');
    }
  }
  await assertRoutes(200);
  await pool.query('SET default_transaction_read_only TO on');
  await assertRoutes(503);
  await pool.query('RESET default_transaction_read_only');
  const updated = await fixture.database.query<{ checksum: string }>(
    "SELECT checksum FROM schema_migrations WHERE name = '001_core.sql'");
  await fixture.database.query("UPDATE schema_migrations SET checksum = 'unexpected' WHERE name = '001_core.sql'");
  await assertRoutes(503);
  await fixture.database.query("UPDATE schema_migrations SET checksum = $1 WHERE name = '001_core.sql'", [updated.rows[0].checksum]);
  await fixture.database.query("UPDATE schema_migrations SET name='998_reordered.sql' WHERE name='001_core.sql'");
  await assertRoutes(503);
  await fixture.database.query("UPDATE schema_migrations SET name='001_core.sql' WHERE name='998_reordered.sql'");
  await fixture.database.query("INSERT INTO schema_migrations(name, checksum) VALUES ('000_inserted.sql', repeat('0',64))");
  await assertRoutes(503);
  await fixture.database.query("DELETE FROM schema_migrations WHERE name='000_inserted.sql'");
  await fixture.database.query("INSERT INTO schema_migrations(name, checksum) VALUES ('999_future.sql', repeat('0',64))");
  await assertRoutes(200);
  await assert.rejects(verifyMigrations(pool), /differ from this release/);
  await fixture.database.query("INSERT INTO schema_migrations(name, checksum) VALUES ('999_duplicate.sql', repeat('1',64))");
  await assertRoutes(503);
  await fixture.database.query("DELETE FROM schema_migrations WHERE name='999_duplicate.sql'");
  await fixture.database.query("DELETE FROM schema_migrations WHERE name='999_future.sql'");
  await assertRoutes(200);
  await pool.close();
  await assertRoutes(503);
});

test('revoking a core runtime grant withdraws only the affected listener', async (t) => {
  const fixture = await createTestDatabase();
  const roles = { api: 'api_' + fixture.schema, ingress: 'ingress_' + fixture.schema };
  const databases = Object.fromEntries(Object.keys(roles).map((service) => [
    service, new Database({ connectionString: fixture.connectionString, schema: fixture.schema, maxConnections: 1 }),
  ]));
  t.after(async () => {
    await Promise.all(Object.values(databases).map((db) => db.close()));
    await fixture.cleanup();
    const admin = new Database({ connectionString: fixture.connectionString });
    try { for (const role of Object.values(roles)) await admin.query(`DROP ROLE IF EXISTS "${role}"`); }
    finally { await admin.close(); }
  });
  for (const role of Object.values(roles)) await fixture.database.query(`CREATE ROLE "${role}" NOLOGIN`);
  await grantApplicationRole(fixture.database, roles.api);
  await grantCardIngressRole(fixture.database, roles.ingress);
  await databases.api.query(`SET ROLE "${roles.api}"`);
  await databases.ingress.query(`SET ROLE "${roles.ingress}"`);
  const api = createReadinessProbe(databases.api, 'api');
  const ingress = createReadinessProbe(databases.ingress, 'ingress');
  assert.deepEqual(await Promise.all([api(), ingress()]), [true, true]);
  await fixture.database.query(`REVOKE INSERT ON journals FROM "${roles.api}"`);
  assert.deepEqual(await Promise.all([api(), ingress()]), [false, true]);
  await fixture.database.query(`GRANT INSERT ON journals TO "${roles.api}"`);
  await fixture.database.query(`REVOKE EXECUTE ON FUNCTION enqueue_sandbox_card_event(jsonb,bigint) FROM "${roles.ingress}"`);
  assert.deepEqual(await Promise.all([api(), ingress()]), [true, false]);
});

test('concurrent probes share one checkout and return unavailable under pool saturation', async (t) => {
  const fixture = await createTestDatabase();
  const database = new Database({ connectionString: fixture.connectionString, schema: fixture.schema, maxConnections: 1 });
  t.after(async () => { await database.close(); await fixture.cleanup(); });
  const probe = createReadinessProbe(database, 'api');
  assert.equal(await probe(), true);
  const occupied = await database.pool.connect();
  try {
    const first = probe();
    for (let attempt = 0; attempt < 20; attempt++) assert.equal(probe(), first);
    assert.equal(database.pool.waitingCount, 1);
    assert.equal(await first, false);
    assert.equal(database.pool.waitingCount, 1);
    assert.equal(await probe(), false);
  } finally { occupied.release(); }
  for (let attempt = 0; attempt < 100 && !(await probe()); attempt++) await delay(10);
  assert.equal(await probe(), true);
});

test('a failing HTTP shutdown hook still releases the database after draining the listener', async () => {
  const app = Fastify();
  const closed: string[] = [];
  app.addHook('onClose', async () => { closed.push('http'); throw new Error('close hook failed'); });
  await app.ready();
  await assert.rejects(closeHttpService(app, { async close() { closed.push('db'); } }), /close hook failed/);
  assert.deepEqual(closed, ['http', 'db']);
});

test('a request accepted before shutdown can finish its database work and receive its HTTP response', { timeout: 10_000 }, async () => {
  const app = Fastify();
  let entered!: () => void;
  let resume!: () => void;
  const requestEntered = new Promise<void>((resolve) => { entered = resolve; });
  const canFinish = new Promise<void>((resolve) => { resume = resolve; });
  let databaseClosed = false;
  app.get('/in-flight', async () => {
    entered();
    await canFinish;
    return { databaseOpen: !databaseClosed };
  });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  try {
    const response = fetch(address + '/in-flight', { signal: AbortSignal.timeout(5_000) });
    await requestEntered;
    const draining = closeHttpService(app, { async close() { databaseClosed = true; } });
    resume();
    assert.deepEqual(await (await response).json(), { databaseOpen: true });
    await draining;
    assert.equal(databaseClosed, true);
  } finally { resume(); await app.close(); }
});
