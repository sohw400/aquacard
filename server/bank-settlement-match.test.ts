import assert from 'node:assert/strict';
import test from 'node:test';
import type { BankStatement, SettlementAdvice } from './bank-settlement-format';
import type { IssuerStatementRow } from './issuer-statement-format';
import { parseIssuerStatement } from './issuer-statement-format';
import { BankSettlementScopeError, matchBankSettlement } from './bank-settlement-match';

const businessDate = '2025-11-26';
const settlementDate = '2025-11-28';
const header = { version: 1 as const, currency: 'TEST_KRW' as const, accountRef: 'settlement-account', settlementDate };
const event = (eventId: string, kind: IssuerStatementRow['kind'], amountWon: string) =>
  ({ eventId, paymentId: 'purchase', kind, amountWon });
const batch = (batchId: string, eventIds: string[], feeWon = '0') => ({ batchId, eventIds, feeWon });
const posting = (postingId: string, batchId: string, direction: BankStatement['rows'][number]['direction'], amountWon: string) =>
  ({ postingId, batchId, direction, amountWon });

function inputs(rows: IssuerStatementRow[], batches: SettlementAdvice['batches'], postings: BankStatement['rows']) {
  const sum = (values: string[]) => values.reduce((n, value) => n + BigInt(value), 0n).toString();
  const statement = parseIssuerStatement({ version: 1, currency: 'TEST_KRW', businessDate, rows, controls: {
    rowCount: rows.length, capturedWon: sum(rows.filter(r => r.kind === 'capture').map(r => r.amountWon)),
    refundedWon: sum(rows.filter(r => r.kind === 'refund').map(r => r.amountWon)),
  } });
  const advice: SettlementAdvice = { ...header, businessDate, batches };
  const bank: BankStatement = { ...header, rows: postings, controls: { rowCount: postings.length,
    debitedWon: sum(postings.filter(r => r.direction === 'debit').map(r => r.amountWon)),
    creditedWon: sum(postings.filter(r => r.direction === 'credit').map(r => r.amountWon)),
  } };
  return { statement, advice, bank };
}

test('each batch nets captures, refunds and explicit issuer fees from the program account perspective', () => {
  const rows = [event('capture', 'capture', '100'), event('refund', 'refund', '25'), event('extra-refund', 'refund', '40'),
    event('cancelled-sale', 'capture', '20'), event('cancelled-refund', 'refund', '22')];
  const { statement, advice, bank } = inputs(rows, [
    batch('outgoing', ['capture', 'refund'], '3'), batch('incoming', ['extra-refund'], '5'),
    batch('zero', ['cancelled-sale', 'cancelled-refund'], '2'),
  ], [posting('bank-credit', 'incoming', 'credit', '35'), posting('bank-debit', 'outgoing', 'debit', '78')]);
  const result = matchBankSettlement(statement, advice, bank);
  assert.equal(result.ok, true);
  assert.equal(result.matchedBatchCount, 3);
  assert.equal(result.feeWon, '10');
  assert.deepEqual(result.expectedTotals, { rowCount: 2, debitedWon: '78', creditedWon: '35' });
  assert.deepEqual(result.bankTotals, result.expectedTotals);
  assert.deepEqual(result.findings, []);
});

test('offsetting differences and swapped posting directions are reported even when total cash matches', () => {
  const { statement, advice, bank } = inputs([event('s', 'capture', '90'), event('r', 'refund', '90')],
    [batch('sale', ['s']), batch('return', ['r'])],
    [posting('p1', 'sale', 'credit', '90'), posting('p2', 'return', 'debit', '90')]);
  const result = matchBankSettlement(statement, advice, bank);
  assert.equal(result.ok, false);
  assert.deepEqual(result.expectedTotals, result.bankTotals);
  assert.deepEqual(result.findings.map(f => [f.batchId, f.codes]), [
    ['return', ['DIRECTION_MISMATCH']], ['sale', ['DIRECTION_MISMATCH']],
  ]);
});

test('repeated posting IDs invalidate every participating batch, even across distinct references', () => {
  const events = ['a', 'b', 'c'].map(id => event(id, 'capture', '12'));
  const { statement, advice, bank } = inputs(events, events.map(e => batch(e.eventId, [e.eventId])),
    [posting('p', 'c', 'debit', '12'), posting('p', 'b', 'debit', '6'), posting('p', 'b', 'debit', '6'),
      posting('p', 'a', 'debit', '12')]);
  const result = matchBankSettlement(statement, advice, bank);
  assert.equal(result.matchedBatchCount, 0);
  assert.deepEqual(result.findings.map(f => [f.batchId, f.codes]), [
    ['a', ['DUPLICATE_BANK_POSTING_ID']], ['b', ['DUPLICATE_BANK_POSTING_ID', 'MULTIPLE_BANK_POSTINGS']],
    ['c', ['DUPLICATE_BANK_POSTING_ID']],
  ]);
  assert.deepEqual(result, matchBankSettlement(statement, { ...advice, batches: advice.batches.toReversed() },
    { ...bank, rows: bank.rows.toReversed() }));
});

