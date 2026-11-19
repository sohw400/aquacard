-- The sandbox has one immutable issuer-card mapping per member. New approvals
-- resolve that mapping on the server; callers cannot omit or substitute a card.
-- Previously completed events and later settlement retain their original terms.
CREATE TABLE card_authorization_decisions (
  event_id TEXT PRIMARY KEY CHECK(event_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  payment_id TEXT NOT NULL CHECK(payment_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  canonical_input JSONB NOT NULL CHECK(jsonb_typeof(canonical_input)='object'),
  decision TEXT NOT NULL CHECK(decision IN ('approved','declined')),
  reason TEXT CHECK(reason IN ('CARD_NOT_ISSUED','CARD_LOCKED','CARD_STATUS_UNCONFIRMED')),
  result JSONB NOT NULL CHECK(jsonb_typeof(result)='object'),
  policy_version INTEGER NOT NULL CHECK(policy_version=1),
  card_id TEXT REFERENCES issuer_cards(id) ON DELETE RESTRICT,
  card_version BIGINT CHECK(card_version BETWEEN 1 AND 9007199254740991),
  desired_status TEXT CHECK(desired_status IN ('active','locked')),
  confirmed_status TEXT CHECK(confirmed_status IN ('active','locked')),
  command_id TEXT REFERENCES issuer_outbox(id) ON DELETE RESTRICT,
  command_status TEXT CHECK(command_status IN ('pending','in_flight','retry','succeeded','failed','needs_review')),
  -- Inbox receipt time is financial event time, not the policy evaluation time.
  event_received_at BIGINT NOT NULL CHECK(event_received_at BETWEEN 0 AND 8639999967600000),
  decided_at BIGINT NOT NULL CHECK(decided_at BETWEEN 0 AND 8640000000000000),
  actor TEXT NOT NULL,
  CHECK(canonical_input->>'kind' IS NOT DISTINCT FROM 'authorize'
    AND canonical_input->>'eventId' IS NOT DISTINCT FROM event_id
    AND canonical_input->>'paymentId' IS NOT DISTINCT FROM payment_id
    AND canonical_input->>'userId' IS NOT DISTINCT FROM user_id),
  CHECK((card_id IS NULL AND card_version IS NULL AND desired_status IS NULL AND confirmed_status IS NULL
      AND command_id IS NULL AND command_status IS NULL AND decision='declined' AND reason='CARD_NOT_ISSUED')
    OR (card_id IS NOT NULL AND card_version IS NOT NULL AND desired_status IS NOT NULL AND confirmed_status IS NOT NULL
      AND reason IS DISTINCT FROM 'CARD_NOT_ISSUED'
      AND ((command_id IS NULL AND command_status IS NULL) OR (command_id IS NOT NULL AND command_status IS NOT NULL)))),
  CHECK((decision='approved' AND reason IS NULL AND card_id IS NOT NULL
      AND desired_status='active' AND confirmed_status='active' AND (command_id IS NULL OR command_status='succeeded')
      AND result ? 'payment' AND NOT result ? 'declined')
    OR (decision='declined' AND reason IS NOT NULL AND result=jsonb_build_object('declined',true,'code',reason)))
);
CREATE INDEX card_authorization_decisions_member ON card_authorization_decisions(user_id,decided_at,event_id);
CREATE INDEX card_authorization_decisions_payment ON card_authorization_decisions(payment_id,event_id);

-- Snapshot validation happens while the command holds the issuer-card lock.
-- Later state changes never rewrite the approval or denial that was returned.
CREATE FUNCTION card_authorization_guard() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE c issuer_cards%ROWTYPE; command_state TEXT; expected_reason TEXT;
BEGIN
  IF current_user IS DISTINCT FROM pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=TG_RELID))
    OR current_setting('aqua.card_authorization_event_id',true) IS DISTINCT FROM NEW.event_id
    OR NEW.actor IS DISTINCT FROM session_user
    OR NEW.canonical_input IS DISTINCT FROM reward_card_canonical(NEW.canonical_input) THEN
    RAISE EXCEPTION 'Card authorization decisions are protected' USING ERRCODE='55000';
  END IF;
  SELECT * INTO c FROM issuer_cards WHERE user_id=NEW.user_id;
  IF c.id IS NULL THEN expected_reason:='CARD_NOT_ISSUED';
  ELSE
    SELECT status INTO command_state FROM issuer_outbox WHERE id=c.last_command_id;
    IF c.desired_status='locked' OR c.confirmed_status='locked' THEN expected_reason:='CARD_LOCKED';
    ELSIF c.last_command_id IS NOT NULL AND command_state IS DISTINCT FROM 'succeeded' THEN expected_reason:='CARD_STATUS_UNCONFIRMED';
    END IF;
  END IF;
  IF ROW(NEW.card_id,NEW.card_version,NEW.desired_status,NEW.confirmed_status,NEW.command_id,NEW.command_status)
    IS DISTINCT FROM ROW(c.id,c.version,c.desired_status,c.confirmed_status,c.last_command_id,command_state)
    OR NEW.reason IS DISTINCT FROM expected_reason
    OR (NEW.decision='approved') IS DISTINCT FROM (expected_reason IS NULL) THEN
    RAISE EXCEPTION 'Card authorization snapshot does not match policy' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER card_authorization_decisions_guard BEFORE INSERT ON card_authorization_decisions
  FOR EACH ROW EXECUTE FUNCTION card_authorization_guard();
