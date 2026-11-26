import type { QueryResultRow } from 'pg';
import type { Database } from './database';

export interface ReconciliationFinding {
  code: string;
  reference: string;
  /** Exact decimal strings for amounts; missing records are explicitly marked. */
  expected: string;
  actual: string;
}

export interface RewardReconciliationReport {
  scope: 'internal_ledgers';
  ok: boolean;
  checkedAt: string;
  counts: Record<string, string>;
  findingCount: string;
  findingsTruncated: boolean;
  findings: ReconciliationFinding[];
}

interface FindingRow extends QueryResultRow, ReconciliationFinding { total_findings: string }
interface CountsRow extends QueryResultRow {
  checked_at: Date;
  monetary_accounts: string;
  monetary_journals: string;
  reward_wallets: string;
  reward_journals: string;
  card_allocations: string;
  cashback_months: string;
  card_payments: string;
  card_events: string;
}

/** Local book consistency only; this does not establish issuer, bank or custody balances. */
export async function reconcileRewards(database: Database, options: { maxFindings?: number } = {}): Promise<RewardReconciliationReport> {
  const maxFindings = options.maxFindings ?? 100;
  if (!Number.isSafeInteger(maxFindings) || maxFindings < 1 || maxFindings > 1_000) throw new Error('maxFindings must be between 1 and 1000.');
  return database.transaction(async (client) => {
    await client.query('SET TRANSACTION READ ONLY');
    await client.query("SET LOCAL statement_timeout = '30s'");
    const { rows: [counts] } = await client.query<CountsRow>(`SELECT transaction_timestamp() AS checked_at,
      (SELECT COUNT(*)::text FROM ledger_accounts) AS monetary_accounts,
      (SELECT COUNT(*)::text FROM journals) AS monetary_journals,
      (SELECT COUNT(*)::text FROM reward_wallets) AS reward_wallets,
      (SELECT COUNT(*)::text FROM reward_journals) AS reward_journals,
      (SELECT COUNT(*)::text FROM card_reward_allocations) AS card_allocations,
      (SELECT COUNT(*)::text FROM reward_cashback_months) AS cashback_months,
      (SELECT COUNT(*)::text FROM card_payments) AS card_payments,
      (SELECT COUNT(*)::text FROM card_payment_events) AS card_events`);
    const { rows } = await client.query<FindingRow>(`SELECT code, reference, expected, actual,
      COUNT(*) OVER ()::text AS total_findings FROM internal_ledger_findings()
      ORDER BY code, reference LIMIT $1`, [maxFindings]);
    const findingCount = rows[0]?.total_findings ?? '0';
    return {
      scope: 'internal_ledgers', ok: findingCount === '0', checkedAt: counts.checked_at.toISOString(),
      counts: { monetaryAccounts: counts.monetary_accounts, monetaryJournals: counts.monetary_journals,
        rewardWallets: counts.reward_wallets, rewardJournals: counts.reward_journals,
        cardAllocations: counts.card_allocations, cashbackMonths: counts.cashback_months,
        cardPayments: counts.card_payments, cardPaymentEvents: counts.card_events },
      findingCount, findingsTruncated: BigInt(findingCount) > BigInt(rows.length),
      findings: rows.map(({ code, reference, expected, actual }) => ({ code, reference, expected, actual })),
    };
  }, { isolation: 'repeatable read' });
}
