-- One submitted application can be completed by independent sandbox issuer
-- events. A spendable issuer card only exists after the member activates it.
CREATE TABLE card_applications (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  submitted_no BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id),
  form TEXT NOT NULL CHECK(form IN ('virtual','physical')),
  status TEXT NOT NULL CHECK(status IN ('submitted','approved','declined','issued','dispatched','delivered','active')),
  version INTEGER NOT NULL CHECK(version BETWEEN 1 AND 6),
  reason TEXT CHECK(reason IN ('ELIGIBILITY','DETAILS_REQUIRED')),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL CHECK(updated_at>=created_at),
  CHECK((status='declined')=(reason IS NOT NULL)),
  CHECK(form='physical' OR status NOT IN ('dispatched','delivered'))
);
CREATE INDEX card_applications_member ON card_applications(user_id,submitted_no DESC);
CREATE UNIQUE INDEX card_applications_live ON card_applications(user_id) WHERE status<>'declined';
CREATE TABLE card_application_events (
  application_id TEXT NOT NULL REFERENCES card_applications(id),
  version INTEGER NOT NULL,
  scope TEXT NOT NULL,
  request_key TEXT NOT NULL,
  command TEXT NOT NULL CHECK(command IN ('submit','activate','approve','decline','issue','dispatch','deliver')),
  canonical_input JSONB NOT NULL,
  result JSONB NOT NULL,
  actor TEXT NOT NULL,
  recorded_at BIGINT NOT NULL,
  PRIMARY KEY(application_id,version),
  UNIQUE(scope,request_key)
);
CREATE TRIGGER card_application_events_immutable BEFORE UPDATE OR DELETE ON card_application_events FOR EACH ROW EXECUTE FUNCTION ledger_reject_history_change();
CREATE TRIGGER card_application_events_no_truncate BEFORE TRUNCATE ON card_application_events FOR EACH STATEMENT EXECUTE FUNCTION ledger_reject_history_change();
CREATE TRIGGER card_applications_no_delete BEFORE DELETE ON card_applications FOR EACH ROW EXECUTE FUNCTION ledger_reject_history_change();
CREATE TRIGGER card_applications_no_truncate BEFORE TRUNCATE ON card_applications FOR EACH STATEMENT EXECUTE FUNCTION ledger_reject_history_change();

CREATE FUNCTION card_application_payload(a card_applications) RETURNS JSONB LANGUAGE sql IMMUTABLE SET search_path FROM CURRENT AS $$
  SELECT jsonb_build_object('id',a.id,'form',a.form,'status',a.status,'version',a.version,'reason',a.reason,'createdAt',a.created_at,'updatedAt',a.updated_at);
$$;
CREATE FUNCTION card_application_require_event() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM card_application_events e WHERE e.application_id=NEW.id AND e.version=NEW.version
    AND e.result=card_application_payload(NEW)) THEN RAISE EXCEPTION 'APPLICATION_HISTORY_INCOMPLETE' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER card_application_history AFTER INSERT OR UPDATE ON card_applications
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION card_application_require_event();

-- Legacy manual sandbox registration keeps its existing behavior for members
-- without a live application. It cannot preempt a new physical delivery.
CREATE FUNCTION check_card_application_registration() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE pending TEXT;
BEGIN
  SELECT a.id INTO pending FROM card_applications a WHERE a.user_id=NEW.user_id AND a.status<>'declined';
  IF FOUND AND (NEW.provider_card_id<>'sandbox-card-'||pending
    OR current_setting('aqua.activating_application',true) IS DISTINCT FROM pending)
    THEN RAISE EXCEPTION 'OUTBOX_CARD_CONFLICT'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER card_application_registration BEFORE INSERT ON issuer_cards FOR EACH ROW EXECUTE FUNCTION check_card_application_registration();

