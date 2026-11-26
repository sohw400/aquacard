-- Auth challenges and their encrypted delivery requests commit together. Only
-- the mail worker can disclose ciphertext or record transport outcomes.
CREATE TABLE auth_mail_outbox (
  id UUID PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('email-verification','password-recovery')),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  token_hash TEXT NOT NULL CHECK(token_hash ~ '^[a-f0-9]{64}$'),
  created_at BIGINT NOT NULL CHECK(created_at BETWEEN 0 AND 8639999999100000),
  expires_at BIGINT NOT NULL CHECK(expires_at>created_at AND expires_at<=created_at+900000),
  key_id TEXT, iv TEXT, auth_tag TEXT, ciphertext TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_flight','retry','sent','discarded','failed')),
  version BIGINT NOT NULL DEFAULT 1 CHECK(version BETWEEN 1 AND 9007199254740991),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 5),
  next_attempt_at BIGINT NOT NULL,
  lease_token UUID, lease_until BIGINT,
  updated_at BIGINT NOT NULL,
  error_code TEXT CHECK(error_code IN ('CHALLENGE_INACTIVE','DELIVERY_EXPIRED','DELIVERY_UNAVAILABLE','DELIVERY_REJECTED','PAYLOAD_UNAVAILABLE','KEY_UNAVAILABLE','ATTEMPTS_EXHAUSTED')),
  completed_lease UUID, completed_version BIGINT, completed_input JSONB, completed_result JSONB,
  UNIQUE(purpose,token_hash),
  CHECK ((status IN ('pending','retry','in_flight') AND key_id IS NOT NULL AND iv IS NOT NULL AND auth_tag IS NOT NULL AND ciphertext IS NOT NULL
    AND key_id ~ '^[A-Za-z0-9_-]{1,40}$'
    AND iv ~ '^[a-f0-9]{24}$' AND auth_tag ~ '^[a-f0-9]{32}$'
    AND ciphertext ~ '^[a-f0-9]+$' AND length(ciphertext) BETWEEN 2 AND 8192 AND length(ciphertext)%2=0)
    OR (status IN ('sent','discarded','failed') AND key_id IS NULL AND iv IS NULL AND auth_tag IS NULL AND ciphertext IS NULL)),
  CHECK ((status='in_flight' AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
    OR (status<>'in_flight' AND lease_token IS NULL AND lease_until IS NULL)),
  CHECK (next_attempt_at BETWEEN created_at AND 8640000000000000 AND updated_at BETWEEN created_at AND 8640000000000000),
  CHECK ((completed_lease IS NULL AND completed_version IS NULL AND completed_input IS NULL AND completed_result IS NULL)
    OR (completed_lease IS NOT NULL AND completed_version IS NOT NULL AND completed_input IS NOT NULL AND completed_result IS NOT NULL))
);
CREATE INDEX auth_mail_due ON auth_mail_outbox(next_attempt_at,created_at,id) WHERE status IN ('pending','retry','in_flight');
CREATE TABLE auth_mail_attempts (
  mail_id UUID NOT NULL REFERENCES auth_mail_outbox(id) ON DELETE RESTRICT,
  version BIGINT NOT NULL,
  attempt_count INTEGER NOT NULL,
  status TEXT NOT NULL,
  error_code TEXT,
  created_at BIGINT NOT NULL,
  actor TEXT NOT NULL,
  PRIMARY KEY(mail_id,version)
);
CREATE TRIGGER auth_mail_attempts_immutable BEFORE UPDATE OR DELETE ON auth_mail_attempts
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_history_change();
CREATE TRIGGER auth_mail_attempts_no_truncate BEFORE TRUNCATE ON auth_mail_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_reject_history_change();
CREATE TRIGGER auth_mail_no_delete BEFORE DELETE ON auth_mail_outbox
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_history_change();
CREATE TRIGGER auth_mail_no_truncate BEFORE TRUNCATE ON auth_mail_outbox
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_reject_history_change();

CREATE FUNCTION auth_mail_guard() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF current_user IS DISTINCT FROM pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=TG_RELID))
    OR current_setting('aqua.auth_mail_action',true) IS DISTINCT FROM 'write' THEN
    RAISE EXCEPTION 'Auth mail state is protected' USING ERRCODE='55000';
  END IF;
  IF TG_OP='UPDATE' AND (ROW(NEW.id,NEW.purpose,NEW.user_id,NEW.token_hash,NEW.created_at,NEW.expires_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.purpose,OLD.user_id,OLD.token_hash,OLD.created_at,OLD.expires_at)
    OR NEW.version<>OLD.version+1 OR OLD.status IN ('sent','discarded','failed')) THEN
    RAISE EXCEPTION 'Auth mail identity and final outcomes are immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER auth_mail_guard BEFORE INSERT OR UPDATE ON auth_mail_outbox
  FOR EACH ROW EXECUTE FUNCTION auth_mail_guard();
