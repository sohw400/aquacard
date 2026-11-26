import type { BankStatement, SettlementAdvice } from './bank-settlement-format';
import type { IssuerStatement } from './issuer-statement-format';

type BankRow = BankStatement['rows'][number];
type ScopeCode = 'SETTLEMENT_SCOPE_MISMATCH' | 'SETTLEMENT_ALLOCATION_MISMATCH';
type FindingCode = 'MISSING_BANK_POSTING' | 'UNEXPECTED_BANK_BATCH' | 'UNEXPECTED_BANK_POSTING'
  | 'MULTIPLE_BANK_POSTINGS' | 'DUPLICATE_BANK_POSTING_ID' | 'DIRECTION_MISMATCH' | 'AMOUNT_MISMATCH';

export class BankSettlementScopeError extends Error {
  constructor(readonly code: ScopeCode) {
    super(code);
    this.name = 'BankSettlementScopeError';
  }
}

interface Gross {
  rowCount: number;
  debited: bigint;
  credited: bigint;
}

function emptyGross(): Gross {
  return { rowCount: 0, debited: 0n, credited: 0n };
}

function reportGross({ rowCount, debited, credited }: Gross) {
  return { rowCount, debitedWon: debited.toString(), creditedWon: credited.toString() };
}

function addAmount(gross: Gross, direction: BankRow['direction'], amount: bigint) {
  gross.rowCount++;
  if (direction === 'debit') gross.debited += amount;
  else gross.credited += amount;
}

interface ExpectedPosting {
  direction: BankRow['direction'] | 'none';
  amountWon: string;
  feeWon: string;
}

function expectedPostings(statement: IssuerStatement, advice: SettlementAdvice) {
  const events = new Map(statement.rows.map(event => [event.eventId, event]));
  if (events.size !== statement.rows.length) throw new BankSettlementScopeError('SETTLEMENT_ALLOCATION_MISMATCH');
  const batches = new Map<string, ExpectedPosting>();
  const totals = emptyGross();
  let fees = 0n;
  for (const batch of advice.batches) {
    if (batches.has(batch.batchId) || !batch.eventIds.length) throw new BankSettlementScopeError('SETTLEMENT_ALLOCATION_MISMATCH');
    const fee = BigInt(batch.feeWon);
    fees += fee;
    let payable = fee;
    for (const eventId of batch.eventIds) {
      const event = events.get(eventId);
      if (!event) throw new BankSettlementScopeError('SETTLEMENT_ALLOCATION_MISMATCH');
      events.delete(eventId);
      const amount = BigInt(event.amountWon);
      payable += event.kind === 'capture' ? amount : -amount;
    }
    const direction = payable > 0n ? 'debit' : payable < 0n ? 'credit' : 'none';
    const amount = payable < 0n ? -payable : payable;
    batches.set(batch.batchId, { direction, amountWon: amount.toString(), feeWon: batch.feeWon });
    if (direction !== 'none') addAmount(totals, direction, amount);
  }
  if (events.size) throw new BankSettlementScopeError('SETTLEMENT_ALLOCATION_MISMATCH');
  return { batches, totals, fees };
}

function bookedPostings(rows: BankRow[]) {
  const batches = new Map<string, Gross>();
  const batchByPosting = new Map<string, string>();
  const duplicateBatches = new Set<string>();
  const totals = emptyGross();
  for (const row of rows) {
    const previous = batchByPosting.get(row.postingId);
    if (previous !== undefined) {
      duplicateBatches.add(previous);
      duplicateBatches.add(row.batchId);
    } else {
      batchByPosting.set(row.postingId, row.batchId);
    }
    const batch = batches.get(row.batchId) ?? emptyGross();
    const amount = BigInt(row.amountWon);
    addAmount(batch, row.direction, amount);
    addAmount(totals, row.direction, amount);
    batches.set(row.batchId, batch);
  }
  return { batches, duplicateBatches, totals };
}

function differences(expected: ExpectedPosting | undefined, booked: Gross, duplicateId: boolean) {
  const codes: FindingCode[] = [];
  if (duplicateId) codes.push('DUPLICATE_BANK_POSTING_ID');
  if (booked.rowCount > 1) codes.push('MULTIPLE_BANK_POSTINGS');
  if (!expected) codes.push('UNEXPECTED_BANK_BATCH');
  else if (expected.direction === 'none') {
    if (booked.rowCount) codes.push('UNEXPECTED_BANK_POSTING');
  } else if (booked.rowCount === 0) codes.push('MISSING_BANK_POSTING');
  else if (booked.rowCount === 1) {
    if ((booked.debited > 0n ? 'debit' : 'credit') !== expected.direction) codes.push('DIRECTION_MISMATCH');
    if ((booked.debited + booked.credited).toString() !== expected.amountWon) codes.push('AMOUNT_MISMATCH');
  }
  return codes;
}

interface BatchFinding {
  batchId: string;
  codes: FindingCode[];
  expected: ExpectedPosting | null;
  bank: ReturnType<typeof reportGross>;
}

export function verifyBankSettlementScope(statement: IssuerStatement, advice: SettlementAdvice, bank: BankStatement) {
  if (statement.businessDate !== advice.businessDate || advice.settlementDate !== bank.settlementDate
    || advice.settlementDate < advice.businessDate || statement.currency !== advice.currency
    || advice.currency !== bank.currency || advice.accountRef !== bank.accountRef) {
    throw new BankSettlementScopeError('SETTLEMENT_SCOPE_MISMATCH');
  }
}

export function matchBankSettlement(statement: IssuerStatement, advice: SettlementAdvice, bank: BankStatement) {
  verifyBankSettlementScope(statement, advice, bank);
  const expected = expectedPostings(statement, advice);
  const booked = bookedPostings(bank.rows);
  const ids = new Set([...expected.batches.keys(), ...booked.batches.keys()]);
  const findings: BatchFinding[] = [];
  let findingCount = 0;
  for (const batchId of Array.from(ids).sort()) {
    const posting = expected.batches.get(batchId);
    const observed = booked.batches.get(batchId) ?? emptyGross();
    const codes = differences(posting, observed, booked.duplicateBatches.has(batchId));
    if (!codes.length) continue;
    findingCount++;
    if (findings.length < 100) findings.push({ batchId, codes, expected: posting ?? null, bank: reportGross(observed) });
  }
  return {
    scope: 'bank_settlement' as const, businessDate: statement.businessDate, settlementDate: bank.settlementDate,
    currency: bank.currency, ok: findingCount === 0, matchedBatchCount: ids.size - findingCount, findingCount,
    findingsTruncated: findings.length < findingCount, expectedTotals: reportGross(expected.totals),
    bankTotals: reportGross(booked.totals), feeWon: expected.fees.toString(), findings,
  };
}
