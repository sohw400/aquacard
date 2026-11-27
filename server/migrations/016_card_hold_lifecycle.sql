-- The sandbox term is captured on authorization. A deployment may change the
-- singleton for future approvals; old holds retain the deadline originally set.
CREATE TABLE sandbox_card_hold_policy (
  singleton BOOLEAN PRIMARY KEY CHECK (singleton),
  days SMALLINT NOT NULL CHECK (days BETWEEN 1 AND 30)
);
INSERT INTO sandbox_card_hold_policy VALUES (true,7);
CREATE TABLE card_hold_deadlines (
  payment_id TEXT PRIMARY KEY REFERENCES card_payments(id),
  expires_at BIGINT NOT NULL
);
INSERT INTO card_hold_deadlines
  SELECT id, least(created_at + 604800000, 8639999967600000) FROM card_payments;
CREATE INDEX card_payments_open_by_age ON card_payments(created_at,id) WHERE held_won>0;
CREATE FUNCTION record_sandbox_card_deadline() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
BEGIN
  INSERT INTO card_hold_deadlines(payment_id,expires_at)
    VALUES(NEW.id,least(NEW.created_at + (SELECT days::bigint*86400000 FROM sandbox_card_hold_policy WHERE singleton),8639999967600000));
  RETURN NEW;
END;
$$;
CREATE TRIGGER card_hold_deadline AFTER INSERT ON card_payments FOR EACH ROW EXECUTE FUNCTION record_sandbox_card_deadline();