test('missing, extra, split and unexpected zero-net postings cannot cancel one another', () => {
  const { statement, advice, bank } = inputs(
    [event('a', 'capture', '10'), event('r', 'refund', '4'), event('x', 'capture', '2'), event('y', 'refund', '2')],
    [batch('out', ['a']), batch('ref', ['r']), batch('zero', ['x', 'y'])],
    [posting('x1', 'extra', 'credit', '4'), posting('a1', 'out', 'debit', '6'), posting('a2', 'out', 'debit', '4'),
      posting('z', 'zero', 'credit', '2')]);
  const result = matchBankSettlement(statement, advice, bank);
  assert.deepEqual(result.findings.map(f => [f.batchId, f.codes]), [['extra', ['UNEXPECTED_BANK_BATCH']],
    ['out', ['MULTIPLE_BANK_POSTINGS']], ['ref', ['MISSING_BANK_POSTING']], ['zero', ['UNEXPECTED_BANK_POSTING']]]);
  assert.deepEqual(result.findings[0].expected, null);
  assert.deepEqual(result.findings[1].bank, { rowCount: 2, debitedWon: '10', creditedWon: '0' });
});

test('incompatible periods, accounts and coverage stop the check with a safe code', () => {
  const { statement, advice, bank } = inputs([event('a', 'capture', '10'), event('b', 'capture', '30')],
    [batch('first', ['a']), batch('second', ['b'])], []);
  for (const wrong of [{ ...bank, settlementDate: businessDate }, { ...bank, accountRef: 'different-account' }]) {
    assert.throws(() => matchBankSettlement(statement, advice, wrong),
      { name: 'BankSettlementScopeError', message: 'SETTLEMENT_SCOPE_MISMATCH' });
  }
  assert.throws(() => matchBankSettlement(statement, { ...advice, businessDate: '2025-11-25' }, bank),
    { name: 'BankSettlementScopeError', message: 'SETTLEMENT_SCOPE_MISMATCH' });
  for (const batches of [[batch('first', ['unknown', 'b'])], [batch('first', ['a'])],
    [batch('first', ['a', 'b']), batch('second', ['b'])], [batch('same', ['a']), batch('same', ['b'])]]) {
    assert.throws(() => matchBankSettlement(statement, { ...advice, batches }, bank),
      (error: unknown) => error instanceof BankSettlementScopeError && error.code === 'SETTLEMENT_ALLOCATION_MISMATCH'
        && error.message === error.code);
  }
  assert.throws(() => matchBankSettlement({ ...statement, rows: [statement.rows[0], statement.rows[0]] }, advice, bank),
    { name: 'BankSettlementScopeError', message: 'SETTLEMENT_ALLOCATION_MISMATCH' });
});

test('full gross amounts remain exact when findings are truncated', () => {
  const events = Array.from({ length: 105 }, (_, i) => event('e-' + String(i).padStart(3, '0'), 'capture', '9007199254740991'));
  const { statement, advice, bank } = inputs(events, events.map(e => batch(e.eventId, [e.eventId], '1')),
    events.map(e => posting('p-' + e.eventId, e.eventId, 'debit', '9007199254740991')).toReversed());
  const result = matchBankSettlement(statement, advice, bank);
  assert.equal(result.findingCount, 105);
  assert.equal(result.findings.length, 100);
  assert.equal(result.findingsTruncated, true);
  assert.deepEqual(result.findings.at(-1), { batchId: 'e-099', codes: ['AMOUNT_MISMATCH'],
    expected: { direction: 'debit', amountWon: '9007199254740992', feeWon: '1' },
    bank: { rowCount: 1, debitedWon: '9007199254740991', creditedWon: '0' } });
  assert.equal(result.expectedTotals.debitedWon, (9007199254740992n * 105n).toString());
  assert.equal(result.bankTotals.debitedWon, (9007199254740991n * 105n).toString());
  const empty = inputs([], [], []);
  const resultEmpty = matchBankSettlement(empty.statement, empty.advice, empty.bank);
  assert.equal(resultEmpty.ok, true);
  assert.equal(resultEmpty.matchedBatchCount, 0);
  assert.equal(resultEmpty.feeWon, '0');
});
