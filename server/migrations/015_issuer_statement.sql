-- Both arms of journal_entries can use this index when looking up a settlement day.
CREATE INDEX journals_card_settlement_day ON journals (created_at)
  WHERE from_account_id = 'system:card_settlement' OR to_account_id = 'system:card_settlement';

CREATE FUNCTION issuer_statement_postings(p_start_ms BIGINT, p_end_ms BIGINT)
RETURNS TABLE(event_id TEXT, payment_id TEXT, kind TEXT, amount_won TEXT)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
  posting RECORD;
  reference_id TEXT;
  row_count INTEGER := 0;
BEGIN
  IF p_start_ms IS NULL OR p_end_ms IS NULL OR p_end_ms::numeric - p_start_ms <> 86400000
     OR mod(p_start_ms::numeric + 32400000, 86400000) <> 0
     OR p_end_ms > extract(epoch FROM transaction_timestamp()) * 1000 THEN
    RAISE EXCEPTION 'STATEMENT_WINDOW_INVALID' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM ledger_accounts a WHERE a.id = 'system:card_settlement'
      AND a.kind = 'sandbox_card_settlement' AND a.currency = 'TEST_KRW') THEN
    RAISE EXCEPTION 'STATEMENT_LEDGER_INCONSISTENT' USING ERRCODE = '22000';
  END IF;

  FOR posting IN
    WITH grouped AS (
      SELECT j.card_event_id, j.card_payment_id,
        CASE WHEN leg.amount_won > 0 THEN 'capture' ELSE 'refund' END AS direction,
        sum(abs(leg.amount_won::numeric)) AS gross,
        bool_and(leg.currency = 'TEST_KRW') AS valid_currency
      FROM journal_entries leg JOIN journals j ON j.id = leg.journal_id
      WHERE leg.account_id = 'system:card_settlement'
        AND leg.created_at >= p_start_ms AND leg.created_at < p_end_ms
      GROUP BY j.card_event_id, j.card_payment_id, direction
    )
    SELECT g.*, e.event_id IS NOT NULL AS has_event,
      e.payment_id = g.card_payment_id AND e.kind = g.direction AS valid_link,
      count(*) OVER (PARTITION BY g.card_event_id) AS groups_per_event
    FROM grouped g LEFT JOIN card_payment_events e ON e.event_id = g.card_event_id
    ORDER BY g.card_event_id COLLATE "C", g.card_payment_id COLLATE "C", g.direction
    LIMIT 10001
  LOOP
    row_count := row_count + 1;
    IF row_count > 10000 THEN
      RAISE EXCEPTION 'STATEMENT_LEDGER_CAPACITY' USING ERRCODE = '54000';
    END IF;
    -- Conflicting representable groups reach the matcher as a duplicate event.
    -- A single orphan, wrong payment or wrong direction cannot produce a clean day.
    IF NOT posting.has_event OR NOT posting.valid_currency
        OR (posting.groups_per_event = 1 AND posting.valid_link IS DISTINCT FROM TRUE)
        OR posting.gross NOT BETWEEN 1 AND 9007199254740991 THEN
      RAISE EXCEPTION 'STATEMENT_LEDGER_INCONSISTENT' USING ERRCODE = '22000';
    END IF;
    -- Restrict references at the privilege boundary even for direct SQL callers.
    FOREACH reference_id IN ARRAY ARRAY[posting.card_event_id, posting.card_payment_id] LOOP
      IF reference_id IS NULL OR reference_id COLLATE "C" !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
          OR reference_id COLLATE "C" ~ '(^|[^0-9])[0-9]{13,19}($|[^0-9])'
          OR reference_id COLLATE "C" ~ '(^|[^0-9])([0-9]{4}[-:._][0-9]{4}[-:._][0-9]{4}[-:._][0-9]{1,4}|[0-9]{4}[-:._][0-9]{6}[-:._][0-9]{5})($|[^0-9])' THEN
        RAISE EXCEPTION 'STATEMENT_LEDGER_INCONSISTENT' USING ERRCODE = '22000';
      END IF;
    END LOOP;
    event_id := posting.card_event_id;
    payment_id := posting.card_payment_id;
    kind := posting.direction;
    amount_won := posting.gross::text;
    RETURN NEXT;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION issuer_statement_postings(BIGINT, BIGINT) FROM PUBLIC;
