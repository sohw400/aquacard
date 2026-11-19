import { databaseFromEnvironment } from './database';
import { applyMigrations } from './migrations';
import { grantApplicationRole, grantCardIngressRole, grantCardWorkerRole, grantCardDispatcherRole } from './permissions';

const database = await databaseFromEnvironment(true);
try {
  const roles = [process.env.DATABASE_RUNTIME_ROLE, process.env.DATABASE_INGRESS_ROLE, process.env.DATABASE_WORKER_ROLE, process.env.DATABASE_DISPATCHER_ROLE].filter(Boolean);
  if (new Set(roles).size !== roles.length) throw new Error('The API, card ingress, worker and dispatcher must use different database roles.');
  await applyMigrations(database);
  if (process.env.DATABASE_RUNTIME_ROLE) await grantApplicationRole(database, process.env.DATABASE_RUNTIME_ROLE);
  if (process.env.DATABASE_INGRESS_ROLE) await grantCardIngressRole(database, process.env.DATABASE_INGRESS_ROLE);
  if (process.env.DATABASE_WORKER_ROLE) await grantCardWorkerRole(database, process.env.DATABASE_WORKER_ROLE);
  if (process.env.DATABASE_DISPATCHER_ROLE) await grantCardDispatcherRole(database, process.env.DATABASE_DISPATCHER_ROLE);
  console.log('PostgreSQL migrations are up to date.');
} finally { await database.close(); }
