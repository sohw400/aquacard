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
    OR has_table_privilege(current_user, $4, 'INSERT,UPDATE,DELETE,TRUNCATE') AS unsafe
    FROM pg_roles r WHERE r.rolname = current_user`, [database.schema, `${database.schema}.journals`, `${database.schema}.ledger_accounts`, `${database.schema}.schema_migrations`]);
  if (result.rows.length !== 1 || result.rows[0].unsafe) {
    throw new Error('The API requires a restricted application database role. Keep migration and administrator credentials out of the running API.');
  }
}
