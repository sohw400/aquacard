import { CardOperationsStore, parseCardOperationsInput, parseCardOperationsRequestId } from './card-operations';
import { cardServiceDatabase } from './card-service-database';
import { LedgerError } from './errors';
import { verifyMigrations } from './migrations';
import { verifyCardOperationsRole } from './permissions';

const usage = 'Usage: server:card:ops -- trace-event <event-id> <request-uuid> <case-reference> | trace-inbox <inbox-uuid> <request-uuid> <case-reference> | read <request-uuid>';
let recoveryRequestId: string | undefined;

async function run() {
  const [action, ...args] = process.argv.slice(2);
  if (action === '--help' && !args.length) { console.log(usage); return; }
  if ((action !== 'trace-event' && action !== 'trace-inbox' && action !== 'read')
    || (action === 'read' ? args.length !== 1 : args.length !== 3)) {
    throw new LedgerError(400, 'INVALID_OPS_COMMAND', usage);
  }
  // Validate before opening a connection or loading certificates. An invalid
  // argument must never be printed back as a purported safe recovery key.
  const input = action === 'read' ? undefined : parseCardOperationsInput({ requestId: args[1],
    lookup: { kind: action === 'trace-event' ? 'event' : 'inbox', id: args[0] }, caseReference: args[2] });
  recoveryRequestId = input?.requestId ?? parseCardOperationsRequestId(args[0]);
  if (!process.env.OPERATIONS_DATABASE_URL) {
    throw new LedgerError(503, 'OPS_CONFIGURATION_REQUIRED', 'Set OPERATIONS_DATABASE_URL to the separate restricted operations login.');
  }
  const database = await cardServiceDatabase('operations');
  try {
    await verifyMigrations(database);
    await verifyCardOperationsRole(database);
    const operations = new CardOperationsStore(database);
    const report = input ? await operations.trace(input) : await operations.read(recoveryRequestId);
    console.log(JSON.stringify(report));
  } finally { await database.close(); }
}

run().catch((error: unknown) => {
  const known = error instanceof LedgerError;
  console.error(JSON.stringify({ code: known ? error.code : 'OPS_UNAVAILABLE',
    ...(recoveryRequestId ? { requestId: recoveryRequestId } : {}),
    message: known ? error.message : 'Check the operations connection, role grants and migrations. Retry with the original request ID.' }));
  process.exitCode = known && error.status < 500 ? 1 : 2;
});
