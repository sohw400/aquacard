-- Durable delivery is separate from card approval. This adapter accepts only
-- the strict Aqua sandbox event format; no issuer payload or card data is stored.
CREATE TABLE card_inbox_lanes (
  payment_id TEXT PRIMARY KEY CHECK(payment_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
);
CREATE TABLE card_event_inbox (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  arrival_sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  source TEXT NOT NULL DEFAULT 'sandbox' CHECK(source='sandbox'),
  event_id TEXT NOT NULL,
  canonical_input JSONB NOT NULL CHECK(jsonb_typeof(canonical_input)='object'),
  payment_id TEXT NOT NULL REFERENCES card_inbox_lanes(payment_id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL,
  received_at BIGINT NOT NULL CHECK(received_at BETWEEN 0 AND 8639999967600000),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','retry','applied','dead_letter')),
  next_attempt_at BIGINT,
  attempt_count BIGINT NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 9007199254740991),
  cycle_attempts INTEGER NOT NULL DEFAULT 0 CHECK(cycle_attempts BETWEEN 0 AND 8),
  version BIGINT NOT NULL DEFAULT 0 CHECK(version BETWEEN 0 AND 9007199254740991),
  last_error_code TEXT,
  result JSONB,
  processed_at BIGINT CHECK(processed_at BETWEEN 0 AND 8639999967600000),
  updated_at BIGINT NOT NULL CHECK(updated_at BETWEEN received_at AND 8639999967600000),
  UNIQUE(source,event_id),
  CHECK(attempt_count>=cycle_attempts AND version>=attempt_count),
  CHECK(event_id=canonical_input->>'eventId' AND payment_id=canonical_input->>'paymentId' AND user_id=canonical_input->>'userId'),
  CHECK(next_attempt_at IS NULL OR next_attempt_at BETWEEN 0 AND 8639999967600000),
  CHECK((status='pending' AND next_attempt_at IS NOT NULL AND last_error_code IS NULL AND result IS NULL AND cycle_attempts=0)
    OR (status='retry' AND next_attempt_at IS NOT NULL AND last_error_code IS NOT NULL AND result IS NULL AND cycle_attempts BETWEEN 1 AND 7 AND processed_at IS NOT NULL)
    OR (status='applied' AND next_attempt_at IS NULL AND last_error_code IS NULL AND jsonb_typeof(result)='object' AND result IS NOT NULL AND cycle_attempts>=1 AND processed_at IS NOT NULL)
    OR (status='dead_letter' AND next_attempt_at IS NULL AND last_error_code IS NOT NULL AND result IS NULL AND cycle_attempts>=1 AND processed_at IS NOT NULL))
);
CREATE INDEX card_inbox_due ON card_event_inbox(next_attempt_at,arrival_sequence) INCLUDE(payment_id) WHERE status IN ('pending','retry');
CREATE INDEX card_inbox_lane_due ON card_event_inbox(payment_id,next_attempt_at,arrival_sequence) WHERE status IN ('pending','retry');
CREATE INDEX card_inbox_unapplied_captures ON card_event_inbox(payment_id,user_id,arrival_sequence)
  WHERE canonical_input->>'kind'='capture' AND status<>'applied';

CREATE TABLE card_inbox_attempts (
  inbox_id TEXT NOT NULL REFERENCES card_event_inbox(id) ON DELETE RESTRICT,
  attempt_no BIGINT NOT NULL CHECK(attempt_no BETWEEN 1 AND 9007199254740991),
  cycle_attempt INTEGER NOT NULL CHECK(cycle_attempt BETWEEN 1 AND 8),
  version BIGINT NOT NULL CHECK(version BETWEEN 1 AND 9007199254740991),
  attempted_at BIGINT NOT NULL CHECK(attempted_at BETWEEN 0 AND 8639999967600000),
  status TEXT NOT NULL CHECK(status IN ('retry','applied','dead_letter')),
  error_code TEXT,
  next_attempt_at BIGINT,
  PRIMARY KEY(inbox_id,attempt_no),
  UNIQUE(inbox_id,version),
  CHECK((status='applied' AND error_code IS NULL AND next_attempt_at IS NULL)
    OR (status='retry' AND error_code IS NOT NULL AND next_attempt_at IS NOT NULL AND cycle_attempt<8)
    OR (status='dead_letter' AND error_code IS NOT NULL AND next_attempt_at IS NULL))
);
CREATE TABLE card_inbox_requeues (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  inbox_id TEXT NOT NULL REFERENCES card_event_inbox(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL UNIQUE,
  canonical_input JSONB NOT NULL CHECK(jsonb_typeof(canonical_input)='object'),
  reason TEXT NOT NULL CHECK(char_length(reason) BETWEEN 10 AND 500),
  actor TEXT NOT NULL,
  created_at BIGINT NOT NULL CHECK(created_at BETWEEN 0 AND 8639999967600000),
  from_version BIGINT NOT NULL CHECK(from_version BETWEEN 0 AND 9007199254740990),
  to_version BIGINT NOT NULL CHECK(to_version=from_version+1),
  result JSONB NOT NULL CHECK(jsonb_typeof(result)='object'),
  UNIQUE(inbox_id,to_version)
);

CREATE FUNCTION card_inbox_retryable(p_code TEXT) RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
  SELECT p_code IN ('CARD_PAYMENT_NOT_FOUND','CARD_STATE_CONFLICT','REWARD_BUDGET_UNAVAILABLE',
    'REWARD_BACKING_MISMATCH','DATABASE_BUSY','INTERNAL_ERROR');
$$;

CREATE FUNCTION card_inbox_guard() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE action TEXT:=nullif(current_setting('aqua.inbox_action',true),'');
BEGIN
  -- Caller-controlled settings alone never confer authority: all entrypoints
  -- execute as the trusted owner and ordinary roles have no table mutations.
  IF current_user IS DISTINCT FROM pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=TG_RELID)) THEN
    RAISE EXCEPTION 'Card inbox history is protected' USING ERRCODE='55000';
  END IF;
  IF TG_TABLE_NAME='card_inbox_lanes' THEN
    IF action IS DISTINCT FROM 'enqueue' THEN RAISE EXCEPTION 'Card inbox lanes are protected' USING ERRCODE='55000'; END IF;
  ELSIF TG_TABLE_NAME='card_event_inbox' THEN
    IF TG_OP='INSERT' THEN
      IF action IS DISTINCT FROM 'enqueue' OR NEW.status<>'pending' OR NEW.attempt_count<>0 OR NEW.cycle_attempts<>0
        OR NEW.version<>0 OR NEW.next_attempt_at IS DISTINCT FROM NEW.received_at OR NEW.updated_at<>NEW.received_at
        OR NEW.processed_at IS NOT NULL OR NEW.canonical_input IS DISTINCT FROM reward_card_canonical(NEW.canonical_input) THEN
        RAISE EXCEPTION 'Invalid initial card inbox record' USING ERRCODE='55000';
      END IF;
    ELSE
      IF ROW(NEW.id,NEW.arrival_sequence,NEW.source,NEW.event_id,NEW.canonical_input,NEW.payment_id,NEW.user_id,NEW.received_at)
        IS DISTINCT FROM ROW(OLD.id,OLD.arrival_sequence,OLD.source,OLD.event_id,OLD.canonical_input,OLD.payment_id,OLD.user_id,OLD.received_at)
        OR OLD.status='applied' OR NEW.version<>OLD.version+1 OR NEW.updated_at<OLD.updated_at THEN
        RAISE EXCEPTION 'Card inbox identity and completed results are immutable' USING ERRCODE='55000';
      END IF;
      IF action='process' THEN
        IF OLD.status NOT IN ('pending','retry') OR NEW.status='pending' OR NEW.attempt_count<>OLD.attempt_count+1
          OR NEW.cycle_attempts<>OLD.cycle_attempts+1 THEN RAISE EXCEPTION 'Invalid card inbox transition' USING ERRCODE='55000'; END IF;
      ELSIF action='requeue' THEN
        IF OLD.status<>'dead_letter' OR NOT card_inbox_retryable(OLD.last_error_code) OR NEW.status<>'pending'
          OR NEW.attempt_count<>OLD.attempt_count OR NEW.cycle_attempts<>0 OR NEW.processed_at IS DISTINCT FROM OLD.processed_at THEN
          RAISE EXCEPTION 'Invalid card inbox requeue' USING ERRCODE='55000'; END IF;
      ELSE RAISE EXCEPTION 'Card inbox changes require a private command' USING ERRCODE='55000';
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME='card_inbox_attempts' THEN
    IF action IS DISTINCT FROM 'process' THEN RAISE EXCEPTION 'Attempt history is protected' USING ERRCODE='55000'; END IF;
  ELSIF action IS DISTINCT FROM 'requeue' OR NEW.actor IS DISTINCT FROM session_user THEN
    RAISE EXCEPTION 'Requeue history is protected' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER card_inbox_guard BEFORE INSERT OR UPDATE ON card_event_inbox FOR EACH ROW EXECUTE FUNCTION card_inbox_guard();
