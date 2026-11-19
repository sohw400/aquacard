import { readFile } from 'node:fs/promises';
import { Database } from './database';

/** A receiver must never silently inherit the API or migration owner's credentials. */
export async function cardServiceDatabase(service: 'ingress' | 'worker'): Promise<Database> {
  if (service !== 'ingress' && service !== 'worker') throw new Error('Unknown card service database role.');
  const variable = service === 'ingress' ? 'INGRESS_DATABASE_URL' : 'WORKER_DATABASE_URL';
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
