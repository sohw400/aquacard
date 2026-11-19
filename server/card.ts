import { readFile, stat } from 'node:fs/promises';
import { databaseFromEnvironment } from './database';
import { verifyMigrations } from './migrations';
import { LedgerError } from './ledger';
import { CardPaymentStore } from './card-payments';
import { parseSandboxCardEvent } from './card-command';

class CommandError extends Error {}

async function run() {
  if (process.env.NODE_ENV === 'production') throw new CommandError('Card test events are disabled in production.');
  const [file, ...extra] = process.argv.slice(2);
  if (!file || extra.length) throw new CommandError('Usage: npm run server:card -- <sandbox-event.json>');
  const info = await stat(file);
  if (!info.isFile() || info.size > 16_384) throw new CommandError('Use a JSON event file no larger than 16 KiB.');
  const content = await readFile(file, 'utf8');
  if (Buffer.byteLength(content) > 16_384) throw new CommandError('Use a JSON event file no larger than 16 KiB.');
  const event = parseSandboxCardEvent(JSON.parse(content) as unknown);
  const database = await databaseFromEnvironment();
  try {
    await verifyMigrations(database);
    const result = await new CardPaymentStore(database).apply(event);
    console.log(JSON.stringify({ mode: 'sandbox', ...result }));
  } finally { await database.close(); }
}

run().catch((error: unknown) => {
  if (error instanceof LedgerError) console.error(`${error.code}: ${error.message}`);
  else if (error instanceof CommandError) console.error(error.message);
  else console.error('Card event was not confirmed. Check the JSON file and database configuration, then retry with the same event ID.');
  process.exitCode = 1;
});
