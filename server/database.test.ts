import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { Database } from './database';
import { applyMigrations, verifyMigrations } from './migrations';
import { createTestDatabase } from './test-support';

test('independent deployers serialize migrations and preserve the recorded SQL checksums', async () => {
  const fixture = await createTestDatabase();
  const other = new Database({ connectionString: fixture.connectionString, schema: fixture.schema });
  try {
    const before = (await fixture.database.query('SELECT * FROM schema_migrations ORDER BY name')).rows;
    await Promise.all([applyMigrations(fixture.database), applyMigrations(other)]);
    assert.deepEqual((await fixture.database.query('SELECT * FROM schema_migrations ORDER BY name')).rows, before);
    await verifyMigrations(other);
    assert.ok(before.length >= 2);
  } finally { await other.close(); await fixture.cleanup(); }
});

test('failed schema changes roll back and edited historical migrations cannot be applied', async () => {
  const fixture = await createTestDatabase();
  const directory = await mkdtemp(join(tmpdir(), 'aqua-migrations-'));
  const url = pathToFileURL(directory + '/');
  try {
    await cp(new URL('./migrations/', import.meta.url), directory, { recursive: true });
    const before = (await fixture.database.query('SELECT * FROM schema_migrations ORDER BY name')).rows;
    await writeFile(join(directory, '999_broken.sql'), 'CREATE TABLE should_rollback (id TEXT); SELECT missing_aqua_migration_function();');
    await assert.rejects(applyMigrations(fixture.database, url));
    assert.equal((await fixture.database.query("SELECT to_regclass('should_rollback') AS target")).rows[0].target, null);
    assert.deepEqual((await fixture.database.query('SELECT * FROM schema_migrations ORDER BY name')).rows, before);
    await rm(join(directory, '999_broken.sql'));
    const first = join(directory, String(before[0].name));
    await writeFile(first, (await readFile(first, 'utf8')) + '\n-- changed after deployment\n');
    await assert.rejects(applyMigrations(fixture.database, url), /differ from this release/);
    await verifyMigrations(fixture.database);
  } finally { await fixture.cleanup(); await rm(directory, { recursive: true, force: true }); }
});

test('transaction failure rolls back before the same pool connection is reused', async () => {
  const fixture = await createTestDatabase();
  try {
    await fixture.database.query('CREATE TABLE transaction_probe (id INTEGER PRIMARY KEY)');
    await assert.rejects(fixture.database.transaction(async (client) => {
      await client.query('INSERT INTO transaction_probe VALUES (1)');
      await client.query('INSERT INTO transaction_probe VALUES (1)');
    }));
    assert.equal((await fixture.database.query('SELECT count(*)::int AS count FROM transaction_probe')).rows[0].count, 0);
    await fixture.database.transaction((client) => client.query('INSERT INTO transaction_probe VALUES (2)'));
    assert.equal((await fixture.database.query('SELECT id FROM transaction_probe')).rows[0].id, 2);
  } finally { await fixture.cleanup(); }
});

test('remote PostgreSQL connections cannot disable certificate verification or inject session options', () => {
  assert.throws(() => new Database({ connectionString: 'postgresql://aqua:unused@db.example/aqua?sslmode=disable' }), /cannot be disabled/);
  assert.throws(() => new Database({ connectionString: 'postgresql://aqua:unused@localhost/aqua?sslmode=disable', production: true }), /cannot be disabled/);
  assert.throws(() => new Database({ connectionString: 'postgresql://aqua:unused@db.example/aqua?ssl=true' }), /TLS overrides/);
  assert.throws(() => new Database({ connectionString: 'postgresql://aqua:unused@localhost/aqua?options=-c+search_path%3Dpublic' }), /session options/);
  assert.throws(() => new Database({ connectionString: 'postgresql://aqua:unused@localhost/aqua', schema: 'pg_catalog' }), /system namespaces/);
});

test('private staging requires certificate-verified database TLS for every runtime role', async t => {
  const original = process.env.NODE_ENV;
  t.after(() => { if (original === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = original; });
  process.env.NODE_ENV = 'staging';
  const local = 'postgresql://local-test@127.0.0.1/aqua';
  assert.throws(() => new Database({ connectionString: local + '?sslmode=disable' }), /TLS cannot be disabled/);
  const db = new Database({ connectionString: local, ca: 'example-private-ca' });
  try { assert.deepEqual(db.pool.options.ssl, { rejectUnauthorized: true, ca: 'example-private-ca' }); }
  finally { await db.close(); }
});
