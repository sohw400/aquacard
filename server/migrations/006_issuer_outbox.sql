-- Sandbox issuer control synchronization. These records do not authorize a
-- payment or change a financial ledger. HTTP is always outside the transaction.
CREATE TABLE issuer_cards (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL DEFAULT 'sandbox' CHECK(provider='sandbox'),
  provider_card_id TEXT NOT NULL UNIQUE CHECK(provider_card_id ~ '^sandbox-card-[A-Za-z0-9_-]{1,100}$'),
  initial_status TEXT NOT NULL CHECK(initial_status IN ('active','locked')),
  desired_status TEXT NOT NULL CHECK(desired_status IN ('active','locked')),
  confirmed_status TEXT NOT NULL CHECK(confirmed_status IN ('active','locked')),
  version BIGINT NOT NULL DEFAULT 1 CHECK(version BETWEEN 1 AND 9007199254740991),
  last_command_id TEXT,
  created_at BIGINT NOT NULL CHECK(created_at BETWEEN 0 AND 8639999913600000),
  updated_at BIGINT NOT NULL CHECK(updated_at BETWEEN created_at AND 8640000000000000)
);
CREATE TABLE issuer_outbox (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  card_id TEXT NOT NULL REFERENCES issuer_cards(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL CHECK(idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  canonical_input JSONB NOT NULL CHECK(jsonb_typeof(canonical_input)='object'),
  receipt JSONB NOT NULL CHECK(jsonb_typeof(receipt)='object'),
  request_key TEXT NOT NULL UNIQUE DEFAULT 'aqua-'||gen_random_uuid()::text,
  target_status TEXT NOT NULL CHECK(target_status IN ('active','locked')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_flight','retry','succeeded','failed','needs_review')),
  phase TEXT NOT NULL DEFAULT 'send' CHECK(phase IN ('send','lookup')),
  version BIGINT NOT NULL DEFAULT 0 CHECK(version BETWEEN 0 AND 9007199254740991),
  attempt_count BIGINT NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 9007199254740991),
  cycle_attempts INTEGER NOT NULL DEFAULT 0 CHECK(cycle_attempts BETWEEN 0 AND 8),
  lease_token TEXT,
  lease_until BIGINT,
  next_attempt_at BIGINT,
  error_code TEXT,
  created_at BIGINT NOT NULL CHECK(created_at BETWEEN 0 AND 8639999913600000),
  updated_at BIGINT NOT NULL CHECK(updated_at BETWEEN created_at AND 8640000000000000),
  expires_at BIGINT NOT NULL CHECK(expires_at=created_at+86400000),
  UNIQUE(user_id,idempotency_key),
  CHECK(user_id=canonical_input->>'userId' AND card_id=canonical_input->>'cardId'
    AND target_status=canonical_input->>'targetStatus' AND idempotency_key=canonical_input->>'idempotencyKey'),
  CHECK(attempt_count>=cycle_attempts AND version>=attempt_count),
  CHECK(next_attempt_at IS NULL OR next_attempt_at BETWEEN 0 AND 8640000000000000),
  CHECK((status='pending' AND next_attempt_at IS NOT NULL AND lease_token IS NULL AND lease_until IS NULL AND cycle_attempts=0 AND error_code IS NULL)
    OR (status='in_flight' AND next_attempt_at IS NULL AND lease_token IS NOT NULL AND lease_until IS NOT NULL AND cycle_attempts BETWEEN 1 AND 8)
    OR (status='retry' AND next_attempt_at IS NOT NULL AND lease_token IS NULL AND lease_until IS NULL AND cycle_attempts BETWEEN 1 AND 7 AND error_code IS NOT NULL)
    OR (status='succeeded' AND next_attempt_at IS NULL AND lease_token IS NULL AND lease_until IS NULL AND error_code IS NULL AND cycle_attempts>=1)
    OR (status IN ('failed','needs_review') AND next_attempt_at IS NULL AND lease_token IS NULL AND lease_until IS NULL AND error_code IS NOT NULL))
);
ALTER TABLE issuer_cards ADD CONSTRAINT issuer_cards_last_command FOREIGN KEY(last_command_id) REFERENCES issuer_outbox(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX issuer_one_unresolved_command ON issuer_outbox(card_id) WHERE status IN ('pending','in_flight','retry','needs_review');
CREATE INDEX issuer_outbox_due ON issuer_outbox(next_attempt_at,created_at,id) WHERE status IN ('pending','retry');
CREATE INDEX issuer_outbox_expired ON issuer_outbox(lease_until,created_at,id) WHERE status='in_flight';

CREATE TABLE issuer_outbox_audit (
  outbox_id TEXT NOT NULL REFERENCES issuer_outbox(id) ON DELETE RESTRICT,
  version BIGINT NOT NULL CHECK(version BETWEEN 0 AND 9007199254740991),
  kind TEXT NOT NULL CHECK(kind IN ('requested','claimed','completed','lease_exhausted','window_expired','requeued')),
  status TEXT NOT NULL,
  phase TEXT NOT NULL,
  attempt_count BIGINT NOT NULL,
  cycle_attempts INTEGER NOT NULL,
  lease_token TEXT,
  error_code TEXT,
  next_attempt_at BIGINT,
  created_at BIGINT NOT NULL CHECK(created_at BETWEEN 0 AND 8640000000000000),
  actor TEXT NOT NULL,
  PRIMARY KEY(outbox_id,version)
);
CREATE TABLE issuer_outbox_completions (
  lease_token TEXT PRIMARY KEY,
  outbox_id TEXT NOT NULL REFERENCES issuer_outbox(id) ON DELETE RESTRICT,
  canonical_input JSONB NOT NULL CHECK(jsonb_typeof(canonical_input)='object'),
  result JSONB NOT NULL CHECK(jsonb_typeof(result)='object'),
  created_at BIGINT NOT NULL CHECK(created_at BETWEEN 0 AND 8640000000000000)
);
CREATE TABLE issuer_outbox_requeues (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  outbox_id TEXT NOT NULL REFERENCES issuer_outbox(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL UNIQUE,
  canonical_input JSONB NOT NULL CHECK(jsonb_typeof(canonical_input)='object'),
  reason TEXT NOT NULL CHECK(char_length(reason) BETWEEN 10 AND 500),
  actor TEXT NOT NULL,
  created_at BIGINT NOT NULL CHECK(created_at BETWEEN 0 AND 8640000000000000),
  from_version BIGINT NOT NULL,
  to_version BIGINT NOT NULL CHECK(to_version=from_version+1),
  result JSONB NOT NULL CHECK(jsonb_typeof(result)='object'),
  UNIQUE(outbox_id,to_version)
);

CREATE FUNCTION issuer_outbox_clock(p_now BIGINT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF p_now IS NULL OR p_now NOT BETWEEN 0 AND 8639999913600000 THEN RAISE EXCEPTION 'INVALID_OUTBOX_COMMAND' USING ERRCODE='22023'; END IF;
END;
$$;
CREATE FUNCTION issuer_outbox_object(p_input JSONB,p_keys TEXT[]) RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF p_input IS NULL OR jsonb_typeof(p_input)<>'object' OR octet_length(p_input::text)>16384 THEN RETURN FALSE; END IF;
  RETURN p_input ?& p_keys AND (SELECT count(*) FROM jsonb_object_keys(p_input))=cardinality(p_keys);
END;
$$;
CREATE FUNCTION issuer_outbox_text(p_input JSONB,p_key TEXT,p_pattern TEXT) RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(jsonb_typeof(p_input->p_key)='string' AND p_input->>p_key ~ p_pattern,FALSE);
$$;
CREATE FUNCTION issuer_outbox_version(p_input JSONB,p_key TEXT,p_min BIGINT) RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF jsonb_typeof(p_input->p_key) IS DISTINCT FROM 'number' OR p_input->>p_key !~ '^[0-9]+$' THEN RETURN FALSE; END IF;
  RETURN (p_input->>p_key)::NUMERIC BETWEEN p_min AND 9007199254740991;
END;
$$;

CREATE FUNCTION issuer_outbox_guard() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE action TEXT:=nullif(current_setting('aqua.issuer_action',true),'');
BEGIN
  IF current_user IS DISTINCT FROM pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=TG_RELID)) THEN
    RAISE EXCEPTION 'Issuer state is protected' USING ERRCODE='55000';
  END IF;
  IF TG_TABLE_NAME='issuer_cards' THEN
    IF TG_OP='INSERT' THEN
      IF action IS DISTINCT FROM 'register' OR NEW.version<>1 OR NEW.last_command_id IS NOT NULL
        OR NEW.desired_status<>NEW.initial_status OR NEW.confirmed_status<>NEW.initial_status OR NEW.updated_at<>NEW.created_at THEN
        RAISE EXCEPTION 'Invalid initial issuer card' USING ERRCODE='55000'; END IF;
    ELSE
      IF ROW(NEW.id,NEW.user_id,NEW.provider,NEW.provider_card_id,NEW.initial_status,NEW.created_at)
        IS DISTINCT FROM ROW(OLD.id,OLD.user_id,OLD.provider,OLD.provider_card_id,OLD.initial_status,OLD.created_at)
        OR NEW.version<>OLD.version+1 OR NEW.updated_at<OLD.updated_at THEN
        RAISE EXCEPTION 'Issuer identity is immutable' USING ERRCODE='55000'; END IF;
      IF action='request' THEN
        IF NEW.confirmed_status<>OLD.confirmed_status OR NEW.last_command_id IS NULL OR NEW.last_command_id IS NOT DISTINCT FROM OLD.last_command_id THEN
          RAISE EXCEPTION 'Issuer request cannot confirm state' USING ERRCODE='55000'; END IF;
      ELSIF action IN ('finish','claim') THEN
        IF NEW.desired_status<>OLD.desired_status OR NEW.last_command_id IS DISTINCT FROM OLD.last_command_id
          OR (NEW.confirmed_status<>OLD.confirmed_status AND NOT EXISTS(SELECT 1 FROM issuer_outbox o
            WHERE o.id=NEW.last_command_id AND o.status='succeeded' AND o.target_status=NEW.confirmed_status)) THEN
          RAISE EXCEPTION 'Issuer confirmation requires success' USING ERRCODE='55000'; END IF;
      ELSE RAISE EXCEPTION 'Issuer state requires a command' USING ERRCODE='55000'; END IF;
    END IF;
  ELSIF TG_TABLE_NAME='issuer_outbox' THEN
    IF TG_OP='INSERT' THEN
      IF action IS DISTINCT FROM 'request' OR NEW.version<>0 OR NEW.attempt_count<>0 OR NEW.cycle_attempts<>0
        OR NEW.status<>'pending' OR NEW.phase<>'send' OR NEW.updated_at<>NEW.created_at OR NEW.next_attempt_at IS DISTINCT FROM NEW.created_at THEN
        RAISE EXCEPTION 'Invalid initial issuer command' USING ERRCODE='55000'; END IF;
    ELSE
      IF ROW(NEW.id,NEW.card_id,NEW.user_id,NEW.idempotency_key,NEW.canonical_input,NEW.receipt,NEW.request_key,NEW.target_status,NEW.created_at,NEW.expires_at)
        IS DISTINCT FROM ROW(OLD.id,OLD.card_id,OLD.user_id,OLD.idempotency_key,OLD.canonical_input,OLD.receipt,OLD.request_key,OLD.target_status,OLD.created_at,OLD.expires_at)
        OR OLD.status IN ('succeeded','failed') OR NEW.version<>OLD.version+1 OR NEW.updated_at<OLD.updated_at THEN
        RAISE EXCEPTION 'Issuer command identity and final results are immutable' USING ERRCODE='55000'; END IF;
      IF action='claim' THEN
        IF OLD.status NOT IN ('pending','retry','in_flight') OR NEW.status NOT IN ('in_flight','needs_review')
          OR (NEW.status='in_flight' AND (NEW.attempt_count<>OLD.attempt_count+1 OR NEW.cycle_attempts<>OLD.cycle_attempts+1))
          OR (NEW.status='needs_review' AND (NEW.attempt_count<>OLD.attempt_count OR NEW.cycle_attempts<>OLD.cycle_attempts)) THEN
          RAISE EXCEPTION 'Invalid issuer claim' USING ERRCODE='55000'; END IF;
      ELSIF action='finish' THEN
        IF OLD.status<>'in_flight' OR NEW.status NOT IN ('retry','succeeded','failed','needs_review')
          OR NEW.attempt_count<>OLD.attempt_count OR NEW.cycle_attempts<>OLD.cycle_attempts THEN
          RAISE EXCEPTION 'Invalid issuer completion' USING ERRCODE='55000'; END IF;
      ELSIF action='requeue' THEN
        IF OLD.status<>'needs_review' OR NEW.status<>'pending' OR NEW.phase<>'lookup'
          OR NEW.attempt_count<>OLD.attempt_count OR NEW.cycle_attempts<>0 THEN RAISE EXCEPTION 'Invalid issuer recovery' USING ERRCODE='55000'; END IF;
      ELSE RAISE EXCEPTION 'Issuer transition requires a command' USING ERRCODE='55000'; END IF;
    END IF;
  ELSIF TG_TABLE_NAME='issuer_outbox_completions' THEN
    IF action IS DISTINCT FROM 'finish' THEN RAISE EXCEPTION 'Issuer completion history is protected' USING ERRCODE='55000'; END IF;
  ELSIF TG_TABLE_NAME='issuer_outbox_requeues' THEN
    IF action IS DISTINCT FROM 'requeue' OR NEW.actor IS DISTINCT FROM session_user THEN RAISE EXCEPTION 'Issuer recovery history is protected' USING ERRCODE='55000'; END IF;
  ELSIF action NOT IN ('request','claim','finish','requeue') OR action IS NULL OR NEW.actor IS DISTINCT FROM session_user THEN
    RAISE EXCEPTION 'Issuer audit history is protected' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['issuer_cards','issuer_outbox','issuer_outbox_audit','issuer_outbox_completions','issuer_outbox_requeues'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT%s ON %I FOR EACH ROW EXECUTE FUNCTION issuer_outbox_guard()',t||'_guard',CASE WHEN t IN ('issuer_cards','issuer_outbox') THEN ' OR UPDATE' ELSE '' END,t);
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION ledger_reject_history_change()',t||'_no_delete',t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION ledger_reject_history_change()',t||'_no_truncate',t);
    IF t NOT IN ('issuer_cards','issuer_outbox') THEN EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION ledger_reject_history_change()',t||'_immutable',t); END IF;
  END LOOP;
END; $$;

CREATE FUNCTION issuer_outbox_record_audit(p_id TEXT,p_kind TEXT,p_now BIGINT) RETURNS VOID LANGUAGE sql SET search_path FROM CURRENT AS $$
  INSERT INTO issuer_outbox_audit(outbox_id,version,kind,status,phase,attempt_count,cycle_attempts,lease_token,error_code,next_attempt_at,created_at,actor)
    SELECT id,version,p_kind,status,phase,attempt_count,cycle_attempts,lease_token,error_code,next_attempt_at,p_now,session_user FROM issuer_outbox WHERE id=p_id;
$$;
CREATE FUNCTION issuer_outbox_require_audit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE o issuer_outbox%ROWTYPE; c issuer_cards%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME='issuer_cards' THEN
    SELECT * INTO c FROM issuer_cards WHERE id=NEW.id;
    IF c.last_command_id IS NULL THEN RETURN NULL; END IF;
    SELECT * INTO o FROM issuer_outbox WHERE id=c.last_command_id;
    IF o.card_id IS DISTINCT FROM c.id OR o.user_id IS DISTINCT FROM c.user_id OR o.target_status IS DISTINCT FROM c.desired_status
      OR (o.status='succeeded' AND o.target_status<>c.confirmed_status) THEN RAISE EXCEPTION 'OUTBOX_TRANSITION_INCOMPLETE' USING ERRCODE='23514'; END IF;
  ELSE
    SELECT * INTO o FROM issuer_outbox WHERE id=NEW.id;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM issuer_outbox_audit a WHERE a.outbox_id=o.id AND a.version=o.version
    AND a.status=o.status AND a.phase=o.phase AND a.attempt_count=o.attempt_count AND a.cycle_attempts=o.cycle_attempts
    AND a.lease_token IS NOT DISTINCT FROM o.lease_token AND a.error_code IS NOT DISTINCT FROM o.error_code
    AND a.next_attempt_at IS NOT DISTINCT FROM o.next_attempt_at) THEN RAISE EXCEPTION 'OUTBOX_TRANSITION_INCOMPLETE' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER issuer_outbox_transition_complete AFTER INSERT OR UPDATE ON issuer_outbox
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION issuer_outbox_require_audit();
CREATE CONSTRAINT TRIGGER issuer_card_transition_complete AFTER INSERT OR UPDATE ON issuer_cards
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION issuer_outbox_require_audit();

CREATE FUNCTION register_sandbox_issuer_card(p_input JSONB,p_now BIGINT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE c issuer_cards%ROWTYPE; prior_context TEXT:=current_setting('aqua.issuer_action',true);
BEGIN
  PERFORM issuer_outbox_clock(p_now);
  IF NOT issuer_outbox_object(p_input,ARRAY['userId','providerCardId','initialStatus'])
    OR NOT issuer_outbox_text(p_input,'userId','^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
    OR NOT issuer_outbox_text(p_input,'providerCardId','^sandbox-card-[A-Za-z0-9_-]{1,100}$')
    OR NOT issuer_outbox_text(p_input,'initialStatus','^(active|locked)$') THEN RAISE EXCEPTION 'INVALID_OUTBOX_COMMAND' USING ERRCODE='22023'; END IF;
  PERFORM id FROM users WHERE id=p_input->>'userId' FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'OUTBOX_CARD_NOT_FOUND'; END IF;
  SELECT * INTO c FROM issuer_cards WHERE user_id=p_input->>'userId';
  IF FOUND THEN
    IF c.provider_card_id<>p_input->>'providerCardId' OR c.initial_status<>p_input->>'initialStatus' THEN RAISE EXCEPTION 'OUTBOX_CARD_CONFLICT'; END IF;
    RETURN jsonb_build_object('cardId',c.id);
  END IF;
  IF EXISTS(SELECT 1 FROM issuer_cards WHERE provider_card_id=p_input->>'providerCardId') THEN RAISE EXCEPTION 'OUTBOX_CARD_CONFLICT'; END IF;
  PERFORM set_config('aqua.issuer_action','register',true);
  INSERT INTO issuer_cards(user_id,provider_card_id,initial_status,desired_status,confirmed_status,created_at,updated_at)
    VALUES(p_input->>'userId',p_input->>'providerCardId',p_input->>'initialStatus',p_input->>'initialStatus',p_input->>'initialStatus',p_now,p_now) RETURNING * INTO c;
  PERFORM set_config('aqua.issuer_action',coalesce(prior_context,''),true);
  RETURN jsonb_build_object('cardId',c.id);
END;
$$;

CREATE FUNCTION issuer_card_snapshot(p_user TEXT) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE answer JSONB;
BEGIN
  IF p_user IS NULL OR p_user !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN RAISE EXCEPTION 'INVALID_OUTBOX_COMMAND' USING ERRCODE='22023'; END IF;
  SELECT jsonb_build_object('id',c.id,'desiredStatus',c.desired_status,'confirmedStatus',c.confirmed_status,'version',c.version,'updatedAt',c.updated_at,
    'command',CASE WHEN o.id IS NULL THEN NULL ELSE jsonb_build_object('id',o.id,'status',o.status,'phase',o.phase,'attemptCount',o.attempt_count,
      'errorCode',o.error_code,'createdAt',o.created_at,'updatedAt',o.updated_at) END)
    INTO answer FROM issuer_cards c LEFT JOIN issuer_outbox o ON o.id=c.last_command_id WHERE c.user_id=p_user;
  RETURN jsonb_build_object('mode','sandbox','card',answer);
END;
$$;

CREATE FUNCTION request_issuer_card_status(p_input JSONB,p_now BIGINT) RETURNS JSONB
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

CREATE FUNCTION claim_issuer_outbox(p_now BIGINT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE selected_card TEXT; o issuer_outbox%ROWTYPE; failure TEXT; next_phase TEXT; prior_context TEXT:=current_setting('aqua.issuer_action',true);
BEGIN
  PERFORM issuer_outbox_clock(p_now);
  SELECT c.id INTO selected_card FROM issuer_cards c JOIN issuer_outbox q ON q.card_id=c.id
    WHERE (q.status IN ('pending','retry') AND q.next_attempt_at<=p_now) OR (q.status='in_flight' AND q.lease_until<=p_now)
    ORDER BY coalesce(q.next_attempt_at,q.lease_until),q.created_at,q.id FOR NO KEY UPDATE OF c SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO o FROM issuer_outbox WHERE card_id=selected_card AND
    ((status IN ('pending','retry') AND next_attempt_at<=p_now) OR (status='in_flight' AND lease_until<=p_now)) FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF o.version=9007199254740991 OR o.attempt_count=9007199254740991 THEN RAISE EXCEPTION 'OUTBOX_CAPACITY'; END IF;
  next_phase:=CASE WHEN o.status='in_flight' THEN 'lookup' ELSE o.phase END;
  IF o.cycle_attempts>=8 THEN failure:='OUTCOME_UNKNOWN';
  ELSIF next_phase='send' AND p_now>=o.expires_at THEN failure:='IDEMPOTENCY_WINDOW_EXPIRED'; END IF;
  PERFORM set_config('aqua.issuer_action','claim',true);
  IF failure IS NOT NULL THEN
    UPDATE issuer_outbox SET status='needs_review',phase='lookup',version=version+1,error_code=failure,next_attempt_at=NULL,
      lease_token=NULL,lease_until=NULL,updated_at=greatest(updated_at,p_now) WHERE id=o.id RETURNING * INTO o;
    UPDATE issuer_cards SET version=version+1,updated_at=greatest(updated_at,p_now) WHERE id=o.card_id;
    PERFORM issuer_outbox_record_audit(o.id,CASE WHEN failure='OUTCOME_UNKNOWN' THEN 'lease_exhausted' ELSE 'window_expired' END,p_now);
    PERFORM set_config('aqua.issuer_action',coalesce(prior_context,''),true);
    RETURN NULL;
  END IF;
  UPDATE issuer_outbox SET status='in_flight',phase=next_phase,version=version+1,attempt_count=attempt_count+1,cycle_attempts=cycle_attempts+1,
    lease_token=gen_random_uuid()::text,lease_until=p_now+30000,next_attempt_at=NULL,updated_at=greatest(updated_at,p_now) WHERE id=o.id RETURNING * INTO o;
  PERFORM issuer_outbox_record_audit(o.id,'claimed',p_now);
  PERFORM set_config('aqua.issuer_action',coalesce(prior_context,''),true);
  RETURN jsonb_build_object('id',o.id,'cardId',o.card_id,'providerCardId',(SELECT provider_card_id FROM issuer_cards WHERE id=o.card_id),
    'requestKey',o.request_key,'targetStatus',o.target_status,'phase',o.phase,'leaseToken',o.lease_token,'version',o.version,
    'leaseUntil',o.lease_until,'expiresAt',o.expires_at,'attemptCount',o.attempt_count);
END;
$$;

CREATE FUNCTION finish_issuer_outbox(p_input JSONB,p_now BIGINT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE o issuer_outbox%ROWTYPE; prior issuer_outbox_completions%ROWTYPE; outcome JSONB; kind TEXT; failure TEXT;
  next_status TEXT; next_phase TEXT; next_at BIGINT; answer JSONB; prior_context TEXT:=current_setting('aqua.issuer_action',true);
  delays BIGINT[]:=ARRAY[1000,5000,15000,60000,300000,900000,3600000]::BIGINT[];
BEGIN
  PERFORM issuer_outbox_clock(p_now);
  IF NOT issuer_outbox_object(p_input,ARRAY['id','leaseToken','expectedVersion','outcome'])
    OR NOT issuer_outbox_text(p_input,'id','^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    OR NOT issuer_outbox_text(p_input,'leaseToken','^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    OR NOT issuer_outbox_version(p_input,'expectedVersion',1) THEN RAISE EXCEPTION 'INVALID_OUTBOX_COMMAND' USING ERRCODE='22023'; END IF;
  outcome:=p_input->'outcome';
  IF NOT (issuer_outbox_object(outcome,ARRAY['kind']) OR issuer_outbox_object(outcome,ARRAY['kind','code']))
    OR NOT issuer_outbox_text(outcome,'kind','^(succeeded|rejected|uncertain|not_found)$') THEN RAISE EXCEPTION 'INVALID_OUTBOX_COMMAND' USING ERRCODE='22023'; END IF;
  kind:=outcome->>'kind';
  IF (kind IN ('succeeded','not_found') AND outcome ? 'code')
    OR (kind='rejected' AND outcome ? 'code' AND NOT issuer_outbox_text(outcome,'code','^(CARD_NOT_FOUND|CARD_CLOSED|COMMAND_REJECTED)$'))
    OR (kind='uncertain' AND outcome ? 'code' AND NOT issuer_outbox_text(outcome,'code','^(PROVIDER_UNAVAILABLE|PROVIDER_PENDING|PROVIDER_TIMEOUT|PROVIDER_INVALID_RESPONSE|IDEMPOTENCY_WINDOW_EXPIRED)$')) THEN
    RAISE EXCEPTION 'INVALID_OUTBOX_COMMAND' USING ERRCODE='22023'; END IF;
  SELECT * INTO prior FROM issuer_outbox_completions WHERE lease_token=p_input->>'leaseToken';
  IF FOUND THEN
    IF prior.canonical_input IS DISTINCT FROM p_input THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
    RETURN prior.result;
  END IF;
  PERFORM c.id FROM issuer_cards c JOIN issuer_outbox q ON q.card_id=c.id WHERE q.id=p_input->>'id' FOR NO KEY UPDATE OF c;
  SELECT * INTO o FROM issuer_outbox WHERE id=p_input->>'id' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'OUTBOX_CARD_NOT_FOUND'; END IF;
  SELECT * INTO prior FROM issuer_outbox_completions WHERE lease_token=p_input->>'leaseToken';
  IF FOUND THEN
    IF prior.canonical_input IS DISTINCT FROM p_input THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
    RETURN prior.result;
  END IF;
  IF o.status<>'in_flight' OR o.lease_token IS DISTINCT FROM p_input->>'leaseToken' OR o.version<>(p_input->>'expectedVersion')::BIGINT
    OR o.lease_until<=p_now THEN RAISE EXCEPTION 'OUTBOX_LEASE_LOST'; END IF;
  IF o.version=9007199254740991 THEN RAISE EXCEPTION 'OUTBOX_CAPACITY'; END IF;
  next_phase:='lookup';
  IF kind='succeeded' THEN next_status:='succeeded';
  ELSIF kind='rejected' THEN next_status:='failed'; failure:=coalesce(outcome->>'code','COMMAND_REJECTED');
  ELSE
    IF kind='not_found' THEN
      IF o.phase<>'lookup' THEN RAISE EXCEPTION 'INVALID_OUTBOX_COMMAND' USING ERRCODE='22023'; END IF;
      IF p_now>=o.expires_at THEN failure:='IDEMPOTENCY_WINDOW_EXPIRED';
      ELSE next_phase:='send'; failure:='OUTCOME_UNKNOWN'; END IF;
    ELSE failure:=coalesce(outcome->>'code','PROVIDER_UNAVAILABLE'); END IF;
    IF o.cycle_attempts>=8 OR failure='IDEMPOTENCY_WINDOW_EXPIRED' THEN next_status:='needs_review'; next_phase:='lookup';
    ELSE next_status:='retry'; next_at:=p_now+delays[o.cycle_attempts]; END IF;
  END IF;
  PERFORM set_config('aqua.issuer_action','finish',true);
  UPDATE issuer_outbox SET status=next_status,phase=next_phase,version=version+1,error_code=failure,next_attempt_at=next_at,
    lease_token=NULL,lease_until=NULL,updated_at=greatest(updated_at,p_now) WHERE id=o.id RETURNING * INTO o;
  IF next_status IN ('succeeded','failed','needs_review') THEN
    UPDATE issuer_cards SET confirmed_status=CASE WHEN next_status='succeeded' THEN o.target_status ELSE confirmed_status END,
      version=version+1,updated_at=greatest(updated_at,p_now) WHERE id=o.card_id;
  END IF;
  answer:=jsonb_build_object('id',o.id,'status',o.status,'version',o.version,'nextAttemptAt',o.next_attempt_at,'errorCode',o.error_code);
  INSERT INTO issuer_outbox_completions(lease_token,outbox_id,canonical_input,result,created_at)
    VALUES(p_input->>'leaseToken',o.id,p_input,answer,p_now);
  PERFORM issuer_outbox_record_audit(o.id,'completed',p_now);
  PERFORM set_config('aqua.issuer_action',coalesce(prior_context,''),true);
  RETURN answer;
END;
$$;

CREATE FUNCTION issuer_outbox_stats(p_now BIGINT) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE answer JSONB;
BEGIN
  PERFORM issuer_outbox_clock(p_now);
  SELECT jsonb_build_object('pending',(count(*) FILTER(WHERE status='pending'))::text,'inFlight',(count(*) FILTER(WHERE status='in_flight'))::text,
    'retry',(count(*) FILTER(WHERE status='retry'))::text,'succeeded',(count(*) FILTER(WHERE status='succeeded'))::text,
    'failed',(count(*) FILTER(WHERE status='failed'))::text,'needsReview',(count(*) FILTER(WHERE status='needs_review'))::text,
    'due',(count(*) FILTER(WHERE (status IN ('pending','retry') AND next_attempt_at<=p_now) OR (status='in_flight' AND lease_until<=p_now)))::text,
    'oldestPendingAt',min(created_at) FILTER(WHERE status IN ('pending','in_flight','retry','needs_review'))) INTO answer FROM issuer_outbox;
  RETURN answer;
END;
$$;

CREATE FUNCTION operator_retry_issuer_outbox(p_input JSONB,p_now BIGINT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE input JSONB; o issuer_outbox%ROWTYPE; prior issuer_outbox_requeues%ROWTYPE; reason_text TEXT; answer JSONB;
  prior_context TEXT:=current_setting('aqua.issuer_action',true);
BEGIN
  PERFORM issuer_outbox_clock(p_now);
  IF NOT issuer_outbox_object(p_input,ARRAY['id','expectedVersion','idempotencyKey','reason'])
    OR NOT issuer_outbox_text(p_input,'id','^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    OR NOT issuer_outbox_text(p_input,'idempotencyKey','^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
    OR NOT issuer_outbox_version(p_input,'expectedVersion',1)
    OR jsonb_typeof(p_input->'reason') IS DISTINCT FROM 'string' OR p_input->>'reason' ~ '[[:cntrl:]]' THEN RAISE EXCEPTION 'INVALID_OUTBOX_COMMAND' USING ERRCODE='22023'; END IF;
  reason_text:=regexp_replace(p_input->>'reason','^[[:space:]]+|[[:space:]]+$','','g');
  IF char_length(reason_text) NOT BETWEEN 10 AND 500 THEN RAISE EXCEPTION 'INVALID_OUTBOX_COMMAND' USING ERRCODE='22023'; END IF;
  input:=jsonb_set(p_input,'{reason}',to_jsonb(reason_text));
  -- A global operation key can target different cards; serialize it before
  -- taking a card lock so concurrent conflicting recoveries never both act.
  PERFORM pg_advisory_xact_lock(hashtextextended('aqua:issuer-requeue:'||(input->>'idempotencyKey'),0));
  SELECT * INTO prior FROM issuer_outbox_requeues WHERE idempotency_key=input->>'idempotencyKey';
  IF FOUND THEN
    IF prior.canonical_input IS DISTINCT FROM input THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
    RETURN prior.result;
  END IF;
  PERFORM c.id FROM issuer_cards c JOIN issuer_outbox q ON q.card_id=c.id WHERE q.id=input->>'id' FOR NO KEY UPDATE OF c;
  SELECT * INTO o FROM issuer_outbox WHERE id=input->>'id' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'OUTBOX_CARD_NOT_FOUND'; END IF;
  IF o.version<>(input->>'expectedVersion')::BIGINT THEN RAISE EXCEPTION 'OUTBOX_VERSION_CHANGED'; END IF;
  IF o.status<>'needs_review' THEN RAISE EXCEPTION 'OUTBOX_NOT_RETRYABLE'; END IF;
  IF o.version=9007199254740991 THEN RAISE EXCEPTION 'OUTBOX_CAPACITY'; END IF;
  PERFORM set_config('aqua.issuer_action','requeue',true);
  answer:=jsonb_build_object('id',o.id,'status','pending','version',o.version+1);
  INSERT INTO issuer_outbox_requeues(outbox_id,idempotency_key,canonical_input,reason,actor,created_at,from_version,to_version,result)
    VALUES(o.id,input->>'idempotencyKey',input,reason_text,session_user,p_now,o.version,o.version+1,answer);
  UPDATE issuer_outbox SET status='pending',phase='lookup',version=version+1,cycle_attempts=0,error_code=NULL,
    next_attempt_at=p_now,updated_at=greatest(updated_at,p_now) WHERE id=o.id;
  PERFORM issuer_outbox_record_audit(o.id,'requeued',p_now);
  PERFORM set_config('aqua.issuer_action',coalesce(prior_context,''),true);
  RETURN answer;
END;
$$;

-- Deployment grants only approved entrypoints to the API and dispatcher.
DO $$ DECLARE f record; BEGIN
  FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p WHERE p.pronamespace=current_schema()::regnamespace
    AND (p.proname LIKE 'issuer_%' OR p.proname IN ('register_sandbox_issuer_card','request_issuer_card_status','claim_issuer_outbox','finish_issuer_outbox','operator_retry_issuer_outbox'))
  LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature); END LOOP;
END; $$;
