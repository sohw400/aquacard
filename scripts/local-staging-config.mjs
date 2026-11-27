// Private configuration for the local staging stack. No user-supplied database target is accepted.
import { randomBytes, createHash } from 'node:crypto';
import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isIP } from 'node:net';
import pg from 'pg';

const dir = process.env.STAGE_DIR;
const dbName = 'aqua_staging';
const localHost = '127.0.0.1:54339';
const roles = {
  admin: ['MIGRATION_DATABASE_URL'], app: ['DATABASE_URL','DATABASE_RUNTIME_ROLE'],
  dispatcher: ['DISPATCHER_DATABASE_URL','DATABASE_DISPATCHER_ROLE'],
  funding: ['FUNDING_DATABASE_URL','DATABASE_FUNDING_ROLE'],
  issuance: ['ISSUANCE_DATABASE_URL','DATABASE_ISSUANCE_ROLE'],
  operations: ['OPERATIONS_DATABASE_URL','DATABASE_OPERATIONS_ROLE'],
  authorizer: ['AUTHORIZATION_SIMULATOR_DATABASE_URL','DATABASE_AUTHORIZATION_SIMULATOR_ROLE'],
  mail: ['AUTH_MAIL_DATABASE_URL','DATABASE_AUTH_MAIL_ROLE'],
};
const role = id => 'aqua_stage_' + id;