CREATE FUNCTION auth_mail_audit() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
BEGIN
  INSERT INTO auth_mail_attempts(mail_id,version,attempt_count,status,error_code,created_at,actor)
    VALUES(NEW.id,NEW.version,NEW.attempt_count,NEW.status,NEW.error_code,NEW.updated_at,session_user);
  RETURN NULL;
END;
$$;
CREATE TRIGGER auth_mail_audit AFTER INSERT OR UPDATE ON auth_mail_outbox
  FOR EACH ROW EXECUTE FUNCTION auth_mail_audit();

CREATE FUNCTION auth_mail_challenge_valid(p_purpose TEXT,p_user TEXT,p_hash TEXT,p_created BIGINT,p_expiry BIGINT,p_now BIGINT)
RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
  SELECT p_expiry>p_now AND CASE p_purpose
    WHEN 'password-recovery' THEN EXISTS(SELECT 1 FROM auth_recovery c WHERE c.token_hash=p_hash AND c.user_id=p_user
      AND c.created_at=p_created AND c.expires_at=p_expiry AND c.used_at IS NULL)
    WHEN 'email-verification' THEN EXISTS(SELECT 1 FROM auth_email_verification c JOIN users u ON u.id=c.user_id
      WHERE c.token_hash=p_hash AND c.user_id=p_user AND c.email=u.email AND u.email_verified_at IS NULL
        AND c.created_at=p_created AND c.expires_at=p_expiry AND c.used_at IS NULL)
    ELSE false END;
$$;