CREATE TRIGGER card_inbox_lane_guard BEFORE INSERT ON card_inbox_lanes FOR EACH ROW EXECUTE FUNCTION card_inbox_guard();
CREATE TRIGGER card_inbox_attempt_guard BEFORE INSERT ON card_inbox_attempts FOR EACH ROW EXECUTE FUNCTION card_inbox_guard();
CREATE TRIGGER card_inbox_requeue_guard BEFORE INSERT ON card_inbox_requeues FOR EACH ROW EXECUTE FUNCTION card_inbox_guard();
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['card_inbox_lanes','card_event_inbox','card_inbox_attempts','card_inbox_requeues'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION ledger_reject_history_change()',t||'_no_delete',t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION ledger_reject_history_change()',t||'_no_truncate',t);
    IF t<>'card_event_inbox' THEN EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION ledger_reject_history_change()',t||'_immutable',t); END IF;
  END LOOP;
END; $$;

CREATE FUNCTION card_inbox_require_audit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE i card_event_inbox%ROWTYPE;
BEGIN
  SELECT * INTO i FROM card_event_inbox WHERE id=NEW.id;
  IF i.version=0 THEN RETURN NULL; END IF;
  IF i.status='pending' THEN
    IF NOT EXISTS(SELECT 1 FROM card_inbox_requeues r WHERE r.inbox_id=i.id AND r.to_version=i.version) THEN
      RAISE EXCEPTION 'INBOX_TRANSITION_INCOMPLETE' USING ERRCODE='23514';
    END IF;
  ELSIF NOT EXISTS(SELECT 1 FROM card_inbox_attempts a WHERE a.inbox_id=i.id AND a.version=i.version
    AND a.attempt_no=i.attempt_count AND a.cycle_attempt=i.cycle_attempts AND a.status=i.status
    AND a.attempted_at=i.processed_at AND a.error_code IS NOT DISTINCT FROM i.last_error_code
    AND a.next_attempt_at IS NOT DISTINCT FROM i.next_attempt_at) THEN
    RAISE EXCEPTION 'INBOX_TRANSITION_INCOMPLETE' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER card_inbox_transition_complete AFTER INSERT OR UPDATE ON card_event_inbox
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION card_inbox_require_audit();

