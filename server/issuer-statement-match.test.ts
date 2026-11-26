import assert from 'node:assert/strict';
import test from 'node:test';
import type { IssuerStatementRow } from './issuer-statement-format';
import { matchIssuerStatement } from './issuer-statement-match';

function row(eventId: string, kind: 'capture' | 'refund', amountWon: string, paymentId = 'purchase'): IssuerStatementRow {
  return { eventId, kind, amountWon, paymentId };
}

function statement(rows: IssuerStatementRow[]) {
  return { businessDate: '2026-11-26', currency: 'TEST_KRW' as const, rows };
}

test('each partial capture and refund matches its own event, in any order', () => {
  const rows = [row('c1', 'capture', '60'), row('c2', 'capture', '40'), row('r1', 'refund', '22'), row('r2', 'refund', '8')];
  const result = matchIssuerStatement(statement(rows), rows.toReversed());
  assert.equal(result.ok, true);
  assert.equal(result.matchedEventCount, 4);
  assert.equal(result.findingCount, 0);
  assert.deepEqual(result.findings, []);
  assert.equal(result.findingsTruncated, false);
  assert.deepEqual(result.statementTotals, { rowCount: 4, captureCount: 2, refundCount: 2, capturedWon: '100', refundedWon: '30', netWon: '70' });
  assert.deepEqual(result.ledgerTotals, result.statementTotals);
});

test('offsetting errors within the same gross total still identify both affected events', () => {
  const result = matchIssuerStatement(statement([row('r2', 'refund', '8'), row('r1', 'refund', '22')]),
    [row('r1', 'refund', '23'), row('r2', 'refund', '7')]);
  assert.deepEqual(result.statementTotals, result.ledgerTotals);
  assert.equal(result.statementTotals.netWon, '-30');
  assert.equal(result.ok, false);
  assert.equal(result.findingCount, 2);
  assert.deepEqual(result.findings.map(f => [f.eventId, f.codes, f.statement.row?.amountWon, f.ledger.row?.amountWon]),
    [['r1', ['AMOUNT_MISMATCH'], '22', '23'], ['r2', ['AMOUNT_MISMATCH'], '8', '7']]);
});

test('duplicate references never match, whether identical or conflicting; one side can also be missing', () => {
  const duplicate = row('dup', 'capture', '20');
  const ambiguous = row('mixed', 'capture', '100');
  const rows = [duplicate, duplicate, row('only-statement', 'refund', '7'), ambiguous, row('same', 'capture', '5')];
  const ledger = [ambiguous, row('mixed', 'refund', '15'), row('only-ledger', 'capture', '12'), row('same', 'capture', '5')];
  const result = matchIssuerStatement(statement(rows), ledger);
  assert.equal(result.matchedEventCount, 1);
  assert.equal(result.findingCount, 4);
  assert.deepEqual(result.findings.map(f => [f.eventId, f.codes]),
    [['dup', ['MISSING_IN_LEDGER', 'DUPLICATE_STATEMENT_EVENT']], ['mixed', ['DUPLICATE_LEDGER_EVENT']],
      ['only-ledger', ['MISSING_IN_STATEMENT']], ['only-statement', ['MISSING_IN_LEDGER']]]);
  assert.deepEqual(result.findings[0].statement, { rowCount: 2, conflictingRows: false });
  assert.deepEqual(result.findings[1].ledger, { rowCount: 2, conflictingRows: true });
  assert.equal(result.statementTotals.capturedWon, '145');
  assert.equal(result.ledgerTotals.refundedWon, '15');
  assert.deepEqual(matchIssuerStatement(statement(rows.toReversed()), ledger.toReversed()), result);
});

test('both sides with repeated IDs remain unresolved even when a pair of rows would match', () => {
  const first = row('same-id', 'capture', '22');
  const second = row('same-id', 'capture', '221', 'unrelated');
  const result = matchIssuerStatement(statement([first, second]), [first, first]);
  assert.equal(result.matchedEventCount, 0);
  assert.deepEqual(result.findings, [{
    eventId: 'same-id', codes: ['DUPLICATE_STATEMENT_EVENT', 'DUPLICATE_LEDGER_EVENT'],
    statement: { rowCount: 2, conflictingRows: true }, ledger: { rowCount: 2, conflictingRows: false },
  }]);
});

test('a single event reports all differing fields without printing unrelated row data', () => {
  const statementRow = { ...row('r', 'refund', '1', 'a'), userEmail: 'private@example.test' };
  const ledgerRow = { ...row('r', 'capture', '2', 'b'), counterparty: 'Private Merchant' };
  const result = matchIssuerStatement(statement([statementRow]), [ledgerRow]);
  assert.equal(result.findingCount, 1);
  assert.deepEqual(result.findings[0].codes, ['PAYMENT_ID_MISMATCH', 'KIND_MISMATCH', 'AMOUNT_MISMATCH']);
  assert.deepEqual(result.findings[0].ledger, { rowCount: 1, row: { paymentId: 'b', kind: 'capture', amountWon: '2' } });
  assert.doesNotMatch(JSON.stringify(result), /private@example|Private Merchant/);
});

test('the sorted detail cap does not truncate totals, finding counts or exact integer arithmetic', () => {
  const rows = [row('z', 'capture', '9007199254740991'), row('a', 'capture', '9007199254740991'), row('m', 'refund', '3')];
  const result = matchIssuerStatement(statement(rows), [], 1);
  assert.equal(result.findingsTruncated, true);
  assert.deepEqual(result.findings.map(f => f.eventId), ['a']);
  assert.equal(result.findingCount, 3);
  assert.equal(result.statementTotals.netWon, '18014398509481979');
  const empty = matchIssuerStatement(statement([]), []);
  assert.equal(empty.ok, true);
  assert.equal(empty.matchedEventCount, 0);
  assert.equal(empty.ledgerTotals.netWon, '0');
  for (const invalidCap of [0, -1, 1.5, 1_001, Infinity, NaN]) {
    assert.throws(() => matchIssuerStatement(statement([]), [], invalidCap), /maxFindings/);
  }
});
