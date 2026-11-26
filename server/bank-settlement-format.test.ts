import assert from 'node:assert/strict';
import test from 'node:test';
import { BankSettlementFormatError, parseBankStatement, parseSettlementAdvice,
  type BankStatement, type SettlementAdvice } from './bank-settlement-format';

const advice: SettlementAdvice = {
  version: 1, currency: 'TEST_KRW', accountRef: 'acct-demo', businessDate: '2024-02-29', settlementDate: '2024-03-04',
  batches: [{ batchId: 'batch-A', feeWon: '2', eventIds: ['capture:1', 'refund:2'] }],
};
const bank: BankStatement = {
  version: 1, currency: 'TEST_KRW', settlementDate: '2024-03-04', accountRef: 'acct-demo',
  controls: { rowCount: 2, debitedWon: '72', creditedWon: '9' },
  rows: [
    { postingId: 'bank-debit', batchId: 'batch-A', direction: 'debit', amountWon: '72' },
    { postingId: 'bank-credit', batchId: 'batch-B', direction: 'credit', amountWon: '9' },
  ],
};

function invalid(parse: (input: unknown) => unknown, input: unknown, code: string) {
  assert.throws(() => parse(input), (e: unknown) => e instanceof BankSettlementFormatError && e.code === code && e.message === code);
}

test('Korean dates are real calendar days and allow settlement on or after the business day', () => {
  assert.deepEqual(parseSettlementAdvice(advice), advice);
  assert.deepEqual(parseBankStatement(bank), bank);
  assert.equal(parseSettlementAdvice({ ...advice, settlementDate: advice.businessDate }).settlementDate, advice.businessDate);
  for (const date of ['2023-02-29', '2024-02-31', '2024-03-04T00:00:00+09:00', '0000-01-01', 0]) {
    invalid(parseSettlementAdvice, { ...advice, businessDate: date }, 'INVALID_SETTLEMENT_DATE');
    invalid(parseBankStatement, { ...bank, settlementDate: date }, 'INVALID_SETTLEMENT_DATE');
  }
  invalid(parseSettlementAdvice, { ...advice, settlementDate: '2024-02-28' }, 'INVALID_SETTLEMENT_DATE');
});

test('advice assigns every supplied event at most once and requires at least one event per batch', () => {
  const [first] = advice.batches;
  for (const batches of [[{ ...first, eventIds: ['dup', 'dup'] }], [first, { ...first, batchId: 'b', eventIds: ['refund:2'] }]]) {
    invalid(parseSettlementAdvice, { ...advice, batches }, 'DUPLICATE_ADVICE_EVENT');
  }
  invalid(parseSettlementAdvice, { ...advice, batches: [first, { ...first, eventIds: ['other'] }] }, 'DUPLICATE_ADVICE_BATCH');
  invalid(parseSettlementAdvice, { ...advice, batches: [{ ...first, eventIds: [] }] }, 'INVALID_SETTLEMENT_ADVICE');
  assert.deepEqual(parseSettlementAdvice({ ...advice, batches: [] }).batches, []);
});

test('bank retains duplicate postings and checks the original gross debit, credit and count independently', () => {
  const [debit] = bank.rows;
  const rows = [debit, ...bank.rows];
  const controls = { ...bank.controls, rowCount: 3, debitedWon: '144' };
  assert.deepEqual(parseBankStatement({ ...bank, rows, controls }).rows, rows);
  for (const changed of [
    { ...controls, rowCount: 2 }, { ...controls, debitedWon: '143', creditedWon: '8' },
    { ...controls, debitedWon: '9', creditedWon: '144' },
  ]) invalid(parseBankStatement, { ...bank, rows, controls: changed }, 'BANK_CONTROL_MISMATCH');
  assert.deepEqual(parseBankStatement({ ...bank, rows: [], controls: { rowCount: 0, debitedWon: '0', creditedWon: '0' } }).rows, []);
});