CREATE TABLE card_hold_expirations (
  payment_id TEXT PRIMARY KEY REFERENCES card_hold_deadlines(payment_id),
  event_id TEXT NOT NULL UNIQUE REFERENCES card_payment_events(event_id),
  released_won BIGINT NOT NULL CHECK(released_won>0),
  expired_at BIGINT NOT NULL
);
CREATE TABLE card_capture_resolutions (
  inbox_id TEXT PRIMARY KEY REFERENCES card_event_inbox(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  evidence_ref TEXT NOT NULL CHECK(evidence_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  replacement_id TEXT UNIQUE REFERENCES card_event_inbox(id),
  inbox_version BIGINT NOT NULL,
  actor TEXT NOT NULL,
  resolved_at BIGINT NOT NULL
);
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['card_hold_deadlines','card_hold_expirations','card_capture_resolutions'] LOOP
    EXECUTE format('CREATE TRIGGER immutable_record BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION ledger_reject_history_change()',t);
    EXECUTE format('CREATE TRIGGER immutable_history BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION ledger_reject_history_change()',t);
  END LOOP;
END; $$;
CREATE OR REPLACE FUNCTION apply_sandbox_card_event(p_input JSONB,p_now BIGINT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE input JSONB; event_key TEXT; uid TEXT; k TEXT; reason_code TEXT; answer JSONB; command_state TEXT;
  d card_authorization_decisions%ROWTYPE; e card_payment_events%ROWTYPE; c issuer_cards%ROWTYPE; access customer_access%ROWTYPE; verified BIGINT;
  prior_context TEXT:=current_setting('aqua.card_authorization_event_id',true);
BEGIN
  IF p_now IS NULL OR p_now NOT BETWEEN 0 AND 8639999967600000 THEN RAISE EXCEPTION 'INVALID_CARD_EVENT' USING ERRCODE='22023'; END IF;
  input:=reward_card_canonical(p_input); event_key:=input->>'eventId'; uid:=input->>'userId'; k:=input->>'kind';
  -- One global event identity spans approvals, denials, and settlement kinds.
  -- Hash collisions only serialize unrelated work; they cannot share a result.
  PERFORM pg_advisory_xact_lock(hashtextextended(current_schema()||':aqua:card-event:'||event_key,0));
  SELECT * INTO d FROM card_authorization_decisions WHERE event_id=event_key;
  IF FOUND THEN
    IF d.canonical_input IS DISTINCT FROM input THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
    RETURN d.result;
  END IF;
  SELECT * INTO e FROM card_payment_events WHERE event_id=event_key;
  IF FOUND THEN
    IF e.canonical_input IS DISTINCT FROM input THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
    IF e.result IS NULL THEN RAISE EXCEPTION 'CARD_STATE_CONFLICT'; END IF;
    RETURN e.result;
  END IF;
  IF k='capture' THEN
    -- The exact replay above is still valid after the original deadline.
    -- A fresh capture and the expiry worker serialize before locking money.
    PERFORM terms.payment_id FROM card_hold_deadlines terms JOIN card_payments p ON p.id=terms.payment_id
      WHERE terms.payment_id=input->>'paymentId' AND p.user_id=uid FOR SHARE OF terms;
    IF FOUND AND (EXISTS (SELECT 1 FROM card_hold_deadlines terms WHERE terms.payment_id=input->>'paymentId' AND p_now>=terms.expires_at)
        OR EXISTS (SELECT 1 FROM card_hold_expirations x WHERE x.payment_id=input->>'paymentId')) THEN
      RAISE EXCEPTION 'CARD_HOLD_EXPIRED';
    END IF;
  END IF;
  IF k<>'authorize' THEN RETURN apply_sandbox_card_event_financial_004(input,p_now); END IF;
  -- Registration owns the same member lock, including when no card exists yet.
  -- NO KEY UPDATE remains compatible with the outbox's foreign-key checks.
  PERFORM id FROM users WHERE id=uid FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'USER_NOT_FOUND'; END IF;
  SELECT email_verified_at INTO verified FROM users WHERE id=uid;
  SELECT * INTO access FROM customer_access WHERE user_id=uid FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CUSTOMER_ACCESS_REQUIRED'; END IF;
  SELECT * INTO c FROM issuer_cards WHERE user_id=uid FOR NO KEY UPDATE;
  IF NOT FOUND THEN reason_code:='CARD_NOT_ISSUED';
  ELSE
    SELECT status INTO command_state FROM issuer_outbox WHERE id=c.last_command_id;
    IF access.status<>'active' THEN reason_code:='CUSTOMER_ACCESS_REQUIRED';
    ELSIF verified IS NULL THEN reason_code:='EMAIL_VERIFICATION_REQUIRED';
    ELSIF c.desired_status='locked' OR c.confirmed_status='locked' THEN reason_code:='CARD_LOCKED';
    ELSIF c.last_command_id IS NOT NULL AND command_state IS DISTINCT FROM 'succeeded' THEN reason_code:='CARD_STATUS_UNCONFIRMED';
    END IF;
  END IF;
  IF reason_code IS NULL THEN answer:=apply_sandbox_card_event_financial_004(input,p_now);
  ELSE answer:=jsonb_build_object('declined',true,'code',reason_code);
  END IF;
  PERFORM set_config('aqua.card_authorization_event_id',event_key,true);
  INSERT INTO card_authorization_decisions(event_id,payment_id,user_id,canonical_input,decision,reason,result,policy_version,
    card_id,card_version,desired_status,confirmed_status,command_id,command_status,event_received_at,decided_at,actor,customer_status,customer_version,email_verified_at)
  VALUES(event_key,input->>'paymentId',uid,input,CASE WHEN reason_code IS NULL THEN 'approved' ELSE 'declined' END,reason_code,answer,3,
    c.id,c.version,c.desired_status,c.confirmed_status,c.last_command_id,command_state,p_now,
    floor(extract(epoch FROM clock_timestamp())*1000)::BIGINT,session_user,access.status,access.version,verified);
  PERFORM set_config('aqua.card_authorization_event_id',coalesce(prior_context,''),true);
  -- A denial must commit before a caller presents it as a domain error. Raising
  -- here would erase the decision and permit the same event after an unlock.
  RETURN answer;
END;
$$;

-- A concurrent committed pre-deadline delivery must be visible to the expiry
-- claim. A delivery that loses this race is recorded and sent to review.
CREATE FUNCTION lock_sandbox_card_deadline() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
BEGIN
  PERFORM 1 FROM card_hold_deadlines WHERE payment_id=NEW.payment_id FOR SHARE;
  RETURN NEW;
END;
$$;
CREATE TRIGGER card_capture_receipt_deadline BEFORE INSERT ON card_event_inbox FOR EACH ROW
  WHEN (NEW.canonical_input->>'kind' IN ('capture','reverse')) EXECUTE FUNCTION lock_sandbox_card_deadline();

CREATE FUNCTION operator_resolve_card_capture(p_input JSONB,p_now BIGINT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE i card_event_inbox%ROWTYPE; r card_capture_resolutions%ROWTYPE; replacement card_event_inbox%ROWTYPE;
  target TEXT; request_key TEXT; evidence TEXT; replacement_key TEXT; expected BIGINT;
BEGIN
  IF p_now IS NULL OR p_now NOT BETWEEN 0 AND 8639999967600000
    OR NOT issuer_outbox_object(p_input,ARRAY['id','expectedVersion','idempotencyKey','evidenceRef','replacementId'])
    OR NOT issuer_outbox_text(p_input,'id','^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    OR NOT issuer_outbox_text(p_input,'idempotencyKey','^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
    OR NOT issuer_outbox_text(p_input,'evidenceRef','^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
    OR NOT (p_input->'replacementId'='null'::jsonb OR issuer_outbox_text(p_input,'replacementId','^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
    OR jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR (p_input->>'expectedVersion') !~ '^[0-9]{1,16}$'
    THEN RAISE EXCEPTION 'INVALID_INBOX_COMMAND' USING ERRCODE='22023'; END IF;
  target:=p_input->>'id'; expected:=(p_input->>'expectedVersion')::bigint; request_key:=p_input->>'idempotencyKey';
  evidence:=p_input->>'evidenceRef'; replacement_key:=p_input->>'replacementId';
  PERFORM pg_advisory_xact_lock(hashtextextended(current_schema()||':capture-resolution:'||request_key,0));
  SELECT * INTO r FROM card_capture_resolutions WHERE idempotency_key=request_key;
  IF FOUND THEN
    IF ROW(r.inbox_id,r.inbox_version,r.evidence_ref,r.replacement_id) IS DISTINCT FROM ROW(target,expected,evidence,replacement_key)
      THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
  ELSE
    PERFORM l.payment_id FROM card_inbox_lanes l JOIN card_event_inbox x ON x.payment_id=l.payment_id
      WHERE x.id=target FOR NO KEY UPDATE OF l;
    SELECT * INTO i FROM card_event_inbox WHERE id=target FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'INBOX_EVENT_NOT_FOUND'; END IF;
    IF i.version<>expected THEN RAISE EXCEPTION 'INBOX_VERSION_CHANGED'; END IF;
    IF i.status<>'dead_letter' OR i.canonical_input->>'kind'<>'capture' OR EXISTS(SELECT FROM card_capture_resolutions WHERE inbox_id=target)
      THEN RAISE EXCEPTION 'INBOX_STATE_CONFLICT'; END IF;
    IF replacement_key IS NOT NULL THEN
      IF EXISTS(SELECT FROM card_capture_resolutions WHERE replacement_id=replacement_key) THEN RAISE EXCEPTION 'INBOX_STATE_CONFLICT'; END IF;
      SELECT * INTO replacement FROM card_event_inbox WHERE id=replacement_key;
      IF NOT FOUND OR replacement.payment_id<>i.payment_id OR replacement.user_id<>i.user_id
        OR replacement.arrival_sequence<=i.arrival_sequence OR replacement.status<>'pending'
        OR replacement.canonical_input->>'kind' NOT IN ('capture','reverse')
        THEN RAISE EXCEPTION 'INBOX_STATE_CONFLICT'; END IF;
    END IF;
    INSERT INTO card_capture_resolutions VALUES(target,request_key,evidence,replacement_key,expected,session_user,p_now)
      RETURNING * INTO r;
  END IF;
  RETURN jsonb_build_object('id',r.inbox_id,'disposition',CASE WHEN r.replacement_id IS NULL THEN 'void' ELSE 'superseded' END,
    'replacementId',r.replacement_id,'evidenceRef',r.evidence_ref,'resolvedAt',r.resolved_at);
END;
$$;
CREATE FUNCTION prevent_resolved_capture_retry() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM card_capture_resolutions WHERE inbox_id=OLD.id) THEN RAISE EXCEPTION 'INBOX_NOT_RETRYABLE'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER card_capture_resolution_final BEFORE UPDATE ON card_event_inbox FOR EACH ROW
  WHEN (OLD.status='dead_letter') EXECUTE FUNCTION prevent_resolved_capture_retry();

CREATE FUNCTION card_hold_has_prior_delivery(p_payment TEXT,p_user TEXT,p_end BIGINT) RETURNS BOOLEAN
LANGUAGE sql STABLE SET search_path FROM CURRENT AS $$
  SELECT EXISTS(SELECT 1 FROM card_event_inbox i WHERE i.payment_id=p_payment AND i.user_id=p_user AND i.received_at<p_end
    AND ((i.canonical_input->>'kind'='capture' AND i.status<>'applied'
      AND NOT EXISTS(SELECT 1 FROM card_capture_resolutions r WHERE r.inbox_id=i.id))
      OR (i.canonical_input->>'kind'='reverse' AND i.status IN ('pending','retry'))));
$$;
CREATE FUNCTION expire_sandbox_card_hold(p_now BIGINT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE selected TEXT; uid TEXT; cutoff BIGINT; event_key TEXT; answer JSONB; released BIGINT;
BEGIN
  IF p_now IS NULL OR p_now NOT BETWEEN 0 AND 8639999967600000 THEN RAISE EXCEPTION 'INVALID_INBOX_COMMAND' USING ERRCODE='22023'; END IF;
  -- A fast worker host may not release a hold before the database clock.
  p_now:=least(p_now,floor(extract(epoch FROM statement_timestamp())*1000)::bigint);
  SELECT d.payment_id,p.user_id,d.expires_at INTO selected,uid,cutoff FROM card_payments p
    JOIN card_hold_deadlines d ON d.payment_id=p.id
    WHERE p.held_won>0 AND (p_now=8639999967600000 OR p.created_at<=p_now-86400000)
      AND d.expires_at<=p_now AND NOT card_hold_has_prior_delivery(p.id,p.user_id,d.expires_at)
    ORDER BY p.created_at,p.id FOR UPDATE OF d SKIP LOCKED LIMIT 1;
  IF NOT FOUND OR card_hold_has_prior_delivery(selected,uid,cutoff) THEN RETURN NULL; END IF;
  event_key:='hold-expiry-'||gen_random_uuid()::text;
  BEGIN
    answer:=apply_sandbox_card_event(jsonb_build_object('kind','reverse','eventId',event_key,'paymentId',selected,'userId',uid),p_now);
  EXCEPTION WHEN raise_exception THEN
    -- A direct sandbox command may have finalized this hold after the scan.
    IF SQLERRM='CARD_STATE_CONFLICT' AND EXISTS(SELECT 1 FROM card_payments WHERE id=selected AND held_won=0) THEN RETURN NULL; END IF;
    RAISE;
  END;
  released:=(answer->'payment'->>'releasedWon')::bigint;
  INSERT INTO card_hold_expirations VALUES(selected,event_key,released,p_now);
  -- Avoid placing payment and event identifiers in the periodic worker log.
  RETURN jsonb_build_object('paymentId',selected,'eventId',event_key,'releasedWon',released);
END;
$$;
REVOKE ALL ON FUNCTION record_sandbox_card_deadline(),lock_sandbox_card_deadline(),
  prevent_resolved_capture_retry(),card_hold_has_prior_delivery(text,text,bigint),operator_resolve_card_capture(jsonb,bigint),
  expire_sandbox_card_hold(bigint) FROM PUBLIC;

CREATE OR REPLACE FUNCTION card_inbox_next_in_lane(p_payment TEXT,p_now BIGINT)
RETURNS TABLE(id TEXT,next_attempt_at BIGINT,arrival_sequence BIGINT)
LANGUAGE sql STABLE SET search_path FROM CURRENT AS $$
  SELECT i.id,i.next_attempt_at,i.arrival_sequence FROM card_event_inbox i
    WHERE i.payment_id=p_payment AND i.status IN ('pending','retry') AND i.next_attempt_at<=p_now
      AND (i.canonical_input->>'kind' NOT IN ('capture','reverse') OR NOT EXISTS (
        SELECT 1 FROM card_event_inbox older WHERE older.payment_id=i.payment_id AND older.user_id=i.user_id
          AND older.arrival_sequence<i.arrival_sequence AND older.canonical_input->>'kind'='capture' AND older.status<>'applied'
          AND NOT EXISTS(SELECT 1 FROM card_capture_resolutions r WHERE r.inbox_id=older.id)
      ))
    ORDER BY i.next_attempt_at,i.arrival_sequence LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION process_card_inbox(p_now BIGINT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE i card_event_inbox%ROWTYPE; applied JSONB; failure TEXT; pg_state TEXT; message TEXT;
  lane_key TEXT; next_at BIGINT; next_status TEXT; attempt BIGINT; cycle INTEGER; retry BOOLEAN;
  prior_context TEXT:=current_setting('aqua.inbox_action',true);
  delays BIGINT[]:=ARRAY[1000,5000,15000,60000,300000,900000,3600000]::BIGINT[];
BEGIN
  IF p_now IS NULL OR p_now NOT BETWEEN 0 AND 8639999967600000 THEN RAISE EXCEPTION 'INVALID_INBOX_COMMAND' USING ERRCODE='22023'; END IF;
  -- Keep the existing payment-family arrival ordering and predecessor recovery.
  WITH due_lanes AS MATERIALIZED (
    SELECT DISTINCT payment_id FROM card_event_inbox WHERE status IN ('pending','retry') AND next_attempt_at<=p_now
  )
  SELECT l.payment_id INTO lane_key FROM due_lanes due JOIN card_inbox_lanes l ON l.payment_id=due.payment_id
    CROSS JOIN LATERAL card_inbox_next_in_lane(l.payment_id,p_now) candidate
    ORDER BY candidate.next_attempt_at,candidate.arrival_sequence
    FOR NO KEY UPDATE OF l SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT inbox.* INTO i FROM card_event_inbox inbox JOIN card_inbox_next_in_lane(lane_key,p_now) candidate ON candidate.id=inbox.id
    FOR UPDATE OF inbox;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF i.attempt_count=9007199254740991 OR i.version=9007199254740991 THEN RAISE EXCEPTION 'INBOX_CAPACITY'; END IF;
  attempt:=i.attempt_count+1; cycle:=i.cycle_attempts+1;
  PERFORM set_config('aqua.inbox_action','process',true);
  BEGIN
    applied:=apply_sandbox_card_event(i.canonical_input,i.received_at);
    -- Force both financial and policy integrity inside the failure subtransaction.
    SET CONSTRAINTS ALL IMMEDIATE;
    SET CONSTRAINTS ALL DEFERRED;
    IF applied->'declined'='true'::jsonb THEN
      failure:=applied->>'code';
      IF failure NOT IN ('CARD_NOT_ISSUED','CARD_LOCKED','CARD_STATUS_UNCONFIRMED','CUSTOMER_ACCESS_REQUIRED','EMAIL_VERIFICATION_REQUIRED') THEN
        RAISE EXCEPTION 'CARD_AUTHORIZATION_INCOMPLETE' USING ERRCODE='23514';
      END IF;
      -- Do not raise: the immutable denial and terminal inbox attempt commit
      -- together. These policy codes are absent from card_inbox_retryable.
      applied:=NULL;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS pg_state=RETURNED_SQLSTATE,message=MESSAGE_TEXT;
    applied:=NULL;
    IF pg_state IN ('55P03','40P01','40001') THEN failure:='DATABASE_BUSY';
    ELSIF message IN ('CARD_PAYMENT_NOT_FOUND','CARD_STATE_CONFLICT','REWARD_BUDGET_UNAVAILABLE','REWARD_BACKING_MISMATCH',
      'CARD_HOLD_EXPIRED','INVALID_CARD_EVENT','USER_NOT_FOUND','CARD_OWNER_MISMATCH','INSUFFICIENT_FUNDS','IDEMPOTENCY_CONFLICT',
      'RECIPIENT_BALANCE_LIMIT','LEDGER_CAPACITY','REWARD_BALANCE_LIMIT','REWARD_PROGRAM_INACTIVE') THEN failure:=message;
    ELSE failure:='INTERNAL_ERROR'; END IF;
  END;
  IF applied IS NOT NULL THEN next_status:='applied';
  ELSE
    retry:=card_inbox_retryable(failure) AND cycle<8;
    next_status:=CASE WHEN retry THEN 'retry' ELSE 'dead_letter' END;
    IF retry THEN next_at:=least(8639999967600000,p_now+delays[cycle]); END IF;
  END IF;
  UPDATE card_event_inbox SET status=next_status,attempt_count=attempt,cycle_attempts=cycle,version=version+1,
    last_error_code=failure,result=applied,next_attempt_at=next_at,processed_at=p_now,updated_at=greatest(updated_at,p_now)
    WHERE id=i.id RETURNING * INTO i;
  INSERT INTO card_inbox_attempts(inbox_id,attempt_no,cycle_attempt,version,attempted_at,status,error_code,next_attempt_at)
    VALUES(i.id,i.attempt_count,i.cycle_attempts,i.version,i.processed_at,i.status,i.last_error_code,i.next_attempt_at);
  PERFORM set_config('aqua.inbox_action',coalesce(prior_context,''),true);
  RETURN jsonb_build_object('id',i.id,'status',i.status,'attemptCount',i.attempt_count,'cycleAttempts',i.cycle_attempts,
    'version',i.version,'errorCode',i.last_error_code,'nextAttemptAt',i.next_attempt_at);
END;
$$;

CREATE OR REPLACE FUNCTION read_queue_health(p_now BIGINT) RETURNS JSONB
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
          AND NOT EXISTS(SELECT 1 FROM card_capture_resolutions r WHERE r.inbox_id=earlier.id)
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
      (SELECT count(*) FROM card_event_inbox i WHERE i.status = 'dead_letter' AND (card_inbox_retryable(i.last_error_code) OR i.last_error_code='CARD_HOLD_EXPIRED')
        AND NOT EXISTS(SELECT 1 FROM card_capture_resolutions r WHERE r.inbox_id=i.id)),
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

CREATE OR REPLACE FUNCTION prepare_card_operations_report(p_input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE input JSONB; request_key TEXT; event_key TEXT; source_count INTEGER; conflict BOOLEAN;
  report JSONB; authorization_report JSONB; ledger_event JSONB; inbox JSONB; payment JSONB; issuer_command JSONB;
  attempts JSONB; prepared BIGINT; r card_operations_reports%ROWTYPE;
  d card_authorization_decisions%ROWTYPE; e card_payment_events%ROWTYPE; i card_event_inbox%ROWTYPE;
  p card_payments%ROWTYPE; o issuer_outbox%ROWTYPE;
  prior_context TEXT:=current_setting('aqua.card_operations_request_id',true);
  failure TEXT; failure_state TEXT;
BEGIN
  input:=card_operations_canonical(p_input); request_key:=input->>'requestId';
  -- Enforce one MVCC view even for callers that bypass the supported CLI.
  IF current_setting('transaction_isolation') NOT IN ('repeatable read','serializable') THEN
    RAISE EXCEPTION 'OPS_SNAPSHOT_REQUIRED';
  END IF;
  SELECT * INTO r FROM card_operations_reports WHERE actor=session_user AND request_id=request_key;
  IF FOUND THEN
    IF r.canonical_input IS DISTINCT FROM input THEN RAISE EXCEPTION 'OPS_REQUEST_CONFLICT'; END IF;
    RETURN jsonb_build_object('requestId',r.request_id,'preparedAt',r.prepared_at,'duplicate',true);
  END IF;
  IF input->'lookup'->>'kind'='inbox' THEN
    SELECT * INTO i FROM card_event_inbox WHERE id=input->'lookup'->>'id';
    event_key:=i.event_id;
  ELSE
    event_key:=input->'lookup'->>'id';
    SELECT * INTO i FROM card_event_inbox WHERE source='sandbox' AND event_id=event_key;
  END IF;
  SELECT * INTO d FROM card_authorization_decisions WHERE event_id=event_key;
  SELECT * INTO e FROM card_payment_events WHERE event_id=event_key;
  source_count:=(d.event_id IS NOT NULL)::INTEGER+(e.event_id IS NOT NULL)::INTEGER+(i.id IS NOT NULL)::INTEGER;
  conflict:=(d.event_id IS NOT NULL AND e.event_id IS NOT NULL AND d.canonical_input IS DISTINCT FROM e.canonical_input)
    OR (d.event_id IS NOT NULL AND i.id IS NOT NULL AND d.canonical_input IS DISTINCT FROM i.canonical_input)
    OR (e.event_id IS NOT NULL AND i.id IS NOT NULL AND e.canonical_input IS DISTINCT FROM i.canonical_input);
  IF d.event_id IS NOT NULL THEN
    authorization_report:=jsonb_build_object('eventId',d.event_id,'paymentId',d.payment_id,'userId',d.user_id,
      'decision',d.decision,'reason',d.reason,'amountWon',d.canonical_input->'amountWon','policyVersion',d.policy_version,
      'eventReceivedAt',d.event_received_at,'decidedAt',d.decided_at,
      'customerAtDecision',CASE WHEN d.customer_status IS NULL THEN NULL ELSE
        jsonb_build_object('status',d.customer_status,'version',d.customer_version)
          || CASE WHEN d.policy_version=3 THEN jsonb_build_object('emailVerifiedAt',d.email_verified_at) ELSE '{}'::jsonb END END,'cardAtDecision',CASE WHEN d.card_id IS NULL THEN NULL ELSE
        jsonb_build_object('id',d.card_id,'version',d.card_version,'desiredStatus',d.desired_status,
          'confirmedStatus',d.confirmed_status,'commandId',d.command_id,'commandStatus',d.command_status) END);
    SELECT * INTO o FROM issuer_outbox WHERE id=d.command_id;
    IF o.id IS NOT NULL THEN
      -- Current command state in this snapshot, distinct from cardAtDecision.
      issuer_command:=jsonb_build_object('id',o.id,'cardId',o.card_id,'userId',o.user_id,'targetStatus',o.target_status,
        'status',o.status,'phase',o.phase,'version',o.version,'attemptCount',o.attempt_count,'cycleAttempts',o.cycle_attempts,
        'errorCode',o.error_code,'nextAttemptAt',o.next_attempt_at,'createdAt',o.created_at,'updatedAt',o.updated_at,'expiresAt',o.expires_at);
    END IF;
  END IF;
  IF e.event_id IS NOT NULL THEN
    ledger_event:=jsonb_build_object('eventId',e.event_id,'paymentId',e.payment_id,'userId',e.user_id,'kind',e.kind,
      'amountWon',e.canonical_input->'amountWon','finalCapture',e.canonical_input->'finalCapture','createdAt',e.created_at,
      'legacyPolicy',e.kind='authorize' AND d.event_id IS NULL);
    -- A declined or conflicting inbox request must never select another
    -- payment merely because its input reused that payment identifier.
    SELECT * INTO p FROM card_payments WHERE id=e.payment_id AND user_id=e.user_id;
    IF p.id IS NOT NULL THEN
      payment:=jsonb_build_object('id',p.id,'userId',p.user_id,'status',p.status,'authorizedWon',p.authorized_won,
        'heldWon',p.held_won,'capturedWon',p.captured_won,'releasedWon',p.released_won,'refundedWon',p.refunded_won,
        'createdAt',p.created_at,'updatedAt',p.updated_at);
    END IF;
  END IF;
  IF i.id IS NOT NULL THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('attemptNo',a.attempt_no,'cycleAttempt',a.cycle_attempt,'version',a.version,
      'attemptedAt',a.attempted_at,'status',a.status,'errorCode',a.error_code,'nextAttemptAt',a.next_attempt_at)
      ORDER BY a.attempt_no DESC),'[]'::jsonb) INTO attempts
      FROM (SELECT * FROM card_inbox_attempts WHERE inbox_id=i.id ORDER BY attempt_no DESC LIMIT 20) a;
    inbox:=jsonb_build_object('id',i.id,'eventId',i.event_id,'paymentId',i.payment_id,'userId',i.user_id,
      'kind',i.canonical_input->'kind','amountWon',i.canonical_input->'amountWon','finalCapture',i.canonical_input->'finalCapture',
      'status',i.status,'receivedAt',i.received_at,'processedAt',i.processed_at,'updatedAt',i.updated_at,
      'nextAttemptAt',i.next_attempt_at,'attemptCount',i.attempt_count,'cycleAttempts',i.cycle_attempts,'version',i.version,
      'errorCode',i.last_error_code,'retryEligible',i.status='dead_letter' AND i.version<9007199254740991 AND card_inbox_retryable(i.last_error_code)
        AND NOT EXISTS(SELECT 1 FROM card_capture_resolutions r WHERE r.inbox_id=i.id),
      'attempts',attempts,'attemptsTruncated',i.attempt_count>20,'attemptLimit',20);
  END IF;
  prepared:=floor(extract(epoch FROM clock_timestamp())*1000)::BIGINT;
  report:=jsonb_build_object('version',1,'mode','sandbox','requestId',request_key,'preparedAt',prepared,
    'lookup',input->'lookup','caseReference',input->'caseReference','found',source_count>0,
    'correlation',CASE WHEN conflict THEN 'conflict' WHEN source_count=0 THEN 'not_found' WHEN source_count=1 THEN 'single_source' ELSE 'consistent' END,
    'authorization',authorization_report,'ledgerEvent',ledger_event,'inbox',inbox,'payment',payment,'issuerCommand',issuer_command);
  IF octet_length(report::text)>65536 THEN RAISE EXCEPTION 'OPS_UNAVAILABLE'; END IF;
  PERFORM set_config('aqua.card_operations_request_id',request_key,true);
  INSERT INTO card_operations_reports(actor,request_id,canonical_input,prepared_at,creator_xid,result)
    VALUES(session_user,request_key,input,prepared,pg_current_xact_id(),report)
    ON CONFLICT(actor,request_id) DO NOTHING RETURNING * INTO r;
  -- A simultaneous winner outside this repeatable-read snapshot ordinarily
  -- raises 40001. Never silently return a freshly recomputed conflicting view.
  IF NOT FOUND THEN
    SELECT * INTO r FROM card_operations_reports WHERE actor=session_user AND request_id=request_key;
    IF NOT FOUND THEN RAISE EXCEPTION 'OPS_DATABASE_BUSY' USING ERRCODE='40001'; END IF;
    IF r.canonical_input IS DISTINCT FROM input THEN RAISE EXCEPTION 'OPS_REQUEST_CONFLICT'; END IF;
    PERFORM set_config('aqua.card_operations_request_id',coalesce(prior_context,''),true);
    RETURN jsonb_build_object('requestId',r.request_id,'preparedAt',r.prepared_at,'duplicate',true);
  END IF;
  PERFORM set_config('aqua.card_operations_request_id',coalesce(prior_context,''),true);
  -- No found flag, financial fields or report content leave this transaction.
  RETURN jsonb_build_object('requestId',r.request_id,'preparedAt',r.prepared_at,'duplicate',false);
EXCEPTION WHEN OTHERS THEN
  -- A failed-row CHECK error can contain the complete proposed row in DETAIL.
  -- Do not disclose the report through an error before its audit is committed.
  GET STACKED DIAGNOSTICS failure=MESSAGE_TEXT,failure_state=RETURNED_SQLSTATE;
  IF failure IN ('INVALID_OPS_REQUEST','OPS_SNAPSHOT_REQUIRED','OPS_REQUEST_CONFLICT') THEN
    RAISE EXCEPTION USING MESSAGE=failure,ERRCODE=CASE WHEN failure='INVALID_OPS_REQUEST' THEN '22023' ELSE 'P0001' END;
  ELSIF failure_state IN ('40001','40P01','55P03') THEN
    RAISE EXCEPTION 'OPS_DATABASE_BUSY' USING ERRCODE=failure_state;
  END IF;
  RAISE EXCEPTION 'OPS_UNAVAILABLE';
END;
$$;
