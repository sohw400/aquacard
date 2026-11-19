import { checkedSchema, type Database } from './database';

/** The deployment creates this login role and stores its credentials outside source control. */
export async function grantApplicationRole(database: Database, role: string): Promise<void> {
  checkedSchema(role);
  await database.transaction(async (client) => {
    const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
    if (!exists.rowCount) throw new Error('DATABASE_RUNTIME_ROLE does not exist. Create the application login role before granting access.');
    const quoted = '"' + role + '"';
    await client.query(`GRANT USAGE ON SCHEMA "${database.schema}" TO ${quoted}`);
    await client.query(`REVOKE ALL ON schema_migrations, users, ledger_accounts, journals, journal_entries, auth_sessions, auth_recovery, auth_rate_limits FROM ${quoted}`);
    await client.query(`GRANT SELECT ON schema_migrations, users, ledger_accounts, journals, journal_entries, auth_sessions, auth_recovery, auth_rate_limits TO ${quoted}`);
    await client.query(`GRANT INSERT ON users, ledger_accounts, journals, auth_sessions, auth_recovery, auth_rate_limits TO ${quoted}`);
    await client.query(`GRANT UPDATE(password_hash) ON users TO ${quoted}`);
    // PostgreSQL row locks require UPDATE on at least one column. Identity updates themselves
    // remain forbidden by the immutable-identity trigger; balance_won is never granted.
    await client.query(`GRANT UPDATE(id) ON ledger_accounts TO ${quoted}`);
    await client.query(`GRANT UPDATE(expires_at) ON auth_sessions TO ${quoted}`);
    await client.query(`GRANT UPDATE(used_at) ON auth_recovery TO ${quoted}`);
    await client.query(`GRANT UPDATE ON auth_rate_limits TO ${quoted}`);
    await client.query(`GRANT DELETE ON auth_sessions, auth_recovery, auth_rate_limits TO ${quoted}`);
    await client.query(`REVOKE ALL ON card_payments, card_payment_events FROM ${quoted}`);
    await client.query(`GRANT SELECT ON card_payments, card_payment_events TO ${quoted}`);
    await client.query(`REVOKE ALL ON FUNCTION apply_sandbox_card_event(jsonb, bigint) FROM ${quoted}`);
    await client.query(`GRANT EXECUTE ON FUNCTION apply_sandbox_card_event(jsonb, bigint) TO ${quoted}`);
    await client.query(`REVOKE ALL ON reward_wallets, reward_journals, reward_entries, reward_commands, reward_cashback_months, card_reward_allocations, reward_program, reward_history FROM ${quoted}`);
    await client.query(`REVOKE ALL ON reward_cash_plans FROM ${quoted}`);
    await client.query(`GRANT SELECT ON reward_wallets, reward_journals, reward_entries, reward_commands, reward_cashback_months, card_reward_allocations, reward_program, reward_history TO ${quoted}`);
    await client.query(`GRANT EXECUTE ON FUNCTION rewards_snapshot(text, bigint), apply_reward_preference(jsonb, bigint) TO ${quoted}`);
    await client.query(`REVOKE ALL ON card_event_inbox, card_inbox_attempts, card_inbox_requeues, card_inbox_lanes FROM ${quoted}`);
    await client.query(`REVOKE ALL ON FUNCTION operator_fund_reward_budget(jsonb, bigint), operator_set_reward_program(jsonb, bigint), operator_grant_rewards(jsonb, bigint) FROM ${quoted}`);
    await client.query(`REVOKE ALL ON FUNCTION apply_sandbox_card_event_legacy_003(jsonb, bigint) FROM ${quoted}`);
    const internalFunctions = await client.query<{ signature: string }>(`SELECT p.oid::regprocedure::text AS signature
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = $1 AND p.prosecdef
      AND p.oid NOT IN ('apply_sandbox_card_event(jsonb,bigint)'::regprocedure,
        'rewards_snapshot(text,bigint)'::regprocedure, 'apply_reward_preference(jsonb,bigint)'::regprocedure)`, [database.schema]);
    for (const { signature } of internalFunctions.rows) await client.query(`REVOKE ALL ON FUNCTION ${signature} FROM ${quoted}`);
  });
}

