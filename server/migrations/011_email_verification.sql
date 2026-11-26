-- Email ownership is independent of customer review. No existing account is
-- inferred to own its address, and verification never approves customer access.
ALTER TABLE users ADD COLUMN email_verified_at BIGINT
  CHECK(email_verified_at IS NULL OR (email_verified_at>=created_at AND email_verified_at<=8640000000000000));

CREATE TABLE auth_email_verification (
  token_hash TEXT PRIMARY KEY CHECK(token_hash ~ '^[a-f0-9]{64}$'),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL CHECK(email=lower(btrim(email)) AND char_length(email) BETWEEN 3 AND 254),
  created_at BIGINT NOT NULL CHECK(created_at BETWEEN 0 AND 8640000000000000),
  expires_at BIGINT NOT NULL CHECK(expires_at>created_at AND expires_at<=8640000000000000),
  used_at BIGINT CHECK(used_at IS NULL OR (used_at>=created_at AND used_at<expires_at))
);
CREATE INDEX auth_email_verification_user ON auth_email_verification(user_id);
CREATE INDEX auth_email_verification_expiry ON auth_email_verification(expires_at);

-- There is no address-change/reverification workflow in this release. Proof is
-- monotonic for the immutable address, so financial readers do not need user
-- row locks that could deadlock with cross-member transfer foreign keys.
CREATE FUNCTION auth_email_identity_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.email_verified_at IS NOT NULL THEN
      RAISE EXCEPTION 'Email ownership must be verified separately' USING ERRCODE='55000';
    END IF;
  ELSE
    IF NEW.email IS DISTINCT FROM OLD.email
      OR (OLD.email_verified_at IS NOT NULL AND NEW.email_verified_at IS DISTINCT FROM OLD.email_verified_at) THEN
      RAISE EXCEPTION 'Email identity and completed proof are immutable' USING ERRCODE='55000';
    END IF;
    IF OLD.email_verified_at IS NULL AND NEW.email_verified_at IS NOT NULL THEN
      -- User -> customer is the authorization/verification lock order. Customer
      -- transitions never lock users; their derived snapshots stay consistent.
      PERFORM user_id FROM customer_access WHERE user_id=NEW.id FOR SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION 'CUSTOMER_ACCESS_NOT_FOUND'; END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER users_email_identity_guard BEFORE INSERT OR UPDATE OF email,email_verified_at ON users
  FOR EACH ROW EXECUTE FUNCTION auth_email_identity_guard();

CREATE FUNCTION confirm_auth_email_verification(p_user TEXT,p_token TEXT,p_now BIGINT) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE u users%ROWTYPE; challenge auth_email_verification%ROWTYPE; verified BIGINT;
BEGIN
  IF p_user IS NULL OR char_length(p_user) NOT BETWEEN 1 AND 128
    OR p_token IS NULL OR p_token !~ '^[a-f0-9]{64}$'
    OR p_now IS NULL OR p_now NOT BETWEEN 0 AND 8640000000000000 THEN
    RAISE EXCEPTION 'INVALID_EMAIL_VERIFICATION' USING ERRCODE='22023';
  END IF;
  SELECT * INTO u FROM users WHERE id=p_user FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_EMAIL_VERIFICATION'; END IF;
  SELECT * INTO challenge FROM auth_email_verification
    WHERE token_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex') AND user_id=p_user FOR UPDATE;
  IF NOT FOUND OR challenge.email IS DISTINCT FROM u.email THEN RAISE EXCEPTION 'INVALID_EMAIL_VERIFICATION'; END IF;
  IF challenge.used_at IS NOT NULL THEN
    IF u.email_verified_at IS NULL THEN RAISE EXCEPTION 'INVALID_EMAIL_VERIFICATION'; END IF;
    -- A committed confirmation retry is deterministic even after token expiry.
    RETURN u.email_verified_at;
  END IF;
  IF challenge.created_at>p_now OR challenge.expires_at<=p_now OR u.created_at>p_now THEN
    RAISE EXCEPTION 'INVALID_EMAIL_VERIFICATION';
  END IF;
  verified:=coalesce(u.email_verified_at,p_now);
  UPDATE users SET email_verified_at=verified WHERE id=p_user;
  UPDATE auth_email_verification SET used_at=p_now WHERE token_hash=challenge.token_hash;
  RETURN verified;
END;
$$;

