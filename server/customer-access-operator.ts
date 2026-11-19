import type { CustomerAccessStatus } from '../shared/api';
import { CustomerAccessStore } from './customer-access';
import { databaseFromEnvironment } from './database';
import { LedgerError } from './errors';
import { verifyMigrations } from './migrations';

class CommandError extends Error {}
const usage = 'Usage: server:customer:access -- status <user-id> | set <user-id> <unverified|pending_review|active|restricted|frozen|closed> <expected-version> <idempotency-key> <reason>';
const statuses: string[] = ['unverified', 'pending_review', 'active', 'restricted', 'frozen', 'closed'];

async function run() {
  const [action, ...args] = process.argv.slice(2);
  if (!((action === 'status' && args.length === 1) || (action === 'set' && args.length === 5))) throw new CommandError(usage);
  if (action === 'set' && process.env.NODE_ENV === 'production') throw new CommandError('Sandbox customer access changes are disabled in production.');
  if (action === 'set' && (!statuses.includes(args[1]) || !/^[1-9][0-9]*$/.test(args[2]) || !Number.isSafeInteger(Number(args[2])))) {
    throw new CommandError('Use a supported customer status and the current version from status.');
  }
  if (action === 'set' && !process.env.MIGRATION_DATABASE_URL) throw new CommandError('Set MIGRATION_DATABASE_URL for trusted sandbox customer access changes.');
  const database = await databaseFromEnvironment(action === 'set');
  try {
    await verifyMigrations(database);
    const access = new CustomerAccessStore(database);
    const result = action === 'status' ? await access.snapshot(args[0])
      : await access.transition({ userId: args[0], status: args[1] as CustomerAccessStatus, expectedVersion: Number(args[2]), idempotencyKey: args[3], reason: args[4] });
    console.log(JSON.stringify({ mode: 'sandbox', ...result }));
  } finally { await database.close(); }
}

run().catch((error: unknown) => {
  if (error instanceof CommandError) console.error(error.message);
  else if (error instanceof LedgerError) console.error(`${error.code}: ${error.message}`);
  else console.error('The customer access change was not confirmed. Check configuration and retry with the original operation key.');
  process.exitCode = 1;
});
