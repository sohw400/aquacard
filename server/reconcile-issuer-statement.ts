import { createHash } from 'node:crypto';
import { constants, writeSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { cardServiceDatabase } from './card-service-database';
import { IssuerStatementFormatError, parseIssuerStatement } from './issuer-statement-format';
import { readIssuerStatementLedger } from './issuer-statement-ledger';
import { matchIssuerStatement } from './issuer-statement-match';
import { verifyMigrations } from './migrations';
import { verifySettlementRole } from './permissions';

const usage = 'Usage: node dist-server/reconcile-issuer-statement.js FILE';
const maxBytes = 4 * 1024 * 1024;

async function readStatementBytes(path: string): Promise<Buffer> {
  // Open nonblocking before fstat so a FIFO without a writer cannot stall the command.
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(maxBytes)) throw new Error('Invalid file.');
    const bytes = Buffer.allocUnsafe(Number(before.size) + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await file.stat({ bigint: true });
    if (BigInt(offset) !== before.size || before.size !== after.size || before.ctimeNs !== after.ctimeNs) {
      throw new Error('File changed during read.');
    }
    return bytes.subarray(0, offset);
  } finally { await file.close(); }
}

function decodedMemberCount(value: unknown): number {
  if (value === null || typeof value !== 'object') return 0;
  const children: unknown[] = Object.values(value);
  let count = Array.isArray(value) ? 0 : children.length;
  for (const child of children) count += decodedMemberCount(child);
  return count;
}

function decodeStatement(bytes: Buffer) {
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const decoded: unknown = JSON.parse(source);
  const statement = parseIssuerStatement(decoded);
  // After syntax and shape validation, each unquoted colon names exactly one
  // member. JSON.parse drops earlier members with the same decoded name.
  let members = 0;
  let inString = false;
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '"') inString = !inString;
    else if (inString && source[i] === '\\') i++;
    else if (!inString && source[i] === ':') members++;
  }
  if (members !== decodedMemberCount(decoded)) throw new Error('Repeated JSON member.');
  return statement;
}

function incomplete(code: string) {
  console.error(JSON.stringify({ status: 'incomplete', code }));
  process.exitCode = 2;
}

async function run() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log(usage);
    console.log('Compare a normalized TEST_KRW statement for one completed Korean business date. Exit 0 for a match, 1 for differences or 2 for an incomplete check.');
    return;
  }
  if (args.length !== 1 || !args[0] || args[0] === '-') return incomplete('STATEMENT_FILE_REQUIRED');

  let bytes: Buffer;
  try { bytes = await readStatementBytes(args[0]); }
  catch { return incomplete('STATEMENT_FILE_UNAVAILABLE'); }
  let statement: ReturnType<typeof parseIssuerStatement>;
  try { statement = decodeStatement(bytes); }
  catch (error) { return incomplete(error instanceof IssuerStatementFormatError ? error.code : 'INVALID_STATEMENT_FORMAT'); }

  // Bound a network outage during role verification, snapshot retrieval or shutdown.
  const deadline = setTimeout(() => {
    writeSync(2, JSON.stringify({ status: 'incomplete', code: 'SETTLEMENT_CHECK_UNAVAILABLE' }) + '\n');
    process.exit(2);
  }, 75_000);
  try {
    const db = await cardServiceDatabase('settlement');
    let report: ReturnType<typeof matchIssuerStatement>;
    try {
      await verifyMigrations(db);
      await verifySettlementRole(db);
      const ledger = await readIssuerStatementLedger(db, statement.startMs, statement.endMs);
      report = matchIssuerStatement(statement, ledger);
    } finally { await db.close(); }
    console.log(JSON.stringify({ ...report, statementSha256: createHash('sha256').update(bytes).digest('hex') }));
    process.exitCode = report.ok ? 0 : 1;
  } catch {
    // Connection and SQL messages may include credentials, row data or identifiers.
    incomplete('SETTLEMENT_CHECK_UNAVAILABLE');
  } finally { clearTimeout(deadline); }
}

await run();
