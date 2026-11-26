import { readFile } from 'node:fs/promises';
import { Database } from './database';
import { monitorSecretConnectionString } from './monitor-database-secret';

const serviceUrls = {
  ingress: 'INGRESS_DATABASE_URL',
  worker: 'WORKER_DATABASE_URL',
  dispatcher: 'DISPATCHER_DATABASE_URL',
  operations: 'OPERATIONS_DATABASE_URL',
  monitor: 'MONITOR_DATABASE_URL',
  settlement: 'SETTLEMENT_DATABASE_URL',
} as const;

/** Each service requires its own login, including the read-only scheduled monitor. */
export async function cardServiceDatabase(service: keyof typeof serviceUrls): Promise<Database> {
  if (!Object.hasOwn(serviceUrls, service)) throw new Error('Unknown card service database role.');
  const variable = serviceUrls[service];
  let connectionString = process.env[variable];
  if (service === 'monitor' && process.env.MONITOR_DATABASE_SECRET !== undefined) {
    if (connectionString) throw new Error('Configure only one monitor database credential.');
    connectionString = monitorSecretConnectionString(process.env.MONITOR_DATABASE_SECRET);
  }
  if (!connectionString) throw new Error(`Set ${variable} to the separate restricted ${service} login.`);
  return new Database({
    connectionString,
    schema: process.env.DATABASE_SCHEMA,
    maxConnections: service === 'ingress' ? 10 : 2,
    production: process.env.NODE_ENV === 'production',
    ca: process.env.DATABASE_CA_FILE ? await readFile(process.env.DATABASE_CA_FILE, 'utf8') : undefined,
  });
}
