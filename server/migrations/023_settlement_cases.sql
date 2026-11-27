-- Human investigation records. None of these functions can write to the financial ledger.
CREATE TABLE settlement_cases (
  id UUID PRIMARY KEY,
  source JSONB UNIQUE NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open','assigned','evidenced','approved')),
  version INTEGER NOT NULL CHECK (version > 0),
  opened_by NAME NOT NULL,
  opened_by_oid OID NOT NULL,
  assigned_to NAME,
  assigned_to_oid OID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp()
);
CREATE INDEX settlement_cases_queue ON settlement_cases(state,id);

CREATE TABLE settlement_case_events (
  command_id UUID PRIMARY KEY,
  case_id UUID NOT NULL REFERENCES settlement_cases(id),
  version INTEGER NOT NULL,
  actor NAME NOT NULL,
  actor_oid OID NOT NULL,
  command JSONB NOT NULL,
  receipt JSONB NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE(case_id, version)
);

CREATE FUNCTION private_settlement_case_append_only() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'SETTLEMENT_AUDIT_IMMUTABLE' USING ERRCODE='55000';
END;
$$;
CREATE TRIGGER immutable_settlement_case_events BEFORE UPDATE OR DELETE OR TRUNCATE
  ON settlement_case_events FOR EACH STATEMENT EXECUTE FUNCTION private_settlement_case_append_only();

CREATE FUNCTION private_settlement_case_valid_source(s JSONB) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE
  hashes JSONB := s->'sourceSha256';
  code JSONB;
  allowed TEXT[];
  day DATE;