CREATE OR REPLACE FUNCTION customer_access_snapshot(p_user TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE answer JSONB;
BEGIN
  SELECT jsonb_build_object('status',a.status,'version',a.version,'updatedAt',a.updated_at,
    'canTransact',a.status='active' AND u.email_verified_at IS NOT NULL)
    INTO answer FROM customer_access a JOIN users u ON u.id=a.user_id WHERE a.user_id=p_user;
  IF answer IS NULL THEN RAISE EXCEPTION 'CUSTOMER_ACCESS_NOT_FOUND'; END IF;
  RETURN answer;
END;
$$;

CREATE OR REPLACE FUNCTION customer_access_require_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE a customer_access%ROWTYPE;
BEGIN
  SELECT * INTO a FROM customer_access WHERE user_id=NEW.user_id;
  -- canTransact is derived from separately verified email ownership. An old
  -- operation's immutable result remains historical after proof is completed.
  IF NOT EXISTS(SELECT 1 FROM customer_access_events e WHERE e.user_id=a.user_id AND e.version=a.version
    AND e.status=a.status AND e.created_at=a.updated_at
    AND e.result-'canTransact'=customer_access_snapshot(a.user_id)-'canTransact') THEN
    RAISE EXCEPTION 'CUSTOMER_ACCESS_AUDIT_INCOMPLETE' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION customer_require_active(p_users TEXT[]) RETURNS VOID
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
  IF EXISTS(SELECT 1 FROM users WHERE id=ANY(p_users) AND email_verified_at IS NULL) THEN
    RAISE EXCEPTION 'EMAIL_VERIFICATION_REQUIRED';
  END IF;
END;
$$;

-- Old decisions and report payloads remain untouched. New decisions attest the
-- proof observed at evaluation time, independently of provider receipt time.
ALTER TABLE card_authorization_decisions ADD COLUMN email_verified_at BIGINT
  CHECK(email_verified_at IS NULL OR email_verified_at BETWEEN 0 AND 8640000000000000);
ALTER TABLE card_authorization_decisions DROP CONSTRAINT card_authorization_decisions_reason_check;
ALTER TABLE card_authorization_decisions ADD CONSTRAINT card_authorization_decisions_reason_check
  CHECK(reason IN ('CARD_NOT_ISSUED','CARD_LOCKED','CARD_STATUS_UNCONFIRMED','CUSTOMER_ACCESS_REQUIRED','EMAIL_VERIFICATION_REQUIRED'));
ALTER TABLE card_authorization_decisions DROP CONSTRAINT card_authorization_decisions_policy_version_check;
ALTER TABLE card_authorization_decisions ADD CONSTRAINT card_authorization_decisions_policy_version_check CHECK(policy_version IN (1,2,3));
ALTER TABLE card_authorization_decisions DROP CONSTRAINT card_authorization_customer_snapshot;
ALTER TABLE card_authorization_decisions ADD CONSTRAINT card_authorization_customer_snapshot CHECK(
  (policy_version=1 AND customer_status IS NULL AND customer_version IS NULL)
  OR (policy_version IN (2,3) AND customer_status IS NOT NULL AND customer_version IS NOT NULL));
ALTER TABLE card_authorization_decisions ADD CONSTRAINT card_authorization_email_snapshot CHECK(
  (policy_version<3 AND email_verified_at IS NULL)
  OR (policy_version=3 AND (decision<>'approved' OR email_verified_at IS NOT NULL)));


CREATE OR REPLACE FUNCTION card_authorization_guard() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE c issuer_cards%ROWTYPE; command_state TEXT; expected_reason TEXT; access customer_access%ROWTYPE; verified BIGINT;
BEGIN
  IF current_user IS DISTINCT FROM pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=TG_RELID))
    OR current_setting('aqua.card_authorization_event_id',true) IS DISTINCT FROM NEW.event_id
    OR NEW.actor IS DISTINCT FROM session_user
    OR NEW.canonical_input IS DISTINCT FROM reward_card_canonical(NEW.canonical_input) THEN
    RAISE EXCEPTION 'Card authorization decisions are protected' USING ERRCODE='55000';
  END IF;
  SELECT email_verified_at INTO verified FROM users WHERE id=NEW.user_id;
  SELECT * INTO access FROM customer_access WHERE user_id=NEW.user_id;
  SELECT * INTO c FROM issuer_cards WHERE user_id=NEW.user_id;
  IF c.id IS NULL THEN expected_reason:='CARD_NOT_ISSUED';
  ELSE
    SELECT status INTO command_state FROM issuer_outbox WHERE id=c.last_command_id;
    IF access.status IS DISTINCT FROM 'active' THEN expected_reason:='CUSTOMER_ACCESS_REQUIRED';
    ELSIF verified IS NULL THEN expected_reason:='EMAIL_VERIFICATION_REQUIRED';
    ELSIF c.desired_status='locked' OR c.confirmed_status='locked' THEN expected_reason:='CARD_LOCKED';
    ELSIF c.last_command_id IS NOT NULL AND command_state IS DISTINCT FROM 'succeeded' THEN expected_reason:='CARD_STATUS_UNCONFIRMED';
    END IF;
  END IF;
  IF NEW.policy_version<>3 OR NEW.email_verified_at IS DISTINCT FROM verified OR ROW(NEW.customer_status,NEW.customer_version) IS DISTINCT FROM ROW(access.status,access.version)
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

REVOKE ALL ON auth_email_verification FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_email_identity_guard(),confirm_auth_email_verification(TEXT,TEXT,BIGINT) FROM PUBLIC;

-- Runtime cleanup must not need UPDATE privileges over proof consumption.
-- Short-lived row locks are confined to this bounded statement; consumed
-- challenges stay available for deterministic confirmation retries.
CREATE FUNCTION cleanup_auth_email_verification(p_now BIGINT) RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE removed INTEGER;
BEGIN
  IF p_now IS NULL OR p_now NOT BETWEEN 0 AND 8640000000000000 THEN
    RAISE EXCEPTION 'INVALID_CLOCK' USING ERRCODE='22023';
  END IF;
  DELETE FROM auth_email_verification WHERE token_hash IN (
    SELECT token_hash FROM auth_email_verification WHERE expires_at<=p_now AND used_at IS NULL
    ORDER BY expires_at,token_hash LIMIT 256 FOR UPDATE SKIP LOCKED
  );
  GET DIAGNOSTICS removed=ROW_COUNT;
  RETURN removed;
END;
$$;
REVOKE ALL ON FUNCTION cleanup_auth_email_verification(BIGINT) FROM PUBLIC;
