import { databaseFromEnvironment } from './database';
import { verifyMigrations } from './migrations';
import { grantApplicationRole, verifyApplicationRole } from './permissions';

const role = 'aqua_fallback_api_015';
if (!process.env.MIGRATION_DATABASE_URL || !process.env.DATABASE_URL || process.env.NODE_ENV !== 'production') {
  throw new Error('Provide separate migration and fallback API logins over verified production TLS.');
}
const ownerUrl = new URL(process.env.MIGRATION_DATABASE_URL);
const fallbackUrl = new URL(process.env.DATABASE_URL);
if (ownerUrl.host !== fallbackUrl.host || ownerUrl.pathname !== fallbackUrl.pathname || ownerUrl.username === fallbackUrl.username
  || fallbackUrl.username !== role) throw new Error('The fallback login must identify the same database with its dedicated role.');
const owner = await databaseFromEnvironment(true);
const fallback = await databaseFromEnvironment();
try {
  await verifyMigrations(owner);
  const identity = await fallback.query('SELECT current_user AS name');
  if (identity.rows[0]?.name !== role) throw new Error('Unexpected fallback login.');
  const candidate = await owner.query(`SELECT r.rolcanlogin AND NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole
      OR r.rolreplication OR r.rolbypassrls OR has_schema_privilege(r.oid,$2,'CREATE')
      OR EXISTS (SELECT FROM pg_auth_members m WHERE m.member=r.oid)
      OR EXISTS (SELECT FROM pg_shdepend d WHERE d.refclassid='pg_authid'::regclass AND d.refobjid=r.oid AND d.deptype='o'))
      AS ordinary FROM pg_roles r WHERE r.rolname=$1`, [role, owner.schema]);
  if (candidate.rows[0]?.ordinary !== true) throw new Error('Create an unprivileged standalone fallback login with no owned objects.');
  // Detect accidental ACLs on new or unrelated relations before assigning the historical allowlist.
  const oldReadable = ['schema_migrations','users','ledger_accounts','journals','journal_entries','auth_sessions',
    'auth_recovery','auth_email_verification','auth_rate_limits','card_payments','card_payment_events','reward_wallets',
    'reward_journals','reward_entries','reward_commands','reward_cashback_months','card_reward_allocations','reward_program','reward_history'];
  const unexpected = await owner.query(`SELECT EXISTS (SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND c.relkind IN ('r','v','m','p','f') AND NOT(c.relname=ANY($3::name[]))
    AND (has_table_privilege($2,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
      OR has_any_column_privilege($2,c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))) AS unsafe`, [owner.schema,role,oldReadable]);
  if (unexpected.rows[0]?.unsafe !== false) throw new Error('The fallback role already has unrelated table grants.');
  await grantApplicationRole(owner, role);
  await verifyMigrations(fallback);
  await verifyApplicationRole(fallback);
  console.log('Fallback API role matches the previous API allowlist.');
} finally { await Promise.all([owner.close(),fallback.close()]); }