async function putPrivate(name, value) {
  const dest = join(dir, name);
  const tmp = dest + '.tmp';
  await writeFile(tmp, value, { mode: 0o600 });
  await rename(tmp, dest);
}
async function credentials() {
  let saved;
  let changed = false;
  try {
    saved = JSON.parse(await readFile(join(dir, 'credentials.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    saved = Object.fromEntries(['bootstrap', ...Object.keys(roles)].map(id => [id, randomBytes(32).toString('hex')]));
    saved.mailKey = randomBytes(32).toString('base64');
    changed = true;
  }
  if (saved.dispatcher === undefined) { saved.dispatcher = randomBytes(32).toString('hex'); changed = true; }
  if (saved.issuerKey === undefined) { saved.issuerKey = randomBytes(32).toString('base64url'); changed = true; }
  if (!/^[a-zA-Z0-9_-]{43}$/.test(saved.issuerKey)) throw new Error('Invalid local staging issuer key.');
  for (const id of ['bootstrap', ...Object.keys(roles)]) {
    if (!/^[a-f0-9]{64}$/.test(saved[id])) throw new Error('Incomplete local staging credentials file.');
  }
  if (Buffer.from(saved.mailKey, 'base64').length !== 32) throw new Error('Invalid local staging mail key.');
  if (changed) await putPrivate('credentials.json', JSON.stringify(saved));
  return saved;
}
const url = (user, pass, host) => `postgresql://${user}:${pass}@${host}/${dbName}`;
async function envFile(name, entries) {
  // Compose and Node both accept single quoted JSON keyrings with literal double quotes.
  const lines = Object.entries(entries).map(([key, value]) => {
    if (/[\r\n]/.test(value) || value.includes("'") && value.includes('"')) throw new Error('Unsupported configuration path.');
    const quote = value.includes("'") ? '"' : "'";
    return key + '=' + quote + value + quote;
  });
  await putPrivate(name, lines.join('\n') + '\n');
}
async function configure(proxyIp) {
  const preview = process.env.STAGE_PREVIEW || '';
  if (preview) {
    const u = new URL(preview);
    if (u.protocol !== 'https:' || u.origin !== preview || u.hostname.includes('*')) throw new Error('Preview needs an exact HTTPS origin without a path.');
  }
  const common = { NODE_ENV: 'staging', DATABASE_SCHEMA: 'aqua', DATABASE_CA_FILE: '/run/aqua/ca.crt' };
  const secrets = await credentials();
  const keyring = { AQUA_AUTH_MAIL_KEYS: JSON.stringify({ stage: secrets.mailKey }), AQUA_AUTH_MAIL_ACTIVE_KEY: 'stage' };
  const origins = ['https://localhost:3443','https://127.0.0.1:3443', ...(preview ? [preview] : [])].join(',');
  if (proxyIp && !isIP(proxyIp)) throw new Error('Unexpected edge proxy address.');
  await putPrivate('db-bootstrap-password', secrets.bootstrap);
  await envFile('api.env', { ...common, ...keyring, DATABASE_URL: url(role('app'), secrets.app, 'postgres:5432'),
    AQUA_HOST: '0.0.0.0', AQUA_PORT: '3001', AQUA_STATIC_DIR: '/app/dist',
    AQUA_ALLOWED_ORIGINS: origins, AQUA_TRUSTED_PROXIES: proxyIp || '' });
  await envFile('mail.env', { ...common, ...keyring,
    AUTH_MAIL_DATABASE_URL: url(role('mail'), secrets.mail, 'postgres:5432'),
    AQUA_AUTH_MAIL_TRANSPORT: 'file', AQUA_MAIL_DIR: '/var/aqua-mail' });
  const issuer = { NODE_ENV: 'staging', AQUA_ISSUER_KEY_ID: 'local', AQUA_ISSUER_SIGNING_KEY: secrets.issuerKey };
  await envFile('issuer.env', { ...issuer, AQUA_LOCAL_STAGING_ISSUER_DIR: '/var/aqua-issuer' });
  await envFile('dispatcher.env', { ...common, ...issuer, AQUA_ISSUER_SANDBOX_URL: 'http://127.0.0.1:3005',
    DISPATCHER_DATABASE_URL: url(role('dispatcher'), secrets.dispatcher, 'postgres:5432') });
  const operator = { ...common, DATABASE_CA_FILE: join(dir, 'ca.crt'), AQUA_ALLOWED_ORIGINS: origins };
  for (const [id, [variable, login]] of Object.entries(roles)) {
    operator[variable] = url(role(id), secrets[id], localHost);
    if (login) operator[login] = role(id);
  }
  await envFile('operator.env', operator);
  const migration = { ...common, MIGRATION_DATABASE_URL: url(role('admin'), secrets.admin, 'postgres:5432') };
  for (const [id, [, login]] of Object.entries(roles)) {
    if (login) migration[login] = role(id);
  }
  await envFile('migration.env', migration);
}
async function bootstrap() {
  const secrets = await credentials();
  const options = { ssl: { rejectUnauthorized: true, ca: await readFile(join(dir, 'ca.crt'), 'utf8') }, connectionTimeoutMillis: 5000 };
  const owner = new pg.Client({ ...options, connectionString: `postgresql://postgres:${secrets.bootstrap}@${localHost}/postgres` });
  await owner.connect();
  try {
    await owner.query('BEGIN');
    // The bootstrap login is confined to this dedicated, TLS-authenticated cluster.
    for (const id of Object.keys(roles)) {
      const name = role(id);
      const existing = await owner.query('SELECT rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls,rolcanlogin FROM pg_roles WHERE rolname=$1',[name]);
      if (!existing.rowCount) {
        await owner.query('CREATE ROLE "' + name + '" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ' + pg.escapeLiteral(secrets[id]));
      } else {
        const r = existing.rows[0];
        if (r.rolsuper || r.rolcreaterole || r.rolcreatedb || r.rolreplication || r.rolbypassrls || !r.rolcanlogin) throw new Error('Unexpected privileges for ' + name);
      }
    }
    await owner.query('COMMIT');
    const db = await owner.query('SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=$1',[dbName]);
    if (!db.rowCount) await owner.query('CREATE DATABASE aqua_staging OWNER aqua_stage_admin');
    else if (db.rows[0].owner !== role('admin')) throw new Error('Staging database has a different owner.');
    await owner.query('BEGIN');
    await owner.query('REVOKE ALL ON DATABASE aqua_staging FROM PUBLIC');
    for (const id of Object.keys(roles)) await owner.query('GRANT CONNECT ON DATABASE aqua_staging TO "' + role(id) + '"');
    await owner.query('COMMIT');
  } finally { await owner.end(); }
  const migrator = new pg.Client({ ...options, connectionString: url(role('admin'), secrets.admin, localHost) });
  await migrator.connect();
  try { await migrator.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC'); } finally { await migrator.end(); }
}
async function releaseId() {
  const hash = createHash('sha256');
  async function add(path) {
    hash.update(path + '\0'); hash.update(await readFile(path));
  }
  for (const folder of ['src','server','shared','public']) {
    const files = await readdir(folder, { recursive:true, withFileTypes:true });
    for (const path of files.filter(file=>file.isFile()).map(file=>join(file.parentPath,file.name)).sort()) await add(path);
  }
  for (const file of ['scripts/build-server.mjs','package.json','package-lock.json','index.html','tsconfig.json','tsconfig.server.json','vite.config.ts']) await add(file);
  console.log(hash.digest('hex'));
}
switch (process.argv[2]) {
  case 'release': await releaseId(); break;
  case 'configure': await configure(process.argv[3]); break;
  case 'bootstrap': await bootstrap(); break;
  default: throw new Error('Unknown local staging configuration action.');
}
