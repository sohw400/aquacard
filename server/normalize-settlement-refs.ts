import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { BankSettlementFormatError, parseSettlementAdvice } from './bank-settlement-format';
import { IssuerStatementFormatError, parseIssuerStatement } from './issuer-statement-format';
import { readSettlementInput, SettlementInputError } from './settlement-input-file';
import { sourceReferenceReader } from './settlement-reference';

async function readKey(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) || (stat.size !== 64 && stat.size !== 65)) throw new Error('Invalid key file.');
    const buffer = Buffer.alloc(66);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== stat.size) throw new Error('Invalid key file.');
    const hex = buffer.toString('latin1', 0, bytesRead);
    if (!/^[0-9a-fA-F]{64}\n?$/.test(hex)) throw new Error('Invalid key file.');
    return Buffer.from(hex.trimEnd(), 'hex');
  } finally { await file.close(); }
}

function incomplete(code: string) {
  console.error(JSON.stringify({ status: 'incomplete', code }));
  process.exitCode = 2;
}

async function run(args: string[]) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node dist-server/normalize-settlement-refs.js issuer|advice FILE');
    console.log('Read SETTLEMENT_REFERENCE_KEY_FILE and write normalized TEST_KRW JSON to stdout.');
    return;
  }
  const [kind, path] = args;
  if (args.length !== 2 || !path || path === '-' || (kind !== 'issuer' && kind !== 'advice')) {
    return incomplete('SETTLEMENT_SOURCE_REQUIRED');
  }
  let key: Buffer;
  try { key = await readKey(process.env.SETTLEMENT_REFERENCE_KEY_FILE ?? ''); }
  catch { return incomplete('SETTLEMENT_REFERENCE_KEY_UNAVAILABLE'); }
  try {
    const readReference = sourceReferenceReader(key);
    if (kind === 'advice') {
      const { value } = await readSettlementInput(path, data => parseSettlementAdvice(data, readReference));
      console.log(JSON.stringify(value));
    } else {
      const { value } = await readSettlementInput(path, data => parseIssuerStatement(data, readReference));
      const { version, businessDate, currency, controls, rows } = value;
      console.log(JSON.stringify({ version, businessDate, currency, controls, rows }));
    }
  } catch (error) {
    incomplete(error instanceof BankSettlementFormatError || error instanceof IssuerStatementFormatError
      || error instanceof SettlementInputError ? error.code : 'INVALID_STATEMENT_FORMAT');
  } finally { key.fill(0); }
}

await run(process.argv.slice(2));
