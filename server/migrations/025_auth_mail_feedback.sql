-- One recipient per Aqua auth email. Address changes are forbidden by the
-- users email-identity guard. Never persist raw provider envelopes or email addresses.
CREATE TABLE auth_mail_feedback_events (
  event_id TEXT PRIMARY KEY CHECK(event_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'),
  mail_id UUID NOT NULL REFERENCES auth_mail_outbox(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK(kind IN ('permanent_bounce','transient_bounce','complaint','not_spam')),
  received_at BIGINT NOT NULL CHECK(received_at BETWEEN 0 AND 8640000000000000),
  actor TEXT NOT NULL
);
CREATE INDEX auth_mail_feedback_suppressed ON auth_mail_feedback_events(user_id) WHERE kind IN ('permanent_bounce','complaint');
CREATE TRIGGER auth_mail_feedback_immutable BEFORE UPDATE OR DELETE ON auth_mail_feedback_events
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_history_change();
CREATE TRIGGER auth_mail_feedback_no_truncate BEFORE TRUNCATE ON auth_mail_feedback_events
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_reject_history_change();

ALTER TABLE auth_mail_outbox DROP CONSTRAINT auth_mail_outbox_error_code_check;
ALTER TABLE auth_mail_outbox ADD CONSTRAINT auth_mail_outbox_error_code_check CHECK(error_code IN
  ('CHALLENGE_INACTIVE','DELIVERY_EXPIRED','DELIVERY_UNAVAILABLE','DELIVERY_REJECTED','PAYLOAD_UNAVAILABLE','KEY_UNAVAILABLE','ATTEMPTS_EXHAUSTED','RECIPIENT_SUPPRESSED'));

CREATE FUNCTION record_auth_mail_feedback(p JSONB,p_now BIGINT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE message auth_mail_outbox%ROWTYPE; prior auth_mail_feedback_events%ROWTYPE; address_hash TEXT;
BEGIN
  IF p_now IS NULL OR p_now NOT BETWEEN 0 AND 8640000000000000
    OR NOT issuer_outbox_object(p,ARRAY['eventId','mailId','recipientHash','kind'])
    OR NOT issuer_outbox_text(p,'eventId','^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$')
    OR NOT issuer_outbox_text(p,'mailId','^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')
    OR NOT issuer_outbox_text(p,'recipientHash','^[a-f0-9]{64}$')
    OR NOT issuer_outbox_text(p,'kind','^(permanent_bounce|transient_bounce|complaint|not_spam)$') THEN
    RAISE EXCEPTION 'INVALID_MAIL_FEEDBACK' USING ERRCODE='22023';
  END IF;
  SELECT * INTO message FROM auth_mail_outbox WHERE id=(p->>'mailId')::uuid;
  IF NOT FOUND THEN RAISE EXCEPTION 'MAIL_FEEDBACK_UNMATCHED'; END IF;
  SELECT encode(sha256(convert_to(email,'UTF8')),'hex') INTO address_hash FROM users WHERE id=message.user_id;
  IF address_hash IS DISTINCT FROM p->>'recipientHash' OR NOT EXISTS (
      SELECT 1 FROM auth_mail_attempts WHERE mail_id=message.id AND status='in_flight') THEN
    RAISE EXCEPTION 'MAIL_FEEDBACK_UNMATCHED';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(current_schema() || ':auth-mail-feedback:' || (p->>'eventId'),0));
  SELECT * INTO prior FROM auth_mail_feedback_events WHERE event_id=p->>'eventId';
  IF FOUND THEN
    IF prior.mail_id<>message.id OR prior.kind<>p->>'kind' THEN RAISE EXCEPTION 'MAIL_FEEDBACK_CONFLICT'; END IF;
  ELSE
    INSERT INTO auth_mail_feedback_events(event_id,mail_id,user_id,kind,received_at,actor)
      VALUES(p->>'eventId',message.id,message.user_id,p->>'kind',p_now,session_user) RETURNING * INTO prior;
  END IF;
  RETURN jsonb_build_object('kind',prior.kind,'receivedAt',prior.received_at,
    'suppressionEvent',prior.kind IN ('permanent_bounce','complaint'));
END;
$$;

-- Enqueue succeeds just as for any other address so callers cannot learn its
-- suppression status. Discard envelope secrets before they can enter storage.
CREATE FUNCTION discard_suppressed_auth_mail() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM auth_mail_feedback_events f WHERE f.user_id=NEW.user_id AND f.kind IN ('permanent_bounce','complaint')) THEN
    NEW.status:='discarded'; NEW.error_code:='RECIPIENT_SUPPRESSED'; NEW.key_id:=NULL;
    NEW.iv:=NULL; NEW.auth_tag:=NULL; NEW.ciphertext:=NULL;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER auth_mail_suppressed_on_enqueue BEFORE INSERT ON auth_mail_outbox FOR EACH ROW EXECUTE FUNCTION discard_suppressed_auth_mail();

CREATE OR REPLACE FUNCTION claim_auth_mail(p_now BIGINT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE row auth_mail_outbox%ROWTYPE; prior TEXT:=current_setting('aqua.auth_mail_action',true); reason TEXT; visited INTEGER:=0;
BEGIN
  IF p_now IS NULL OR p_now NOT BETWEEN 0 AND 8639999999970000 THEN RAISE EXCEPTION 'INVALID_AUTH_MAIL' USING ERRCODE='22023'; END IF;
  FOR row IN SELECT * FROM auth_mail_outbox WHERE status IN ('pending','retry','in_flight')
    AND next_attempt_at<=p_now AND (status<>'in_flight' OR lease_until<=p_now)
    ORDER BY next_attempt_at,created_at,id FOR UPDATE SKIP LOCKED LIMIT 64 LOOP
    visited:=visited+1;
    reason:=NULL;
    IF EXISTS(SELECT 1 FROM auth_mail_feedback_events f WHERE f.user_id=row.user_id AND f.kind IN ('permanent_bounce','complaint')) THEN reason:='RECIPIENT_SUPPRESSED';
    ELSIF row.expires_at<=p_now THEN reason:='DELIVERY_EXPIRED';
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

REVOKE ALL ON TABLE auth_mail_feedback_events FROM PUBLIC;
REVOKE ALL ON FUNCTION record_auth_mail_feedback(jsonb,bigint),discard_suppressed_auth_mail() FROM PUBLIC;
