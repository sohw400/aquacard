import type { CustomerAccessStatus } from '../shared/api';
import { CustomerAccessStore, type TransferRiskTier } from './customer-access';
import { databaseFromEnvironment } from './database';
import { LedgerError } from './errors';
import { verifyMigrations } from './migrations';

class CommandError extends Error {}
const usage = 'Usage: server:customer:access -- status <user-id> | set <user-id> <unverified|pending_review|active|restricted|frozen|closed> <expected-version> <idempotency-key> <reason> | risk-status <user-id> | set-risk <user-id> <standard|high> <expected-version> <idempotency-key> <case-reference>';
const statuses: string[] = ['unverified', 'pending_review', 'active', 'restricted', 'frozen', 'closed'];

async function run() {
  const [action, ...args] = process.argv.slice(2);
  const risk = action === 'risk-status' || action === 'set-risk';
  const write = action === 'set' || action === 'set-risk';
  if (!((action === 'status' || action === 'risk-status') && args.length === 1) && !(write && args.length === 5)) throw new CommandError(usage);
  if ((risk || write) && process.env.NODE_ENV === 'production') throw new CommandError('Sandbox customer access changes are disabled in production.');
  if (write && (!(risk ? ['standard','high'] : statuses).includes(args[1]) ||
      !(risk ? /^(0|[1-9][0-9]*)$/ : /^[1-9][0-9]*$/).test(args[2]) || !Number.isSafeInteger(Number(args[2])))) {
    throw new CommandError('Use a supported customer status and the current version from status.');
  }
  if ((write || risk) && !process.env.MIGRATION_DATABASE_URL) throw new CommandError('Set MIGRATION_DATABASE_URL for trusted sandbox customer access changes.');
  const database = await databaseFromEnvironment(write || risk);
  try {
    await verifyMigrations(database);
    const access = new CustomerAccessStore(database);
    let result;
    switch (action) {
      case 'status': result = await access.snapshot(args[0]); break;
      case 'risk-status': result = await access.transferRisk(args[0]); break;
      case 'set-risk':
        result = await access.setTransferRisk({ userId: args[0], tier: args[1] as TransferRiskTier, expectedVersion: Number(args[2]),
          idempotencyKey: args[3], caseRef: args[4] }); break;
      default:
        result = await access.transition({ userId: args[0], status: args[1] as CustomerAccessStatus, expectedVersion: Number(args[2]), idempotencyKey: args[3], reason: args[4] });
    }
    console.log(JSON.stringify({ mode: 'sandbox', ...result }));
  } finally { await database.close(); }
}

run().catch((error: unknown) => {
  if (error instanceof CommandError) console.error(error.message);
  else if (error instanceof LedgerError) console.error(`${error.code}: ${error.message}`);
  else console.error('The customer access change was not confirmed. Check configuration and retry with the original operation key.');
  process.exitCode = 1;
});
