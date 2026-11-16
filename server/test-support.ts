import { randomBytes } from 'node:crypto';
import { Database } from './database';
import { applyMigrations } from './migrations';

/** Each fixture owns one random schema, never the caller's application schema or database. */
export async function createTestDatabase() {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) throw new Error('TEST_DATABASE_URL is required. Start the local PostgreSQL service before running server tests.');
  const schema = `test_${randomBytes(12).toString('hex')}`;
  const database = new Database({ connectionString, schema, maxConnections: 8 });
  try { await applyMigrations(database); }
  catch (error) { await database.close(); throw error; }
  let cleaned = false;
  return {
    database, schema, connectionString,
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      try { await database.query(`DROP SCHEMA "${schema}" CASCADE`); }
      finally { await database.close(); }
    },
  };
}
