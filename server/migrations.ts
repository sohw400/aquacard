import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { Database } from './database';

interface Migration { name: string; sql: string; checksum: string }

async function files(directory: URL): Promise<Migration[]> {
  const names = (await readdir(directory)).filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name)).sort();
  if (!names.length || new Set(names.map((name) => name.slice(0, 3))).size !== names.length) throw new Error('Migration files are missing or have duplicate versions.');
  return Promise.all(names.map(async (name) => {
    const sql = await readFile(new URL(name, directory), 'utf8');
    return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  }));
}

function checkHistory(migrations: Migration[], applied: { name: string; checksum: string }[]) {
  for (let index = 0; index < applied.length; index++) {
    const expected = migrations[index];
    if (!expected || applied[index].name !== expected.name || applied[index].checksum !== expected.checksum) {
      throw new Error('Applied database migrations differ from this release. Do not edit applied SQL migrations.');
    }
  }
}

export async function releaseMigrationManifest() {
  const migrations = await files(new URL('./migrations/', import.meta.url));
  return {
    checksums: JSON.stringify(Object.fromEntries(migrations.map(({ name, checksum }) => [name, checksum]))),
    lastVersion: migrations[migrations.length - 1].name.slice(0, 3),
  };
}

/** A deployment runs this explicit command once; API instances never perform DDL on startup. */
export async function applyMigrations(database: Database, directory = new URL('./migrations/', import.meta.url)): Promise<void> {
  const migrations = await files(directory);
  await database.transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`aqua:migrations:${database.schema}`]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${database.schema}"`);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const applied = await client.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations ORDER BY name');
    checkHistory(migrations, applied.rows);
    for (const migration of migrations.slice(applied.rows.length)) {
      await client.query(migration.sql);
      await client.query('INSERT INTO schema_migrations(name, checksum) VALUES ($1, $2)', [migration.name, migration.checksum]);
    }
  });
}

export async function verifyMigrations(database: Database): Promise<void> {
  const migrations = await files(new URL('./migrations/', import.meta.url));
  let applied: { name: string; checksum: string }[];
  try { applied = (await database.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations ORDER BY name')).rows; }
  catch { throw new Error('Database schema is unavailable. Run db:migrate with the migration role before starting the API.'); }
  checkHistory(migrations, applied);
  if (applied.length !== migrations.length) throw new Error('Database migrations are pending. Run db:migrate before starting this release.');
}
