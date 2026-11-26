import type { IssuerStatement, IssuerStatementRow } from './issuer-statement-format';

type FindingCode =
  | 'DUPLICATE_STATEMENT_EVENT' | 'DUPLICATE_LEDGER_EVENT'
  | 'MISSING_IN_LEDGER' | 'MISSING_IN_STATEMENT'
  | 'PAYMENT_ID_MISMATCH' | 'KIND_MISMATCH' | 'AMOUNT_MISMATCH';

interface SideEvidence {
  rowCount: number;
  row?: Pick<IssuerStatementRow, 'paymentId' | 'kind' | 'amountWon'>;
  conflictingRows?: boolean;
}

interface EventFinding {
  eventId: string;
  codes: FindingCode[];
  statement: SideEvidence;
  ledger: SideEvidence;
}

function indexRows(rows: readonly IssuerStatementRow[]) {
  const events = new Map<string, IssuerStatementRow[]>();
  let captureCount = 0;
  let captured = 0n;
  let refunded = 0n;
  for (const row of rows) {
    const group = events.get(row.eventId);
    if (group) group.push(row);
    else events.set(row.eventId, [row]);
    if (row.kind === 'capture') {
      captureCount++;
      captured += BigInt(row.amountWon);
    } else {
      refunded += BigInt(row.amountWon);
    }
  }
  return {
    events,
    totals: {
      rowCount: rows.length, captureCount, refundCount: rows.length - captureCount,
      capturedWon: captured.toString(), refundedWon: refunded.toString(), netWon: (captured - refunded).toString(),
    },
  };
}

function discrepancies(statement: readonly IssuerStatementRow[], ledger: readonly IssuerStatementRow[]): FindingCode[] {
  const codes: FindingCode[] = [];
  if (statement.length === 0) codes.push('MISSING_IN_STATEMENT');
  if (ledger.length === 0) codes.push('MISSING_IN_LEDGER');
  if (statement.length > 1) codes.push('DUPLICATE_STATEMENT_EVENT');
  if (ledger.length > 1) codes.push('DUPLICATE_LEDGER_EVENT');
  if (codes.length) return codes;

  const supplied = statement[0];
  const posted = ledger[0];
  if (supplied.paymentId !== posted.paymentId) codes.push('PAYMENT_ID_MISMATCH');
  if (supplied.kind !== posted.kind) codes.push('KIND_MISMATCH');
  if (supplied.amountWon !== posted.amountWon) codes.push('AMOUNT_MISMATCH');
  return codes;
}

function evidence(rows: readonly IssuerStatementRow[]): SideEvidence {
  if (rows.length === 0) return { rowCount: 0 };
  const { paymentId, kind, amountWon } = rows[0];
  if (rows.length === 1) return { rowCount: 1, row: { paymentId, kind, amountWon } };
  return {
    rowCount: rows.length,
    conflictingRows: rows.some(row => row.paymentId !== paymentId || row.kind !== kind || row.amountWon !== amountWon),
  };
}

/** Compares normalized rows in the same clearing period. Gross totals count every supplied row, including duplicates. */
export function matchIssuerStatement(
  statement: Pick<IssuerStatement, 'businessDate' | 'currency' | 'rows'>,
  ledgerRows: readonly IssuerStatementRow[],
  maxFindings = 100,
) {
  if (!Number.isInteger(maxFindings) || maxFindings < 1 || maxFindings > 1_000) {
    throw new Error('maxFindings must be between 1 and 1000.');
  }
  const supplied = indexRows(statement.rows);
  const posted = indexRows(ledgerRows);
  const ids = new Set([...supplied.events.keys(), ...posted.events.keys()]);
  const findings: EventFinding[] = [];
  let findingCount = 0;
  for (const eventId of Array.from(ids).sort()) {
    const statementGroup = supplied.events.get(eventId) ?? [];
    const ledgerGroup = posted.events.get(eventId) ?? [];
    const codes = discrepancies(statementGroup, ledgerGroup);
    if (!codes.length) continue;
    findingCount++;
    if (findings.length < maxFindings) {
      findings.push({ eventId, codes, statement: evidence(statementGroup), ledger: evidence(ledgerGroup) });
    }
  }
  return {
    scope: 'issuer_statement' as const, businessDate: statement.businessDate, currency: statement.currency,
    ok: findingCount === 0, matchedEventCount: ids.size - findingCount, findingCount,
    findingsTruncated: findings.length < findingCount, statementTotals: supplied.totals, ledgerTotals: posted.totals, findings,
  };
}
