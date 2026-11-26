import type { Database } from './database';
import { isStatementReference, type IssuerStatementRow } from './issuer-statement-format';

export type IssuerStatementPosting = IssuerStatementRow;

export class SettlementDayOpenError extends Error {
  readonly code = 'SETTLEMENT_DAY_OPEN';
}

export async function readIssuerStatementLedger(
  database: Database, startMs: number, endMs: number, requireClosedThroughMs?: number,
): Promise<IssuerStatementPosting[]> {
  const dayMs = 86_400_000;
  const koreaOffsetMs = 32_400_000;
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs)
      || endMs - startMs !== dayMs || (startMs % dayMs + koreaOffsetMs) % dayMs !== 0
      || (requireClosedThroughMs !== undefined && (!Number.isSafeInteger(requireClosedThroughMs)
        || requireClosedThroughMs < endMs || (requireClosedThroughMs - endMs) % dayMs !== 0))) {
    throw new Error('STATEMENT_WINDOW_INVALID');
  }
  return database.transaction(async client => {
    await client.query('SET TRANSACTION READ ONLY');
    await client.query("SET LOCAL statement_timeout = '10s'");
    // The issuer function checks its own day. A later bank booking day must
    // also have ended when this same database snapshot was taken.
    if (requireClosedThroughMs !== undefined) {
      const result = await client.query<{ closed: boolean }>(
        'SELECT $1::bigint <= extract(epoch FROM transaction_timestamp()) * 1000 AS closed', [requireClosedThroughMs]);
      if (!result.rows[0].closed) throw new SettlementDayOpenError();
    }
    const { rows } = await client.query<IssuerStatementPosting>(`
      SELECT event_id AS "eventId", payment_id AS "paymentId", kind, amount_won AS "amountWon"
      FROM issuer_statement_postings($1::bigint, $2::bigint)
      ORDER BY event_id COLLATE "C", payment_id COLLATE "C", kind`, [startMs, endMs]);
    if (rows.some(row => !isStatementReference(row.eventId) || !isStatementReference(row.paymentId))) {
      throw new Error('STATEMENT_LEDGER_INCONSISTENT');
    }
    return rows;
  }, { isolation: 'repeatable read' });
}
