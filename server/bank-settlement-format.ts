import { isStatementReference, isStatementWon, MAX_ISSUER_STATEMENT_ROWS, objectWithFields,
  statementDayWindow } from './issuer-statement-format';

export interface SettlementAdvice {
  version: 1;
  currency: 'TEST_KRW';
  businessDate: string;
  settlementDate: string;
  accountRef: string;
  batches: { batchId: string; eventIds: string[]; feeWon: string }[];
}

export interface BankStatement {
  version: 1;
  currency: 'TEST_KRW';
  settlementDate: string;
  accountRef: string;
  controls: { rowCount: number; debitedWon: string; creditedWon: string };
  rows: { postingId: string; batchId: string; direction: 'debit' | 'credit'; amountWon: string }[];
}

type FormatErrorCode = 'INVALID_SETTLEMENT_ADVICE' | 'INVALID_BANK_STATEMENT'
  | 'INVALID_SETTLEMENT_DATE' | 'INVALID_SETTLEMENT_REFERENCE' | 'INVALID_SETTLEMENT_AMOUNT'
  | 'DUPLICATE_ADVICE_BATCH' | 'DUPLICATE_ADVICE_EVENT' | 'BANK_CONTROL_MISMATCH';

export class BankSettlementFormatError extends Error {
  constructor(readonly code: FormatErrorCode) {
    super(code);
    this.name = 'BankSettlementFormatError';
  }
}

const maxRows = MAX_ISSUER_STATEMENT_ROWS;
const maxFee = BigInt(Number.MAX_SAFE_INTEGER);
// A single bank posting can settle all the card events in the file plus a batch fee.
const maxBankPosting = maxFee * (BigInt(maxRows) + 1n);
const maxBankTotal = maxBankPosting * BigInt(maxRows);

function reference(value: unknown): string {
  if (!isStatementReference(value)) throw new BankSettlementFormatError('INVALID_SETTLEMENT_REFERENCE');
  return value;
}

function accountAlias(value: unknown): string {
  const ref = reference(value);
  if (!/[A-Za-z]/.test(ref)) throw new BankSettlementFormatError('INVALID_SETTLEMENT_REFERENCE');
  return ref;
}

function date(value: unknown): string {
  const day = statementDayWindow(value);
  if (!day) throw new BankSettlementFormatError('INVALID_SETTLEMENT_DATE');
  return day.date;
}

function won(value: unknown, maximum: bigint, allowZero: boolean): string {
  if (!isStatementWon(value, maximum, allowZero)) throw new BankSettlementFormatError('INVALID_SETTLEMENT_AMOUNT');
  return value;
}

export function parseSettlementAdvice(input: unknown): SettlementAdvice {
  if (!objectWithFields(input, ['version', 'currency', 'businessDate', 'settlementDate', 'accountRef', 'batches'])
    || input.version !== 1 || input.currency !== 'TEST_KRW' || !Array.isArray(input.batches)
    || input.batches.length > maxRows) {
    throw new BankSettlementFormatError('INVALID_SETTLEMENT_ADVICE');
  }
  const businessDate = date(input.businessDate);
  const settlementDate = date(input.settlementDate);
  if (settlementDate < businessDate) throw new BankSettlementFormatError('INVALID_SETTLEMENT_DATE');
  const accountRef = accountAlias(input.accountRef);
  const batches: SettlementAdvice['batches'] = [];
  const batchIds = new Set<string>();
  const assigned = new Set<string>();
  for (const batch of input.batches) {
    if (!objectWithFields(batch, ['batchId', 'eventIds', 'feeWon']) || !Array.isArray(batch.eventIds)
      || !batch.eventIds.length || assigned.size + batch.eventIds.length > maxRows) {
      throw new BankSettlementFormatError('INVALID_SETTLEMENT_ADVICE');
    }
    const batchId = reference(batch.batchId);
    if (batchIds.has(batchId)) throw new BankSettlementFormatError('DUPLICATE_ADVICE_BATCH');
    batchIds.add(batchId);
    const eventIds: string[] = [];
    for (const value of batch.eventIds) {
      const eventId = reference(value);
      if (assigned.has(eventId)) throw new BankSettlementFormatError('DUPLICATE_ADVICE_EVENT');
      assigned.add(eventId);
      eventIds.push(eventId);
    }
    batches.push({ batchId, eventIds, feeWon: won(batch.feeWon, maxFee, true) });
  }
  return { version: 1, currency: 'TEST_KRW', businessDate, settlementDate, accountRef, batches };
}

export function parseBankStatement(input: unknown): BankStatement {
  if (!objectWithFields(input, ['version', 'currency', 'settlementDate', 'accountRef', 'controls', 'rows'])
    || input.version !== 1 || input.currency !== 'TEST_KRW' || !Array.isArray(input.rows) || input.rows.length > maxRows) {
    throw new BankSettlementFormatError('INVALID_BANK_STATEMENT');
  }
  const settlementDate = date(input.settlementDate);
  const accountRef = accountAlias(input.accountRef);
  const controls = input.controls;
  if (!objectWithFields(controls, ['rowCount', 'debitedWon', 'creditedWon'])
    || typeof controls.rowCount !== 'number' || !Number.isSafeInteger(controls.rowCount)
    || controls.rowCount < 0 || controls.rowCount > maxRows) {
    throw new BankSettlementFormatError('INVALID_BANK_STATEMENT');
  }
  const debitedWon = won(controls.debitedWon, maxBankTotal, true);
  const creditedWon = won(controls.creditedWon, maxBankTotal, true);
  const rows: BankStatement['rows'] = [];
  let debited = 0n;
  let credited = 0n;
  for (const row of input.rows) {
    if (!objectWithFields(row, ['postingId', 'batchId', 'direction', 'amountWon'])
      || (row.direction !== 'debit' && row.direction !== 'credit')) {
      throw new BankSettlementFormatError('INVALID_BANK_STATEMENT');
    }
    const amountWon = won(row.amountWon, maxBankPosting, false);
    rows.push({ postingId: reference(row.postingId), batchId: reference(row.batchId), direction: row.direction, amountWon });
    if (row.direction === 'debit') debited += BigInt(amountWon);
    else credited += BigInt(amountWon);
  }
  if (rows.length !== controls.rowCount || debited.toString() !== debitedWon || credited.toString() !== creditedWon) {
    throw new BankSettlementFormatError('BANK_CONTROL_MISMATCH');
  }
  return { version: 1, currency: 'TEST_KRW', settlementDate, accountRef,
    controls: { rowCount: controls.rowCount, debitedWon, creditedWon }, rows };
}