BEGIN
  IF (jsonb_typeof(s)='object' AND s ?& ARRAY['scope','businessDate','settlementDate','accountSha256','referenceSha256','findingSha256','codes','sourceSha256']
      AND s-ARRAY['scope','businessDate','settlementDate','accountSha256','referenceSha256','findingSha256','codes','sourceSha256']='{}'::jsonb
      AND s->>'scope' IN ('issuer_statement','bank_settlement') AND jsonb_typeof(s->'businessDate')='string'
      AND s->>'businessDate' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      AND jsonb_typeof(s->'referenceSha256')='string' AND s->>'referenceSha256' ~ '^[0-9a-f]{64}$'
      AND jsonb_typeof(s->'findingSha256')='string' AND s->>'findingSha256' ~ '^[0-9a-f]{64}$'
      AND jsonb_typeof(s->'codes')='array' AND jsonb_typeof(hashes)='object'
      AND jsonb_typeof(hashes->'issuerStatement')='string' AND hashes->>'issuerStatement' ~ '^[0-9a-f]{64}$') IS DISTINCT FROM TRUE THEN RETURN false; END IF;
  day := (s->>'businessDate')::date;
  IF jsonb_array_length(s->'codes') NOT BETWEEN 1 AND 8 THEN RETURN false; END IF;
  IF s->>'scope'='issuer_statement' THEN
    IF s->'settlementDate'<>'null'::jsonb OR s->'accountSha256'<>'null'::jsonb OR hashes-'issuerStatement'<>'{}'::jsonb THEN RETURN false; END IF;
    allowed := ARRAY['DUPLICATE_STATEMENT_EVENT','DUPLICATE_LEDGER_EVENT','MISSING_IN_LEDGER','MISSING_IN_STATEMENT',
                     'PAYMENT_ID_MISMATCH','KIND_MISMATCH','AMOUNT_MISMATCH'];
  ELSE
    IF (jsonb_typeof(s->'settlementDate')='string' AND s->>'settlementDate' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        AND (s->>'settlementDate')::date >= day AND jsonb_typeof(s->'accountSha256')='string' AND s->>'accountSha256' ~ '^[0-9a-f]{64}$'
        AND hashes-ARRAY['issuerStatement','settlementAdvice','bankStatement']='{}'::jsonb
        AND jsonb_typeof(hashes->'settlementAdvice')='string' AND hashes->>'settlementAdvice' ~ '^[0-9a-f]{64}$'
        AND jsonb_typeof(hashes->'bankStatement')='string' AND hashes->>'bankStatement' ~ '^[0-9a-f]{64}$') IS DISTINCT FROM TRUE THEN RETURN false; END IF;
    allowed := ARRAY['MISSING_BANK_POSTING','UNEXPECTED_BANK_BATCH','UNEXPECTED_BANK_POSTING','MULTIPLE_BANK_POSTINGS',
                     'DUPLICATE_BANK_POSTING_ID','DIRECTION_MISMATCH','AMOUNT_MISMATCH'];
  END IF;
  FOR code IN SELECT value FROM jsonb_array_elements(s->'codes') LOOP
    IF (jsonb_typeof(code)='string' AND (code #>> '{}')=ANY(allowed)) IS DISTINCT FROM TRUE THEN RETURN false; END IF;
    allowed := array_remove(allowed,code #>> '{}');
  END LOOP;
  RETURN true;
EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN RETURN false;
END;
$$;

-- Lock the request ID before checking for replay, including across case IDs and operators.
CREATE FUNCTION private_settlement_case_replay(cmd JSONB) RETURNS JSONB
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  prior settlement_case_events%ROWTYPE;
BEGIN
  IF (jsonb_typeof(cmd->'commandId')='string' AND cmd->>'commandId' ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$') IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'SETTLEMENT_CASE_INVALID' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('settlement-case:' || (cmd->>'commandId'),0));
  SELECT * INTO prior FROM settlement_case_events WHERE command_id=(cmd->>'commandId')::uuid;
  IF FOUND THEN
    IF prior.command<>cmd OR prior.actor_oid<>session_user::regrole::oid OR prior.actor<>session_user THEN
      RAISE EXCEPTION 'SETTLEMENT_COMMAND_CONFLICT' USING ERRCODE='22023';
    END IF;
    RETURN prior.receipt;
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION private_settlement_case_record(c settlement_cases, cmd JSONB) RETURNS JSONB
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  receipt JSONB := jsonb_build_object('caseId',c.id,'state',c.state,'version',c.version);
BEGIN
  INSERT INTO settlement_case_events(command_id,case_id,version,actor,actor_oid,command,receipt)
  VALUES ((cmd->>'commandId')::uuid,c.id,c.version,session_user,session_user::regrole::oid,cmd,receipt);
  RETURN receipt;
END;
$$;

CREATE FUNCTION open_settlement_case(cmd JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
  c settlement_cases%ROWTYPE;
  replay JSONB;
BEGIN
  IF (jsonb_typeof(cmd)='object' AND cmd ?& ARRAY['commandId','source'] AND cmd-ARRAY['commandId','source']='{}'::jsonb
      AND private_settlement_case_valid_source(cmd->'source')) IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'SETTLEMENT_CASE_INVALID' USING ERRCODE='22023';
  END IF;
  -- No case may attest an open business or booking day, even via direct SQL.
  IF COALESCE(cmd#>>'{source,settlementDate}',cmd#>>'{source,businessDate}')::date >= (transaction_timestamp() AT TIME ZONE 'Asia/Seoul')::date THEN
    RAISE EXCEPTION 'SETTLEMENT_DAY_OPEN' USING ERRCODE='22023';
  END IF;
  replay := private_settlement_case_replay(cmd);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  INSERT INTO settlement_cases(id,source,state,version,opened_by,opened_by_oid)
    VALUES ((cmd->>'commandId')::uuid,cmd->'source','open',1,session_user,session_user::regrole::oid)
    ON CONFLICT (source) DO NOTHING RETURNING * INTO c;
  IF NOT FOUND THEN RAISE EXCEPTION 'SETTLEMENT_CASE_ALREADY_RECORDED' USING ERRCODE='22023'; END IF;
  RETURN private_settlement_case_record(c,cmd);
END;
$$;

CREATE FUNCTION transition_settlement_case(cmd JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
  c settlement_cases%ROWTYPE;
  replay JSONB;
  action TEXT := cmd->>'action';
  shape TEXT[] := ARRAY['commandId','caseId','expectedVersion','action'];
  actor_id OID := session_user::regrole::oid;
BEGIN
  IF action IN ('evidence','return') THEN shape := array_append(shape,'evidenceSha256'); END IF;
  IF action='evidence' THEN shape := array_append(shape,'resolution'); END IF;
  IF (jsonb_typeof(cmd)='object' AND cmd ?& shape AND cmd-shape='{}'::jsonb
      AND action IN ('claim','release','evidence','return','approve')
      AND jsonb_typeof(cmd->'caseId')='string' AND cmd->>'caseId' ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
      AND jsonb_typeof(cmd->'expectedVersion')='number' AND cmd->>'expectedVersion' ~ '^[1-9][0-9]{0,8}$'
      AND (action NOT IN ('evidence','return') OR (jsonb_typeof(cmd->'evidenceSha256')='string' AND cmd->>'evidenceSha256' ~ '^[0-9a-f]{64}$'))
      AND (action<>'evidence' OR cmd->>'resolution' IN ('source_corrected','timing_confirmed','provider_confirmed','adjustment_required'))) IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'SETTLEMENT_CASE_INVALID' USING ERRCODE='22023';
  END IF;
  replay := private_settlement_case_replay(cmd);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  SELECT * INTO c FROM settlement_cases WHERE id=(cmd->>'caseId')::uuid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SETTLEMENT_CASE_NOT_FOUND' USING ERRCODE='22023'; END IF;
  IF c.version<>(cmd->>'expectedVersion')::integer THEN RAISE EXCEPTION 'SETTLEMENT_CASE_STALE' USING ERRCODE='22023'; END IF;
  IF action='claim' AND c.state='open' THEN
    c.state:='assigned'; c.assigned_to:=session_user; c.assigned_to_oid:=actor_id;
  ELSIF action IN ('evidence','release') AND c.state='assigned' THEN
    IF c.assigned_to_oid<>actor_id OR c.assigned_to<>session_user THEN RAISE EXCEPTION 'SETTLEMENT_CASE_ASSIGNEE_REQUIRED' USING ERRCODE='22023'; END IF;
    IF action='evidence' THEN c.state:='evidenced';
    ELSE c.state:='open'; c.assigned_to:=NULL; c.assigned_to_oid:=NULL; END IF;
  ELSIF action IN ('return','approve') AND c.state='evidenced' THEN
    IF c.opened_by_oid=actor_id OR c.opened_by=session_user OR EXISTS (
      SELECT 1 FROM settlement_case_events WHERE case_id=c.id AND command->>'action'='evidence'
        AND (actor_oid=actor_id OR actor=session_user)) THEN
      RAISE EXCEPTION 'SETTLEMENT_CASE_INDEPENDENT_REVIEW_REQUIRED' USING ERRCODE='22023';
    END IF;
    c.state:=CASE WHEN action='approve' THEN 'approved' ELSE 'assigned' END;
  ELSE RAISE EXCEPTION 'SETTLEMENT_CASE_STATE_CONFLICT' USING ERRCODE='22023'; END IF;
  UPDATE settlement_cases SET state=c.state,assigned_to=c.assigned_to,assigned_to_oid=c.assigned_to_oid,
    version=version+1,updated_at=transaction_timestamp() WHERE id=c.id RETURNING * INTO c;
  RETURN private_settlement_case_record(c,cmd);
END;
$$;

CREATE FUNCTION read_settlement_case(case_id UUID) RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
  SELECT jsonb_build_object('caseId',c.id,'state',c.state,'version',c.version,'source',c.source,
    'openedBy',c.opened_by,'assignedTo',c.assigned_to,'createdAt',c.created_at,'updatedAt',c.updated_at,
    'history',COALESCE((SELECT jsonb_agg(jsonb_build_object('version',e.version,'actor',e.actor,'recordedAt',e.recorded_at,
      'commandId',e.command_id,'action',COALESCE(e.command->>'action','open'),'resolution',e.command->>'resolution',
      'evidenceSha256',e.command->>'evidenceSha256') ORDER BY e.version) FROM settlement_case_events e WHERE e.case_id=c.id),'[]'::jsonb))
  FROM settlement_cases c WHERE c.id=$1
$$;

CREATE FUNCTION list_settlement_cases(p_state TEXT, p_after UUID) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
BEGIN
  IF p_state IS NULL OR p_state NOT IN ('open','assigned','evidenced','approved') THEN RAISE EXCEPTION 'SETTLEMENT_CASE_INVALID' USING ERRCODE='22023'; END IF;
  RETURN (SELECT COALESCE(jsonb_agg(jsonb_build_object('caseId',q.id,'version',q.version,'state',q.state,
    'openedBy',q.opened_by,'assignedTo',q.assigned_to,'businessDate',q.source->>'businessDate','scope',q.source->>'scope',
    'referenceSha256',q.source->>'referenceSha256') ORDER BY q.id),'[]'::jsonb)
    FROM (SELECT * FROM settlement_cases WHERE state=p_state AND (p_after IS NULL OR id>p_after) ORDER BY id LIMIT 50) q);
END;
$$;

REVOKE ALL ON settlement_cases,settlement_case_events FROM PUBLIC;
REVOKE ALL ON FUNCTION private_settlement_case_append_only(),private_settlement_case_valid_source(jsonb),
  private_settlement_case_replay(jsonb),private_settlement_case_record(settlement_cases,jsonb),
  open_settlement_case(jsonb),transition_settlement_case(jsonb),read_settlement_case(uuid),list_settlement_cases(text,uuid) FROM PUBLIC;
