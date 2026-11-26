-- Limit recurring scans to actionable work and the terminal states being measured.
CREATE INDEX card_inbox_recent_failures ON card_event_inbox(updated_at)
  WHERE status = 'dead_letter';
CREATE INDEX card_inbox_waiting_review ON card_event_inbox(updated_at)
  WHERE status = 'dead_letter' AND card_inbox_retryable(last_error_code);
CREATE INDEX issuer_outbox_terminal ON issuer_outbox(status, updated_at) WHERE status IN ('failed', 'needs_review');
CREATE INDEX auth_mail_recent_failures ON auth_mail_outbox(updated_at)
  WHERE status = 'failed' OR (status = 'discarded' AND error_code = 'DELIVERY_EXPIRED');

CREATE FUNCTION read_queue_health(p_now BIGINT) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE snapshot JSONB;
BEGIN
  IF p_now IS NULL OR p_now NOT BETWEEN 0 AND 8640000000000000 THEN
    RAISE EXCEPTION 'INVALID_QUEUE_MONITOR_TIME' USING ERRCODE = '22023';
  END IF;

  -- Match the worker's card_inbox_next_in_lane predecessor rule. Due successors
  -- may be waiting for a retry or an operator, even when their own time has come.
  WITH card_due AS MATERIALIZED (
    SELECT i.next_attempt_at,
      i.canonical_input->>'kind' IN ('capture', 'reverse') AND EXISTS (
        SELECT 1 FROM card_event_inbox earlier
        WHERE earlier.payment_id = i.payment_id AND earlier.user_id = i.user_id
          AND earlier.arrival_sequence < i.arrival_sequence
          AND earlier.canonical_input->>'kind' = 'capture' AND earlier.status <> 'applied'
      ) AS blocked
    FROM card_event_inbox i
    WHERE i.status IN ('pending', 'retry') AND i.next_attempt_at <= p_now
  ), issuer_due AS (
    SELECT next_attempt_at AS due_at FROM issuer_outbox
      WHERE status IN ('pending', 'retry') AND next_attempt_at <= p_now
    UNION ALL
    SELECT lease_until FROM issuer_outbox WHERE status = 'in_flight' AND lease_until <= p_now
  ), mail_due AS (
    SELECT greatest(next_attempt_at, lease_until) AS due_at FROM auth_mail_outbox
    WHERE status IN ('pending', 'retry', 'in_flight') AND next_attempt_at <= p_now
      AND (status <> 'in_flight' OR lease_until <= p_now)
  ), stats(queue, due, oldest, failed, review, blocked) AS (
    SELECT 'cardInbox', count(*) FILTER (WHERE NOT blocked), min(next_attempt_at) FILTER (WHERE NOT blocked),
      -- A policy decline has its own immutable decision, including for customers
      -- with unverified email. A financial authorization may also be unfunded.
      (SELECT count(*) FROM card_event_inbox i WHERE i.status = 'dead_letter'
        AND i.updated_at > p_now - 900000 AND i.updated_at <= p_now
        AND NOT (i.canonical_input->>'kind' = 'authorize' AND (i.last_error_code = 'INSUFFICIENT_FUNDS' OR EXISTS (
          SELECT 1 FROM card_authorization_decisions d
          WHERE d.event_id = i.event_id AND d.decision = 'declined' AND d.reason = i.last_error_code
        )))),
      (SELECT count(*) FROM card_event_inbox WHERE status = 'dead_letter' AND card_inbox_retryable(last_error_code)),
      count(*) FILTER (WHERE blocked) FROM card_due
    UNION ALL
    SELECT 'issuerOutbox', count(*), min(due_at),
      (SELECT count(*) FROM issuer_outbox WHERE status = 'failed' AND updated_at > p_now - 900000 AND updated_at <= p_now),
      (SELECT count(*) FROM issuer_outbox WHERE status = 'needs_review'),
      0 FROM issuer_due
    UNION ALL
    SELECT 'authMail', count(*), min(due_at),
      (SELECT count(*) FROM auth_mail_outbox WHERE (status = 'failed' OR (status = 'discarded' AND error_code = 'DELIVERY_EXPIRED'))
        AND updated_at > p_now - 900000 AND updated_at <= p_now),
      0, 0 FROM mail_due
  )
  SELECT jsonb_object_agg(queue, jsonb_build_object(
    'dueCount', due, 'oldestDueSeconds', coalesce((p_now - oldest) / 1000, 0),
    'recentFailures', failed, 'needsReview', review, 'blockedCount', blocked
  )) INTO snapshot FROM stats;
  RETURN snapshot;
END;
$$;
REVOKE ALL ON FUNCTION read_queue_health(bigint) FROM PUBLIC;
