import { databaseFromEnvironment } from './database';
import { verifyMigrations } from './migrations';
import { verifyApplicationRole } from './permissions';
import { IssuerOutboxStore, type IssuerCardStatus } from './issuer-outbox';
import { LedgerError } from './errors';

class CommandError extends Error {}
const usage = 'Usage: server:issuer -- register <user-id> <sandbox-card-ref> <active|locked> | request <user-id> <card-id> <active|locked> <version> <key> | status [user-id] | inspect <command-id> | retry <command-id> <version> <key> <reason>';
const uuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
function version(value: string): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) throw new CommandError('Use the current version from status or inspect.');
  return Number(value);
}
function status(value: string): IssuerCardStatus {
  if (value !== 'active' && value !== 'locked') throw new CommandError('Card status must be active or locked.');
  return value;
}

async function run() {
  const [action, ...args] = process.argv.slice(2);
  if (process.env.NODE_ENV === 'production' && action !== 'status' && action !== 'inspect') throw new CommandError('Sandbox issuer commands are disabled in production.');
  if (!action || !['register', 'request', 'status', 'inspect', 'retry'].includes(action)
    || (action === 'register' && args.length !== 3) || (action === 'request' && args.length !== 5)
    || (action === 'status' && args.length > 1) || (action === 'inspect' && args.length !== 1)
    || (action === 'retry' && args.length !== 4)) throw new CommandError(usage);
  if ((action === 'inspect' || action === 'retry') && !uuid(args[0])) throw new CommandError('Use the command UUID returned by request.');
  const desired = action === 'register' || action === 'request' ? status(args[2]) : undefined;
  const expectedVersion = action === 'request' ? version(args[3]) : action === 'retry' ? version(args[1]) : undefined;
  const operator = action !== 'request';
  if (operator && !process.env.MIGRATION_DATABASE_URL) throw new CommandError('Set MIGRATION_DATABASE_URL for private issuer registration, inspection and recovery.');
  const database = await databaseFromEnvironment(operator);
  try {
    await verifyMigrations(database);
    if (!operator) await verifyApplicationRole(database);
    const outbox = new IssuerOutboxStore(database);
    if (action === 'register') console.log(JSON.stringify(await outbox.register({ userId: args[0], providerCardId: args[1], initialStatus: desired! })));
    else if (action === 'request') console.log(JSON.stringify(await outbox.requestStatus({ userId: args[0], cardId: args[1], targetStatus: desired!, expectedVersion: expectedVersion!, idempotencyKey: args[4] })));
    else if (action === 'retry') console.log(JSON.stringify(await outbox.requeue({ id: args[0], expectedVersion: expectedVersion!, idempotencyKey: args[2], reason: args[3] })));
    else if (action === 'status') console.log(JSON.stringify(args.length ? await outbox.snapshot(args[0]) : await outbox.stats()));
    else {
      const inspection = await database.transaction(async (client) => {
        await client.query('SET TRANSACTION READ ONLY');
        const { rows: [record] } = await client.query(`SELECT id,status,phase,version,attempt_count,cycle_attempts,
          expires_at,lease_until,next_attempt_at,error_code,created_at,updated_at FROM issuer_outbox WHERE id=$1`, [args[0]]);
        if (!record) throw new CommandError('Issuer command was not found.');
        const { rows: history } = await client.query(`SELECT version,kind,status,phase,attempt_count,cycle_attempts,
          error_code,next_attempt_at,created_at,actor FROM issuer_outbox_audit WHERE outbox_id=$1 ORDER BY version DESC LIMIT 100`, [args[0]]);
        const { rows: recoveries } = await client.query(`SELECT from_version,to_version,created_at,actor,reason
          FROM issuer_outbox_requeues WHERE outbox_id=$1 ORDER BY to_version DESC LIMIT 100`, [args[0]]);
        return { record, history, recoveries, historyLimit: 100 };
      }, { isolation: 'repeatable read' });
      console.log(JSON.stringify(inspection));
    }
  } finally { await database.close(); }
}

run().catch((error: unknown) => {
  if (error instanceof CommandError) console.error(error.message);
  else if (error instanceof LedgerError) console.error(`${error.code}: ${error.message}`);
  else console.error('The issuer operation was not confirmed. Check configuration and retry with the original operation key.');
  process.exitCode = 1;
});