CREATE FUNCTION enqueue_sandbox_card_event(p_input JSONB,p_now BIGINT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE input JSONB; i card_event_inbox%ROWTYPE; inserted BOOLEAN; prior_context TEXT:=current_setting('aqua.inbox_action',true);
BEGIN
  IF p_now IS NULL OR p_now NOT BETWEEN 0 AND 8639999967600000 THEN RAISE EXCEPTION 'INVALID_INBOX_COMMAND' USING ERRCODE='22023'; END IF;
  IF p_input IS NULL OR octet_length(p_input::text)>16384 THEN RAISE EXCEPTION 'INVALID_CARD_EVENT' USING ERRCODE='22023'; END IF;
  input:=reward_card_canonical(p_input);
  PERFORM set_config('aqua.inbox_action','enqueue',true);
  INSERT INTO card_inbox_lanes(payment_id) VALUES(input->>'paymentId') ON CONFLICT DO NOTHING;
  INSERT INTO card_event_inbox(event_id,canonical_input,payment_id,user_id,received_at,next_attempt_at,updated_at)
    VALUES(input->>'eventId',input,input->>'paymentId',input->>'userId',p_now,p_now,p_now)
    ON CONFLICT(source,event_id) DO NOTHING RETURNING * INTO i;
  inserted:=FOUND;
  IF NOT inserted THEN
    SELECT * INTO i FROM card_event_inbox WHERE source='sandbox' AND event_id=input->>'eventId';
    IF i.canonical_input IS DISTINCT FROM input THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
  END IF;
  PERFORM set_config('aqua.inbox_action',coalesce(prior_context,''),true);
  RETURN jsonb_build_object('id',i.id,'eventId',i.event_id,'status',i.status,'receivedAt',i.received_at,'duplicate',NOT inserted);
END;
$$;

CREATE FUNCTION card_inbox_next_in_lane(p_payment TEXT,p_now BIGINT)
RETURNS TABLE(id TEXT,next_attempt_at BIGINT,arrival_sequence BIGINT)
LANGUAGE sql STABLE SET search_path FROM CURRENT AS $$
  SELECT i.id,i.next_attempt_at,i.arrival_sequence FROM card_event_inbox i
    WHERE i.payment_id=p_payment AND i.status IN ('pending','retry') AND i.next_attempt_at<=p_now
      AND (i.canonical_input->>'kind' NOT IN ('capture','reverse') OR NOT EXISTS (
        SELECT 1 FROM card_event_inbox older WHERE older.payment_id=i.payment_id AND older.user_id=i.user_id
          AND older.arrival_sequence<i.arrival_sequence AND older.canonical_input->>'kind'='capture' AND older.status<>'applied'
      ))
    ORDER BY i.next_attempt_at,i.arrival_sequence LIMIT 1;
$$;

CREATE FUNCTION process_card_inbox(p_now BIGINT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE i card_event_inbox%ROWTYPE; applied JSONB; failure TEXT; pg_state TEXT; message TEXT;
  lane_key TEXT; next_at BIGINT; next_status TEXT; attempt BIGINT; cycle INTEGER; retry BOOLEAN;
  prior_context TEXT:=current_setting('aqua.inbox_action',true);
  delays BIGINT[]:=ARRAY[1000,5000,15000,60000,300000,900000,3600000]::BIGINT[];
BEGIN
  IF p_now IS NULL OR p_now NOT BETWEEN 0 AND 8639999967600000 THEN RAISE EXCEPTION 'INVALID_INBOX_COMMAND' USING ERRCODE='22023'; END IF;
  -- A worker owns the payment family before selecting its event. Skipping only
  -- a locked inbox row could let a later final capture release an earlier
  -- partial capture's funds. NO KEY UPDATE still permits ingress FK checks.
  WITH due_lanes AS MATERIALIZED (
    SELECT DISTINCT payment_id FROM card_event_inbox WHERE status IN ('pending','retry') AND next_attempt_at<=p_now
  )
  SELECT l.payment_id INTO lane_key FROM due_lanes due JOIN card_inbox_lanes l ON l.payment_id=due.payment_id
    CROSS JOIN LATERAL card_inbox_next_in_lane(l.payment_id,p_now) candidate
    ORDER BY candidate.next_attempt_at,candidate.arrival_sequence
    FOR NO KEY UPDATE OF l SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  -- Re-read under the lane lock. Missing predecessors can arrive in any order,
  -- but a capture or reversal never overtakes an older unapplied capture.
  SELECT inbox.* INTO i FROM card_event_inbox inbox JOIN card_inbox_next_in_lane(lane_key,p_now) candidate ON candidate.id=inbox.id
    FOR UPDATE OF inbox;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF i.attempt_count=9007199254740991 OR i.version=9007199254740991 THEN RAISE EXCEPTION 'INBOX_CAPACITY'; END IF;
  attempt:=i.attempt_count+1; cycle:=i.cycle_attempts+1;
  PERFORM set_config('aqua.inbox_action','process',true);
  BEGIN
    -- The ledger and inbox completion share this transaction. Never acknowledge
    -- first or retry a financial write outside it. Receipt time stays immutable.
    applied:=apply_sandbox_card_event(i.canonical_input,i.received_at);
    -- Deferred ledger checks must fail INSIDE this subtransaction so all money
    -- changes roll back before a retry/dead-letter attempt is recorded.
    SET CONSTRAINTS ALL IMMEDIATE;
    SET CONSTRAINTS ALL DEFERRED;
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
    VALUES(i.id,i.attempt_count,i.cycle_attempts,i.version,p_now,i.status,i.last_error_code,i.next_attempt_at);
  PERFORM set_config('aqua.inbox_action',coalesce(prior_context,''),true);
  RETURN jsonb_build_object('id',i.id,'status',i.status,'attemptCount',i.attempt_count,'cycleAttempts',i.cycle_attempts,
    'version',i.version,'errorCode',i.last_error_code,'nextAttemptAt',i.next_attempt_at);
END;
$$;

CREATE FUNCTION card_inbox_stats(p_now BIGINT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE answer JSONB;
BEGIN
  IF p_now IS NULL OR p_now NOT BETWEEN 0 AND 8639999967600000 THEN RAISE EXCEPTION 'INVALID_INBOX_COMMAND' USING ERRCODE='22023'; END IF;
  SELECT jsonb_build_object('pending',(count(*) FILTER(WHERE status='pending'))::text,
    'retry',(count(*) FILTER(WHERE status='retry'))::text,'applied',(count(*) FILTER(WHERE status='applied'))::text,
    'deadLetter',(count(*) FILTER(WHERE status='dead_letter'))::text,
    'due',(count(*) FILTER(WHERE status IN ('pending','retry') AND next_attempt_at<=p_now))::text,
    'oldestPendingAt',min(received_at) FILTER(WHERE status IN ('pending','retry'))) INTO answer FROM card_event_inbox;
  RETURN answer;
END;
$$;

CREATE FUNCTION operator_retry_card_inbox(p_input JSONB,p_now BIGINT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE input JSONB; i card_event_inbox%ROWTYPE; prior card_inbox_requeues%ROWTYPE; reason_text TEXT; request_key TEXT;
  expected BIGINT; answer JSONB; prior_context TEXT:=current_setting('aqua.inbox_action',true);
BEGIN
  IF p_now IS NULL OR p_now NOT BETWEEN 0 AND 8639999967600000 OR jsonb_typeof(p_input) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'INVALID_INBOX_COMMAND' USING ERRCODE='22023'; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p_input))<>4 OR NOT(p_input ?& ARRAY['id','idempotencyKey','reason','expectedVersion'])
    OR jsonb_typeof(p_input->'id') IS DISTINCT FROM 'string' OR p_input->>'id' !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    OR jsonb_typeof(p_input->'idempotencyKey') IS DISTINCT FROM 'string' OR p_input->>'idempotencyKey' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    OR jsonb_typeof(p_input->'reason') IS DISTINCT FROM 'string' OR p_input->>'reason' ~ '[[:cntrl:]]'
    OR jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR p_input->>'expectedVersion' !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'INVALID_INBOX_COMMAND' USING ERRCODE='22023'; END IF;
  reason_text:=regexp_replace(p_input->>'reason','^[[:space:]]+|[[:space:]]+$','','g');
  IF char_length(reason_text) NOT BETWEEN 10 AND 500 OR (p_input->>'expectedVersion')::NUMERIC>9007199254740991 THEN
    RAISE EXCEPTION 'INVALID_INBOX_COMMAND' USING ERRCODE='22023'; END IF;
  input:=jsonb_set(p_input,'{reason}',to_jsonb(reason_text)); request_key:=input->>'idempotencyKey'; expected:=(input->>'expectedVersion')::BIGINT;
  SELECT * INTO prior FROM card_inbox_requeues WHERE idempotency_key=request_key;
  IF FOUND THEN
    IF prior.canonical_input IS DISTINCT FROM input THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
    RETURN prior.result;
  END IF;
  -- Every path that locks an inbox record first owns its payment lane.
  PERFORM l.payment_id FROM card_inbox_lanes l JOIN card_event_inbox event ON event.payment_id=l.payment_id
    WHERE event.id=input->>'id' FOR NO KEY UPDATE OF l;
  SELECT * INTO i FROM card_event_inbox WHERE id=input->>'id' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'INBOX_EVENT_NOT_FOUND'; END IF;
  SELECT * INTO prior FROM card_inbox_requeues WHERE idempotency_key=request_key;
  IF FOUND THEN
    IF prior.canonical_input IS DISTINCT FROM input THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
    RETURN prior.result;
  END IF;
  IF i.version<>expected THEN RAISE EXCEPTION 'INBOX_VERSION_CHANGED'; END IF;
  IF i.status<>'dead_letter' THEN RAISE EXCEPTION 'INBOX_STATE_CONFLICT'; END IF;
  IF NOT card_inbox_retryable(i.last_error_code) THEN RAISE EXCEPTION 'INBOX_NOT_RETRYABLE'; END IF;
  IF i.version=9007199254740991 THEN RAISE EXCEPTION 'INBOX_CAPACITY'; END IF;
  PERFORM set_config('aqua.inbox_action','requeue',true);
  answer:=jsonb_build_object('id',i.id,'status','pending','version',i.version+1);
  INSERT INTO card_inbox_requeues(inbox_id,idempotency_key,canonical_input,reason,actor,created_at,from_version,to_version,result)
    VALUES(i.id,request_key,input,reason_text,session_user,p_now,i.version,i.version+1,answer);
  UPDATE card_event_inbox SET status='pending',cycle_attempts=0,version=version+1,last_error_code=NULL,
    next_attempt_at=p_now,updated_at=greatest(updated_at,p_now) WHERE id=i.id;
  PERFORM set_config('aqua.inbox_action',coalesce(prior_context,''),true);
  RETURN answer;
END;
$$;

-- Only deployment grants the approved entrypoints to ingress and worker roles.
DO $$ DECLARE f record; BEGIN
  FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p
    WHERE p.pronamespace=current_schema()::regnamespace AND
      (p.proname LIKE 'card_inbox_%' OR p.proname IN ('enqueue_sandbox_card_event','process_card_inbox','operator_retry_card_inbox'))
  LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature); END LOOP;
END; $$;
