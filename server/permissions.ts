import { checkedSchema, type Database } from './database';

/** The deployment creates this login role and stores its credentials outside source control. */
export async function grantApplicationRole(database: Database, role: string): Promise<void> {
  checkedSchema(role);
  await database.transaction(async (client) => {
    const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
    if (!exists.rowCount) throw new Error('DATABASE_RUNTIME_ROLE does not exist. Create the application login role before granting access.');
    const quoted = '"' + role + '"';
    await client.query(`GRANT USAGE ON SCHEMA "${database.schema}" TO ${quoted}`);
    await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA "${database.schema}" FROM ${quoted}`);
    await client.query(`REVOKE ALL ON schema_migrations, users, ledger_accounts, journals, journal_entries, auth_sessions, auth_recovery, auth_email_verification, auth_rate_limits FROM ${quoted}`);
    // Explicitly reset the previous release's writable columns before granting the new set.
    await client.query(`REVOKE UPDATE(token_hash, user_id, created_at, expires_at, session_id, device_label, last_seen_at, reauthenticated_at) ON auth_sessions FROM ${quoted}`);
    await client.query(`GRANT SELECT ON schema_migrations, users, ledger_accounts, journals, journal_entries, auth_sessions, auth_recovery, auth_email_verification, auth_rate_limits TO ${quoted}`);
    await client.query(`GRANT INSERT ON ledger_accounts, journals, auth_sessions, auth_recovery, auth_email_verification, auth_rate_limits TO ${quoted}`);
    await client.query(`REVOKE INSERT(email_verified_at), UPDATE(email_verified_at, email) ON users FROM ${quoted}`);
    await client.query(`GRANT INSERT(id,email,name,tag,password_hash,created_at) ON users TO ${quoted}`);
    await client.query(`GRANT UPDATE(password_hash) ON users TO ${quoted}`);
    // PostgreSQL row locks require UPDATE on at least one column. Identity updates themselves
    // remain forbidden by the immutable-identity trigger; balance_won is never granted.
    await client.query(`GRANT UPDATE(id) ON ledger_accounts TO ${quoted}`);
    await client.query(`GRANT UPDATE(last_seen_at, reauthenticated_at) ON auth_sessions TO ${quoted}`);
    await client.query(`GRANT UPDATE(used_at) ON auth_recovery TO ${quoted}`);
    await client.query(`GRANT UPDATE ON auth_rate_limits TO ${quoted}`);
    await client.query(`GRANT DELETE ON auth_sessions, auth_recovery, auth_email_verification, auth_rate_limits TO ${quoted}`);
    await client.query(`REVOKE ALL ON card_payments, card_payment_events FROM ${quoted}`);
    await client.query(`GRANT SELECT ON card_payments, card_payment_events TO ${quoted}`);
    await client.query(`GRANT EXECUTE ON FUNCTION internal_ledger_findings() TO ${quoted}`);
    await client.query(`REVOKE ALL ON FUNCTION apply_sandbox_card_event(jsonb, bigint) FROM ${quoted}`);
    await client.query(`GRANT EXECUTE ON FUNCTION apply_sandbox_card_event(jsonb, bigint) TO ${quoted}`);
    await client.query(`REVOKE ALL ON reward_wallets, reward_journals, reward_entries, reward_commands, reward_cashback_months, card_reward_allocations, reward_program, reward_history FROM ${quoted}`);
    await client.query(`REVOKE ALL ON reward_cash_plans FROM ${quoted}`);
    await client.query(`GRANT SELECT ON reward_wallets, reward_journals, reward_entries, reward_commands, reward_cashback_months, card_reward_allocations, reward_program, reward_history TO ${quoted}`);
    await client.query(`GRANT EXECUTE ON FUNCTION rewards_snapshot(text, bigint), apply_reward_preference(jsonb, bigint) TO ${quoted}`);
    await client.query(`REVOKE ALL ON card_event_inbox, card_inbox_attempts, card_inbox_requeues, card_inbox_lanes FROM ${quoted}`);
    await client.query(`REVOKE ALL ON issuer_cards, issuer_outbox, issuer_outbox_audit, issuer_outbox_completions, issuer_outbox_requeues FROM ${quoted}`);
    await client.query(`REVOKE ALL ON card_authorization_decisions, card_operations_reports FROM ${quoted}`);
    await client.query(`REVOKE ALL ON customer_access, customer_access_events, auth_mail_outbox, auth_mail_attempts FROM ${quoted}`);
    await client.query(`GRANT EXECUTE ON FUNCTION confirm_auth_email_verification(text,text,bigint), cleanup_auth_email_verification(bigint), enqueue_auth_mail(jsonb) TO ${quoted}`);
    await client.query(`GRANT EXECUTE ON FUNCTION customer_access_snapshot(text), customer_require_active(text[]) TO ${quoted}`);
    await client.query(`GRANT EXECUTE ON FUNCTION issuer_card_snapshot(text), request_issuer_card_status(jsonb,bigint) TO ${quoted}`);
    await client.query(`REVOKE ALL ON FUNCTION operator_fund_reward_budget(jsonb, bigint), operator_set_reward_program(jsonb, bigint), operator_grant_rewards(jsonb, bigint) FROM ${quoted}`);
    await client.query(`REVOKE ALL ON FUNCTION apply_sandbox_card_event_legacy_003(jsonb, bigint) FROM ${quoted}`);
    const internalFunctions = await client.query<{ signature: string }>(`SELECT p.oid::regprocedure::text AS signature
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = $1 AND p.prosecdef
      AND p.oid NOT IN ('apply_sandbox_card_event(jsonb,bigint)'::regprocedure,
        'rewards_snapshot(text,bigint)'::regprocedure, 'apply_reward_preference(jsonb,bigint)'::regprocedure,
        'issuer_card_snapshot(text)'::regprocedure, 'request_issuer_card_status(jsonb,bigint)'::regprocedure,
        'customer_access_snapshot(text)'::regprocedure, 'customer_require_active(text[])'::regprocedure,
        'confirm_auth_email_verification(text,text,bigint)'::regprocedure, 'cleanup_auth_email_verification(bigint)'::regprocedure, 'enqueue_auth_mail(jsonb)'::regprocedure)`, [database.schema]);
    for (const { signature } of internalFunctions.rows) await client.query(`REVOKE ALL ON FUNCTION ${signature} FROM ${quoted}`);
  });
}

/** Production boot fails if a migration owner or administrator was supplied as the runtime login. */
export async function verifyApplicationRole(database: Database): Promise<void> {
  const result = await database.query<{ unsafe: boolean }>(`SELECT
    r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls
    OR EXISTS (SELECT 1 FROM pg_roles delegated WHERE delegated.oid<>r.oid AND pg_has_role(current_user,delegated.oid,'SET'))
    OR EXISTS (SELECT 1 FROM pg_auth_members membership WHERE membership.member=r.oid)
    OR EXISTS (SELECT 1 FROM pg_namespace owned WHERE owned.nspname=$1 AND owned.nspowner=r.oid)
    OR EXISTS (SELECT 1 FROM pg_class owned JOIN pg_namespace ns ON ns.oid=owned.relnamespace WHERE ns.nspname=$1 AND owned.relowner=r.oid)
    OR EXISTS (SELECT 1 FROM pg_proc owned JOIN pg_namespace ns ON ns.oid=owned.pronamespace WHERE ns.nspname=$1 AND owned.proowner=r.oid)
    OR EXISTS (SELECT 1 FROM pg_class sequence JOIN pg_namespace ns ON ns.oid=sequence.relnamespace
      WHERE ns.nspname=$1 AND sequence.relkind='S' AND has_sequence_privilege(current_user,sequence.oid,'USAGE,SELECT,UPDATE'))
    OR has_schema_privilege(current_user, $1, 'CREATE')
    OR has_table_privilege(current_user, $2, 'UPDATE,DELETE,TRUNCATE')
    OR has_table_privilege(current_user, $3, 'UPDATE,DELETE,TRUNCATE')
    OR has_column_privilege(current_user, $3, 'balance_won', 'UPDATE')
    OR has_table_privilege(current_user, $4, 'INSERT,UPDATE,DELETE,TRUNCATE')
    OR has_table_privilege(current_user, $5, 'INSERT,UPDATE,DELETE,TRUNCATE')
    OR has_table_privilege(current_user, $6, 'INSERT,UPDATE,DELETE,TRUNCATE') AS unsafe
    FROM pg_roles r WHERE r.rolname = current_user`, [database.schema, `${database.schema}.journals`, `${database.schema}.ledger_accounts`, `${database.schema}.schema_migrations`, `${database.schema}.card_payments`, `${database.schema}.card_payment_events`]);
  if (result.rows.length !== 1 || result.rows[0].unsafe) {
    throw new Error('The API requires a restricted application database role. Keep migration and administrator credentials out of the running API.');
  }
  const sessionAccess = await database.query<{ unsafe: boolean }>(`SELECT EXISTS (
    SELECT 1 FROM unnest(ARRAY['token_hash','user_id','created_at','expires_at','session_id','device_label']) AS c(name)
    WHERE has_column_privilege(current_user, 'auth_sessions', name, 'UPDATE')
  ) AS unsafe`);
  if (sessionAccess.rows[0]?.unsafe !== false) throw new Error('The API cannot change session identity or extend its fixed expiry.');
  const emailAccess = await database.query<{ unsafe: boolean }>(`SELECT
    has_column_privilege(current_user, 'users', 'email_verified_at', 'INSERT,UPDATE')
    OR has_column_privilege(current_user, 'users', 'email', 'UPDATE') AS unsafe`);
  if (emailAccess.rows[0]?.unsafe !== false) throw new Error('The API cannot directly establish email ownership or change the verified address.');
  const protectedTables = ['reward_wallets', 'reward_journals', 'reward_commands', 'reward_cash_plans', 'reward_cashback_months', 'card_reward_allocations', 'reward_program', 'reward_history', 'card_event_inbox', 'card_inbox_attempts', 'card_inbox_requeues', 'card_inbox_lanes', 'issuer_cards', 'issuer_outbox', 'issuer_outbox_audit', 'issuer_outbox_completions', 'issuer_outbox_requeues', 'card_authorization_decisions', 'card_operations_reports', 'customer_access', 'customer_access_events', 'auth_mail_outbox', 'auth_mail_attempts'].map((table) => `${database.schema}.${table}`);
  const rewardAccess = await database.query<{ unsafe: boolean }>(`SELECT EXISTS (
    SELECT 1 FROM unnest($1::text[]) AS t(name) WHERE has_table_privilege(current_user, name, 'INSERT,UPDATE,DELETE,TRUNCATE')
      OR has_any_column_privilege(current_user, name, 'INSERT,UPDATE')
  ) OR EXISTS (
    SELECT 1 FROM unnest($2::text[]) AS f(name) WHERE has_function_privilege(current_user, name, 'EXECUTE')
  ) AS unsafe`, [protectedTables, ['operator_fund_reward_budget', 'operator_set_reward_program', 'operator_grant_rewards', 'apply_sandbox_card_event_legacy_003'].map((name) => `${database.schema}.${name}(jsonb,bigint)`)]);
  if (rewardAccess.rows[0]?.unsafe !== false) throw new Error('The API cannot change reward projections or execute reward budget and grant operations.');
  const internalAccess = await database.query<{ unsafe: boolean }>(`SELECT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = $1 AND p.prosecdef AND p.prorettype <> 'trigger'::regtype
      AND p.oid NOT IN ('apply_sandbox_card_event(jsonb,bigint)'::regprocedure,
        'rewards_snapshot(text,bigint)'::regprocedure, 'apply_reward_preference(jsonb,bigint)'::regprocedure,
        'issuer_card_snapshot(text)'::regprocedure, 'request_issuer_card_status(jsonb,bigint)'::regprocedure,
        'customer_access_snapshot(text)'::regprocedure, 'customer_require_active(text[])'::regprocedure,
        'confirm_auth_email_verification(text,text,bigint)'::regprocedure, 'cleanup_auth_email_verification(bigint)'::regprocedure, 'enqueue_auth_mail(jsonb)'::regprocedure)
      AND has_function_privilege(current_user, p.oid, 'EXECUTE')
  ) AS unsafe`, [database.schema]);
  if (internalAccess.rows[0]?.unsafe !== false) throw new Error('The API cannot execute private ledger helper functions.');
  const issuerAccess = await database.query<{ unsafe: boolean }>(`SELECT EXISTS (
    SELECT 1 FROM unnest($1::text[]) t(name)
    WHERE has_table_privilege(current_user,name,'SELECT') OR has_any_column_privilege(current_user,name,'SELECT')
  ) OR NOT has_function_privilege(current_user,'issuer_card_snapshot(text)','EXECUTE')
    OR NOT has_function_privilege(current_user,'request_issuer_card_status(jsonb,bigint)','EXECUTE')
    OR NOT has_function_privilege(current_user,'customer_access_snapshot(text)','EXECUTE')
    OR NOT has_function_privilege(current_user,'customer_require_active(text[])','EXECUTE')
    OR NOT has_function_privilege(current_user,'confirm_auth_email_verification(text,text,bigint)','EXECUTE')
    OR NOT has_function_privilege(current_user,'cleanup_auth_email_verification(bigint)','EXECUTE')
    OR NOT has_function_privilege(current_user,'enqueue_auth_mail(jsonb)','EXECUTE') AS unsafe`,
  [['issuer_cards', 'issuer_outbox', 'issuer_outbox_audit', 'issuer_outbox_completions', 'issuer_outbox_requeues', 'card_authorization_decisions', 'card_operations_reports', 'customer_access', 'customer_access_events', 'auth_mail_outbox', 'auth_mail_attempts'].map((table) => `${database.schema}.${table}`)]);
  if (issuerAccess.rows[0]?.unsafe !== false) throw new Error('The API requires the issuer command functions without direct issuer table access.');
}

const cardServiceFunctions = {
  ingress: ['enqueue_sandbox_card_event(jsonb,bigint)'],
  worker: ['process_card_inbox(bigint)', 'card_inbox_stats(bigint)'],
  dispatcher: ['claim_issuer_outbox(bigint)', 'finish_issuer_outbox(jsonb,bigint)', 'issuer_outbox_stats(bigint)'],
  operations: ['prepare_card_operations_report(jsonb)', 'read_card_operations_report(text)'],
  monitor: ['read_queue_health(bigint)', 'operations_ledger_finding_count()'],
  mail: ['claim_auth_mail(bigint)', 'finish_auth_mail(jsonb,bigint)', 'auth_mail_stats(bigint)'],
} as const;

async function allowServicePrivileges(connection: Pick<Database, 'query'>, schema: string,
  role: string, service: keyof typeof cardServiceFunctions): Promise<void> {
  const quoted = '"' + checkedSchema(role) + '"';
  await connection.query(`GRANT USAGE ON SCHEMA "${checkedSchema(schema)}" TO ${quoted}`);
  await connection.query(`GRANT SELECT ON schema_migrations TO ${quoted}`);
  await connection.query(`GRANT EXECUTE ON FUNCTION ${cardServiceFunctions[service].join(', ')} TO ${quoted}`);
}

function grantCardServiceRole(database: Database, role: string, service: keyof typeof cardServiceFunctions) {
  return database.transaction(async client => {
    const quoted = '"' + checkedSchema(role) + '"';
    if (!(await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount) {
      throw new Error(`Provision a separate card ${service} database login before granting access.`);
    }
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA "${database.schema}" FROM ${quoted}`);
    await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA "${database.schema}" FROM ${quoted}`);
    await client.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA "${database.schema}" FROM ${quoted}`);
    await allowServicePrivileges(client, database.schema, role, service);
  });
}

