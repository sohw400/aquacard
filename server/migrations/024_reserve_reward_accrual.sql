-- All weights are exact integer basis-point milliseconds. One whole reward
-- requires 10,000 basis points times 365 days of won-milliseconds (ACT/365).
CREATE TABLE reserve_reward_rates (
  version BIGINT PRIMARY KEY CHECK(version BETWEEN 0 AND 9007199254740991), rate_bps INTEGER NOT NULL CHECK(rate_bps BETWEEN 0 AND 10000),
  effective_ms BIGINT NOT NULL, start_weight NUMERIC NOT NULL CHECK(start_weight>=0), operation_key TEXT UNIQUE
);
CREATE TABLE reserve_reward_policy (
  singleton BOOLEAN PRIMARY KEY CHECK(singleton), version BIGINT NOT NULL REFERENCES reserve_reward_rates(version)
);
INSERT INTO reserve_reward_rates(version,rate_bps,effective_ms,start_weight) VALUES(0,0,floor(extract(epoch FROM clock_timestamp())*1000)::bigint,0);
INSERT INTO reserve_reward_policy VALUES(true,0);

CREATE TABLE reserve_reward_accruals (
  user_id TEXT PRIMARY KEY REFERENCES reserve_wallets(user_id), balance_won BIGINT NOT NULL CHECK(balance_won BETWEEN 0 AND 9007199254740991),
  last_weight NUMERIC NOT NULL DEFAULT 0 CHECK(last_weight>=0), unpaid_units NUMERIC NOT NULL DEFAULT 0 CHECK(unpaid_units>=0),
  payout_sequence BIGINT NOT NULL DEFAULT 0, retry_at TIMESTAMPTZ, deferred_reason TEXT,
  next_weight NUMERIC GENERATED ALWAYS AS (
    CASE WHEN unpaid_units>=315360000000000 THEN last_weight
      WHEN balance_won>0 THEN last_weight+div(315360000000000-unpaid_units+balance_won-1,balance_won) END
  ) STORED
);
CREATE INDEX reserve_rewards_due ON reserve_reward_accruals(next_weight,user_id) WHERE next_weight IS NOT NULL;
CREATE TABLE reserve_reward_payouts (
  user_id TEXT NOT NULL REFERENCES reserve_reward_accruals(user_id), sequence BIGINT NOT NULL, paid_at_ms BIGINT NOT NULL,
  weight NUMERIC NOT NULL, amount_won BIGINT NOT NULL CHECK(amount_won>0), offset_won BIGINT NOT NULL CHECK(offset_won BETWEEN 0 AND amount_won),
  reward_command_id TEXT NOT NULL UNIQUE REFERENCES reward_commands(id), PRIMARY KEY(user_id,sequence)
);
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['reserve_reward_rates','reserve_reward_payouts'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION ledger_reject_history_change()',t||'_immutable',t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION ledger_reject_history_change()',t||'_no_truncate',t);
  END LOOP;
END; $$;

INSERT INTO reserve_reward_accruals(user_id,balance_won)
  SELECT user_id,balance_won FROM ledger_accounts WHERE kind='user_reserve';
CREATE FUNCTION reserve_accrual_signup() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
BEGIN INSERT INTO reserve_reward_accruals(user_id,balance_won) VALUES(NEW.user_id,0); RETURN NEW; END; $$;
CREATE TRIGGER reserve_rewards_on_signup AFTER INSERT ON reserve_wallets FOR EACH ROW EXECUTE FUNCTION reserve_accrual_signup();

