import type { Database } from './database';
import { isStatementReference, type IssuerStatementRow } from './issuer-statement-format';

export type IssuerStatementPosting = IssuerStatementRow;

export async function readIssuerStatementLedger(
  database: Database, startMs: number, endMs: number,
): Promise<IssuerStatementPosting[]> {
  const dayMs = 86_400_000;
  const koreaOffsetMs = 32_400_000;
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs)
      || endMs - startMs !== dayMs || (startMs % dayMs + koreaOffsetMs) % dayMs !== 0) {
    throw new Error('STATEMENT_WINDOW_INVALID');
  }
  return database.transaction(async client => {
    await client.query('SET TRANSACTION READ ONLY');
    await client.query("SET LOCAL statement_timeout = '10s'");
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
