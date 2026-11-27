import { readFile, stat } from 'node:fs/promises';
import { databaseFromEnvironment } from './database';
import { cardServiceDatabase } from './card-service-database';
import { verifyMigrations } from './migrations';
import { verifyCardIngressRole, verifyCorrectionRole } from './permissions';
import { CardInboxStore } from './card-inbox';
import { parseSandboxCardEvent } from './card-command';
import { LedgerError } from './errors';

class CommandError extends Error {}
const usage = 'Usage: server:inbox -- enqueue <event.json> | status [inbox-id] | retry <inbox-id> <version> <key> <reason> | resolve <inbox-id> <version> <key> <evidence-ref> <replacement-inbox-id|void>';
const validId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

async function run() {
  const [action, ...args] = process.argv.slice(2);
  if (process.env.NODE_ENV === 'production' && action !== 'status') throw new CommandError('Sandbox inbox changes are disabled in production.');
  if ((action === 'enqueue' && args.length !== 1) || (action === 'status' && args.length > 1)
    || (action === 'retry' && args.length !== 4) || (action === 'resolve' && args.length !== 5) || !['enqueue','status','retry','resolve'].includes(action ?? '')) throw new CommandError(usage);
  if ((action === 'retry' || action === 'resolve' || (action === 'status' && args.length)) && !validId(args[0])) throw new CommandError('Use the inbox UUID returned by receipt, not a card payment ID.');
  const versioned = action === 'retry' || action === 'resolve';
  const version = versioned ? Number(args[1]) : 0;
  if (versioned && (!/^\d+$/.test(args[1]) || !Number.isSafeInteger(version))) throw new CommandError('Use the current inbox version shown by status.');
  if (action === 'resolve' && args[4] !== 'void' && !validId(args[4])) throw new CommandError('Supply the replacement receipt UUID or void.');
  let event;
  if (action === 'enqueue') {
    const info = await stat(args[0]);
    if (!info.isFile() || info.size > 16_384) throw new CommandError('Use an event JSON file no larger than 16 KiB.');
    const contents = await readFile(args[0], 'utf8');
    if (Buffer.byteLength(contents) > 16_384) throw new CommandError('Use an event JSON file no larger than 16 KiB.');
    event = parseSandboxCardEvent(JSON.parse(contents) as unknown);
  } else if (action !== 'resolve' && !process.env.MIGRATION_DATABASE_URL) throw new CommandError('Set MIGRATION_DATABASE_URL for private inbox inspection and local retry operations.');
  const service = action === 'enqueue' ? 'ingress' : action === 'resolve' ? 'correction' : null;
  const database = service ? await cardServiceDatabase(service) : await databaseFromEnvironment(true);
  try {
    await verifyMigrations(database);
    if (action === 'enqueue') await verifyCardIngressRole(database);
    if (action === 'resolve') await verifyCorrectionRole(database);
    const inbox = new CardInboxStore(database);
    if (action === 'enqueue') console.log(JSON.stringify({ mode: 'sandbox', receipt: await inbox.enqueue(event!) }));
    else if (action === 'resolve') console.log(JSON.stringify(await inbox.resolveCapture({ id: args[0],
      expectedVersion: version, idempotencyKey: args[2], evidenceRef: args[3], replacementId: args[4] === 'void' ? null : args[4] })));
    else if (action === 'retry') console.log(JSON.stringify(await inbox.requeue({ id: args[0], expectedVersion: version, idempotencyKey: args[2], reason: args[3] })));
    else if (!args.length) console.log(JSON.stringify(await inbox.stats()));
    else {
      const records = await database.transaction(async (client) => {
        await client.query('SET TRANSACTION READ ONLY');
        const { rows: [record] } = await client.query(`SELECT id,event_id,status,received_at,processed_at,updated_at,next_attempt_at,
          attempt_count,cycle_attempts,version,last_error_code FROM card_event_inbox WHERE id=$1`, [args[0]]);
        if (!record) throw new CommandError('Inbox record was not found.');
        const { rows: attempts } = await client.query(`SELECT attempt_no,cycle_attempt,version,attempted_at,status,error_code,next_attempt_at
          FROM card_inbox_attempts WHERE inbox_id=$1 ORDER BY attempt_no DESC LIMIT 100`, [args[0]]);
        const { rows: retries } = await client.query(`SELECT created_at,from_version,to_version,actor,reason FROM card_inbox_requeues
          WHERE inbox_id=$1 ORDER BY to_version DESC LIMIT 100`, [args[0]]);
        const { rows: [resolution] } = await client.query(
          'SELECT evidence_ref,replacement_id,actor,resolved_at FROM card_capture_resolutions WHERE inbox_id=$1', [args[0]]);
        return { record, attempts, retries, resolution: resolution ?? null, historyLimit: 100 };
      }, { isolation: 'repeatable read' });
      console.log(JSON.stringify(records));
    }
  } finally { await database.close(); }
}

run().catch((error: unknown) => {
  if (error instanceof CommandError) console.error(error.message);
  else if (error instanceof LedgerError) console.error(`${error.code}: ${error.message}`);
  else console.error('The inbox operation was not confirmed. Check configuration and retry with the original event or operation key.');
  process.exitCode = 1;
});