CREATE FUNCTION member_card_application(p_user TEXT) RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
  WITH latest AS (
    SELECT a AS application FROM card_applications a WHERE a.user_id=p_user ORDER BY a.submitted_no DESC LIMIT 1
  ), eligible AS (
    SELECT EXISTS(SELECT FROM users u JOIN customer_access c ON c.user_id=u.id
      WHERE u.id=p_user AND u.email_verified_at IS NOT NULL AND c.status='active')
      AND NOT EXISTS(SELECT 1 FROM issuer_cards WHERE user_id=p_user) AS may_issue
  )
  SELECT jsonb_build_object('application',CASE WHEN (l.application).id IS NOT NULL THEN card_application_payload(l.application) END,
    'canApply',e.may_issue AND ((l.application).id IS NULL OR (l.application).status='declined'),
    'canActivate',e.may_issue AND coalesce(((l.application).form='virtual' AND (l.application).status='issued')
      OR ((l.application).form='physical' AND (l.application).status='delivered'),false))
    FROM eligible e LEFT JOIN latest l ON true;
$$;

CREATE FUNCTION card_application_command(p_source TEXT,p_input JSONB,p_now BIGINT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE member_id TEXT; action TEXT; request_scope TEXT; key_value TEXT; next_status TEXT;
  a card_applications%ROWTYPE; prior card_application_events%ROWTYPE; receipt JSONB; previous_context TEXT;
BEGIN
  PERFORM issuer_outbox_clock(p_now);
  IF p_source='provider' THEN
    action:=p_input->>'action';
    IF NOT issuer_outbox_text(p_input,'action','^(approve|decline|issue|dispatch|deliver)$')
      OR NOT issuer_outbox_text(p_input,'eventId','^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
      OR (action='decline' AND (NOT issuer_outbox_object(p_input,ARRAY['action','applicationId','expectedVersion','eventId','reason'])
        OR NOT issuer_outbox_text(p_input,'reason','^(ELIGIBILITY|DETAILS_REQUIRED)$')))
      OR (action<>'decline' AND NOT issuer_outbox_object(p_input,ARRAY['action','applicationId','expectedVersion','eventId']))
      THEN RAISE EXCEPTION 'INVALID_CARD_APPLICATION' USING ERRCODE='22023'; END IF;
    request_scope:='sandbox-issuer'; key_value:=p_input->>'eventId';
  ELSIF p_source IN ('submit','activate') THEN
    action:=p_source;
    IF NOT issuer_outbox_text(p_input,'userId','^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
      OR NOT issuer_outbox_text(p_input,'idempotencyKey','^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
      OR (action='submit' AND (NOT issuer_outbox_object(p_input,ARRAY['userId','form','idempotencyKey'])
        OR NOT issuer_outbox_text(p_input,'form','^(virtual|physical)$')))
      OR (action='activate' AND NOT issuer_outbox_object(p_input,ARRAY['userId','applicationId','expectedVersion','idempotencyKey']))
      THEN RAISE EXCEPTION 'INVALID_CARD_APPLICATION' USING ERRCODE='22023'; END IF;
    member_id:=p_input->>'userId';
    request_scope:='member:'||member_id; key_value:=p_input->>'idempotencyKey';
  ELSE RAISE EXCEPTION 'INVALID_CARD_APPLICATION' USING ERRCODE='22023'; END IF;
  IF action<>'submit' AND (NOT issuer_outbox_text(p_input,'applicationId','^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    OR NOT issuer_outbox_version(p_input,'expectedVersion',1)) THEN RAISE EXCEPTION 'INVALID_CARD_APPLICATION' USING ERRCODE='22023'; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(current_schema()||':card-app:'||request_scope||':'||key_value,0));
  SELECT * INTO prior FROM card_application_events WHERE scope=request_scope AND request_key=key_value;
  IF FOUND THEN
    IF prior.command<>action OR prior.canonical_input<>p_input THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
    RETURN prior.result;
  END IF;
  IF p_source='provider' THEN
    SELECT user_id INTO member_id FROM card_applications WHERE id=p_input->>'applicationId';
    IF NOT FOUND THEN RAISE EXCEPTION 'CARD_APPLICATION_NOT_FOUND'; END IF;
  END IF;
  -- Same member lock as manual registration and authorization. Decisions and
  -- replay receipts survive freezes, but new issuance requires eligibility.
  PERFORM id FROM users WHERE id=member_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CARD_APPLICATION_NOT_FOUND'; END IF;
  IF action<>'submit' THEN
    SELECT * INTO a FROM card_applications WHERE id=p_input->>'applicationId' AND user_id=member_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'CARD_APPLICATION_NOT_FOUND'; END IF;
    IF a.version<>(p_input->>'expectedVersion')::bigint THEN RAISE EXCEPTION 'CARD_APPLICATION_VERSION_CHANGED'; END IF;
  END IF;
  IF action<>'decline' THEN PERFORM customer_require_active(ARRAY[member_id]); END IF;
  IF action='submit' THEN
    IF EXISTS(SELECT 1 FROM issuer_cards WHERE user_id=member_id)
      OR EXISTS(SELECT 1 FROM card_applications WHERE user_id=member_id AND status<>'declined')
      THEN RAISE EXCEPTION 'CARD_APPLICATION_EXISTS'; END IF;
    INSERT INTO card_applications(user_id,form,status,version,created_at,updated_at)
      VALUES(member_id,p_input->>'form','submitted',1,p_now,p_now) RETURNING * INTO a;
  ELSE
    next_status:=CASE
      WHEN action='approve' AND a.status='submitted' THEN 'approved'
      WHEN action='decline' AND a.status='submitted' THEN 'declined'
      WHEN action='issue' AND a.status='approved' THEN 'issued'
      WHEN action='dispatch' AND a.form='physical' AND a.status='issued' THEN 'dispatched'
      WHEN action='deliver' AND a.form='physical' AND a.status='dispatched' THEN 'delivered'
      WHEN action='activate' AND ((a.form='physical' AND a.status='delivered') OR (a.form='virtual' AND a.status='issued')) THEN 'active' END;
    IF next_status IS NULL THEN RAISE EXCEPTION 'CARD_APPLICATION_STATE_CONFLICT'; END IF;
    IF next_status='active' THEN
      previous_context:=current_setting('aqua.activating_application',true);
      PERFORM set_config('aqua.activating_application',a.id,true);
      PERFORM register_sandbox_issuer_card(jsonb_build_object('userId',member_id,'providerCardId','sandbox-card-'||a.id,'initialStatus','active'),p_now);
      PERFORM set_config('aqua.activating_application',coalesce(previous_context,''),true);
    END IF;
    UPDATE card_applications SET status=next_status,version=version+1,reason=p_input->>'reason',updated_at=greatest(updated_at,p_now)
      WHERE id=a.id RETURNING * INTO a;
  END IF;
  receipt:=card_application_payload(a);
  INSERT INTO card_application_events(application_id,version,scope,request_key,command,canonical_input,result,actor,recorded_at)
    VALUES(a.id,a.version,request_scope,key_value,action,p_input,receipt,session_user,p_now);
  RETURN receipt;
END;
$$;
CREATE FUNCTION submit_card_application(p_input JSONB,p_now BIGINT) RETURNS JSONB LANGUAGE sql SECURITY DEFINER SET search_path FROM CURRENT AS $$
  SELECT card_application_command('submit',p_input,p_now);
$$;
CREATE FUNCTION activate_card_application(p_input JSONB,p_now BIGINT) RETURNS JSONB LANGUAGE sql SECURITY DEFINER SET search_path FROM CURRENT AS $$
  SELECT card_application_command('activate',p_input,p_now);
$$;
CREATE FUNCTION apply_card_application_event(p_input JSONB,p_now BIGINT) RETURNS JSONB LANGUAGE sql SECURITY DEFINER SET search_path FROM CURRENT AS $$
  SELECT card_application_command('provider',p_input,p_now);
$$;
REVOKE ALL ON FUNCTION card_application_payload(card_applications),card_application_require_event(),check_card_application_registration(),
  member_card_application(text),card_application_command(text,jsonb,bigint),submit_card_application(jsonb,bigint),
  activate_card_application(jsonb,bigint),apply_card_application_event(jsonb,bigint) FROM PUBLIC;