test('normalization accepts only defined fields, sandbox currency and opaque references', () => {
  for (const changes of [{ currency: 'KRW' }, { version: 2 }, { accountNumber: 'sensitive' }]) {
    invalid(parseSettlementAdvice, { ...advice, ...changes }, 'INVALID_SETTLEMENT_ADVICE');
    invalid(parseBankStatement, { ...bank, ...changes }, 'INVALID_BANK_STATEMENT');
  }
  for (const accountRef of ['110123456789', '110-12-3456789', 'acct:4111-1111-1111-1111', 'customer@example.test']) {
    invalid(parseBankStatement, { ...bank, accountRef }, 'INVALID_SETTLEMENT_REFERENCE');
    invalid(parseSettlementAdvice, { ...advice, accountRef }, 'INVALID_SETTLEMENT_REFERENCE');
  }
  const [batch] = advice.batches;
  invalid(parseSettlementAdvice, { ...advice, batches: [{ ...batch, feeCurrency: 'USD' }] }, 'INVALID_SETTLEMENT_ADVICE');
  invalid(parseSettlementAdvice, { ...advice, batches: [{ ...batch, eventIds: ['4111111111111111'] }] }, 'INVALID_SETTLEMENT_REFERENCE');
  invalid(parseSettlementAdvice, { ...advice, batches: [{ ...batch, batchId: 'x y' }] }, 'INVALID_SETTLEMENT_REFERENCE');
  const [row] = bank.rows;
  for (const changes of [{ direction: 'pending' }, { memo: 'private' }]) {
    invalid(parseBankStatement, { ...bank, rows: [{ ...row, ...changes }] }, 'INVALID_BANK_STATEMENT');
  }
  for (const name of ['postingId', 'batchId']) {
    invalid(parseBankStatement, { ...bank, rows: [{ ...row, [name]: 'email@example.test' }] }, 'INVALID_SETTLEMENT_REFERENCE');
  }
  invalid(parseBankStatement, { ...bank, controls: { ...bank.controls, pending: 0 } }, 'INVALID_BANK_STATEMENT');
});

test('bank money is exact for aggregated batches beyond safe JS integers and the inputs have explicit bounds', () => {
  const maxFee = BigInt(Number.MAX_SAFE_INTEGER);
  const maxAmount = maxFee * 10001n;
  const [row] = bank.rows;
  const rows = [row, row].map((r, i) => ({ ...r, postingId: 'row-' + i, amountWon: String(maxAmount) }));
  const controls = { rowCount: 2, debitedWon: String(maxAmount * 2n), creditedWon: '0' };
  assert.deepEqual(parseBankStatement({ ...bank, rows, controls }).controls, controls);
  for (const value of ['0', '1e3', '2.5', '01', '+2', '-4', ' 2', '1\n', 2, (maxAmount + 1n).toString()]) {
    invalid(parseBankStatement, { ...bank, rows: [{ ...row, amountWon: value }] }, 'INVALID_SETTLEMENT_AMOUNT');
  }
  const [batch] = advice.batches;
  assert.equal(parseSettlementAdvice({ ...advice, batches: [{ ...batch, feeWon: '0' }] }).batches[0].feeWon, '0');
  for (const feeWon of ['-1', '3.00', 0, (maxFee + 1n).toString()]) {
    invalid(parseSettlementAdvice, { ...advice, batches: [{ ...batch, feeWon }] }, 'INVALID_SETTLEMENT_AMOUNT');
  }
  for (const rowCount of [-1, 0.25, 10001, '2']) {
    invalid(parseBankStatement, { ...bank, controls: { ...bank.controls, rowCount } }, 'INVALID_BANK_STATEMENT');
  }
  invalid(parseBankStatement, { ...bank, controls: { ...bank.controls, creditedWon: String(maxAmount * 10000n + 1n) } }, 'INVALID_SETTLEMENT_AMOUNT');
});

test('file limits apply to all allocations combined and cap the bank rows supplied', () => {
  const [batch] = advice.batches;
  const eventIds = Array.from({ length: 10_000 }, (_, i) => 'event-' + i);
  const batches = [{ ...batch, eventIds }];
  assert.equal(parseSettlementAdvice({ ...advice, batches }).batches[0].eventIds.length, 10_000);
  invalid(parseSettlementAdvice, { ...advice, batches: [...batches, { ...batch, batchId: 'overflow', eventIds: ['extra'] }] }, 'INVALID_SETTLEMENT_ADVICE');
  invalid(parseSettlementAdvice, { ...advice, batches: Array(10_001).fill(null) }, 'INVALID_SETTLEMENT_ADVICE');
  const row = { ...bank.rows[0], amountWon: '1' };
  const rows = Array(10_000).fill(row);
  const controls = { rowCount: 10_000, debitedWon: '10000', creditedWon: '0' };
  assert.equal(parseBankStatement({ ...bank, rows, controls }).rows.length, 10_000);
  invalid(parseBankStatement, { ...bank, rows: [...rows, row], controls }, 'INVALID_BANK_STATEMENT');
});
