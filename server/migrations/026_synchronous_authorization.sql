-- Local issuer simulator only. A fixed signed-request timestamp, not the time of a retry,
-- determines the synthetic two-second authorization window.
CREATE TABLE sandbox_sync_requests (
  id UUID PRIMARY KEY,
  issued_at BIGINT NOT NULL,
  body_sha256 BYTEA NOT NULL CHECK (octet_length(body_sha256)=32)
);
CREATE TABLE sandbox_sync_decisions (
  request_id UUID PRIMARY KEY REFERENCES sandbox_sync_requests(id),
  outcome TEXT NOT NULL CHECK (outcome IN ('approved','declined','timed_out')),
  decided_at BIGINT NOT NULL CHECK (decided_at>=0)
);
CREATE TRIGGER sync_requests_immutable BEFORE UPDATE OR DELETE ON sandbox_sync_requests
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_history_change();
CREATE TRIGGER sync_requests_no_truncate BEFORE TRUNCATE ON sandbox_sync_requests
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_reject_history_change();
CREATE TRIGGER sync_decisions_immutable BEFORE UPDATE OR DELETE ON sandbox_sync_decisions
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_history_change();
CREATE TRIGGER sync_decisions_no_truncate BEFORE TRUNCATE ON sandbox_sync_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_reject_history_change();

CREATE FUNCTION private_sync_request_complete() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM sandbox_sync_decisions WHERE request_id=NEW.id) THEN RAISE EXCEPTION 'SYNC_DECISION_INCOMPLETE'; END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER sync_request_complete AFTER INSERT ON sandbox_sync_requests
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private_sync_request_complete();

-- The async inbox may settle an approved hold. It cannot create or resurrect an
-- authorization in this request namespace, even using another event ID for the payment.
CREATE FUNCTION private_sync_event_guard() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
  is_authorization BOOLEAN;
  rid UUID;
BEGIN
  is_authorization := NEW.canonical_input->>'kind'='authorize';
  IF NEW.event_id NOT LIKE 'sync-auth:%' AND (NOT is_authorization OR NEW.payment_id NOT LIKE 'sync-pay:%') THEN RETURN NEW; END IF;
  IF NOT is_authorization OR NEW.event_id !~ '^sync-auth:[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
     OR NEW.payment_id<>'sync-pay:' || substr(NEW.event_id,11) THEN RAISE EXCEPTION 'SYNC_AUTHORIZATION_REQUIRED'; END IF;
  rid := substr(NEW.event_id,11)::uuid;
  IF NOT EXISTS (SELECT 1 FROM sandbox_sync_requests r WHERE r.id=rid
      AND NOT EXISTS (SELECT 1 FROM sandbox_sync_decisions d WHERE d.request_id=r.id)) THEN RAISE EXCEPTION 'SYNC_AUTHORIZATION_REQUIRED'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sync_financial_event BEFORE INSERT ON card_payment_events
  FOR EACH ROW EXECUTE FUNCTION private_sync_event_guard();
CREATE TRIGGER sync_policy_event BEFORE INSERT ON card_authorization_decisions
  FOR EACH ROW EXECUTE FUNCTION private_sync_event_guard();

CREATE FUNCTION lookup_sandbox_authorization(rid UUID) RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
  SELECT jsonb_build_object('requestId',r.id,'paymentId','sync-pay:'||r.id::text,
    'outcome',d.outcome,'deadlineAt',r.issued_at+2000,'decidedAt',d.decided_at)
  FROM sandbox_sync_requests r JOIN sandbox_sync_decisions d ON d.request_id=r.id WHERE r.id=rid
$$;

