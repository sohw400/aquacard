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
}

// Aggregate immutable history independently of application projection functions.
// All arithmetic stays NUMERIC/BIGINT in PostgreSQL and decimal text at the boundary.
const FINDINGS_SQL = `WITH
money_history AS MATERIALIZED (
  SELECT account_id, currency, SUM(amount_won) AS balance FROM journal_entries GROUP BY account_id, currency
),
reward_balances AS MATERIALIZED (
  SELECT user_id,
    SUM(CASE WHEN account_id = 'reward:' || user_id THEN amount_won ELSE 0 END) AS available,
    SUM(CASE WHEN account_id = 'reward_hold:' || user_id THEN amount_won ELSE 0 END) AS held,
    SUM(CASE WHEN account_id = 'reward_due:' || user_id THEN -amount_won ELSE 0 END) AS due
  FROM reward_entries WHERE user_id IS NOT NULL GROUP BY user_id
),
history_balances AS MATERIALIZED (
  SELECT user_id, SUM(available_delta_won) AS available, SUM(held_delta_won) AS held,
    SUM(adjustment_delta_won) AS due FROM reward_history GROUP BY user_id
),
allocation_holds AS MATERIALIZED (
  SELECT p.user_id,
    SUM(CASE WHEN a.payment_id IS NULL THEN p.held_won ELSE a.principal_held_won END) AS principal_held,
    SUM(COALESCE(a.reward_held_won, 0)) AS reward_held
  FROM card_payments p LEFT JOIN card_reward_allocations a ON a.payment_id = p.id GROUP BY p.user_id
),
month_allocations AS MATERIALIZED (
  SELECT user_id, month, SUM(cashback_pending_won) AS reserved,
    SUM(cashback_awarded_won) AS awarded, SUM(cashback_reversed_won) AS reversed
  FROM card_reward_allocations GROUP BY user_id, month
),
month_credits AS MATERIALIZED (
  SELECT j.user_id, a.month,
    SUM(CASE WHEN j.kind = 'cashback' THEN j.amount_won ELSE 0 END) AS awarded,
    SUM(CASE WHEN j.kind = 'cashback_reversal' THEN j.amount_won ELSE 0 END) AS reversed
  FROM reward_journals j JOIN card_reward_allocations a ON a.payment_id = j.payment_id
  WHERE j.kind IN ('cashback', 'cashback_reversal') GROUP BY j.user_id, a.month
),
allocation_history AS MATERIALIZED (
  SELECT payment_id,
    SUM(CASE WHEN kind = 'card_authorize' THEN amount_won ELSE 0 END) AS authorized,
    SUM(CASE WHEN kind = 'card_capture' THEN amount_won ELSE 0 END) AS captured,
    SUM(CASE WHEN kind = 'card_release' THEN amount_won ELSE 0 END) AS released,
    SUM(CASE WHEN kind = 'card_refund' THEN amount_won ELSE 0 END) AS refunded,
    SUM(CASE WHEN kind = 'cashback' THEN amount_won ELSE 0 END) AS awarded,
    SUM(CASE WHEN kind = 'cashback_reversal' THEN amount_won ELSE 0 END) AS reversed,
    SUM(CASE WHEN kind = 'cashback' THEN -adjustment_delta_won ELSE 0 END) AS offset
  FROM reward_journals WHERE payment_id IS NOT NULL GROUP BY payment_id
),
findings AS (
  SELECT 'MONETARY_BALANCE_MISMATCH' AS code, a.id AS reference,
    COALESCE(h.balance, 0)::text AS expected, a.balance_won::text AS actual
  FROM ledger_accounts a LEFT JOIN money_history h ON h.account_id = a.id AND h.currency = a.currency
  WHERE a.balance_won <> COALESCE(h.balance, 0)
  UNION ALL
  SELECT 'MONETARY_ACCOUNT_MISSING', h.account_id, h.balance::text, 'missing'
  FROM money_history h LEFT JOIN ledger_accounts a ON a.id = h.account_id AND a.currency = h.currency
  WHERE a.id IS NULL
  UNION ALL
  SELECT 'MONETARY_JOURNAL_UNBALANCED', journal_id, '0', SUM(amount_won)::text
  FROM journal_entries GROUP BY journal_id HAVING SUM(amount_won) <> 0
  UNION ALL
  SELECT 'REWARD_WALLET_MISSING', u.id, 'present', 'missing'
  FROM users u LEFT JOIN reward_wallets w ON w.user_id = u.id WHERE w.user_id IS NULL
  UNION ALL
  SELECT v.code, w.user_id, v.expected::text, v.actual::text
  FROM reward_wallets w LEFT JOIN reward_balances r ON r.user_id = w.user_id
  CROSS JOIN LATERAL (VALUES
    ('REWARD_AVAILABLE_MISMATCH', COALESCE(r.available, 0), w.available_won),
    ('REWARD_HELD_MISMATCH', COALESCE(r.held, 0), w.held_won),
    ('REWARD_ADJUSTMENT_MISMATCH', COALESCE(r.due, 0), w.adjustment_due_won)
  ) v(code, expected, actual) WHERE v.expected <> v.actual
  UNION ALL
  SELECT 'REWARD_HISTORY_OWNER_MISSING', r.user_id, 'present', 'missing'
  FROM reward_balances r LEFT JOIN reward_wallets w ON w.user_id = r.user_id WHERE w.user_id IS NULL
  UNION ALL
  SELECT v.code, w.user_id, v.expected::text, v.actual::text
  FROM reward_wallets w LEFT JOIN history_balances h ON h.user_id = w.user_id
  CROSS JOIN LATERAL (VALUES
    ('REWARD_HISTORY_AVAILABLE_MISMATCH', COALESCE(h.available, 0), w.available_won),
    ('REWARD_HISTORY_HELD_MISMATCH', COALESCE(h.held, 0), w.held_won),
    ('REWARD_HISTORY_ADJUSTMENT_MISMATCH', COALESCE(h.due, 0), w.adjustment_due_won)
  ) v(code, expected, actual) WHERE v.expected <> v.actual
  UNION ALL
  SELECT 'REWARD_JOURNAL_UNBALANCED', journal_id, '0', SUM(amount_won)::text
  FROM reward_entries GROUP BY journal_id HAVING SUM(amount_won) <> 0
  UNION ALL
  SELECT 'REWARD_BACKING_MISMATCH', 'system:reward_backing', e.amount::text,
    CASE WHEN a.id IS NULL THEN 'missing' ELSE a.balance_won::text END
  FROM (SELECT COALESCE(SUM(available_won::numeric + held_won), 0) AS amount FROM reward_wallets) e
  LEFT JOIN ledger_accounts a ON a.id = 'system:reward_backing'
  WHERE a.id IS NULL OR e.amount <> a.balance_won
  UNION ALL
  SELECT 'CASHBACK_BACKING_MISMATCH', 'system:reward_cashback_reserved', e.amount::text,
    CASE WHEN a.id IS NULL THEN 'missing' ELSE a.balance_won::text END
  FROM (SELECT COALESCE(SUM(cashback_pending_won), 0) AS amount FROM card_reward_allocations) e
  LEFT JOIN ledger_accounts a ON a.id = 'system:reward_cashback_reserved'
  WHERE a.id IS NULL OR e.amount <> a.balance_won
  UNION ALL
  SELECT 'REWARD_PAYMENT_HOLD_MISMATCH', w.user_id, COALESCE(h.reward_held, 0)::text, w.held_won::text
  FROM reward_wallets w LEFT JOIN allocation_holds h ON h.user_id = w.user_id
  WHERE w.held_won <> COALESCE(h.reward_held, 0)
  UNION ALL
  SELECT 'PRINCIPAL_PAYMENT_HOLD_MISMATCH', u.id, COALESCE(h.principal_held, 0)::text,
    CASE WHEN a.id IS NULL THEN 'missing' ELSE a.balance_won::text END
  FROM users u LEFT JOIN allocation_holds h ON h.user_id = u.id
  LEFT JOIN ledger_accounts a ON a.id = 'hold:' || u.id AND a.user_id = u.id AND a.kind = 'user_card_hold'
  WHERE a.id IS NULL OR a.balance_won <> COALESCE(h.principal_held, 0)
  UNION ALL
  SELECT 'CARD_FUNDING_' || v.metric || '_MISMATCH', a.payment_id, v.expected::text, v.actual::text
  FROM card_reward_allocations a JOIN card_payments p ON p.id = a.payment_id
  CROSS JOIN LATERAL (VALUES
    ('AUTHORIZED', a.principal_authorized_won::numeric + a.reward_authorized_won, p.authorized_won),
    ('HELD', a.principal_held_won::numeric + a.reward_held_won, p.held_won),
    ('CAPTURED', a.principal_captured_won::numeric + a.reward_captured_won, p.captured_won),
    ('RELEASED', a.principal_released_won::numeric + a.reward_released_won, p.released_won),
    ('REFUNDED', a.principal_refunded_won::numeric + a.reward_refunded_won, p.refunded_won)
  ) v(metric, expected, actual) WHERE v.expected <> v.actual
  UNION ALL
  SELECT 'CARD_FUNDING_OWNER_MISMATCH', a.payment_id, p.user_id, a.user_id
  FROM card_reward_allocations a JOIN card_payments p ON p.id = a.payment_id WHERE p.user_id <> a.user_id
  UNION ALL
  SELECT 'CARD_REWARD_HISTORY_' || v.metric || '_MISMATCH', a.payment_id, v.expected::text, v.actual::text
  FROM card_reward_allocations a LEFT JOIN allocation_history h ON h.payment_id = a.payment_id
  CROSS JOIN LATERAL (VALUES
    ('AUTHORIZED', COALESCE(h.authorized, 0), a.reward_authorized_won),
    ('CAPTURED', COALESCE(h.captured, 0), a.reward_captured_won),
    ('RELEASED', COALESCE(h.released, 0), a.reward_released_won),
    ('REFUNDED', COALESCE(h.refunded, 0), a.reward_refunded_won),
    ('CASHBACK_AWARDED', COALESCE(h.awarded, 0), a.cashback_awarded_won),
    ('CASHBACK_REVERSED', COALESCE(h.reversed, 0), a.cashback_reversed_won),
    ('CASHBACK_OFFSET', COALESCE(h.offset, 0), a.cashback_offset_won)
  ) v(metric, expected, actual) WHERE v.expected <> v.actual
  UNION ALL
  SELECT 'CASHBACK_MONTH_' || v.metric || '_MISMATCH', COALESCE(m.user_id, a.user_id) || ':' || COALESCE(m.month, a.month),
    v.expected::text, v.actual::text
  FROM reward_cashback_months m FULL JOIN month_allocations a ON a.user_id = m.user_id AND a.month = m.month
  CROSS JOIN LATERAL (VALUES
    ('RESERVED', COALESCE(a.reserved, 0), COALESCE(m.reserved_won, 0)),
    ('AWARDED', COALESCE(a.awarded, 0), COALESCE(m.awarded_won, 0)),
    ('REVERSED', COALESCE(a.reversed, 0), COALESCE(m.reversed_won, 0))
  ) v(metric, expected, actual) WHERE v.expected <> v.actual
  UNION ALL
  SELECT 'CASHBACK_MONTH_LIMIT_EXCEEDED', user_id || ':' || month, '10000',
    (reserved_won::numeric + awarded_won - reversed_won)::text
  FROM reward_cashback_months WHERE reserved_won::numeric + awarded_won - reversed_won > 10000
  UNION ALL
  SELECT 'CASHBACK_HISTORY_' || v.metric || '_MISMATCH', COALESCE(m.user_id, c.user_id) || ':' || COALESCE(m.month, c.month),
    v.expected::text, v.actual::text
  FROM reward_cashback_months m FULL JOIN month_credits c ON c.user_id = m.user_id AND c.month = m.month
  CROSS JOIN LATERAL (VALUES
    ('AWARDED', COALESCE(c.awarded, 0), COALESCE(m.awarded_won, 0)),
    ('REVERSED', COALESCE(c.reversed, 0), COALESCE(m.reversed_won, 0))
  ) v(metric, expected, actual) WHERE v.expected <> v.actual
  UNION ALL
  SELECT 'CASHBACK_HISTORY_ALLOCATION_MISSING', j.id, 'present', 'missing'
  FROM reward_journals j LEFT JOIN card_reward_allocations a ON a.payment_id = j.payment_id
  WHERE j.kind IN ('cashback', 'cashback_reversal') AND a.payment_id IS NULL
  UNION ALL
  SELECT 'CASHBACK_AUTH_MONTH_MISMATCH', a.payment_id,
    to_char(to_timestamp(p.created_at / 1000.0) AT TIME ZONE 'Asia/Seoul', 'YYYY-MM'), a.month
  FROM card_reward_allocations a JOIN card_payments p ON p.id = a.payment_id
  WHERE a.month <> to_char(to_timestamp(p.created_at / 1000.0) AT TIME ZONE 'Asia/Seoul', 'YYYY-MM')
  UNION ALL
  SELECT 'CASHBACK_INITIAL_RESERVATION_EXCEEDED', payment_id,
    LEAST(10000::numeric, div(principal_authorized_won::numeric * rate_bps, 10000))::text,
    cashback_initial_reserved_won::text FROM card_reward_allocations
  WHERE cashback_initial_reserved_won > LEAST(10000::numeric, div(principal_authorized_won::numeric * rate_bps, 10000))
  UNION ALL
  SELECT 'CASHBACK_' || v.metric || '_MISMATCH', a.payment_id, v.expected::text, v.actual::text
  FROM card_reward_allocations a
  CROSS JOIN LATERAL (VALUES
    ('PENDING', CASE WHEN a.closed_at IS NULL THEN a.cashback_initial_reserved_won ELSE 0 END::numeric, a.cashback_pending_won::numeric),
    ('AWARD', CASE WHEN a.closed_at IS NULL THEN 0 ELSE LEAST(a.cashback_initial_reserved_won::numeric, div(a.cashback_eligible_won_at_close::numeric * a.rate_bps, 10000)) END, a.cashback_awarded_won::numeric),
    ('REVERSAL', CASE WHEN a.closed_at IS NULL OR a.cashback_eligible_won_at_close = 0 THEN 0
      ELSE div(a.cashback_awarded_won::numeric * (a.principal_refunded_won - a.principal_refunded_at_close), a.cashback_eligible_won_at_close) END, a.cashback_reversed_won::numeric)
  ) v(metric, expected, actual) WHERE v.expected IS DISTINCT FROM v.actual
  UNION ALL
  SELECT 'CASHBACK_CLOSE_BASIS_MISMATCH', payment_id,
    (principal_captured_won - principal_refunded_at_close)::text, cashback_eligible_won_at_close::text
  FROM card_reward_allocations WHERE closed_at IS NOT NULL
    AND cashback_eligible_won_at_close <> principal_captured_won - principal_refunded_at_close
  UNION ALL
  SELECT 'CASHBACK_CLOSE_STATE_MISMATCH', payment_id,
    CASE WHEN principal_held_won + reward_held_won = 0 THEN 'closed' ELSE 'open' END,
    CASE WHEN closed_at IS NULL THEN 'open' ELSE 'closed' END
  FROM card_reward_allocations
  WHERE (principal_held_won + reward_held_won = 0) IS DISTINCT FROM (closed_at IS NOT NULL)
)
SELECT code, reference, expected, actual, COUNT(*) OVER ()::text AS total_findings
FROM findings ORDER BY code, reference LIMIT $1`;

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
      (SELECT COUNT(*)::text FROM reward_cashback_months) AS cashback_months`);
    const { rows } = await client.query<FindingRow>(FINDINGS_SQL, [maxFindings]);
    const findingCount = rows[0]?.total_findings ?? '0';
    return {
      scope: 'internal_ledgers', ok: findingCount === '0', checkedAt: counts.checked_at.toISOString(),
      counts: { monetaryAccounts: counts.monetary_accounts, monetaryJournals: counts.monetary_journals,
        rewardWallets: counts.reward_wallets, rewardJournals: counts.reward_journals,
        cardAllocations: counts.card_allocations, cashbackMonths: counts.cashback_months },
      findingCount, findingsTruncated: BigInt(findingCount) > BigInt(rows.length),
      findings: rows.map(({ code, reference, expected, actual }) => ({ code, reference, expected, actual })),
    };
  }, { isolation: 'repeatable read' });
}
