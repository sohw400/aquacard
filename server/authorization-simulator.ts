import { writeSync } from 'node:fs';
import { parseSandboxCardEvent } from './card-command';
import { cardServiceDatabase } from './card-service-database';
import { verifyMigrations } from './migrations';
import { verifyAuthorizationSimulatorRole } from './permissions';
import { readSettlementInput } from './settlement-input-file';

const uuid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const budgetMs = 2_000;
const graceMs = 1_000;

function parseRequest(value: unknown) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid request.');
  const input = value as Record<string, unknown>;
  const fields = ['requestId','issuedAt','userId','amountWon','merchantName'];
  if (Object.keys(input).length !== fields.length || fields.some(key => !Object.hasOwn(input,key))
    || typeof input.requestId !== 'string' || !uuid.test(input.requestId)
    || typeof input.issuedAt !== 'number' || !Number.isSafeInteger(input.issuedAt)
    || input.issuedAt < 0 || input.issuedAt > 8_639_999_967_598_000) throw new Error('Invalid request.');
  const { requestId, issuedAt } = input;
  const card = parseSandboxCardEvent({ kind:'authorize', eventId:'sync-auth:'+requestId, paymentId:'sync-pay:'+requestId,
    userId:input.userId, merchantName:input.merchantName, amountWon:input.amountWon });
  if (card.kind !== 'authorize') throw new Error('Invalid request.');
  return { requestId, issuedAt, userId:card.userId, merchantName:card.merchantName, amountWon:card.amountWon };
}

function invalid(code: string) {
  console.error(JSON.stringify({status:'invalid',code}));
  process.exitCode = 2;
}

async function run(args: string[]) {
  if (args.length===1 && args[0]==='--help') {
    console.log('Usage: node dist-server/authorization-simulator.js decide FILE | lookup REQUEST_UUID');
    return;
  }
  if (process.env.NODE_ENV==='production') return invalid('SIMULATOR_DISABLED');
  const [op, argument] = args;
  if (args.length!==2 || (op!=='decide' && op!=='lookup') || !argument || argument==='-') return invalid('INVALID_SYNC_REQUEST');
  let request;
  if (op==='decide') {
    try { request = (await readSettlementInput(argument,parseRequest)).value; }
    catch { return invalid('INVALID_SYNC_REQUEST'); }
  } else if (!uuid.test(argument)) return invalid('INVALID_SYNC_REQUEST');
  const requestId = request?.requestId ?? argument;
  const unconfirmed = JSON.stringify({requestId,outcome:'unconfirmed'});
  // A lost commit acknowledgement is ambiguous. Only a confirmed database receipt
  // permits a terminal reply. The caller can look up or resend its original request.
  const waitMs = request ? Math.min(budgetMs, Math.max(0,request.issuedAt + budgetMs - Date.now())) + graceMs : budgetMs + graceMs;
  const deadline = setTimeout(() => { writeSync(1,unconfirmed+'\n'); process.exit(2); },waitMs);
  try {
    const db = await cardServiceDatabase('authorizationSimulator');
    let receipt;
    try {
      await verifyMigrations(db);
      await verifyAuthorizationSimulatorRole(db);
      const query = request ? await db.query('SELECT decide_sandbox_authorization($1::jsonb) AS receipt',[JSON.stringify(request)])
        : await db.query('SELECT lookup_sandbox_authorization($1::uuid) AS receipt',[requestId]);
      receipt = query.rows[0].receipt;
    } finally { await db.close(); }
    if (receipt === null) { console.log(unconfirmed); process.exitCode=2; }
    else {
      const delivery = op==='lookup' ? 'lookup' : Date.now()>=receipt.deadlineAt ? 'after_deadline' : 'within_window';
      console.log(JSON.stringify({ ...receipt, delivery }));
    }
  } catch (error) {
    if (error instanceof Error && ['INVALID_SYNC_REQUEST','SYNC_ID_CONFLICT'].includes(error.message)) invalid(error.message);
    else { console.log(unconfirmed); process.exitCode=2; }
  } finally { clearTimeout(deadline); }
}

await run(process.argv.slice(2));
