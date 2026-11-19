import { databaseFromEnvironment } from './database';
import { verifyMigrations } from './migrations';
import { LedgerError, LedgerStore } from './ledger';
import { RewardsStore } from './rewards';

class CommandError extends Error {}
const usage = 'Usage: server:rewards -- budget <won> <key> | program <on|off> <key> | grant <email> <won> <key>';
function won(raw: string | undefined) {
  if (!raw || !/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1) throw new CommandError('Use a positive integer test amount.');
  return Number(raw);
}

async function run() {
  if (process.env.NODE_ENV === 'production') throw new CommandError('Reward test funding and program operations are disabled in production.');
  const [action, ...args] = process.argv.slice(2);
  if (!['budget', 'program', 'grant'].includes(action ?? '') || args.length !== (action === 'grant' ? 3 : 2)) throw new CommandError(usage);
  if (action === 'program' && !['on', 'off'].includes(args[0])) throw new CommandError(usage);
  const idempotencyKey = args.at(-1)!;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(idempotencyKey)) throw new CommandError('Use a stable operation key of at most 128 characters.');
  const amountWon = action === 'program' ? 0 : won(args[action === 'grant' ? 1 : 0]);
  // Deliberately separate operator credentials from the restricted application login.
  if (!process.env.MIGRATION_DATABASE_URL) throw new CommandError('Set MIGRATION_DATABASE_URL for local test operator commands.');
  const database = await databaseFromEnvironment(true);
  try {
    await verifyMigrations(database);
    const rewards = new RewardsStore(database);
    let result: unknown;
    if (action === 'budget') result = await rewards.fundBudget({ amountWon, idempotencyKey });
    else if (action === 'program') result = await rewards.setProgram({ enabled: args[0] === 'on', idempotencyKey });
    else {
      const user = await new LedgerStore(database).getUserByEmail(args[0]);
      if (!user) throw new CommandError('Create this test account in the connected app first.');
      result = await rewards.grant({ userId: user.id, amountWon, idempotencyKey });
    }
    console.log(JSON.stringify({ mode: 'sandbox', action, result }));
  } finally { await database.close(); }
}

run().catch((error: unknown) => {
  if (error instanceof CommandError) console.error(error.message);
  else if (error instanceof LedgerError) console.error(`${error.code}: ${error.message}`);
  else console.error('Reward operation was not confirmed. Check operator credentials and retry with the same operation key.');
  process.exitCode = 1;
});
