import { readFile } from 'node:fs/promises';
import { Database } from './database';

/** A receiver must never silently inherit the API or migration owner's credentials. */
export async function cardServiceDatabase(service: 'ingress' | 'worker' | 'dispatcher'): Promise<Database> {
  if (service !== 'ingress' && service !== 'worker' && service !== 'dispatcher') throw new Error('Unknown card service database role.');
  const variable = { ingress: 'INGRESS_DATABASE_URL', worker: 'WORKER_DATABASE_URL', dispatcher: 'DISPATCHER_DATABASE_URL' }[service];
  const connectionString = process.env[variable];
  if (!connectionString) throw new Error(`Set ${variable} to the separate restricted ${service} login.`);
  return new Database({
    connectionString,
    schema: process.env.DATABASE_SCHEMA,
    maxConnections: service === 'ingress' ? 10 : 2,
    production: process.env.NODE_ENV === 'production',
    ca: process.env.DATABASE_CA_FILE ? await readFile(process.env.DATABASE_CA_FILE, 'utf8') : undefined,
  });
}