-- Policy and postings use the database clock at booking. A delayed card event's
-- original receipt timestamp cannot rewrite an interval already accrued.
CREATE FUNCTION reserve_reward_weight(rate reserve_reward_rates, at_ms BIGINT) RETURNS NUMERIC
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT rate.start_weight+rate.rate_bps::numeric*greatest(at_ms-rate.effective_ms,0)
$$;
CREATE FUNCTION set_reserve_reward_rate(p_bps INTEGER,p_version BIGINT,p_key TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE current_rate reserve_reward_rates%ROWTYPE; prior reserve_reward_rates%ROWTYPE; point BIGINT; weight NUMERIC;
BEGIN
  IF p_bps IS NULL OR p_bps NOT BETWEEN 0 AND 10000 OR p_version IS NULL OR p_version<0
    OR p_key IS NULL OR p_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN RAISE EXCEPTION 'INVALID_RESERVE_RATE'; END IF;
  PERFORM 1 FROM reserve_reward_policy WHERE singleton FOR UPDATE;
  SELECT * INTO prior FROM reserve_reward_rates WHERE operation_key=p_key;
  IF FOUND THEN
    IF prior.rate_bps<>p_bps OR prior.version<>p_version+1 THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
    RETURN jsonb_build_object('rateBps',prior.rate_bps,'policyVersion',prior.version,'effectiveMs',prior.effective_ms);
  END IF;
  SELECT r.* INTO STRICT current_rate FROM reserve_reward_policy h JOIN reserve_reward_rates r ON r.version=h.version WHERE h.singleton;
  IF current_rate.version<>p_version THEN RAISE EXCEPTION 'PREFERENCE_CHANGED'; END IF;
  point:=greatest(current_rate.effective_ms,floor(extract(epoch FROM clock_timestamp())*1000)::bigint);
  weight:=reserve_reward_weight(current_rate,point);
  INSERT INTO reserve_reward_rates(version,rate_bps,effective_ms,start_weight,operation_key) VALUES(p_version+1,p_bps,point,weight,p_key);
  UPDATE reserve_reward_policy SET version=p_version+1 WHERE singleton;
  RETURN jsonb_build_object('rateBps',p_bps,'policyVersion',p_version+1,'effectiveMs',point);
END; $$;

CREATE FUNCTION reserve_checkpoint_movement() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE r reserve_reward_rates%ROWTYPE; weight NUMERIC; balance BIGINT;
BEGIN
  SELECT rate.* INTO STRICT r FROM reserve_reward_policy h JOIN reserve_reward_rates rate ON rate.version=h.version WHERE h.singleton FOR SHARE OF h;
  weight:=reserve_reward_weight(r,floor(extract(epoch FROM clock_timestamp())*1000)::bigint);
  SELECT balance_won INTO STRICT balance FROM ledger_accounts WHERE id='reserve:'||NEW.sender_id;
  UPDATE reserve_reward_accruals SET unpaid_units=unpaid_units+balance_won*greatest(weight-last_weight,0),
    last_weight=greatest(weight,last_weight),balance_won=balance WHERE user_id=NEW.sender_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'RESERVE_ACCRUAL_INCONSISTENT'; END IF;
  RETURN NULL;
END; $$;
CREATE TRIGGER zz_reserve_checkpoint AFTER INSERT ON journals FOR EACH ROW WHEN (NEW.kind='reserve_transfer') EXECUTE FUNCTION reserve_checkpoint_movement();

CREATE OR REPLACE FUNCTION reserve_snapshot(p_user TEXT) RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
  SELECT jsonb_build_object('availableWon',a.balance_won,'autoUse',w.auto_use,'preferenceVersion',w.preference_version) ||
    CASE WHEN r.rate_bps>0 OR due.won>0 THEN jsonb_build_object('accrual',jsonb_build_object(
      'rateBps',r.rate_bps,'policyVersion',r.version,'pendingWon',due.won::text)) ELSE '{}'::jsonb END
  FROM reserve_wallets w JOIN ledger_accounts a ON a.id='reserve:'||w.user_id JOIN reserve_reward_accruals s ON s.user_id=w.user_id
  CROSS JOIN reserve_reward_policy h JOIN reserve_reward_rates r ON r.version=h.version
  CROSS JOIN LATERAL (SELECT div(s.unpaid_units+s.balance_won*greatest(reserve_reward_weight(r,
    floor(extract(epoch FROM statement_timestamp())*1000)::bigint)-s.last_weight,0),315360000000000) AS won) due
  WHERE w.user_id=p_user AND h.singleton
$$;

CREATE FUNCTION settle_next_reserve_reward() RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE rate reserve_reward_rates%ROWTYPE; s reserve_reward_accruals%ROWTYPE; point BIGINT; weight NUMERIC; total NUMERIC;
  uid TEXT; gross BIGINT; operation_key TEXT; cmd TEXT; receipt JSONB; failure TEXT;
BEGIN
  SELECT r.* INTO STRICT rate FROM reserve_reward_policy h JOIN reserve_reward_rates r ON r.version=h.version WHERE h.singleton FOR SHARE OF h;
  point:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
  weight:=reserve_reward_weight(rate,point);
  -- Use the same member mutex as reserve movements, then acquire the reward
  -- ledger locks in the existing reward command. Other workers skip this member.
  SELECT a.user_id INTO uid FROM reserve_reward_accruals a JOIN reserve_wallets w ON w.user_id=a.user_id
    WHERE a.next_weight<=weight AND (a.retry_at IS NULL OR a.retry_at<=clock_timestamp())
    ORDER BY a.next_weight,a.user_id LIMIT 1 FOR UPDATE OF w SKIP LOCKED;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','idle'); END IF;
  SELECT * INTO STRICT s FROM reserve_reward_accruals WHERE user_id=uid FOR UPDATE;
  weight:=greatest(weight,s.last_weight);
  total:=s.unpaid_units+s.balance_won*(weight-s.last_weight);
  gross:=least(div(total,315360000000000),9007199254740991)::bigint;
  IF gross<1 THEN RETURN jsonb_build_object('status','idle'); END IF;
  operation_key:='reserve-accrual-'||gen_random_uuid()::text;
  BEGIN
    receipt:=operator_grant_rewards(jsonb_build_object('userId',uid,'amountWon',gross,'idempotencyKey',operation_key),point);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS failure=MESSAGE_TEXT;
    IF failure NOT IN ('REWARD_BUDGET_UNAVAILABLE','REWARD_PROGRAM_INACTIVE','REWARD_BALANCE_LIMIT','LEDGER_CAPACITY') THEN RAISE; END IF;
    -- No debit from the entitlement. Withdrawals continue independently of the
    -- company budget; give other payable members a turn before retrying.
    UPDATE reserve_reward_accruals SET retry_at=clock_timestamp()+interval '1 minute',deferred_reason=failure WHERE user_id=uid;
    RETURN jsonb_build_object('status','deferred','code',failure);
  END;
  SELECT id INTO STRICT cmd FROM reward_commands WHERE user_id=uid AND kind='grant' AND idempotency_key=operation_key;
  INSERT INTO reserve_reward_payouts(user_id,sequence,paid_at_ms,weight,amount_won,offset_won,reward_command_id)
    VALUES(uid,s.payout_sequence+1,point,weight,gross,(receipt->>'offsetWon')::bigint,cmd);
  UPDATE reserve_reward_accruals SET unpaid_units=total-gross::numeric*315360000000000,last_weight=weight,
    payout_sequence=s.payout_sequence+1,retry_at=NULL,deferred_reason=NULL WHERE user_id=uid;
  RETURN jsonb_build_object('status','paid','amountWon',gross,'offsetWon',(receipt->>'offsetWon')::bigint);
END; $$;

-- Keep the accounting kind "grant" for existing reports; annotate only the
-- member-facing 50-row history with its independently recorded payout source.
DO $$ DECLARE body TEXT; BEGIN
  body:=pg_get_functiondef('rewards_snapshot(text,bigint)'::regprocedure);
  EXECUTE replace(body,'rewards_snapshot(','reserve_base_rewards_snapshot(');
END; $$;
CREATE OR REPLACE FUNCTION rewards_snapshot(p_user_id TEXT,p_now BIGINT) RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE snapshot JSONB; tagged JSONB;
BEGIN
  snapshot:=reserve_base_rewards_snapshot(p_user_id,p_now);
  SELECT coalesce(jsonb_agg(CASE WHEN p.reward_command_id IS NOT NULL THEN h.row||'{"origin":"reserve"}'::jsonb ELSE h.row END ORDER BY h.n),'[]'::jsonb)
    INTO tagged FROM jsonb_array_elements(snapshot->'history') WITH ORDINALITY AS h(row,n)
    LEFT JOIN reward_journals j ON j.id=h.row->>'id' AND j.user_id=p_user_id AND j.kind='grant'
    LEFT JOIN reserve_reward_payouts p ON p.reward_command_id=j.command_id AND p.user_id=p_user_id;
  RETURN jsonb_set(snapshot,'{history}',tagged);
END; $$;
REVOKE ALL ON FUNCTION reserve_accrual_signup(),reserve_reward_weight(reserve_reward_rates,bigint),set_reserve_reward_rate(integer,bigint,text),
  reserve_checkpoint_movement(),settle_next_reserve_reward(),reserve_base_rewards_snapshot(text,bigint) FROM PUBLIC;
