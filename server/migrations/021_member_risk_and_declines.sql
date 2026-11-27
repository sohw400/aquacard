-- Transfer risk is independent of access approval and email ownership. An account
-- with no decision uses the standard limits, including the existing new-account cap.
CREATE TABLE customer_transfer_risk_events (
  user_id TEXT NOT NULL REFERENCES customer_access(user_id) ON DELETE RESTRICT,
  version BIGINT NOT NULL CHECK(version BETWEEN 1 AND 9007199254740991),
  tier TEXT NOT NULL CHECK(tier IN ('standard','high')),
  case_ref TEXT NOT NULL CHECK(case_ref ~ '^[A-Za-z][A-Za-z0-9._:-]{2,79}$'),
  idempotency_key TEXT NOT NULL CHECK(idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  actor TEXT NOT NULL,
  created_at BIGINT NOT NULL CHECK(created_at BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY(user_id,version), UNIQUE(user_id,idempotency_key)
);
CREATE TRIGGER customer_transfer_risk_immutable BEFORE UPDATE OR DELETE ON customer_transfer_risk_events
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_history_change();
CREATE TRIGGER customer_transfer_risk_no_truncate BEFORE TRUNCATE ON customer_transfer_risk_events
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_reject_history_change();

CREATE FUNCTION customer_transfer_limited(p_user TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
  SELECT COALESCE((SELECT tier='high' FROM customer_transfer_risk_events
    WHERE user_id=p_user ORDER BY version DESC LIMIT 1),false);
$$;

CREATE FUNCTION operator_read_transfer_risk(p_user TEXT) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE prior customer_transfer_risk_events%ROWTYPE;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM customer_access WHERE user_id=p_user) THEN RAISE EXCEPTION 'CUSTOMER_ACCESS_NOT_FOUND'; END IF;
  SELECT * INTO prior FROM customer_transfer_risk_events WHERE user_id=p_user ORDER BY version DESC LIMIT 1;
  RETURN jsonb_build_object('tier',coalesce(prior.tier,'standard'),'version',coalesce(prior.version,0),'updatedAt',prior.created_at);
END;
$$;

CREATE FUNCTION operator_set_transfer_risk(p_input JSONB,p_now BIGINT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE uid TEXT; requested TEXT; prior customer_transfer_risk_events%ROWTYPE; current_version BIGINT; observed_at BIGINT;
BEGIN
  IF p_input IS NULL OR jsonb_typeof(p_input) IS DISTINCT FROM 'object'
     OR NOT (p_input ?& ARRAY['userId','tier','expectedVersion','idempotencyKey','caseRef'])
     OR p_input - ARRAY['userId','tier','expectedVersion','idempotencyKey','caseRef'] <> '{}'::jsonb
     OR jsonb_typeof(p_input->'userId') IS DISTINCT FROM 'string' OR (p_input->>'userId') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
     OR jsonb_typeof(p_input->'tier') IS DISTINCT FROM 'string' OR (p_input->>'tier') NOT IN ('standard','high')
     OR jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR (p_input->>'expectedVersion') !~ '^(0|[1-9][0-9]{0,15})$'
     OR jsonb_typeof(p_input->'idempotencyKey') IS DISTINCT FROM 'string' OR (p_input->>'idempotencyKey') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
     OR jsonb_typeof(p_input->'caseRef') IS DISTINCT FROM 'string' OR (p_input->>'caseRef') !~ '^[A-Za-z][A-Za-z0-9._:-]{2,79}$'
     OR p_now IS NULL OR p_now NOT BETWEEN 0 AND 8640000000000000 THEN RAISE EXCEPTION 'INVALID_CUSTOMER_ACCESS_COMMAND'; END IF;
  uid := p_input->>'userId'; requested := p_input->>'tier';
  -- Transfers hold this same eligibility row FOR SHARE until their journal commits.
  PERFORM 1 FROM customer_access WHERE user_id=uid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CUSTOMER_ACCESS_NOT_FOUND'; END IF;
  SELECT * INTO prior FROM customer_transfer_risk_events WHERE user_id=uid AND idempotency_key=p_input->>'idempotencyKey';
  IF FOUND THEN
    IF prior.version - 1 <> (p_input->>'expectedVersion')::bigint OR prior.tier <> requested OR prior.case_ref <> p_input->>'caseRef' OR prior.actor <> session_user THEN
      RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT';
    END IF;
    RETURN jsonb_build_object('tier',prior.tier,'version',prior.version,'updatedAt',prior.created_at);
  END IF;
  SELECT version,created_at INTO current_version,observed_at FROM customer_transfer_risk_events WHERE user_id=uid ORDER BY version DESC LIMIT 1;
  current_version:=coalesce(current_version,0);
  IF current_version <> (p_input->>'expectedVersion')::bigint THEN RAISE EXCEPTION 'CUSTOMER_ACCESS_VERSION_CHANGED'; END IF;
  IF current_version >= 9007199254740991 THEN RAISE EXCEPTION 'CUSTOMER_ACCESS_CAPACITY'; END IF;
  INSERT INTO customer_transfer_risk_events(user_id,version,tier,case_ref,idempotency_key,actor,created_at)
    VALUES(uid,current_version+1,requested,p_input->>'caseRef',p_input->>'idempotencyKey',session_user,greatest(p_now,observed_at))
    RETURNING * INTO prior;
  RETURN jsonb_build_object('tier',prior.tier,'version',prior.version,'updatedAt',prior.created_at);
END;
$$;

-- Always hash references before returning them, including the seek key. The
-- account-facing query exposes no merchant, payment ID, raw payload or risk reason.
CREATE INDEX member_declined_decision_day ON card_authorization_decisions(user_id,decided_at DESC) WHERE decision='declined';
CREATE FUNCTION member_card_declines(p_user TEXT,p_before BIGINT,p_cursor TEXT,p_limit INTEGER)
RETURNS TABLE(id TEXT,created_at BIGINT,reason TEXT)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
BEGIN
  IF p_user IS NULL OR p_user !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 26
    OR (p_before IS NULL) <> (p_cursor IS NULL) OR p_before NOT BETWEEN 0 AND 8640000000000000
    OR p_cursor !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'INVALID_DECLINE_PAGE' USING ERRCODE='22023'; END IF;
  RETURN QUERY SELECT page.ref,page.at,page.msg FROM (
    SELECT encode(sha256(convert_to(length(p_user)::text || ':' || p_user || ':' || d.event_id,'UTF8')),'hex') AS ref, d.decided_at AS at,
      CASE d.reason WHEN 'CARD_LOCKED' THEN 'card_locked' WHEN 'CARD_NOT_ISSUED' THEN 'card_unavailable'
           WHEN 'EMAIL_VERIFICATION_REQUIRED' THEN 'email_verification' ELSE 'unavailable' END AS msg
      FROM card_authorization_decisions d WHERE d.user_id=p_user AND d.decision='declined'
        AND (p_before IS NULL OR d.decided_at<=p_before)
  ) page WHERE p_before IS NULL OR (page.at,page.ref COLLATE "C") < (p_before,p_cursor COLLATE "C")
  ORDER BY page.at DESC,page.ref COLLATE "C" DESC LIMIT p_limit;
END;
$$;
REVOKE ALL ON TABLE customer_transfer_risk_events FROM PUBLIC;
REVOKE ALL ON FUNCTION customer_transfer_limited(text),operator_read_transfer_risk(text),
  operator_set_transfer_risk(jsonb,bigint),member_card_declines(text,bigint,text,integer) FROM PUBLIC;
