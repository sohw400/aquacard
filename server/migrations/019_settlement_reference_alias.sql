-- One key per ledger; it travels with its backups. The settlement role can see
-- only the projected aliases. Original card event IDs and journal links stay intact.
CREATE TABLE settlement_reference_key (
  singleton BOOLEAN PRIMARY KEY CHECK (singleton),
  signing_key BYTEA NOT NULL CHECK (octet_length(signing_key) = 32)
);
REVOKE ALL ON settlement_reference_key FROM PUBLIC;
INSERT INTO settlement_reference_key(singleton, signing_key)
VALUES (true, sha256(uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid())));

CREATE FUNCTION private_settlement_reference(raw_id TEXT, id_kind TEXT, inner_pad BYTEA, outer_pad BYTEA)
RETURNS TEXT LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE
  message BYTEA;
BEGIN
  IF raw_id IS NULL OR raw_id COLLATE "C" !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      OR id_kind NOT IN ('event', 'payment') THEN
    RAISE EXCEPTION 'STATEMENT_LEDGER_INCONSISTENT' USING ERRCODE = '22000';
  END IF;
  IF raw_id COLLATE "C" !~ '(^|[^0-9])[0-9]{13,19}($|[^0-9])'
      AND raw_id COLLATE "C" !~ '(^|[^0-9])([0-9]{4}[-:._][0-9]{4}[-:._][0-9]{4}[-:._][0-9]{1,4}|[0-9]{4}[-:._][0-9]{6}[-:._][0-9]{5})($|[^0-9])' THEN
    RETURN raw_id;
  END IF;
  message := convert_to('AquaCard/settlement-reference/v1/' || id_kind || ':' || raw_id, 'UTF8');
  RETURN CASE WHEN id_kind = 'event' THEN '~e1.' ELSE '~p1.' END
    || encode(sha256(outer_pad || sha256(inner_pad || message)), 'hex');
END;
$$;
REVOKE ALL ON FUNCTION private_settlement_reference(TEXT, TEXT, BYTEA, BYTEA) FROM PUBLIC;

CREATE OR REPLACE FUNCTION issuer_statement_postings(p_start_ms BIGINT, p_end_ms BIGINT)
RETURNS TABLE(event_id TEXT, payment_id TEXT, kind TEXT, amount_won TEXT)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
  posting RECORD;
  signing_key BYTEA;
  inner_pad BYTEA := decode(repeat('36', 64), 'hex');
  outer_pad BYTEA := decode(repeat('5c', 64), 'hex');
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

  -- RFC 2104 HMAC-SHA-256. Build the padded key once per day, outside the row loop.
  SELECT k.signing_key INTO STRICT signing_key FROM settlement_reference_key k WHERE k.singleton;
  FOR i IN 0..31 LOOP
    inner_pad := set_byte(inner_pad, i, get_byte(signing_key, i) # 54);
    outer_pad := set_byte(outer_pad, i, get_byte(signing_key, i) # 92);
  END LOOP;

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
    event_id := private_settlement_reference(posting.card_event_id, 'event', inner_pad, outer_pad);
    payment_id := private_settlement_reference(posting.card_payment_id, 'payment', inner_pad, outer_pad);
    kind := posting.direction;
    amount_won := posting.gross::text;
    RETURN NEXT;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION issuer_statement_postings(BIGINT, BIGINT) FROM PUBLIC;