CREATE TRIGGER card_authorization_decisions_immutable BEFORE UPDATE OR DELETE ON card_authorization_decisions
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_history_change();
CREATE TRIGGER card_authorization_decisions_no_truncate BEFORE TRUNCATE ON card_authorization_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_reject_history_change();

CREATE FUNCTION card_authorization_require_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE d card_authorization_decisions%ROWTYPE; e card_payment_events%ROWTYPE;
BEGIN
  SELECT * INTO d FROM card_authorization_decisions WHERE event_id=NEW.event_id;
  IF TG_TABLE_NAME='card_payment_events' THEN
    IF NEW.kind<>'authorize' THEN
      IF d.event_id IS NOT NULL THEN RAISE EXCEPTION 'CARD_AUTHORIZATION_INCOMPLETE' USING ERRCODE='23514'; END IF;
      RETURN NULL;
    END IF;
  END IF;
  SELECT * INTO e FROM card_payment_events WHERE event_id=NEW.event_id;
  IF d.event_id IS NULL OR (d.decision='declined' AND e.event_id IS NOT NULL)
    OR (d.decision='approved' AND (e.event_id IS NULL OR e.kind<>'authorize'
      OR ROW(d.payment_id,d.user_id,d.canonical_input,d.result,d.event_received_at)
        IS DISTINCT FROM ROW(e.payment_id,e.user_id,e.canonical_input,e.result,e.created_at))) THEN
    RAISE EXCEPTION 'CARD_AUTHORIZATION_INCOMPLETE' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER card_authorization_decision_complete AFTER INSERT ON card_authorization_decisions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION card_authorization_require_complete();
-- Applies only to events inserted after this migration. Existing approvals do
-- not acquire synthetic issuer mappings or fabricated policy snapshots.
CREATE CONSTRAINT TRIGGER card_authorization_event_complete AFTER INSERT ON card_payment_events
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION card_authorization_require_complete();

-- Preserve the funded ledger implementation verbatim behind a private helper.
DO $$ DECLARE definition TEXT; BEGIN
  SELECT pg_get_functiondef('apply_sandbox_card_event(jsonb,bigint)'::regprocedure) INTO definition;
  EXECUTE replace(definition,'apply_sandbox_card_event(','apply_sandbox_card_event_financial_004(');
END; $$;
REVOKE ALL ON FUNCTION apply_sandbox_card_event_financial_004(JSONB,BIGINT) FROM PUBLIC;

CREATE OR REPLACE FUNCTION apply_sandbox_card_event(p_input JSONB,p_now BIGINT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE input JSONB; event_key TEXT; uid TEXT; k TEXT; reason_code TEXT; answer JSONB; command_state TEXT;
  d card_authorization_decisions%ROWTYPE; e card_payment_events%ROWTYPE; c issuer_cards%ROWTYPE;
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
  IF k<>'authorize' THEN RETURN apply_sandbox_card_event_financial_004(input,p_now); END IF;
  -- Registration owns the same member lock, including when no card exists yet.
  -- NO KEY UPDATE remains compatible with the outbox's foreign-key checks.
  PERFORM id FROM users WHERE id=uid FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'USER_NOT_FOUND'; END IF;
  SELECT * INTO c FROM issuer_cards WHERE user_id=uid FOR NO KEY UPDATE;
  IF NOT FOUND THEN reason_code:='CARD_NOT_ISSUED';
  ELSE
    SELECT status INTO command_state FROM issuer_outbox WHERE id=c.last_command_id;
    IF c.desired_status='locked' OR c.confirmed_status='locked' THEN reason_code:='CARD_LOCKED';
    ELSIF c.last_command_id IS NOT NULL AND command_state IS DISTINCT FROM 'succeeded' THEN reason_code:='CARD_STATUS_UNCONFIRMED';
    END IF;
  END IF;
  IF reason_code IS NULL THEN answer:=apply_sandbox_card_event_financial_004(input,p_now);
  ELSE answer:=jsonb_build_object('declined',true,'code',reason_code);
  END IF;
  PERFORM set_config('aqua.card_authorization_event_id',event_key,true);
  INSERT INTO card_authorization_decisions(event_id,payment_id,user_id,canonical_input,decision,reason,result,policy_version,
    card_id,card_version,desired_status,confirmed_status,command_id,command_status,event_received_at,decided_at,actor)
  VALUES(event_key,input->>'paymentId',uid,input,CASE WHEN reason_code IS NULL THEN 'approved' ELSE 'declined' END,reason_code,answer,1,
    c.id,c.version,c.desired_status,c.confirmed_status,c.last_command_id,command_state,p_now,
    floor(extract(epoch FROM clock_timestamp())*1000)::BIGINT,session_user);
  PERFORM set_config('aqua.card_authorization_event_id',coalesce(prior_context,''),true);
  -- A denial must commit before a caller presents it as a domain error. Raising
  -- here would erase the decision and permit the same event after an unlock.
  RETURN answer;
END;
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
      IF failure NOT IN ('CARD_NOT_ISSUED','CARD_LOCKED','CARD_STATUS_UNCONFIRMED') THEN
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
      'INVALID_CARD_EVENT','USER_NOT_FOUND','CARD_OWNER_MISMATCH','INSUFFICIENT_FUNDS','IDEMPOTENCY_CONFLICT',
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

REVOKE ALL ON card_authorization_decisions FROM PUBLIC;
REVOKE ALL ON FUNCTION card_authorization_guard(),card_authorization_require_complete(),
  apply_sandbox_card_event_financial_004(JSONB,BIGINT),apply_sandbox_card_event(JSONB,BIGINT),process_card_inbox(BIGINT) FROM PUBLIC;
