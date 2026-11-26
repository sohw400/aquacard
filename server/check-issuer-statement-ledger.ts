import { writeSync } from 'node:fs';
import { cardServiceDatabase } from './card-service-database';
import type { IssuerStatement } from './issuer-statement-format';
import { readIssuerStatementLedger } from './issuer-statement-ledger';
import { matchIssuerStatement } from './issuer-statement-match';
import { verifyMigrations } from './migrations';
import { verifySettlementRole } from './permissions';

/** Shared by the one-shot settlement commands. Close the pool before returning a report. */
export async function checkIssuerStatementLedger(
  statement: IssuerStatement, requireClosedThroughMs?: number,
): Promise<ReturnType<typeof matchIssuerStatement>> {
  // Bound a network outage during role verification, snapshot retrieval or shutdown.
  const deadline = setTimeout(() => {
    writeSync(2, JSON.stringify({ status: 'incomplete', code: 'SETTLEMENT_CHECK_UNAVAILABLE' }) + '\n');
    process.exit(2);
  }, 75_000);
  try {
    const db = await cardServiceDatabase('settlement');
    try {
      await verifyMigrations(db);
      await verifySettlementRole(db);
      const ledger = await readIssuerStatementLedger(db, statement.startMs, statement.endMs, requireClosedThroughMs);
      return matchIssuerStatement(statement, ledger);
    } finally { await db.close(); }
  } finally { clearTimeout(deadline); }
}
