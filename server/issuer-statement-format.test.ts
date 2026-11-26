import assert from 'node:assert/strict';
import test from 'node:test';
import {
  IssuerStatementFormatError, MAX_ISSUER_STATEMENT_ROWS, isStatementReference,
  parseIssuerStatement, type IssuerStatementRow,
} from './issuer-statement-format';

function statement() {
  return {
    version: 1, businessDate: '2028-02-29', currency: 'TEST_KRW',
    controls: { rowCount: 2, capturedWon: '30', refundedWon: '20' },
    rows: [
      { eventId: 'issuer.capture:1', paymentId: 'payment_a', kind: 'capture', amountWon: '30' },
      { eventId: 'issuer.refund:2', paymentId: 'payment_a', kind: 'refund', amountWon: '20' },
    ] satisfies IssuerStatementRow[],
  };
}

function invalid(input: unknown, code: string) {
  assert.throws(() => parseIssuerStatement(input), (err: unknown) =>
    err instanceof IssuerStatementFormatError && err.code === code && err.message === code);
}

test('business date covers exactly one day from midnight KST with strict Gregorian calendar validation', () => {
  const parsed = parseIssuerStatement(statement());
  assert.equal(new Date(parsed.startMs).toISOString(), '2028-02-28T15:00:00.000Z');
  assert.equal(new Date(parsed.endMs).toISOString(), '2028-02-29T15:00:00.000Z');
  const yearEnd = parseIssuerStatement({ ...statement(), businessDate: '2026-12-31' });
  const next = parseIssuerStatement({ ...statement(), businessDate: '2027-01-01' });
  assert.equal(yearEnd.endMs, next.startMs);
  for (const businessDate of ['2026-02-29', '2025-04-31', '2026-00-31', '0000-01-01', '2026-1-1',
    '2028-02-29T00:00:00+09:00', null]) {
    invalid({ ...statement(), businessDate }, 'INVALID_STATEMENT_DATE');
  }
});

test('parsing preserves duplicate rows and sums whole won exactly beyond JavaScript safe integer totals', () => {
  const duplicate = { ...statement().rows[0], amountWon: '9007199254740991' };
  const controls = { rowCount: 2, capturedWon: '18014398509481982', refundedWon: '0' };
  const result = parseIssuerStatement({ ...statement(), rows: [duplicate, duplicate], controls });
  assert.deepEqual(result.rows, [duplicate, duplicate]);
  assert.deepEqual(result.controls, controls);
  invalid({ ...statement(), rows: [duplicate, duplicate],
    controls: { ...controls, capturedWon: '18014398509481983' } }, 'STATEMENT_CONTROL_MISMATCH');
});

test('the declared count and gross amounts detect missing rows and offsetting capture/refund errors', () => {
  const file = statement();
  invalid({ ...file, rows: file.rows.slice(0, 1) }, 'STATEMENT_CONTROL_MISMATCH');
  for (const controls of [{ ...file.controls, rowCount: 3 }, { ...file.controls, capturedWon: '29', refundedWon: '19' }]) {
    invalid({ ...file, controls }, 'STATEMENT_CONTROL_MISMATCH');
  }
  const empty = parseIssuerStatement({ ...file, controls: { rowCount: 0, capturedWon: '0', refundedWon: '0' }, rows: [] });
  assert.deepEqual(empty.rows, []);
});

test('amounts must be bounded canonical decimal strings and each event amount must be positive', () => {
  const file = statement();
  for (const amountWon of [0, 1, 1n, null, '', '0', '-1', '+1', '01', '1.0', '1e3', ' 2', '4\n',
    '9007199254740992', '0123456789'.repeat(100)]) {
    invalid({ ...file, rows: [{ ...file.rows[0], amountWon }] }, 'INVALID_STATEMENT_AMOUNT');
  }
  for (const capturedWon of [0, '00', '-1', '9'.repeat(50)]) {
    invalid({ ...file, controls: { ...file.controls, capturedWon } }, 'INVALID_STATEMENT_AMOUNT');
  }
  for (const rowCount of ['2', -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    invalid({ ...file, controls: { ...file.controls, rowCount } }, 'INVALID_STATEMENT_FORMAT');
  }
});

test('opaque references accept card-command tokens and refuse card-number-shaped or raw customer identifiers', () => {
  const file = statement();
  for (const id of ['xy:AB-01.a_1', '550e8400-e29b-41d4-a716-446655440000', 'a'.repeat(128)]) {
    assert.ok(isStatementReference(id));
  }
  for (const id of ['4111111111111111', 'evt:4111-1111-1111-1111', 'evt:4111111111111111:retry',
    'pay.3782.822463.10005', 'customer@example.test', 'a'.repeat(129), 'key\n', '', null]) {
    invalid({ ...file, rows: [{ ...file.rows[0], eventId: id }] }, 'INVALID_STATEMENT_REFERENCE');
    invalid({ ...file, rows: [{ ...file.rows[0], paymentId: id }] }, 'INVALID_STATEMENT_REFERENCE');
  }
});

test('only the defined version, currency, controls and capture/refund fields are accepted', () => {
  const file = statement();
  for (const bad of [null, [], { ...file, rawPayload: 'private' }, { ...file, version: 2 },
    { ...file, currency: 'KRW' }, { ...file, controls: null }, { ...file, controls: { ...file.controls, email: 'private' } },
    { ...file, rows: [null] }, { ...file, rows: [{ ...file.rows[0], pan: 'private' }] },
    { ...file, rows: [{ ...file.rows[0], kind: 'authorize' }] },
    { ...file, rows: [{ eventId: 'x', kind: 'capture', amountWon: '1' }] }]) {
    invalid(bad, 'INVALID_STATEMENT_FORMAT');
  }
});

test('row limit accepts a full statement and rejects over-limit input before scanning entries', () => {
  const file = statement();
  const rows = Array.from({ length: MAX_ISSUER_STATEMENT_ROWS }, () => file.rows[0]);
  const controls = { rowCount: rows.length, capturedWon: String(30 * rows.length), refundedWon: '0' };
  assert.equal(parseIssuerStatement({ ...file, rows, controls }).rows.length, rows.length);
  invalid({ ...file, rows: [...rows, null], controls }, 'INVALID_STATEMENT_FORMAT');
});