CREATE FUNCTION decide_sandbox_authorization(p JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
  rid UUID;
  original sandbox_sync_requests%ROWTYPE;
  canonical JSONB;
  event_key TEXT;
  payment_key TEXT;
  issued BIGINT;
  now_ms BIGINT;
  available_ms BIGINT;
  deadline BIGINT;
  fingerprint BYTEA;
  answer JSONB;
  outcome TEXT;
  prior_lock TEXT := current_setting('lock_timeout');
BEGIN
  IF (jsonb_typeof(p)='object' AND p ?& ARRAY['requestId','issuedAt','userId','merchantName','amountWon']
      AND p-ARRAY['requestId','issuedAt','userId','merchantName','amountWon']='{}'::jsonb
      AND jsonb_typeof(p->'requestId')='string' AND p->>'requestId' ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
      AND jsonb_typeof(p->'issuedAt')='number' AND p->>'issuedAt' ~ '^(0|[1-9][0-9]{0,15})$'
      AND jsonb_typeof(p->'userId')='string' AND p->>'userId' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      AND jsonb_typeof(p->'merchantName')='string' AND length(btrim(p->>'merchantName')) BETWEEN 1 AND 100
      AND (p->>'merchantName') !~ '[[:cntrl:]]' AND length(p->>'merchantName')<=100
      AND jsonb_typeof(p->'amountWon')='number' AND p->>'amountWon' ~ '^[1-9][0-9]{0,15}$'
      AND (p->>'amountWon')::numeric<=9007199254740991) IS DISTINCT FROM TRUE THEN RAISE EXCEPTION 'INVALID_SYNC_REQUEST' USING ERRCODE='22023'; END IF;
  issued := (p->>'issuedAt')::bigint;
  IF issued>8639999967598000 THEN RAISE EXCEPTION 'INVALID_SYNC_REQUEST' USING ERRCODE='22023'; END IF;
  rid := (p->>'requestId')::uuid; deadline:=issued+2000;
  event_key:='sync-auth:'||rid::text; payment_key:='sync-pay:'||rid::text;
  fingerprint:=sha256(convert_to(p::text,'UTF8'));
  IF NOT pg_try_advisory_xact_lock(hashtextextended(current_schema()||':sync-authorization:'||rid::text,0)) THEN
    RAISE EXCEPTION 'SYNC_RESULT_UNCONFIRMED'; END IF;
  SELECT * INTO original FROM sandbox_sync_requests WHERE id=rid;
  IF FOUND THEN
    IF original.body_sha256<>fingerprint THEN RAISE EXCEPTION 'SYNC_ID_CONFLICT'; END IF;
    RETURN lookup_sandbox_authorization(rid);
  END IF;
  now_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
  IF issued>now_ms THEN RAISE EXCEPTION 'INVALID_SYNC_REQUEST' USING ERRCODE='22023'; END IF;
  IF EXISTS(SELECT 1 FROM card_authorization_decisions WHERE event_id=event_key OR payment_id=payment_key)
    OR EXISTS(SELECT 1 FROM card_payment_events WHERE event_id=event_key)
    OR EXISTS(SELECT 1 FROM card_payments WHERE id=payment_key) THEN RAISE EXCEPTION 'SYNC_ID_CONFLICT'; END IF;
  canonical:=jsonb_build_object('kind','authorize','eventId',event_key,'paymentId',payment_key,'userId',p->'userId',
    'merchantName',p->'merchantName','amountWon',p->'amountWon');
  INSERT INTO sandbox_sync_requests(id,issued_at,body_sha256) VALUES(rid,issued,fingerprint);
  available_ms:=deadline - floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
  IF available_ms<=0 THEN outcome:='timed_out';
  ELSE
    BEGIN
      PERFORM set_config('lock_timeout',available_ms::text||'ms',true);
      answer:=apply_sandbox_card_event(canonical,issued);
      now_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
      -- An exception here rolls back the entire inner financial transaction, including
      -- any decisions and holds it just created, before the terminal timeout is saved.
      IF now_ms>=deadline THEN RAISE EXCEPTION 'SYNC_DEADLINE_EXCEEDED'; END IF;
      IF answer->'declined'='true'::jsonb THEN outcome:='declined';
      ELSIF EXISTS(SELECT 1 FROM card_authorization_decisions WHERE event_id=event_key AND decision='approved') THEN outcome:='approved';
      ELSE RAISE EXCEPTION 'SYNC_DECISION_INCOMPLETE'; END IF;
    EXCEPTION
      WHEN lock_not_available THEN outcome:='timed_out';
      WHEN raise_exception THEN
        IF SQLERRM='SYNC_DEADLINE_EXCEEDED' THEN outcome:='timed_out';
        ELSIF SQLERRM IN ('INSUFFICIENT_FUNDS','USER_NOT_FOUND') THEN
          now_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
          outcome:=CASE WHEN now_ms>=deadline THEN 'timed_out' ELSE 'declined' END;
        ELSE RAISE; END IF;
    END;
    PERFORM set_config('lock_timeout',prior_lock,true);
  END IF;
  IF outcome='timed_out' THEN now_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint; END IF;
  INSERT INTO sandbox_sync_decisions(request_id,outcome,decided_at) VALUES(rid,outcome,now_ms);
  RETURN jsonb_build_object('requestId',rid,'paymentId',payment_key,'outcome',outcome,'deadlineAt',deadline,'decidedAt',now_ms);
END;
$$;
REVOKE ALL ON sandbox_sync_requests,sandbox_sync_decisions FROM PUBLIC;
REVOKE ALL ON FUNCTION private_sync_request_complete(),private_sync_event_guard(),lookup_sandbox_authorization(uuid),
  decide_sandbox_authorization(jsonb) FROM PUBLIC;
