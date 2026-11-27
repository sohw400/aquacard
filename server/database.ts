import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';

export interface DatabaseOptions {
  connectionString: string;
  schema?: string;
  maxConnections?: number;
  /** Managed PostgreSQL certificates are verified. Supply the provider's CA when needed. */
  ca?: string;
  production?: boolean;
}

const ISOLATION = new Set(['read committed', 'repeatable read', 'serializable']);

export function checkedSchema(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value) || value.startsWith('pg_') || value === 'information_schema') {
    throw new Error('DATABASE_SCHEMA must be a lowercase SQL identifier outside PostgreSQL system namespaces.');
  }
  return value;
}

/** PostgreSQL owns concurrency and durability. No local database or in-memory fallback exists. */
export class Database {
  readonly pool: Pool;
  readonly schema: string;
  private closing: Promise<void> | undefined;

  constructor(options: DatabaseOptions) {
    this.schema = checkedSchema(options.schema ?? 'aqua');
    let url: URL;
    try { url = new URL(options.connectionString); } catch { throw new Error('DATABASE_URL must be a PostgreSQL connection URL.'); }
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname.slice(1)) {
      throw new Error('DATABASE_URL must identify a PostgreSQL server and database.');
    }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    const requireTls = options.production || process.env.NODE_ENV === 'staging';
    const sslMode = url.searchParams.get('sslmode');
    if (sslMode && !['disable', 'require', 'verify-ca', 'verify-full'].includes(sslMode)) throw new Error('Unsupported PostgreSQL TLS mode.');
    if (sslMode === 'disable' && (!local || requireTls)) throw new Error('PostgreSQL TLS cannot be disabled for remote or production connections.');
    // pg's URL SSL parameters can otherwise override rejectUnauthorized. Parse and enforce them here.
    for (const key of ['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert']) {
      if (key !== 'sslmode' && url.searchParams.has(key)) throw new Error('Configure database certificates through DATABASE_CA_FILE; URL TLS overrides are not supported.');
      url.searchParams.delete(key);
    }
    if (url.searchParams.has('options')) throw new Error('PostgreSQL URL session options are not supported; use DATABASE_SCHEMA.');
    const useTls = requireTls || !local || (sslMode !== null && sslMode !== 'disable');
    const max = options.maxConnections ?? 10;
    if (!Number.isInteger(max) || max < 1 || max > 100) throw new Error('DATABASE_POOL_SIZE must be between 1 and 100.');
    this.pool = new Pool({
      connectionString: url.toString(),
      ssl: useTls ? { rejectUnauthorized: true, ...(options.ca ? { ca: options.ca } : {}) } : false,
      options: `-c search_path=${this.schema},pg_catalog,pg_temp -c statement_timeout=10000 -c lock_timeout=5000 -c idle_in_transaction_session_timeout=15000`,
      max, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 30_000,
      application_name: 'aqua-api',
    });
    // Idle connection errors must not crash the process or disclose connection credentials.
    this.pool.on('error', () => { console.error('PostgreSQL idle connection failed; the pool will replace it.'); });
  }

  query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<T>> {
    return this.pool.query<T>(text, values);
  }

  async transaction<T>(work: (client: PoolClient) => Promise<T>, options: { isolation?: 'read committed' | 'repeatable read' | 'serializable' } = {}): Promise<T> {
    const isolation = options.isolation ?? 'read committed';
    if (!ISOLATION.has(isolation)) throw new Error('Unsupported transaction isolation.');
    const client = await this.pool.connect();
    let begun = false;
    let discard: Error | undefined;
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${isolation.toUpperCase()}`);
      begun = true;
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (begun) {
        try { await client.query('ROLLBACK'); }
        catch { discard = new Error('PostgreSQL transaction connection lost'); }
      }
      // Never retry a transaction silently after an ambiguous COMMIT result. The request key resolves it.
      throw error;
    } finally { client.release(discard); }
  }

  close(): Promise<void> { return this.closing ??= this.pool.end(); }
}

export async function databaseFromEnvironment(migration = false): Promise<Database> {
  const connectionString = (migration ? process.env.MIGRATION_DATABASE_URL : undefined) ?? process.env.DATABASE_URL;
  if (!connectionString) throw new Error('Set DATABASE_URL before starting Aqua. Run db:migrate before starting the API.');
  return new Database({
    connectionString, schema: process.env.DATABASE_SCHEMA,
    maxConnections: process.env.DATABASE_POOL_SIZE ? Number(process.env.DATABASE_POOL_SIZE) : undefined,
    production: process.env.NODE_ENV === 'production',
    ca: process.env.DATABASE_CA_FILE ? await readFile(process.env.DATABASE_CA_FILE, 'utf8') : undefined,
  });
}
