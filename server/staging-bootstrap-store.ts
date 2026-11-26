import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { checkedSchema, type Database } from './database';
import { applyMigrations, verifyMigrations } from './migrations';
import { allowStagingMonitorRole, verifyMonitorRole, verifyStagingMonitorCandidate } from './permissions';
import { monitorSecretConnectionString } from './monitor-database-secret';

const invalid = () => new Error('Invalid staging bootstrap configuration.');

export function stagingCredentials(env: NodeJS.ProcessEnv) {
  const host = env.DATABASE_HOST;
  if (env.NODE_ENV !== 'production' || env.DATABASE_SCHEMA !== 'aqua' || env.DATABASE_NAME !== 'aqua'
    || !host || !/^[a-z0-9][a-z0-9-]*\.[a-z0-9]+\.ap-northeast-2\.rds\.amazonaws\.com$/.test(host)
    || !env.DATABASE_CA_FILE || !env.MONITOR_DATABASE_SECRET || !env.AQUA_STAGING_DB_ADMIN_JSON) throw invalid();
  try {
    const admin = JSON.parse(env.AQUA_STAGING_DB_ADMIN_JSON);
    if (admin?.username !== 'aqua_admin' || typeof admin.password !== 'string' || !admin.password
      || (admin.host !== undefined && admin.host !== host) || (admin.port !== undefined && Number(admin.port) !== 5432)
      || (admin.engine !== undefined && admin.engine !== 'postgres')
      || (admin.dbname !== undefined && admin.dbname !== env.DATABASE_NAME)) throw invalid();
    const monitorUrl = new URL(monitorSecretConnectionString(env.MONITOR_DATABASE_SECRET));
    const monitorPassword = decodeURIComponent(monitorUrl.password);
    if (monitorUrl.host !== host + ':5432' || monitorUrl.pathname !== '/aqua' || monitorUrl.username !== 'aqua_monitor'
      || !/^[\x21-\x7e]+$/.test(monitorPassword) || monitorPassword === admin.password) throw invalid();
    const adminUrl = monitorSecretConnectionString(JSON.stringify({ host, port: 5432, dbname: 'aqua',
      username: admin.username, password: admin.password }));
    return { adminUrl, monitorUrl: monitorUrl.href, monitorPassword, caFile: env.DATABASE_CA_FILE };
  } catch { throw invalid(); }
}

// The foundation generates a printable ASCII password. Derive the PostgreSQL
// SCRAM verifier locally so plaintext is never sent to a SQL statement logger.
function scramVerifier(password: string) {
  if (!/^[\x21-\x7e]+$/.test(password)) throw invalid();
  const salt = randomBytes(16);
  const rounds = 16_384;
  const key = pbkdf2Sync(password, salt, rounds, 32, 'sha256');
  const client = createHmac('sha256', key).update('Client Key').digest();
  const stored = createHash('sha256').update(client).digest('base64');
  const server = createHmac('sha256', key).update('Server Key').digest('base64');
  return `SCRAM-SHA-256$${rounds}:${salt.toString('base64')}$${stored}:${server}`;
}

interface BootstrapIdentity { databaseName: string; adminRole: string; monitorRole: string; monitorPassword: string }

export async function bootstrapMonitor(owner: Database, monitor: Database, identity: BootstrapIdentity) {
  const { databaseName, adminRole, monitorRole, monitorPassword } = identity;
  checkedSchema(monitorRole);
  if (monitorRole === adminRole || owner.schema !== monitor.schema) throw invalid();
  const target = await owner.query<{ valid: boolean; existing: boolean }>(`SELECT current_database()=$1 AND current_user=$2
    AND NOT pg_is_in_recovery() AND current_setting('transaction_read_only')='off'
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname=$3
      AND (n.nspowner<>current_user::regrole OR EXISTS (
        SELECT 1 FROM aclexplode(coalesce(n.nspacl, acldefault('n',n.nspowner))) a
        WHERE a.privilege_type='CREATE' AND a.grantee<>n.nspowner))) AS valid,
    EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=$4) AS existing`,
  [databaseName, adminRole, owner.schema, monitorRole]);
  if (!target.rows[0]?.valid) throw new Error('Staging migration identity or schema ownership mismatch.');

  async function confirmLogin() {
    const login = await monitor.query<{ valid: boolean }>('SELECT current_database()=$1 AND current_user=$2 AS valid', [databaseName, monitorRole]);
    if (!login.rows[0]?.valid) throw new Error('Staging monitor login mismatch.');
  }
  if (target.rows[0].existing) {
    await confirmLogin();
    await verifyStagingMonitorCandidate(owner, monitorRole);
  }

  await applyMigrations(owner);
  await owner.transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['aqua:staging-monitor:' + monitorRole]);
    if ((await client.query('SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=$1', [monitorRole])).rowCount) {
      await confirmLogin();
    } else {
      const verifier = scramVerifier(monitorPassword);
      await client.query("SELECT set_config('aqua_bootstrap.role',$1,true),set_config('aqua_bootstrap.verifier',$2,true)", [monitorRole, verifier]);
      await client.query(`DO $$ BEGIN EXECUTE pg_catalog.format('CREATE ROLE %I LOGIN PASSWORD %L',
        current_setting('aqua_bootstrap.role'),current_setting('aqua_bootstrap.verifier')); END; $$`);
    }
    await allowStagingMonitorRole(client, owner.schema, monitorRole);
  });
  await confirmLogin();
  await verifyMonitorRole(monitor);
  await verifyMigrations(monitor);
}
