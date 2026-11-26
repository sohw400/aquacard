// Committed card events, customer-facing payment totals and monetary journals are
// independent records. Keep both directions of settlement gross until the final
// control balance so one capture or refund cannot conceal another.
export const CARD_SETTLEMENT_FINDINGS_SQL = `WITH
card_events AS MATERIALIZED (
  SELECT e.event_id, e.payment_id, e.kind,
    CASE WHEN v.amount BETWEEN 1 AND 9007199254740991 AND v.amount = trunc(v.amount) THEN trunc(v.amount) END AS amount_won
  FROM card_payment_events e
  CROSS JOIN LATERAL (SELECT CASE WHEN jsonb_typeof(e.canonical_input->'amountWon') = 'number'
    THEN (e.canonical_input->>'amountWon')::numeric END AS amount) v
),
event_totals AS (
  SELECT payment_id, kind, COUNT(*) AS event_count,
    CASE WHEN COUNT(amount_won) = COUNT(*) THEN SUM(amount_won) END AS amount_won
  FROM card_events WHERE kind IN ('authorize', 'capture', 'refund') GROUP BY payment_id, kind
),
settlement_postings AS MATERIALIZED (
  SELECT id, card_payment_id AS payment_id, card_event_id AS event_id,
    CASE WHEN to_account_id = 'system:card_settlement' THEN amount_won ELSE 0 END AS captured,
    CASE WHEN from_account_id = 'system:card_settlement' THEN amount_won ELSE 0 END AS refunded
  FROM journals WHERE from_account_id = 'system:card_settlement' OR to_account_id = 'system:card_settlement'
),
payment_postings AS (
  SELECT payment_id, SUM(captured) AS captured, SUM(refunded) AS refunded
  FROM settlement_postings GROUP BY payment_id
),
event_postings AS (
  SELECT event_id, payment_id, SUM(captured) AS captured, SUM(refunded) AS refunded
  FROM settlement_postings GROUP BY event_id, payment_id
)
SELECT v.code, p.id AS reference,
  (CASE WHEN e.payment_id IS NULL THEN 0 ELSE e.amount_won END)::text AS expected, v.actual::text
FROM card_payments p CROSS JOIN LATERAL (VALUES
  ('CARD_EVENT_AUTHORIZED_MISMATCH', 'authorize', p.authorized_won),
  ('CARD_EVENT_CAPTURED_MISMATCH', 'capture', p.captured_won),
  ('CARD_EVENT_REFUNDED_MISMATCH', 'refund', p.refunded_won)
) v(code, kind, actual)
LEFT JOIN event_totals e ON e.payment_id = p.id AND e.kind = v.kind
WHERE (CASE WHEN e.payment_id IS NULL THEN 0 ELSE e.amount_won END) <> v.actual
UNION ALL
SELECT 'CARD_EVENT_AUTHORIZATION_COUNT_MISMATCH', p.id, '1', COALESCE(e.event_count, 0)::text
FROM card_payments p LEFT JOIN event_totals e ON e.payment_id = p.id AND e.kind = 'authorize'
WHERE COALESCE(e.event_count, 0) <> 1
UNION ALL
SELECT v.code, p.id, v.expected::text, v.actual::text
FROM card_payments p LEFT JOIN payment_postings b ON b.payment_id = p.id
CROSS JOIN LATERAL (VALUES
  ('CARD_SETTLEMENT_CAPTURED_MISMATCH', COALESCE(b.captured, 0), p.captured_won),
  ('CARD_SETTLEMENT_REFUNDED_MISMATCH', COALESCE(b.refunded, 0), p.refunded_won)
) v(code, expected, actual) WHERE v.expected <> v.actual
UNION ALL
SELECT v.code, e.event_id, v.expected::text, v.actual::text
FROM card_events e LEFT JOIN event_postings b ON b.event_id = e.event_id AND b.payment_id = e.payment_id
CROSS JOIN LATERAL (VALUES
  ('CARD_EVENT_SETTLEMENT_CAPTURED_MISMATCH', CASE WHEN e.kind = 'capture' THEN e.amount_won ELSE 0 END, COALESCE(b.captured, 0)),
  ('CARD_EVENT_SETTLEMENT_REFUNDED_MISMATCH', CASE WHEN e.kind = 'refund' THEN e.amount_won ELSE 0 END, COALESCE(b.refunded, 0))
) v(code, expected, actual) WHERE v.expected <> v.actual
UNION ALL
SELECT 'CARD_EVENT_AMOUNT_INVALID', event_id, 'positive whole TEST_KRW amount', 'invalid or missing'
FROM card_events WHERE kind IN ('authorize', 'capture', 'refund') AND amount_won IS NULL
UNION ALL
SELECT 'CARD_SETTLEMENT_EVENT_LINK_MISMATCH', b.id, 'matching card event and payment', 'missing'
FROM settlement_postings b WHERE NOT EXISTS (
  SELECT 1 FROM card_events e WHERE e.event_id = b.event_id AND e.payment_id = b.payment_id
)
UNION ALL
SELECT 'CARD_SETTLEMENT_BALANCE_MISMATCH', 'system:card_settlement', p.net::text, COALESCE(a.balance_won::text, 'missing')
FROM (SELECT COALESCE(SUM(captured_won::numeric - refunded_won), 0) AS net FROM card_payments) p
LEFT JOIN ledger_accounts a ON a.id = 'system:card_settlement'
WHERE a.balance_won IS DISTINCT FROM p.net`;
