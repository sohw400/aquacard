import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import test, { type TestContext } from 'node:test';
import { Database } from './database';
import { cardServiceDatabase } from './card-service-database';
import { createTestDatabase } from './test-support';
import { verifyMigrations } from './migrations';
import {
  grantMonitorRole, verifyMonitorRole, grantApplicationRole, grantCardIngressRole, grantCardWorkerRole, grantCardDispatcherRole, grantCardOperationsRole,
  verifyApplicationRole, verifyCardIngressRole, verifyCardWorkerRole, verifyCardDispatcherRole, verifyCardOperationsRole,
} from './permissions';

const access = {
  monitor: { grant: grantMonitorRole, verify: verifyMonitorRole },
  api: { grant: grantApplicationRole, verify: verifyApplicationRole },
  ingress: { grant: grantCardIngressRole, verify: verifyCardIngressRole },
  worker: { grant: grantCardWorkerRole, verify: verifyCardWorkerRole },
  dispatcher: { grant: grantCardDispatcherRole, verify: verifyCardDispatcherRole },
  operations: { grant: grantCardOperationsRole, verify: verifyCardOperationsRole },
};
type Service = keyof typeof access;

async function fixture(t: TestContext, services: Service[] = ['operations']) {
  const base = await createTestDatabase();
  const password = randomBytes(24).toString('hex');
  const suffix = randomBytes(10).toString('hex');
  const roles = new Map<Service, { name: string; database: Database }>();
  const created: string[] = [];
  t.after(async () => {
    await Promise.all([...roles.values()].map(({ database }) => database.close()));
    try {
      for (const name of created) {
        await base.database.query(`DROP OWNED BY "${name}"`);
        await base.database.query(`DROP ROLE "${name}"`);
      }
    } finally { await base.cleanup(); }
  });
  for (const service of services) {
    const name = `ops_${service}_${suffix}`;
    await base.database.query(`CREATE ROLE "${name}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    created.push(name);
    await access[service].grant(base.database, name);
    const url = new URL(base.connectionString); url.username = name; url.password = password;
    roles.set(service, { name, database: new Database({ connectionString: url.toString(), schema: base.schema, maxConnections: 2 }) });
  }
  return { ...base, roles, service(kind: Service) { const role = roles.get(kind); assert.ok(role); return role; } };
}

test('the operations login prepares and reads its report without direct access to customer, financial or audit records', async (t) => {
  const f = await fixture(t, ['api', 'ingress', 'worker', 'dispatcher', 'operations']);
  const ops = f.service('operations');
  for (const [service, role] of f.roles) await access[service].verify(role.database);
  await verifyMigrations(ops.database);
  await assert.rejects(verifyCardOperationsRole(f.database), /separate restricted operations/);
  const requestId = randomUUID();
  const input = { requestId, lookup: { kind: 'event', id: 'permission-event-not-present' }, caseReference: 'CASE-1001' };
  const receipt = await ops.database.transaction(async (client) => (await client.query(
    'SELECT prepare_card_operations_report($1::jsonb) AS result', [JSON.stringify(input)])).rows[0].result,
  { isolation: 'repeatable read' });
  assert.deepEqual(Object.keys(receipt).sort(), ['duplicate', 'preparedAt', 'requestId']);
  assert.equal(receipt.requestId, requestId);
  const report = (await ops.database.query('SELECT read_card_operations_report($1::text) AS result', [requestId])).rows[0].result;
  assert.equal(report.requestId, requestId); assert.equal(report.found, false);
  const audit = (await f.database.query('SELECT actor FROM card_operations_reports')).rows;
  assert.deepEqual(audit, [{ actor: ops.name }], 'the database login owns the audit; callers cannot supply another actor');
  for (const [service, role] of f.roles) {
    for (const sql of ['SELECT * FROM card_operations_reports', 'SELECT result FROM card_operations_reports',
      'INSERT INTO card_operations_reports DEFAULT VALUES', 'UPDATE card_operations_reports SET actor=actor',
      'DELETE FROM card_operations_reports', 'TRUNCATE card_operations_reports']) {
      await assert.rejects(role.database.query(sql), /permission denied/);
    }
    if (service !== 'operations') {
      await assert.rejects(role.database.query('SELECT prepare_card_operations_report($1::jsonb)', [JSON.stringify(input)]), /permission denied/);
      await assert.rejects(role.database.query('SELECT read_card_operations_report($1::text)', [requestId]), /permission denied/);
    }
  }
  for (const table of ['users', 'auth_sessions', 'ledger_accounts', 'journals', 'card_payments', 'card_payment_events',
    'card_event_inbox', 'card_inbox_attempts', 'issuer_cards', 'issuer_outbox', 'card_authorization_decisions']) {
    await assert.rejects(ops.database.query(`SELECT * FROM ${table}`), /permission denied/);
    await assert.rejects(ops.database.query(`INSERT INTO ${table} DEFAULT VALUES`), /permission denied/);
    await assert.rejects(ops.database.query(`DELETE FROM ${table}`), /permission denied/);
  }
  for (const sql of [
    "SELECT apply_sandbox_card_event('{}'::jsonb,1000::bigint)",
    "SELECT apply_sandbox_card_event_financial_004('{}'::jsonb,1000::bigint)",
    "SELECT request_issuer_card_status('{}'::jsonb,1000::bigint)",
    'SELECT process_card_inbox(1000::bigint)', 'SELECT claim_issuer_outbox(1000::bigint)',
    "SELECT operator_retry_card_inbox('{}'::jsonb,1000::bigint)",
    "SELECT operator_retry_issuer_outbox('{}'::jsonb,1000::bigint)",
    "SELECT operator_grant_rewards('{}'::jsonb,1000::bigint)",
  ]) await assert.rejects(ops.database.query(sql), /permission denied/);
  assert.equal((await f.database.query('SELECT COUNT(*)::int AS n FROM journals')).rows[0].n, 0);
});

test('monitor can count incidents without customer records, traces or payment actions', async (t) => {
  const fixtureRoles = await fixture(t, ['monitor', 'operations']);
  const { database, name } = fixtureRoles.service('monitor');
  const operator = fixtureRoles.service('operations').database;
  await verifyMigrations(database);
  await verifyMonitorRole(database);
  await assert.rejects(verifyMonitorRole(operator), /restricted monitor/);
  for (const sql of ['SELECT operations_ledger_finding_count()', 'SELECT read_queue_health(1000::bigint)']) {
    await database.query(sql);
    await assert.rejects(operator.query(sql), /permission denied/);
  }
  for (const sql of ['SELECT * FROM internal_ledger_findings()', 'SELECT email FROM users',
    'SELECT * FROM journal_entries', 'SELECT * FROM card_event_inbox', 'SELECT * FROM auth_mail_outbox',
    'SELECT read_card_operations_report(NULL)', 'SELECT prepare_card_operations_report(NULL)',
    'SELECT process_card_inbox(1000::bigint)', 'DELETE FROM card_payments']) {
    await assert.rejects(database.query(sql), /permission denied/);
  }
  await fixtureRoles.database.query(`GRANT SELECT(email) ON users TO "${name}"`);
  await assert.rejects(verifyMonitorRole(database), /restricted monitor/);
  await fixtureRoles.database.query(`REVOKE SELECT(email) ON users FROM "${name}"`);
  await verifyMonitorRole(database);
});

test('operations startup rejects accidental table, column, schema and private function permissions', async (t) => {
  const f = await fixture(t); const ops = f.service('operations');
  const grants = [
    ['SELECT ON card_operations_reports', 'SELECT ON card_operations_reports'],
    ['SELECT(result) ON card_operations_reports', 'SELECT(result) ON card_operations_reports'],
    ['UPDATE(actor) ON card_operations_reports', 'UPDATE(actor) ON card_operations_reports'],
    ['INSERT(actor) ON card_operations_reports', 'INSERT(actor) ON card_operations_reports'],
    ['SELECT ON users', 'SELECT ON users'],
    ['EXECUTE ON FUNCTION apply_sandbox_card_event(jsonb,bigint)', 'EXECUTE ON FUNCTION apply_sandbox_card_event(jsonb,bigint)'],
    ['EXECUTE ON FUNCTION apply_sandbox_card_event_financial_004(jsonb,bigint)', 'EXECUTE ON FUNCTION apply_sandbox_card_event_financial_004(jsonb,bigint)'],
    [`CREATE ON SCHEMA "${f.schema}"`, `CREATE ON SCHEMA "${f.schema}"`],
  ];
  for (const [grant, revoke] of grants) {
    await f.database.query(`GRANT ${grant} TO "${ops.name}"`);
    await assert.rejects(verifyCardOperationsRole(ops.database), /separate restricted operations/);
    await f.database.query(`REVOKE ${revoke} FROM "${ops.name}"`);
    await verifyCardOperationsRole(ops.database);
  }
  await f.database.query(`REVOKE EXECUTE ON FUNCTION read_card_operations_report(text) FROM "${ops.name}"`);
  await assert.rejects(verifyCardOperationsRole(ops.database), /separate restricted operations/);
  await grantCardOperationsRole(f.database, ops.name);
  await verifyCardOperationsRole(ops.database);
});

test('API and card workers reject accidental operations access instead of silently sharing the inspection role', async (t) => {
  const f = await fixture(t, ['api', 'ingress', 'worker', 'dispatcher']);
  for (const [service, role] of f.roles) {
    const forbidden = service === 'api' ? /private ledger helper/ : /separate restricted/;
    await f.database.query(`GRANT EXECUTE ON FUNCTION prepare_card_operations_report(jsonb) TO "${role.name}"`);
    await assert.rejects(access[service].verify(role.database), forbidden);
    await f.database.query(`REVOKE EXECUTE ON FUNCTION prepare_card_operations_report(jsonb) FROM "${role.name}"`);
    await f.database.query(`GRANT SELECT(result) ON card_operations_reports TO "${role.name}"`);
    await assert.rejects(access[service].verify(role.database));
    await f.database.query(`REVOKE SELECT(result) ON card_operations_reports FROM "${role.name}"`);
    await access[service].verify(role.database);
  }
});

test('operations startup rejects role delegation and elevated attributes, including membership without immediate SET access', async (t) => {
  const f = await fixture(t, ['api', 'operations']); const ops = f.service('operations'); const api = f.service('api');
  for (const options of ['INHERIT FALSE, SET TRUE', 'ADMIN TRUE, INHERIT FALSE, SET FALSE']) {
    await f.database.query(`GRANT "${api.name}" TO "${ops.name}" WITH ${options}`);
    if (options.includes('SET FALSE')) {
      assert.equal((await ops.database.query("SELECT pg_has_role(current_user,$1,'SET') AS allowed", [api.name])).rows[0].allowed, false);
    }
    await assert.rejects(verifyCardOperationsRole(ops.database), /separate restricted operations/);
    await f.database.query(`REVOKE "${api.name}" FROM "${ops.name}"`);
    await verifyCardOperationsRole(ops.database);
  }
  await f.database.query(`ALTER ROLE "${ops.name}" CREATEROLE`);
  await assert.rejects(verifyCardOperationsRole(ops.database), /separate restricted operations/);
  await f.database.query(`ALTER ROLE "${ops.name}" NOCREATEROLE`);
  await verifyCardOperationsRole(ops.database);
});

test('runtime roles reject sequence grants and re-granting the intended role removes access to inbox arrival ordering', async (t) => {
  const f = await fixture(t, ['api', 'ingress', 'worker', 'dispatcher', 'operations']);
  const sequence = (await f.database.query("SELECT pg_get_serial_sequence('card_event_inbox','arrival_sequence') AS name")).rows[0].name as string;
  assert.match(sequence, /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/);
  const original = (await f.database.query(`SELECT last_value,is_called FROM ${sequence}`)).rows;
  for (const [service, role] of f.roles) {
    for (const privilege of ['SELECT', 'USAGE', 'UPDATE']) {
      await f.database.query(`GRANT ${privilege} ON SEQUENCE ${sequence} TO "${role.name}"`);
      await assert.rejects(access[service].verify(role.database));
      await access[service].grant(f.database, role.name);
      await access[service].verify(role.database);
    }
    await assert.rejects(role.database.query('SELECT nextval($1::regclass)', [sequence]), /permission denied/);
    await assert.rejects(role.database.query('SELECT setval($1::regclass,1000)', [sequence]), /permission denied/);
  }
  assert.deepEqual((await f.database.query(`SELECT last_value,is_called FROM ${sequence}`)).rows, original);
});

test('operations database configuration requires its own URL and preserves production TLS verification', async () => {
  const keys = ['OPERATIONS_DATABASE_URL', 'DATABASE_URL', 'MIGRATION_DATABASE_URL', 'NODE_ENV', 'DATABASE_CA_FILE'] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    delete process.env.OPERATIONS_DATABASE_URL;
    delete process.env.DATABASE_CA_FILE;
    process.env.DATABASE_URL = 'postgresql://api:secret@127.0.0.1:1/aqua';
    process.env.MIGRATION_DATABASE_URL = 'postgresql://owner:secret@127.0.0.1:1/aqua';
    await assert.rejects(cardServiceDatabase('operations'), /Set OPERATIONS_DATABASE_URL/);
    process.env.NODE_ENV = 'production';
    process.env.OPERATIONS_DATABASE_URL = 'postgresql://ops:secret@127.0.0.1:1/aqua?sslmode=disable';
    await assert.rejects(cardServiceDatabase('operations'), /TLS cannot be disabled/);
    process.env.OPERATIONS_DATABASE_URL = 'postgresql://ops:secret@127.0.0.1:1/aqua';
    const database = await cardServiceDatabase('operations');
    try {
      assert.equal(database.pool.options.max, 2);
      assert.deepEqual(database.pool.options.ssl, { rejectUnauthorized: true });
    } finally { await database.close(); }
  } finally {
    for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  }
});

test('revoked ACLs cannot hide an operations login which owns a schema, table or function and can grant itself access', async (t) => {
  const f = await fixture(t); const ops = f.service('operations');
  const owner = (await f.database.query('SELECT current_user AS name')).rows[0].name as string;
  assert.match(owner, /^[a-z][a-z0-9_]{0,62}$/);
  await f.database.query(`ALTER SCHEMA "${f.schema}" OWNER TO "${ops.name}"`);
  try {
    await f.database.query(`REVOKE CREATE ON SCHEMA "${f.schema}" FROM "${ops.name}"`);
    assert.equal((await ops.database.query('SELECT has_schema_privilege(current_user,$1,\'CREATE\') AS allowed', [f.schema])).rows[0].allowed, false);
    await assert.rejects(verifyCardOperationsRole(ops.database), /separate restricted operations/);
  } finally { await f.database.query(`ALTER SCHEMA "${f.schema}" OWNER TO "${owner}"`); }
  // Ownership reassignment changes the schema ACL's owner entry, so restore
  // the ordinary USAGE grant as part of returning to the restricted setup.
  await grantCardOperationsRole(f.database, ops.name);
  await verifyCardOperationsRole(ops.database);

  await f.database.query('CREATE TABLE test_owned_record (secret TEXT)');
  await f.database.query(`ALTER TABLE test_owned_record OWNER TO "${ops.name}"`);
  try {
    await f.database.query(`REVOKE ALL ON test_owned_record FROM "${ops.name}"`);
    assert.equal((await ops.database.query("SELECT has_table_privilege(current_user,'test_owned_record','SELECT') AS allowed")).rows[0].allowed, false);
    await assert.rejects(verifyCardOperationsRole(ops.database), /separate restricted operations/);
  } finally { await f.database.query(`ALTER TABLE test_owned_record OWNER TO "${owner}"`); }
  await verifyCardOperationsRole(ops.database);

  await f.database.query('CREATE FUNCTION test_owned_function() RETURNS INTEGER LANGUAGE sql AS $$ SELECT 1 $$');
  await f.database.query(`ALTER FUNCTION test_owned_function() OWNER TO "${ops.name}"`);
  try {
    await f.database.query(`REVOKE ALL ON FUNCTION test_owned_function() FROM PUBLIC,"${ops.name}"`);
    assert.equal((await ops.database.query("SELECT has_function_privilege(current_user,'test_owned_function()','EXECUTE') AS allowed")).rows[0].allowed, false);
    await assert.rejects(verifyCardOperationsRole(ops.database), /separate restricted operations/);
  } finally { await f.database.query(`ALTER FUNCTION test_owned_function() OWNER TO "${owner}"`); }
  await verifyCardOperationsRole(ops.database);
});

test('migration startup rejects a shared operations role before attempting a database connection', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'server/migrate.ts'], {
    env: { ...process.env, NODE_ENV: 'development', MIGRATION_DATABASE_URL: 'postgresql://secret-user:secret-password@127.0.0.1:1/unused',
      DATABASE_RUNTIME_ROLE: 'same_runtime', DATABASE_INGRESS_ROLE: 'separate_ingress', DATABASE_WORKER_ROLE: 'separate_worker',
      DATABASE_DISPATCHER_ROLE: 'separate_dispatcher', DATABASE_OPERATIONS_ROLE: 'same_runtime' },
    encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must use different database roles/);
  assert.doesNotMatch(result.stdout + result.stderr, /secret-user|secret-password|ECONNREFUSED/);
});