CREATE FUNCTION enqueue_auth_mail(p JSONB) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE row auth_mail_outbox%ROWTYPE; created BIGINT; expiry BIGINT; prior TEXT:=current_setting('aqua.auth_mail_action',true);
BEGIN
  IF NOT issuer_outbox_object(p,ARRAY['id','purpose','userId','tokenHash','keyId','iv','tag','ciphertext','createdAt','expiresAt'])
    OR NOT issuer_outbox_text(p,'id','^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')
    OR NOT issuer_outbox_text(p,'purpose','^(email-verification|password-recovery)$')
    OR NOT issuer_outbox_text(p,'userId','^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
    OR NOT issuer_outbox_text(p,'tokenHash','^[a-f0-9]{64}$')
    OR NOT issuer_outbox_text(p,'keyId','^[A-Za-z0-9_-]{1,40}$')
    OR NOT issuer_outbox_text(p,'iv','^[a-f0-9]{24}$') OR NOT issuer_outbox_text(p,'tag','^[a-f0-9]{32}$')
    OR NOT issuer_outbox_text(p,'ciphertext','^[a-f0-9]+$') OR length(p->>'ciphertext') NOT BETWEEN 2 AND 8192 OR length(p->>'ciphertext')%2<>0
    OR NOT issuer_outbox_version(p,'createdAt',0) OR NOT issuer_outbox_version(p,'expiresAt',1) THEN
    RAISE EXCEPTION 'INVALID_AUTH_MAIL' USING ERRCODE='22023';
  END IF;
  created:=(p->>'createdAt')::BIGINT; expiry:=(p->>'expiresAt')::BIGINT;
  IF created>8639999999100000 OR expiry<=created OR expiry>created+900000
    OR NOT auth_mail_challenge_valid(p->>'purpose',p->>'userId',p->>'tokenHash',created,expiry,created) THEN
    RAISE EXCEPTION 'INVALID_AUTH_MAIL' USING ERRCODE='22023';
  END IF;
  -- Issuers lock the user before challenge replacement. The hash uniqueness also
  -- prevents a repeated queue call from creating multiple messages for one token.
  SELECT * INTO row FROM auth_mail_outbox WHERE purpose=p->>'purpose' AND token_hash=p->>'tokenHash';
  IF FOUND THEN
    IF ROW(row.user_id,row.created_at,row.expires_at) IS DISTINCT FROM ROW(p->>'userId',created,expiry) THEN
      RAISE EXCEPTION 'INVALID_AUTH_MAIL' USING ERRCODE='22023';
    END IF;
    RETURN row.id;
  END IF;
  PERFORM set_config('aqua.auth_mail_action','write',true);
  INSERT INTO auth_mail_outbox(id,purpose,user_id,token_hash,created_at,expires_at,key_id,iv,auth_tag,ciphertext,next_attempt_at,updated_at)
    VALUES((p->>'id')::UUID,p->>'purpose',p->>'userId',p->>'tokenHash',created,expiry,p->>'keyId',p->>'iv',p->>'tag',p->>'ciphertext',created,created);
  PERFORM set_config('aqua.auth_mail_action',coalesce(prior,''),true);
  RETURN (p->>'id')::UUID;
END;
$$;

CREATE FUNCTION claim_auth_mail(p_now BIGINT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE row auth_mail_outbox%ROWTYPE; prior TEXT:=current_setting('aqua.auth_mail_action',true); reason TEXT; visited INTEGER:=0;
BEGIN
  IF p_now IS NULL OR p_now NOT BETWEEN 0 AND 8639999999970000 THEN RAISE EXCEPTION 'INVALID_AUTH_MAIL' USING ERRCODE='22023'; END IF;
  FOR row IN SELECT * FROM auth_mail_outbox WHERE status IN ('pending','retry','in_flight')
    AND next_attempt_at<=p_now AND (status<>'in_flight' OR lease_until<=p_now)
    ORDER BY next_attempt_at,created_at,id FOR UPDATE SKIP LOCKED LIMIT 64 LOOP
    visited:=visited+1;
    reason:=NULL;
    IF row.expires_at<=p_now THEN reason:='DELIVERY_EXPIRED';
    ELSIF NOT auth_mail_challenge_valid(row.purpose,row.user_id,row.token_hash,row.created_at,row.expires_at,p_now) THEN reason:='CHALLENGE_INACTIVE';
    ELSIF row.attempt_count>=5 THEN reason:='ATTEMPTS_EXHAUSTED'; END IF;
    PERFORM set_config('aqua.auth_mail_action','write',true);
    IF reason IS NOT NULL THEN
      UPDATE auth_mail_outbox SET status=CASE WHEN reason='ATTEMPTS_EXHAUSTED' THEN 'failed' ELSE 'discarded' END,
        version=version+1,key_id=NULL,iv=NULL,auth_tag=NULL,ciphertext=NULL,lease_token=NULL,lease_until=NULL,
        error_code=reason,updated_at=greatest(updated_at,p_now) WHERE id=row.id;
      CONTINUE;
    END IF;
    -- Reserve an attempt before exposing the payload. A crashed sender must
    -- count even if its previous attempt was waiting for a rotation key.
    UPDATE auth_mail_outbox SET status='in_flight',version=version+1,attempt_count=attempt_count+1,
      lease_token=gen_random_uuid(),lease_until=least(p_now+30000,expires_at),next_attempt_at=least(p_now+30000,expires_at),
      error_code=NULL,updated_at=greatest(updated_at,p_now) WHERE id=row.id RETURNING * INTO row;
    PERFORM set_config('aqua.auth_mail_action',coalesce(prior,''),true);
    RETURN jsonb_build_object('id',row.id,'purpose',row.purpose,'userId',row.user_id,'tokenHash',row.token_hash,
      'createdAt',row.created_at,'expiresAt',row.expires_at,'keyId',row.key_id,'iv',row.iv,'tag',row.auth_tag,'ciphertext',row.ciphertext,
      'leaseToken',row.lease_token,'leaseUntil',row.lease_until,'version',row.version,'attemptCount',row.attempt_count);
  END LOOP;
  PERFORM set_config('aqua.auth_mail_action',coalesce(prior,''),true);
  RETURN NULL;
END;
$$;

CREATE FUNCTION finish_auth_mail(p JSONB,p_now BIGINT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE row auth_mail_outbox%ROWTYPE; answer JSONB; target TEXT; error TEXT; next_at BIGINT; attempts INTEGER;
  prior TEXT:=current_setting('aqua.auth_mail_action',true); delays BIGINT[]:=ARRAY[1000,5000,15000,60000,300000]::BIGINT[];
BEGIN
  IF p_now IS NULL OR p_now NOT BETWEEN 0 AND 8639999999700000
    OR NOT issuer_outbox_object(p,ARRAY['id','leaseToken','expectedVersion','outcome','errorCode'])
    OR NOT issuer_outbox_text(p,'id','^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')
    OR NOT issuer_outbox_text(p,'leaseToken','^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')
    OR NOT issuer_outbox_version(p,'expectedVersion',1)
    OR NOT issuer_outbox_text(p,'outcome','^(sent|retry|failed)$')
    OR NOT ((p->>'outcome'='sent' AND p->'errorCode'='null'::JSONB)
      OR (p->>'outcome'<>'sent' AND issuer_outbox_text(p,'errorCode','^(DELIVERY_UNAVAILABLE|DELIVERY_REJECTED|PAYLOAD_UNAVAILABLE|KEY_UNAVAILABLE)$'))) THEN
    RAISE EXCEPTION 'INVALID_AUTH_MAIL' USING ERRCODE='22023';
  END IF;
  SELECT * INTO row FROM auth_mail_outbox WHERE id=(p->>'id')::UUID FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_MAIL_LEASE_LOST'; END IF;
  IF row.completed_lease=(p->>'leaseToken')::UUID AND row.completed_version=(p->>'expectedVersion')::BIGINT THEN
    IF row.completed_input IS DISTINCT FROM p THEN RAISE EXCEPTION 'AUTH_MAIL_COMPLETION_CONFLICT'; END IF;
    RETURN row.completed_result;
  END IF;
  IF row.status<>'in_flight' OR row.version<>(p->>'expectedVersion')::BIGINT
    OR row.lease_token<>(p->>'leaseToken')::UUID OR row.lease_until<=p_now THEN RAISE EXCEPTION 'AUTH_MAIL_LEASE_LOST'; END IF;
  target:=p->>'outcome'; error:=p->>'errorCode'; next_at:=p_now; attempts:=row.attempt_count;
  IF target='retry' THEN
    -- The worker proves no provider call occurred on a missing decryption key.
    -- Refund this reservation once; completed_input/result fences duplicate finishes.
    IF error='KEY_UNAVAILABLE' THEN next_at:=least(row.expires_at,p_now+30000); attempts:=attempts-1;
    ELSIF row.attempt_count>=5 THEN target:='failed'; error:='ATTEMPTS_EXHAUSTED';
    ELSE next_at:=least(row.expires_at,p_now+delays[row.attempt_count]); END IF;
  END IF;
  answer:=jsonb_build_object('id',row.id,'status',target,'version',row.version+1,'attemptCount',attempts,'errorCode',error);
  PERFORM set_config('aqua.auth_mail_action','write',true);
  UPDATE auth_mail_outbox SET status=target,version=version+1,attempt_count=attempts,next_attempt_at=greatest(created_at,next_at),
    key_id=CASE WHEN target='retry' THEN key_id ELSE NULL END,iv=CASE WHEN target='retry' THEN iv ELSE NULL END,
    auth_tag=CASE WHEN target='retry' THEN auth_tag ELSE NULL END,ciphertext=CASE WHEN target='retry' THEN ciphertext ELSE NULL END,
    lease_token=NULL,lease_until=NULL,error_code=error,updated_at=greatest(updated_at,p_now),
    completed_lease=(p->>'leaseToken')::UUID,completed_version=(p->>'expectedVersion')::BIGINT,
    completed_input=p,completed_result=answer WHERE id=row.id;
  PERFORM set_config('aqua.auth_mail_action',coalesce(prior,''),true);
  RETURN answer;
END;
$$;

CREATE FUNCTION auth_mail_stats(p_now BIGINT) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE answer JSONB;
BEGIN
  IF p_now IS NULL OR p_now NOT BETWEEN 0 AND 8640000000000000 THEN RAISE EXCEPTION 'INVALID_AUTH_MAIL' USING ERRCODE='22023'; END IF;
  SELECT jsonb_build_object('pending',count(*) FILTER(WHERE status='pending')::TEXT,
    'inFlight',count(*) FILTER(WHERE status='in_flight')::TEXT,'retry',count(*) FILTER(WHERE status='retry')::TEXT,
    'sent',count(*) FILTER(WHERE status='sent')::TEXT,'discarded',count(*) FILTER(WHERE status='discarded')::TEXT,
    'failed',count(*) FILTER(WHERE status='failed')::TEXT,
    'due',count(*) FILTER(WHERE status IN ('pending','retry','in_flight') AND next_attempt_at<=p_now)::TEXT,
    'oldestPendingAt',min(created_at) FILTER(WHERE status IN ('pending','retry','in_flight')))
    INTO answer FROM auth_mail_outbox;
  RETURN answer;
END;
$$;
REVOKE ALL ON auth_mail_outbox,auth_mail_attempts FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_mail_guard(),auth_mail_audit(),auth_mail_challenge_valid(TEXT,TEXT,TEXT,BIGINT,BIGINT,BIGINT),
  enqueue_auth_mail(JSONB),claim_auth_mail(BIGINT),finish_auth_mail(JSONB,BIGINT),auth_mail_stats(BIGINT) FROM PUBLIC;
