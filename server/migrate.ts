import { databaseFromEnvironment } from './database';
import { applyMigrations } from './migrations';
import { grantApplicationRole } from './permissions';

const database = await databaseFromEnvironment(true);
try {
  await applyMigrations(database);
  if (process.env.DATABASE_RUNTIME_ROLE) await grantApplicationRole(database, process.env.DATABASE_RUNTIME_ROLE);
  console.log('PostgreSQL migrations are up to date.');
} finally { await database.close(); }
