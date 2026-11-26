import { databaseFromEnvironment } from './database';
import { applyMigrations } from './migrations';
import { grantApplicationRole, grantCardIngressRole, grantCardWorkerRole, grantCardDispatcherRole, grantCardOperationsRole, grantAuthMailRole, grantMonitorRole } from './permissions';

const database = await databaseFromEnvironment(true);
try {
  const roles = [process.env.DATABASE_RUNTIME_ROLE, process.env.DATABASE_INGRESS_ROLE, process.env.DATABASE_WORKER_ROLE, process.env.DATABASE_DISPATCHER_ROLE, process.env.DATABASE_OPERATIONS_ROLE, process.env.DATABASE_AUTH_MAIL_ROLE, process.env.DATABASE_MONITOR_ROLE].filter(Boolean);
  if (new Set(roles).size !== roles.length) throw new Error('The API, card ingress, worker, dispatcher, operations, monitor and auth mail worker must use different database roles.');
  await applyMigrations(database);
  if (process.env.DATABASE_RUNTIME_ROLE) await grantApplicationRole(database, process.env.DATABASE_RUNTIME_ROLE);
  if (process.env.DATABASE_INGRESS_ROLE) await grantCardIngressRole(database, process.env.DATABASE_INGRESS_ROLE);
  if (process.env.DATABASE_WORKER_ROLE) await grantCardWorkerRole(database, process.env.DATABASE_WORKER_ROLE);
  if (process.env.DATABASE_DISPATCHER_ROLE) await grantCardDispatcherRole(database, process.env.DATABASE_DISPATCHER_ROLE);
  if (process.env.DATABASE_OPERATIONS_ROLE) await grantCardOperationsRole(database, process.env.DATABASE_OPERATIONS_ROLE);
  if (process.env.DATABASE_AUTH_MAIL_ROLE) await grantAuthMailRole(database, process.env.DATABASE_AUTH_MAIL_ROLE);
  if (process.env.DATABASE_MONITOR_ROLE) await grantMonitorRole(database, process.env.DATABASE_MONITOR_ROLE);
  console.log('PostgreSQL migrations are up to date.');
} finally { await database.close(); }
