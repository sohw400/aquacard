import { cardServiceDatabase } from './card-service-database';
import { verifyMigrations } from './migrations';
import { verifyCardWorkerRole } from './permissions';

async function run() {
  const args = process.argv.slice(2);
  const limit = args.length === 1 && args[0] === '--once' ? 1
    : args.length === 2 && args[0] === '--limit' && /^[1-9][0-9]{0,2}$/.test(args[1]) ? Number(args[1]) : 0;
  if (!limit || limit > 500) throw new Error('Usage: --once or --limit 1..500');
  const database = await cardServiceDatabase('worker');
  try {
    await verifyMigrations(database);
    await verifyCardWorkerRole(database);
    for (let i = 0; i < limit; i++) {
      const { rows } = await database.query<{ result: { status: 'paid' | 'deferred' | 'idle' } }>('SELECT settle_next_reserve_reward() AS result');
      console.log(JSON.stringify(rows[0].result));
      if (rows[0].result.status === 'deferred') process.exitCode = 2;
      if (rows[0].result.status === 'idle') break;
    }
  } finally { await database.close(); }
}

await run().catch(() => {
  console.error('Reserve reward settlement incomplete. Use --once or --limit 1..500 and the restricted worker login.');
  process.exitCode = 1;
});
