-- Customer eligibility is separate from authentication and card state. All
-- existing and new members start blocked. An active SANDBOX decision is not KYC.
CREATE TABLE customer_access (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK(status IN ('unverified','pending_review','active','restricted','frozen','closed')),
  version BIGINT NOT NULL CHECK(version BETWEEN 1 AND 9007199254740991),
  updated_at BIGINT NOT NULL CHECK(updated_at BETWEEN 0 AND 8640000000000000)
);
CREATE TABLE customer_access_events (
  user_id TEXT NOT NULL REFERENCES customer_access(user_id) ON DELETE RESTRICT,
  version BIGINT NOT NULL CHECK(version BETWEEN 1 AND 9007199254740991),
  status TEXT NOT NULL CHECK(status IN ('unverified','pending_review','active','restricted','frozen','closed')),
  previous_status TEXT CHECK(previous_status IN ('unverified','pending_review','active','restricted','frozen','closed')),
  idempotency_key TEXT CHECK(idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  canonical_input JSONB,
  result JSONB NOT NULL CHECK(jsonb_typeof(result)='object'),
  reason TEXT NOT NULL CHECK(char_length(reason) BETWEEN 10 AND 500 AND reason !~ '[[:cntrl:]]'),
  source TEXT NOT NULL CHECK(source IN ('initial','sandbox_operator')),
  actor TEXT NOT NULL,
  created_at BIGINT NOT NULL CHECK(created_at BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY(user_id,version), UNIQUE(user_id,idempotency_key),
  CHECK((version=1 AND previous_status IS NULL AND status='unverified' AND source='initial' AND canonical_input IS NULL AND idempotency_key IS NULL)
    OR (version>1 AND previous_status IS NOT NULL AND source='sandbox_operator' AND canonical_input IS NOT NULL AND idempotency_key IS NOT NULL))
);

CREATE FUNCTION customer_access_snapshot(p_user TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE answer JSONB;
BEGIN
  SELECT jsonb_build_object('status',status,'version',version,'updatedAt',updated_at,'canTransact',status='active')
    INTO answer FROM customer_access WHERE user_id=p_user;
  IF answer IS NULL THEN RAISE EXCEPTION 'CUSTOMER_ACCESS_NOT_FOUND'; END IF;
  RETURN answer;
END;
$$;

CREATE FUNCTION customer_access_guard() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE action TEXT:=current_setting('aqua.customer_access_action',true); a customer_access%ROWTYPE;
BEGIN
  IF current_user IS DISTINCT FROM pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=TG_RELID)) THEN
    RAISE EXCEPTION 'Customer access is protected' USING ERRCODE='55000';
  END IF;
  IF TG_TABLE_NAME='customer_access' THEN
    IF TG_OP='INSERT' THEN
      IF action IS DISTINCT FROM 'initialize' OR NEW.status<>'unverified' OR NEW.version<>1 THEN
        RAISE EXCEPTION 'Customer access must start unverified' USING ERRCODE='55000';
      END IF;
    ELSIF action IS DISTINCT FROM 'transition' OR NEW.user_id<>OLD.user_id OR NEW.version<>OLD.version+1
      OR NEW.updated_at<OLD.updated_at OR OLD.status='closed' THEN
      RAISE EXCEPTION 'Customer access requires an audited transition' USING ERRCODE='55000';
    END IF;
  ELSE
    SELECT * INTO a FROM customer_access WHERE user_id=NEW.user_id;
    IF action IS NULL OR action NOT IN ('initialize','transition') OR NEW.actor IS DISTINCT FROM session_user
      OR ROW(NEW.version,NEW.status,NEW.created_at) IS DISTINCT FROM ROW(a.version,a.status,a.updated_at)
      OR NEW.result IS DISTINCT FROM customer_access_snapshot(NEW.user_id)
      OR (action='initialize') IS DISTINCT FROM (NEW.version=1)
      OR (NEW.version>1 AND (NOT EXISTS(SELECT 1 FROM customer_access_events e
          WHERE e.user_id=NEW.user_id AND e.version=NEW.version-1 AND e.status=NEW.previous_status)
        OR NEW.canonical_input->>'userId' IS DISTINCT FROM NEW.user_id
        OR NEW.canonical_input->>'status' IS DISTINCT FROM NEW.status
        OR NEW.canonical_input->>'idempotencyKey' IS DISTINCT FROM NEW.idempotency_key
        OR NEW.canonical_input->>'reason' IS DISTINCT FROM NEW.reason
        OR NEW.canonical_input->'expectedVersion' IS DISTINCT FROM to_jsonb(NEW.version-1))) THEN
      RAISE EXCEPTION 'Customer access audit is protected' USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER customer_access_guard BEFORE INSERT OR UPDATE ON customer_access
  FOR EACH ROW EXECUTE FUNCTION customer_access_guard();
CREATE TRIGGER customer_access_events_guard BEFORE INSERT ON customer_access_events
  FOR EACH ROW EXECUTE FUNCTION customer_access_guard();
CREATE TRIGGER customer_access_events_immutable BEFORE UPDATE OR DELETE ON customer_access_events
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_history_change();
CREATE TRIGGER customer_access_events_no_truncate BEFORE TRUNCATE ON customer_access_events
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_reject_history_change();
CREATE TRIGGER customer_access_no_delete BEFORE DELETE ON customer_access
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_history_change();
CREATE TRIGGER customer_access_no_truncate BEFORE TRUNCATE ON customer_access
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_reject_history_change();

CREATE FUNCTION customer_access_require_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE a customer_access%ROWTYPE;
BEGIN
  SELECT * INTO a FROM customer_access WHERE user_id=NEW.user_id;
  IF NOT EXISTS(SELECT 1 FROM customer_access_events e WHERE e.user_id=a.user_id AND e.version=a.version
    AND e.status=a.status AND e.created_at=a.updated_at AND e.result=customer_access_snapshot(a.user_id)) THEN
    RAISE EXCEPTION 'CUSTOMER_ACCESS_AUDIT_INCOMPLETE' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER customer_access_complete AFTER INSERT OR UPDATE ON customer_access
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION customer_access_require_audit();

CREATE FUNCTION customer_initialize_access(p_user TEXT,p_now BIGINT) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE prior_context TEXT:=current_setting('aqua.customer_access_action',true);
BEGIN
  PERFORM set_config('aqua.customer_access_action','initialize',true);
  INSERT INTO customer_access(user_id,status,version,updated_at) VALUES(p_user,'unverified',1,p_now);
  INSERT INTO customer_access_events(user_id,version,status,result,reason,source,actor,created_at)
    VALUES(p_user,1,'unverified',customer_access_snapshot(p_user),'Initial access requires a separate review.','initial',session_user,p_now);
  PERFORM set_config('aqua.customer_access_action',coalesce(prior_context,''),true);
END;
$$;
CREATE FUNCTION customer_access_on_signup() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
BEGIN PERFORM customer_initialize_access(NEW.id,NEW.created_at); RETURN NEW; END;
$$;
CREATE TRIGGER users_customer_access AFTER INSERT ON users FOR EACH ROW EXECUTE FUNCTION customer_access_on_signup();
-- Backfill records that already exist without inferring any prior verification.
SELECT customer_initialize_access(id,greatest(created_at,floor(extract(epoch FROM clock_timestamp())*1000)::BIGINT)) FROM users;

CREATE FUNCTION operator_set_customer_access(p_input JSONB,p_now BIGINT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE a customer_access%ROWTYPE; e customer_access_events%ROWTYPE; answer JSONB; previous TEXT;
  prior_context TEXT:=current_setting('aqua.customer_access_action',true);
BEGIN
  IF p_now IS NULL OR p_now NOT BETWEEN 0 AND 8640000000000000
    OR NOT issuer_outbox_object(p_input,ARRAY['userId','status','expectedVersion','idempotencyKey','reason'])
    OR NOT issuer_outbox_text(p_input,'userId','^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
    OR NOT issuer_outbox_text(p_input,'status','^(unverified|pending_review|active|restricted|frozen|closed)$')
    OR NOT issuer_outbox_text(p_input,'idempotencyKey','^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
    OR NOT issuer_outbox_version(p_input,'expectedVersion',1)
    OR jsonb_typeof(p_input->'reason') IS DISTINCT FROM 'string'
    OR char_length(p_input->>'reason') NOT BETWEEN 10 AND 500 OR p_input->>'reason' ~ '[[:cntrl:]]'
    OR p_input->>'reason' IS DISTINCT FROM btrim(p_input->>'reason') THEN
    RAISE EXCEPTION 'INVALID_CUSTOMER_ACCESS_COMMAND' USING ERRCODE='22023';
  END IF;
  SELECT * INTO a FROM customer_access WHERE user_id=p_input->>'userId' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CUSTOMER_ACCESS_NOT_FOUND'; END IF;
  SELECT * INTO e FROM customer_access_events WHERE user_id=a.user_id AND idempotency_key=p_input->>'idempotencyKey';
  IF FOUND THEN
    IF e.canonical_input IS DISTINCT FROM p_input OR e.actor IS DISTINCT FROM session_user THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
    RETURN e.result;
  END IF;
  IF a.version<>(p_input->>'expectedVersion')::BIGINT THEN RAISE EXCEPTION 'CUSTOMER_ACCESS_VERSION_CHANGED'; END IF;
  IF a.status='closed' OR a.status=p_input->>'status' THEN RAISE EXCEPTION 'CUSTOMER_ACCESS_TRANSITION_INVALID'; END IF;
  IF a.version=9007199254740991 THEN RAISE EXCEPTION 'CUSTOMER_ACCESS_CAPACITY'; END IF;
  previous:=a.status;
  PERFORM set_config('aqua.customer_access_action','transition',true);
  UPDATE customer_access SET status=p_input->>'status',version=version+1,updated_at=greatest(updated_at,p_now)
    WHERE user_id=a.user_id RETURNING * INTO a;
  answer:=customer_access_snapshot(a.user_id);
  INSERT INTO customer_access_events(user_id,version,status,previous_status,idempotency_key,canonical_input,result,reason,source,actor,created_at)
    VALUES(a.user_id,a.version,a.status,previous,p_input->>'idempotencyKey',p_input,answer,p_input->>'reason','sandbox_operator',session_user,a.updated_at);
  PERFORM set_config('aqua.customer_access_action',coalesce(prior_context,''),true);
  RETURN answer;
END;
$$;

-- Shared policy locks are retained until the financial transaction commits.
-- State changes take the same rows exclusively and never lock ledger/card rows.
CREATE FUNCTION customer_require_active(p_users TEXT[]) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE a customer_access%ROWTYPE; seen INTEGER:=0;
BEGIN
  IF p_users IS NULL OR cardinality(p_users) NOT BETWEEN 1 AND 2 OR array_position(p_users,NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'CUSTOMER_ACCESS_REQUIRED';
  END IF;
  FOR a IN SELECT * FROM customer_access WHERE user_id=ANY(p_users) ORDER BY user_id FOR SHARE LOOP
    seen:=seen+1;
    IF a.status<>'active' THEN RAISE EXCEPTION 'CUSTOMER_ACCESS_REQUIRED'; END IF;
  END LOOP;
  IF seen<>(SELECT count(DISTINCT id) FROM unnest(p_users) id) THEN RAISE EXCEPTION 'CUSTOMER_ACCESS_REQUIRED'; END IF;
END;
$$;
CREATE FUNCTION customer_journal_access_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW.kind='member_transfer' THEN PERFORM customer_require_active(ARRAY[NEW.sender_id,NEW.recipient_id]); END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER journals_customer_access BEFORE INSERT ON journals
  FOR EACH ROW EXECUTE FUNCTION customer_journal_access_guard();
CREATE FUNCTION customer_card_access_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW.kind='authorize' THEN PERFORM customer_require_active(ARRAY[NEW.user_id]); END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER card_events_customer_access BEFORE INSERT ON card_payment_events
  FOR EACH ROW EXECUTE FUNCTION customer_card_access_guard();
CREATE FUNCTION customer_unlock_access_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW.target_status='active' THEN PERFORM customer_require_active(ARRAY[NEW.user_id]); END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER issuer_outbox_customer_access BEFORE INSERT ON issuer_outbox
  FOR EACH ROW EXECUTE FUNCTION customer_unlock_access_guard();

-- Preserve old decisions. Only new decisions carry the customer-policy snapshot.
ALTER TABLE card_authorization_decisions DROP CONSTRAINT card_authorization_decisions_reason_check;
ALTER TABLE card_authorization_decisions ADD CONSTRAINT card_authorization_decisions_reason_check
  CHECK(reason IN ('CARD_NOT_ISSUED','CARD_LOCKED','CARD_STATUS_UNCONFIRMED','CUSTOMER_ACCESS_REQUIRED'));
ALTER TABLE card_authorization_decisions DROP CONSTRAINT card_authorization_decisions_policy_version_check;
ALTER TABLE card_authorization_decisions ADD CONSTRAINT card_authorization_decisions_policy_version_check CHECK(policy_version IN (1,2));
ALTER TABLE card_authorization_decisions ADD COLUMN customer_status TEXT CHECK(customer_status IN ('unverified','pending_review','active','restricted','frozen','closed'));
ALTER TABLE card_authorization_decisions ADD COLUMN customer_version BIGINT CHECK(customer_version BETWEEN 1 AND 9007199254740991);
ALTER TABLE card_authorization_decisions ADD CONSTRAINT card_authorization_customer_snapshot CHECK(
  (policy_version=1 AND customer_status IS NULL AND customer_version IS NULL)
  OR (policy_version=2 AND customer_status IS NOT NULL AND customer_version IS NOT NULL));

CREATE OR REPLACE FUNCTION card_authorization_guard() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE c issuer_cards%ROWTYPE; command_state TEXT; expected_reason TEXT; access customer_access%ROWTYPE;
BEGIN
  IF current_user IS DISTINCT FROM pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=TG_RELID))
    OR current_setting('aqua.card_authorization_event_id',true) IS DISTINCT FROM NEW.event_id
    OR NEW.actor IS DISTINCT FROM session_user
    OR NEW.canonical_input IS DISTINCT FROM reward_card_canonical(NEW.canonical_input) THEN
    RAISE EXCEPTION 'Card authorization decisions are protected' USING ERRCODE='55000';
  END IF;
  SELECT * INTO access FROM customer_access WHERE user_id=NEW.user_id;
  SELECT * INTO c FROM issuer_cards WHERE user_id=NEW.user_id;
  IF c.id IS NULL THEN expected_reason:='CARD_NOT_ISSUED';
  ELSE
    SELECT status INTO command_state FROM issuer_outbox WHERE id=c.last_command_id;
    IF access.status IS DISTINCT FROM 'active' THEN expected_reason:='CUSTOMER_ACCESS_REQUIRED';
    ELSIF c.desired_status='locked' OR c.confirmed_status='locked' THEN expected_reason:='CARD_LOCKED';
    ELSIF c.last_command_id IS NOT NULL AND command_state IS DISTINCT FROM 'succeeded' THEN expected_reason:='CARD_STATUS_UNCONFIRMED';
    END IF;
  END IF;
  IF NEW.policy_version<>2 OR ROW(NEW.customer_status,NEW.customer_version) IS DISTINCT FROM ROW(access.status,access.version)
    OR ROW(NEW.card_id,NEW.card_version,NEW.desired_status,NEW.confirmed_status,NEW.command_id,NEW.command_status)
    IS DISTINCT FROM ROW(c.id,c.version,c.desired_status,c.confirmed_status,c.last_command_id,command_state)
    OR NEW.reason IS DISTINCT FROM expected_reason
    OR (NEW.decision='approved') IS DISTINCT FROM (expected_reason IS NULL) THEN
    RAISE EXCEPTION 'Card authorization snapshot does not match policy' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION apply_sandbox_card_event(p_input JSONB,p_now BIGINT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE input JSONB; event_key TEXT; uid TEXT; k TEXT; reason_code TEXT; answer JSONB; command_state TEXT;
  d card_authorization_decisions%ROWTYPE; e card_payment_events%ROWTYPE; c issuer_cards%ROWTYPE; access customer_access%ROWTYPE;
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
  SELECT * INTO access FROM customer_access WHERE user_id=uid FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CUSTOMER_ACCESS_REQUIRED'; END IF;
  SELECT * INTO c FROM issuer_cards WHERE user_id=uid FOR NO KEY UPDATE;
  IF NOT FOUND THEN reason_code:='CARD_NOT_ISSUED';
  ELSE
    SELECT status INTO command_state FROM issuer_outbox WHERE id=c.last_command_id;
    IF access.status<>'active' THEN reason_code:='CUSTOMER_ACCESS_REQUIRED';
    ELSIF c.desired_status='locked' OR c.confirmed_status='locked' THEN reason_code:='CARD_LOCKED';
    ELSIF c.last_command_id IS NOT NULL AND command_state IS DISTINCT FROM 'succeeded' THEN reason_code:='CARD_STATUS_UNCONFIRMED';
    END IF;
  END IF;
  IF reason_code IS NULL THEN answer:=apply_sandbox_card_event_financial_004(input,p_now);
  ELSE answer:=jsonb_build_object('declined',true,'code',reason_code);
  END IF;
  PERFORM set_config('aqua.card_authorization_event_id',event_key,true);
  INSERT INTO card_authorization_decisions(event_id,payment_id,user_id,canonical_input,decision,reason,result,policy_version,
    card_id,card_version,desired_status,confirmed_status,command_id,command_status,event_received_at,decided_at,actor,customer_status,customer_version)
  VALUES(event_key,input->>'paymentId',uid,input,CASE WHEN reason_code IS NULL THEN 'approved' ELSE 'declined' END,reason_code,answer,2,
    c.id,c.version,c.desired_status,c.confirmed_status,c.last_command_id,command_state,p_now,
    floor(extract(epoch FROM clock_timestamp())*1000)::BIGINT,session_user,access.status,access.version);
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
      IF failure NOT IN ('CARD_NOT_ISSUED','CARD_LOCKED','CARD_STATUS_UNCONFIRMED','CUSTOMER_ACCESS_REQUIRED') THEN
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


CREATE OR REPLACE FUNCTION request_issuer_card_status(p_input JSONB,p_now BIGINT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE c issuer_cards%ROWTYPE; o issuer_outbox%ROWTYPE; command_id TEXT:=gen_random_uuid()::text; receipt JSONB;
  prior_context TEXT:=current_setting('aqua.issuer_action',true);
BEGIN
  PERFORM issuer_outbox_clock(p_now);
  IF NOT issuer_outbox_object(p_input,ARRAY['userId','cardId','targetStatus','expectedVersion','idempotencyKey'])
    OR NOT issuer_outbox_text(p_input,'userId','^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
    OR NOT issuer_outbox_text(p_input,'cardId','^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    OR NOT issuer_outbox_text(p_input,'targetStatus','^(active|locked)$')
    OR NOT issuer_outbox_text(p_input,'idempotencyKey','^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
    OR NOT issuer_outbox_version(p_input,'expectedVersion',1) THEN RAISE EXCEPTION 'INVALID_OUTBOX_COMMAND' USING ERRCODE='22023'; END IF;
  -- Shared policy locks precede card locks; safety lock requests remain allowed.
  PERFORM user_id FROM customer_access WHERE user_id=p_input->>'userId' FOR SHARE;
  -- Lock the member's card before any command row on every mutation path.
  SELECT * INTO c FROM issuer_cards WHERE id=p_input->>'cardId' AND user_id=p_input->>'userId' FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'OUTBOX_CARD_NOT_FOUND'; END IF;
  SELECT * INTO o FROM issuer_outbox WHERE user_id=c.user_id AND idempotency_key=p_input->>'idempotencyKey';
  IF FOUND THEN
    IF o.canonical_input IS DISTINCT FROM p_input THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
    RETURN o.receipt||jsonb_build_object('duplicate',TRUE);
  END IF;
  IF c.version<>(p_input->>'expectedVersion')::BIGINT THEN RAISE EXCEPTION 'OUTBOX_VERSION_CHANGED'; END IF;
  IF EXISTS(SELECT 1 FROM issuer_outbox WHERE card_id=c.id AND status IN ('pending','in_flight','retry','needs_review')) THEN RAISE EXCEPTION 'OUTBOX_PENDING'; END IF;
  IF c.version=9007199254740991 THEN RAISE EXCEPTION 'OUTBOX_CAPACITY'; END IF;
  receipt:=jsonb_build_object('id',command_id,'cardId',c.id,'status','pending','cardVersion',c.version+1);
  PERFORM set_config('aqua.issuer_action','request',true);
  INSERT INTO issuer_outbox(id,card_id,user_id,idempotency_key,canonical_input,receipt,target_status,created_at,updated_at,expires_at,next_attempt_at)
    VALUES(command_id,c.id,c.user_id,p_input->>'idempotencyKey',p_input,receipt,p_input->>'targetStatus',p_now,p_now,p_now+86400000,p_now);
  UPDATE issuer_cards SET desired_status=p_input->>'targetStatus',version=version+1,last_command_id=command_id,updated_at=greatest(updated_at,p_now) WHERE id=c.id;
  PERFORM issuer_outbox_record_audit(command_id,'requested',p_now);
  PERFORM set_config('aqua.issuer_action',coalesce(prior_context,''),true);
  RETURN receipt||jsonb_build_object('duplicate',FALSE);
END;
$$;


REVOKE ALL ON customer_access,customer_access_events FROM PUBLIC;
REVOKE ALL ON FUNCTION customer_access_snapshot(TEXT),customer_access_guard(),customer_access_require_audit(),
  customer_initialize_access(TEXT,BIGINT),customer_access_on_signup(),operator_set_customer_access(JSONB,BIGINT),
  customer_require_active(TEXT[]),customer_journal_access_guard(),customer_card_access_guard(),customer_unlock_access_guard() FROM PUBLIC;

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
        jsonb_build_object('status',d.customer_status,'version',d.customer_version) END,'cardAtDecision',CASE WHEN d.card_id IS NULL THEN NULL ELSE
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
      'errorCode',i.last_error_code,'retryEligible',i.status='dead_letter' AND i.version<9007199254740991 AND card_inbox_retryable(i.last_error_code),
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