async function checkServicePrivileges(connection: Pick<Database, 'query'>, schema: string,
  service: keyof typeof cardServiceFunctions, role?: string, pendingMigration = false): Promise<void> {
  const { rows } = await connection.query<{ unsafe: boolean }>(`SELECT
    r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls
    OR EXISTS (SELECT 1 FROM pg_roles delegated WHERE delegated.oid<>r.oid AND pg_has_role(r.oid,delegated.oid,'SET'))
    OR EXISTS (SELECT 1 FROM pg_auth_members membership WHERE membership.member=r.oid)
    OR EXISTS (SELECT 1 FROM pg_namespace owned WHERE owned.nspname=$1 AND owned.nspowner=r.oid)
    OR EXISTS (SELECT 1 FROM pg_class owned JOIN pg_namespace ns ON ns.oid=owned.relnamespace WHERE ns.nspname=$1 AND owned.relowner=r.oid)
    OR EXISTS (SELECT 1 FROM pg_proc owned JOIN pg_namespace ns ON ns.oid=owned.pronamespace WHERE ns.nspname=$1 AND owned.proowner=r.oid)
    OR EXISTS (SELECT 1 FROM pg_class sequence JOIN pg_namespace ns ON ns.oid=sequence.relnamespace
      WHERE ns.nspname=$1 AND CASE WHEN sequence.relkind='S' THEN has_sequence_privilege(r.oid,sequence.oid,'USAGE,SELECT,UPDATE') ELSE false END)
    OR has_database_privilege(r.oid,current_database(),'CREATE')
    OR COALESCE(has_schema_privilege(r.oid,to_regnamespace($1),'CREATE'),false)
    OR EXISTS (SELECT 1 FROM unnest($2::text[]) f(signature)
      WHERE CASE WHEN to_regprocedure(signature) IS NULL THEN NOT $4::boolean
            ELSE NOT has_function_privilege(r.oid,to_regprocedure(signature),'EXECUTE') END)
    OR EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relkind IN ('r','v','m','p')
        AND (has_table_privilege(r.oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE')
          OR has_any_column_privilege(r.oid,c.oid,'INSERT,UPDATE')
          OR (c.relname<>'schema_migrations' AND (has_table_privilege(r.oid,c.oid,'SELECT') OR has_any_column_privilege(r.oid,c.oid,'SELECT'))))
    ) OR EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname=$1 AND p.prosecdef AND p.prorettype<>'trigger'::regtype
        AND NOT EXISTS (SELECT 1 FROM unnest($2::text[]) f(signature) WHERE to_regprocedure(signature)=p.oid)
        AND has_function_privilege(r.oid,p.oid,'EXECUTE')
    ) AS unsafe FROM pg_roles r WHERE r.rolname=COALESCE($3::name,current_user)`, [schema, cardServiceFunctions[service], role ?? null, pendingMigration]);
  if (rows.length !== 1 || rows[0].unsafe) throw new Error(`The card ${service} requires a separate restricted ${service} database role.`);
}

