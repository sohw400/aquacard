export const MAX_ISSUER_STATEMENT_ROWS = 10_000;

export interface IssuerStatementRow {
  eventId: string;
  paymentId: string;
  kind: 'capture' | 'refund';
  amountWon: string;
}

export interface IssuerStatementControls {
  rowCount: number;
  capturedWon: string;
  refundedWon: string;
}

export interface IssuerStatement {
  version: 1;
  businessDate: string;
  currency: 'TEST_KRW';
  controls: IssuerStatementControls;
  rows: IssuerStatementRow[];
  startMs: number;
  endMs: number;
}

type FormatErrorCode = 'INVALID_STATEMENT_FORMAT' | 'INVALID_STATEMENT_DATE'
  | 'INVALID_STATEMENT_REFERENCE' | 'INVALID_STATEMENT_AMOUNT' | 'STATEMENT_CONTROL_MISMATCH';

export class IssuerStatementFormatError extends Error {
  constructor(readonly code: FormatErrorCode) {
    super(code);
    this.name = 'IssuerStatementFormatError';
  }
}

export function objectWithFields(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

// References are opaque card-command identifiers. Exclude unbroken and conventionally
// grouped card-number-shaped strings before they can appear in an operator report.
const panDigits = /(?:^|\D)\d{13,19}(?!\d)/;
const groupedPan = /(?:^|\D)(?:\d{4}[-:._]\d{4}[-:._]\d{4}[-:._]\d{1,4}|\d{4}[-:._]\d{6}[-:._]\d{5})(?!\d)/;

export function isStatementReference(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
    && !panDigits.test(value) && !groupedPan.test(value);
}

const maxAmount = BigInt(Number.MAX_SAFE_INTEGER);
const maxTotal = maxAmount * BigInt(MAX_ISSUER_STATEMENT_ROWS);
export function isStatementWon(value: unknown, maximum: bigint, allowZero: boolean): value is string {
  return typeof value === 'string' && value.length <= maximum.toString().length
    && /^(0|[1-9][0-9]*)$/.test(value) && (allowZero || value !== '0') && BigInt(value) <= maximum;
}

function decimalWon(value: unknown, maximum: bigint, allowZero: boolean): string {
  if (!isStatementWon(value, maximum, allowZero)) {
    throw new IssuerStatementFormatError('INVALID_STATEMENT_AMOUNT');
  }
  return value;
}

function parseRow(value: unknown): IssuerStatementRow {
  if (!objectWithFields(value, ['eventId', 'paymentId', 'kind', 'amountWon'])
    || (value.kind !== 'capture' && value.kind !== 'refund')) {
    throw new IssuerStatementFormatError('INVALID_STATEMENT_FORMAT');
  }
  if (!isStatementReference(value.eventId) || !isStatementReference(value.paymentId)) {
    throw new IssuerStatementFormatError('INVALID_STATEMENT_REFERENCE');
  }
  return { eventId: value.eventId, paymentId: value.paymentId, kind: value.kind,
    amountWon: decimalWon(value.amountWon, maxAmount, false) };
}

const dayMs = 24 * 60 * 60 * 1000;
const koreaOffsetMs = 9 * 60 * 60 * 1000;

export function statementDayWindow(date: unknown) {
  if (typeof date !== 'string' || !/^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date)) return;
  const midnightUtc = Date.parse(date + 'T00:00:00.000Z');
  if (!Number.isFinite(midnightUtc) || new Date(midnightUtc).toISOString().slice(0, 10) !== date) return;
  const startMs = midnightUtc - koreaOffsetMs;
  return { date, startMs, endMs: startMs + dayMs };
}

export function parseIssuerStatement(input: unknown): IssuerStatement {
  if (!objectWithFields(input, ['version', 'businessDate', 'currency', 'controls', 'rows'])
    || input.version !== 1 || input.currency !== 'TEST_KRW' || !Array.isArray(input.rows)
    || input.rows.length > MAX_ISSUER_STATEMENT_ROWS) {
    throw new IssuerStatementFormatError('INVALID_STATEMENT_FORMAT');
  }
  const window = statementDayWindow(input.businessDate);
  if (!window) throw new IssuerStatementFormatError('INVALID_STATEMENT_DATE');
  const controls = input.controls;
  if (!objectWithFields(controls, ['rowCount', 'capturedWon', 'refundedWon'])
    || typeof controls.rowCount !== 'number' || !Number.isSafeInteger(controls.rowCount)
    || controls.rowCount < 0 || controls.rowCount > MAX_ISSUER_STATEMENT_ROWS) {
    throw new IssuerStatementFormatError('INVALID_STATEMENT_FORMAT');
  }
  const capturedWon = decimalWon(controls.capturedWon, maxTotal, true);
  const refundedWon = decimalWon(controls.refundedWon, maxTotal, true);
  const rows: IssuerStatementRow[] = [];
  let captured = 0n;
  let refunded = 0n;
  for (const value of input.rows) {
    const row = parseRow(value);
    rows.push(row);
    if (row.kind === 'capture') captured += BigInt(row.amountWon);
    else refunded += BigInt(row.amountWon);
  }
  if (controls.rowCount !== rows.length || capturedWon !== captured.toString() || refundedWon !== refunded.toString()) {
    throw new IssuerStatementFormatError('STATEMENT_CONTROL_MISMATCH');
  }
  return { version: 1, currency: 'TEST_KRW', businessDate: window.date, startMs: window.startMs, endMs: window.endMs,
    controls: { rowCount: controls.rowCount, capturedWon, refundedWon }, rows };
}
