-- Keep the capture resolution relation distinct from the prepared report row.
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
      'errorCode',i.last_error_code,'retryEligible',i.status='dead_letter' AND i.version<9007199254740991 AND card_inbox_retryable(i.last_error_code)
        AND NOT EXISTS(SELECT 1 FROM card_capture_resolutions resolution WHERE resolution.inbox_id=i.id),
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