/** Production boot fails if a migration owner or administrator was supplied as the runtime login. */
export async function verifyApplicationRole(database: Database): Promise<void> {
  const result = await database.query<{ unsafe: boolean }>(`SELECT
    r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls
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
  const protectedTables = ['reward_wallets', 'reward_journals', 'reward_commands', 'reward_cash_plans', 'reward_cashback_months', 'card_reward_allocations', 'reward_program', 'reward_history', 'card_event_inbox', 'card_inbox_attempts', 'card_inbox_requeues', 'card_inbox_lanes'].map((table) => `${database.schema}.${table}`);
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
        'rewards_snapshot(text,bigint)'::regprocedure, 'apply_reward_preference(jsonb,bigint)'::regprocedure)
      AND has_function_privilege(current_user, p.oid, 'EXECUTE')
  ) AS unsafe`, [database.schema]);
  if (internalAccess.rows[0]?.unsafe !== false) throw new Error('The API cannot execute private ledger helper functions.');
}

const cardServiceFunctions = {
  ingress: ['enqueue_sandbox_card_event(jsonb,bigint)'],
  worker: ['process_card_inbox(bigint)', 'card_inbox_stats(bigint)'],
} as const;

async function grantCardServiceRole(database: Database, role: string, service: keyof typeof cardServiceFunctions): Promise<void> {
  checkedSchema(role);
  await database.transaction(async (client) => {
    if (!(await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount) throw new Error(`Provision a separate card ${service} database login before granting access.`);
    const quoted = '"' + role + '"';
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA "${database.schema}" FROM ${quoted}`);
    await client.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA "${database.schema}" FROM ${quoted}`);
    await client.query(`GRANT USAGE ON SCHEMA "${database.schema}" TO ${quoted}`);
    await client.query(`GRANT SELECT ON schema_migrations TO ${quoted}`);
    await client.query(`GRANT EXECUTE ON FUNCTION ${cardServiceFunctions[service].join(', ')} TO ${quoted}`);
  });
}

async function verifyCardServiceRole(database: Database, service: keyof typeof cardServiceFunctions): Promise<void> {
  const { rows } = await database.query<{ unsafe: boolean }>(`SELECT
    r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls
    OR has_schema_privilege(current_user, $1, 'CREATE')
    OR EXISTS (SELECT 1 FROM unnest($2::text[]) f(signature) WHERE NOT has_function_privilege(current_user,signature,'EXECUTE'))
    OR EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relkind IN ('r','v','m','p')
        AND (has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE')
          OR has_any_column_privilege(current_user,c.oid,'INSERT,UPDATE')
          OR (c.relname<>'schema_migrations' AND (has_table_privilege(current_user,c.oid,'SELECT') OR has_any_column_privilege(current_user,c.oid,'SELECT'))))
    ) OR EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname=$1 AND p.prosecdef AND p.prorettype<>'trigger'::regtype
        AND NOT p.oid=ANY(ARRAY(SELECT signature::regprocedure::oid FROM unnest($2::text[]) f(signature)))
        AND has_function_privilege(current_user,p.oid,'EXECUTE')
    ) AS unsafe FROM pg_roles r WHERE r.rolname=current_user`, [database.schema, cardServiceFunctions[service]]);
  if (rows.length !== 1 || rows[0].unsafe) throw new Error(`The card ${service} requires a separate restricted ${service} database role.`);
}

export const grantCardIngressRole = (database: Database, role: string) => grantCardServiceRole(database, role, 'ingress');
export const grantCardWorkerRole = (database: Database, role: string) => grantCardServiceRole(database, role, 'worker');
export const verifyCardIngressRole = (database: Database) => verifyCardServiceRole(database, 'ingress');
export const verifyCardWorkerRole = (database: Database) => verifyCardServiceRole(database, 'worker');
