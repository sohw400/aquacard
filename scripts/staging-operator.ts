import { lstat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { Database } from '../server/database';

export class LocalStagingError extends Error {}

export async function assertPrivateStagingPath(path: string, directory = false) {
  const info = await lstat(path);
  if (!(directory ? info.isDirectory() : info.isFile()) || (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())) {
    throw new LocalStagingError('Use an operator-owned private staging directory and private credential files.');
  }
}

const roles = {
  DATABASE_URL: 'aqua_stage_app',
  MIGRATION_DATABASE_URL: 'aqua_stage_admin',
  ISSUANCE_DATABASE_URL: 'aqua_stage_issuance',
  FUNDING_DATABASE_URL: 'aqua_stage_funding',
} as const;
type Connection = keyof typeof roles;

/** Privileged test commands may only connect to the dedicated local TLS database. */
export async function openLocalStagingOperator() {
  if (process.env.NODE_ENV === 'production') throw new LocalStagingError('Local staging only.');
  const dir = resolve(process.env.AQUA_STAGING_DIR ?? 'data/local-staging');
  await assertPrivateStagingPath(dir, true);
  const operatorFile = join(dir, 'operator.env');
  await assertPrivateStagingPath(operatorFile);
  const config = parseEnv(await readFile(operatorFile, 'utf8'));
  if (config.NODE_ENV !== 'staging' || config.DATABASE_SCHEMA !== 'aqua') {
    throw new LocalStagingError('Expected the local staging profile.');
  }
  const ca = await readFile(join(dir, 'ca.crt'), 'utf8');
  function validatedUrl(key: Connection) {
    const raw = config[key] ?? '';
    const url = URL.canParse(raw) ? new URL(raw) : null;
    if (!url || !['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
        || url.pathname !== '/aqua_staging' || url.username !== roles[key] || url.search || url.hash) {
      throw new LocalStagingError(`Invalid local staging connection in ${key}.`);
    }
    return url;
  }
  const host = validatedUrl('DATABASE_URL').host;
  return { dir, database(key: Connection) {
    const url = validatedUrl(key);
    if (url.host !== host) throw new LocalStagingError('All staging logins must target the same database.');
    return new Database({ connectionString: url.href, ca, schema: 'aqua', production: true, maxConnections: 3 });
  } };
}