function verifyCardServiceRole(database: Database, service: keyof typeof cardServiceFunctions) {
  return checkServicePrivileges(database, database.schema, service);
}

/** A valid older release may not contain every newly required function yet. */
export function verifyStagingMonitorCandidate(owner: Database, role: string) {
  return checkServicePrivileges(owner, owner.schema, 'monitor', role, true);
}

/** Add the current grants and check effective rights before committing any DDL. */
export async function allowStagingMonitorRole(client: Pick<Database, 'query'>, schema: string, role: string) {
  await allowServicePrivileges(client, schema, role, 'monitor');
  await checkServicePrivileges(client, schema, 'monitor', role);
}

export const grantCardIngressRole = (database: Database, role: string) => grantCardServiceRole(database, role, 'ingress');
export const grantCardWorkerRole = (database: Database, role: string) => grantCardServiceRole(database, role, 'worker');
export const verifyCardIngressRole = (database: Database) => verifyCardServiceRole(database, 'ingress');
export const verifyCardWorkerRole = (database: Database) => verifyCardServiceRole(database, 'worker');
export const grantCardDispatcherRole = (database: Database, role: string) => grantCardServiceRole(database, role, 'dispatcher');
export const verifyCardDispatcherRole = (database: Database) => verifyCardServiceRole(database, 'dispatcher');
export const grantCardOperationsRole = (database: Database, role: string) => grantCardServiceRole(database, role, 'operations');
export const verifyCardOperationsRole = (database: Database) => verifyCardServiceRole(database, 'operations');

export const grantMonitorRole = (database: Database, role: string) => grantCardServiceRole(database, role, 'monitor');
export const verifyMonitorRole = (database: Database) => verifyCardServiceRole(database, 'monitor');

export const grantAuthMailRole = (database: Database, role: string) => grantCardServiceRole(database, role, 'mail');
export const verifyAuthMailRole = (database: Database) => verifyCardServiceRole(database, 'mail');
