-- Reserve is customer principal, separated from transferable funds. Ordinary card
-- settlement and cashback continue to use the already-funded shared card hold.
ALTER TABLE ledger_accounts DROP CONSTRAINT ledger_accounts_kind_guard, DROP CONSTRAINT ledger_accounts_balance_guard;
ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_accounts_kind_guard CHECK (kind IN
  ('user_spend','user_card_hold','user_reserve','sandbox_control','sandbox_card_settlement','reward_budget','reward_backing','reward_cashback_reserved')),
  ADD CONSTRAINT ledger_accounts_balance_guard CHECK (
    (kind IN ('user_spend','user_card_hold') AND user_id IS NOT NULL AND balance_won BETWEEN 0 AND 9007199254740991)
    OR (kind='user_reserve' AND user_id IS NOT NULL AND id='reserve:'||user_id AND balance_won BETWEEN 0 AND 9007199254740991)
    OR (kind='sandbox_control' AND user_id IS NULL AND balance_won<=0)
    OR (kind IN ('sandbox_card_settlement','reward_budget','reward_backing','reward_cashback_reserved') AND user_id IS NULL AND balance_won>=0));

CREATE TABLE reserve_wallets (
  user_id TEXT PRIMARY KEY REFERENCES users(id), auto_use BOOLEAN NOT NULL DEFAULT false,
  preference_version BIGINT NOT NULL DEFAULT 0 CHECK(preference_version BETWEEN 0 AND 9007199254740991)
);
INSERT INTO reserve_wallets(user_id) SELECT id FROM users;
INSERT INTO ledger_accounts(id,user_id,kind) SELECT 'reserve:'||id,id,'user_reserve' FROM users;
CREATE FUNCTION reserve_on_signup() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
BEGIN
  INSERT INTO reserve_wallets(user_id) VALUES(NEW.id);
  INSERT INTO ledger_accounts(id,user_id,kind) VALUES('reserve:'||NEW.id,NEW.id,'user_reserve');
  RETURN NEW;
END;
$$;
CREATE TRIGGER users_create_reserve AFTER INSERT ON users FOR EACH ROW EXECUTE FUNCTION reserve_on_signup();

CREATE TABLE reserve_commands (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, user_id TEXT NOT NULL REFERENCES users(id),
  request_key TEXT NOT NULL, input JSONB NOT NULL, result JSONB NOT NULL, created_at BIGINT NOT NULL,
  UNIQUE(user_id,request_key)
);
CREATE TABLE card_reserve_allocations (
  payment_id TEXT PRIMARY KEY REFERENCES card_payments(id) DEFERRABLE INITIALLY DEFERRED,
  user_id TEXT NOT NULL REFERENCES users(id), principal_won BIGINT NOT NULL CHECK(principal_won BETWEEN 1 AND 9007199254740991),
  reserve_won BIGINT NOT NULL CHECK(reserve_won BETWEEN 1 AND principal_won)
);
CREATE TABLE reserve_entries (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, user_id TEXT NOT NULL REFERENCES users(id),
  direction TEXT NOT NULL CHECK(direction IN ('in','out')), amount_won BIGINT NOT NULL CHECK(amount_won BETWEEN 1 AND 9007199254740991),
  command_id TEXT UNIQUE REFERENCES reserve_commands(id) DEFERRABLE INITIALLY DEFERRED,
  event_id TEXT UNIQUE REFERENCES card_payment_events(event_id) DEFERRABLE INITIALLY DEFERRED,
  created_at BIGINT NOT NULL, CHECK(num_nonnulls(command_id,event_id)=1)
);
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['reserve_entries','reserve_commands','card_reserve_allocations'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION ledger_reject_history_change()',t||'_immutable',t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION ledger_reject_history_change()',t||'_no_truncate',t);
  END LOOP;
END; $$;

ALTER TABLE journals ADD COLUMN reserve_entry_id TEXT UNIQUE REFERENCES reserve_entries(id);
DO $$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT conname,pg_get_expr(conbin,conrelid) AS expr FROM pg_constraint WHERE conrelid='journals'::regclass
    AND conname IN ('journals_kind_guard','journals_owner_guard','journals_card_link_guard')
  LOOP
    EXECUTE format('ALTER TABLE journals DROP CONSTRAINT %I',c.conname);
    EXECUTE format('ALTER TABLE journals ADD CONSTRAINT %I CHECK ((%s) OR kind=''reserve_transfer'')',c.conname,c.expr);
  END LOOP;
END; $$;
ALTER TABLE journals ADD CONSTRAINT journals_reserve_link CHECK (
  (kind='reserve_transfer' AND reserve_entry_id IS NOT NULL AND sender_id IS NOT NULL AND recipient_id=sender_id
    AND request_owner_id=sender_id AND card_event_id IS NULL AND card_payment_id IS NULL AND reward_plan_id IS NULL
    AND reward_component IS NULL AND reward_command_id IS NULL)
  OR (kind<>'reserve_transfer' AND reserve_entry_id IS NULL));

CREATE FUNCTION reserve_post_journal() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE e reserve_entries%ROWTYPE;
BEGIN
  SELECT * INTO STRICT e FROM reserve_entries WHERE id=NEW.reserve_entry_id;
  IF ROW(NEW.id,NEW.sender_id,NEW.amount_won,NEW.created_at,NEW.from_account_id,NEW.to_account_id) IS DISTINCT FROM
     ROW(e.id,e.user_id,e.amount_won,e.created_at,
         (CASE WHEN e.direction='in' THEN 'user:' ELSE 'reserve:' END)||e.user_id,
         (CASE WHEN e.direction='in' THEN 'reserve:' ELSE 'user:' END)||e.user_id) THEN RAISE EXCEPTION 'INVALID_RESERVE_ENTRY'; END IF;
  PERFORM id FROM ledger_accounts WHERE id IN (NEW.from_account_id,NEW.to_account_id) ORDER BY id FOR UPDATE;
  UPDATE ledger_accounts SET balance_won=balance_won-e.amount_won WHERE id=NEW.from_account_id AND balance_won>=e.amount_won;
  IF NOT FOUND THEN RAISE EXCEPTION 'INSUFFICIENT_FUNDS'; END IF;
  UPDATE ledger_accounts SET balance_won=balance_won+e.amount_won WHERE id=NEW.to_account_id;
  RETURN NULL;
END; $$;
DROP TRIGGER journals_post_balances ON journals;
CREATE TRIGGER journals_post_balances AFTER INSERT ON journals FOR EACH ROW WHEN(NEW.kind<>'reserve_transfer') EXECUTE FUNCTION ledger_post_journal();
CREATE TRIGGER reserve_journals_post_balances AFTER INSERT ON journals FOR EACH ROW WHEN(NEW.kind='reserve_transfer') EXECUTE FUNCTION reserve_post_journal();

-- Keep today's aggregate safe-integer guarantee when new money arrives while
-- a customer already has funds in Reserve. Wallet/hold/Reserve moves conserve it.
CREATE FUNCTION reserve_principal_capacity() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE uid TEXT; combined NUMERIC;
BEGIN
  SELECT user_id INTO uid FROM ledger_accounts WHERE id=NEW.to_account_id AND kind='user_spend';
  IF uid IS NOT NULL THEN
    SELECT sum(balance_won::numeric) INTO combined FROM ledger_accounts
      WHERE user_id=uid AND kind IN ('user_spend','user_card_hold','user_reserve');
    IF combined>9007199254740991 THEN RAISE EXCEPTION 'RECIPIENT_BALANCE_LIMIT'; END IF;
  END IF;
  RETURN NULL;
END; $$;
CREATE TRIGGER zz_reserve_capacity AFTER INSERT ON journals FOR EACH ROW WHEN(NEW.kind<>'reserve_transfer') EXECUTE FUNCTION reserve_principal_capacity();

CREATE FUNCTION reserve_move(p_user TEXT,p_in BOOLEAN,p_amount BIGINT,p_command TEXT,p_event TEXT,p_now BIGINT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE entry_id TEXT; source TEXT; target TEXT; u users%ROWTYPE; next_balance BIGINT;
BEGIN
  source:=(CASE WHEN p_in THEN 'user:' ELSE 'reserve:' END)||p_user;
  target:=(CASE WHEN p_in THEN 'reserve:' ELSE 'user:' END)||p_user;
  PERFORM id FROM ledger_accounts WHERE id IN (source,target) ORDER BY id FOR UPDATE;
  SELECT balance_won-p_amount INTO next_balance FROM ledger_accounts WHERE id=source;
  IF next_balance IS NULL OR next_balance<0 THEN RAISE EXCEPTION 'INSUFFICIENT_FUNDS'; END IF;
  SELECT * INTO STRICT u FROM users WHERE id=p_user;
  INSERT INTO reserve_entries(user_id,direction,amount_won,command_id,event_id,created_at)
    VALUES(p_user,CASE WHEN p_in THEN 'in' ELSE 'out' END,p_amount,p_command,p_event,p_now) RETURNING id INTO entry_id;
  INSERT INTO journals(id,kind,from_account_id,to_account_id,amount_won,sender_id,recipient_id,sender_name,sender_tag,recipient_name,recipient_tag,
    request_owner_id,idempotency_key,request_payload,balance_after_won,created_at,reserve_entry_id)
    VALUES(entry_id,'reserve_transfer',source,target,p_amount,p_user,p_user,u.name,u.tag,u.name,u.tag,p_user,
           '$reserve:'||entry_id,entry_id,next_balance,p_now,entry_id);
END; $$;

CREATE FUNCTION reserve_snapshot(p_user TEXT) RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
  SELECT jsonb_build_object('availableWon',a.balance_won,'autoUse',w.auto_use,'preferenceVersion',w.preference_version)
  FROM reserve_wallets w JOIN ledger_accounts a ON a.id='reserve:'||w.user_id WHERE w.user_id=p_user
$$;

CREATE FUNCTION apply_reserve_command(p_input JSONB,p_now BIGINT) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE uid TEXT:=p_input->>'userId'; req TEXT:=p_input->>'requestKey'; action TEXT:=p_input->>'kind';
  previous reserve_commands%ROWTYPE; w reserve_wallets%ROWTYPE; command_key TEXT:=gen_random_uuid()::text; reply JSONB;
BEGIN
  IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR p_now IS NULL OR p_now NOT BETWEEN 0 AND 8640000000000000
    OR uid IS NULL OR req IS NULL OR req !~ '^[a-zA-Z0-9_-]{8,128}$' OR action IS NULL OR action NOT IN ('in','out','preference') THEN
    RAISE EXCEPTION 'INVALID_RESERVE_COMMAND'; END IF;
  SELECT * INTO w FROM reserve_wallets WHERE user_id=uid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'USER_NOT_FOUND'; END IF;
  SELECT * INTO previous FROM reserve_commands WHERE user_id=uid AND request_key=req;
  IF FOUND THEN
    IF previous.input<>p_input THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
    RETURN previous.result;
  END IF;
  PERFORM customer_require_active(ARRAY[uid]);
  IF action='preference' THEN
    IF p_input-ARRAY['userId','requestKey','kind','autoUse','expectedVersion'] <> '{}'::jsonb
      OR jsonb_typeof(p_input->'autoUse') IS DISTINCT FROM 'boolean' OR jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number'
      OR (p_input->>'expectedVersion') !~ '^(0|[1-9][0-9]{0,15})$' THEN RAISE EXCEPTION 'INVALID_RESERVE_COMMAND'; END IF;
    IF (p_input->>'expectedVersion')::numeric<>w.preference_version THEN RAISE EXCEPTION 'PREFERENCE_CHANGED'; END IF;
    UPDATE reserve_wallets SET auto_use=(p_input->>'autoUse')::boolean,preference_version=preference_version+1 WHERE user_id=uid;
  ELSE
    IF p_input-ARRAY['userId','requestKey','kind','amountWon'] <> '{}'::jsonb OR jsonb_typeof(p_input->'amountWon') IS DISTINCT FROM 'number'
      OR (p_input->>'amountWon') !~ '^[1-9][0-9]{0,15}$' OR (p_input->>'amountWon')::numeric>9007199254740991 THEN RAISE EXCEPTION 'INVALID_RESERVE_COMMAND'; END IF;
    PERFORM reserve_move(uid,action='in',(p_input->>'amountWon')::bigint,command_key,NULL,p_now);
  END IF;
  reply:=reserve_snapshot(uid);
  INSERT INTO reserve_commands(id,user_id,request_key,input,result,created_at) VALUES(command_key,uid,req,p_input,reply,p_now);
  RETURN reply;
END; $$;

-- Principal remains the aggregate used by existing fee and settlement reports.
-- Reserve is its attributable subset, so older clients can read principal unchanged.
CREATE FUNCTION reserve_payment_funding(p_payment TEXT) RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE a card_reserve_allocations%ROWTYPE; p card_payments%ROWTYPE; r card_reward_allocations%ROWTYPE;
  principal JSONB; rewards JSONB; funded BIGINT; captured BIGINT; released BIGINT; refunded BIGINT;
BEGIN
  SELECT * INTO a FROM card_reserve_allocations WHERE payment_id=p_payment;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO STRICT p FROM card_payments WHERE id=p_payment;
  SELECT * INTO r FROM card_reward_allocations WHERE payment_id=p_payment;
  principal:=jsonb_build_object('authorizedWon',a.principal_won,'heldWon',coalesce(r.principal_held_won,p.held_won),
    'capturedWon',coalesce(r.principal_captured_won,p.captured_won),'releasedWon',coalesce(r.principal_released_won,p.released_won),
    'refundedWon',coalesce(r.principal_refunded_won,p.refunded_won));
  rewards:=jsonb_build_object('authorizedWon',coalesce(r.reward_authorized_won,0),'heldWon',coalesce(r.reward_held_won,0),
    'capturedWon',coalesce(r.reward_captured_won,0),'releasedWon',coalesce(r.reward_released_won,0),'refundedWon',coalesce(r.reward_refunded_won,0));
  funded:=a.reserve_won;
  captured:=div(funded::numeric*(principal->>'capturedWon')::bigint,a.principal_won)::bigint;
  released:=funded-div(funded::numeric*(a.principal_won-(principal->>'releasedWon')::bigint),a.principal_won)::bigint;
  refunded:=div(funded::numeric*(principal->>'refundedWon')::bigint,a.principal_won)::bigint;
  RETURN jsonb_build_object('principal',principal,'rewards',rewards,'reserve',jsonb_build_object('authorizedWon',funded,
    'heldWon',funded-captured-released,'capturedWon',captured,'releasedWon',released,'refundedWon',refunded));
END; $$;
CREATE FUNCTION reserve_complete_receipt() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE funding JSONB;
BEGIN
  funding:=reserve_payment_funding(NEW.payment_id);
  IF funding IS NOT NULL THEN NEW.result:=jsonb_set(NEW.result,'{payment,funding}',funding); END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER a_reserve_complete_receipt BEFORE UPDATE OF result ON card_payment_events FOR EACH ROW WHEN(OLD.result IS NULL AND NEW.result IS NOT NULL)
  EXECUTE FUNCTION reserve_complete_receipt();

-- Preserve the original OID called by the existing policy and inbox functions.
-- The delegating function performs only the shortfall transfer and attribution;
-- the established financial command still owns the actual hold/capture/refund.
DO $$ DECLARE body TEXT; BEGIN
  body:=pg_get_functiondef('apply_sandbox_card_event_financial_004(jsonb,bigint)'::regprocedure);
  EXECUTE replace(body,'apply_sandbox_card_event_financial_004(','reserve_base_card_event_004(');
END; $$;
CREATE OR REPLACE FUNCTION apply_sandbox_card_event_financial_004(p_input JSONB,p_now BIGINT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE uid TEXT:=p_input->>'userId'; pid TEXT:=p_input->>'paymentId'; eid TEXT:=p_input->>'eventId'; action TEXT:=p_input->>'kind';
  pref BOOLEAN; need BIGINT; spend BIGINT; principal BIGINT; reward_portion BIGINT; previous_release BIGINT;
  release_delta BIGINT; answer JSONB; original card_payment_events%ROWTYPE;
BEGIN
  SELECT auto_use INTO pref FROM reserve_wallets WHERE user_id=uid FOR UPDATE;
  SELECT * INTO original FROM card_payment_events WHERE event_id=eid;
  IF FOUND THEN RETURN reserve_base_card_event_004(p_input,p_now); END IF;
  IF action='authorize' AND pref THEN
    -- Use the same account lock order as the existing financial function. The
    -- wallet lock protects an ordinary transfer racing this authorization.
    PERFORM id FROM ledger_accounts WHERE id IN ('hold:'||uid,'reserve:'||uid,'user:'||uid,'system:card_settlement',
      'system:reward_budget','system:reward_backing','system:reward_cashback_reserved') ORDER BY id FOR UPDATE;
    SELECT CASE WHEN use_first THEN least(available_won,(p_input->>'amountWon')::bigint) ELSE 0 END INTO reward_portion
      FROM reward_wallets WHERE user_id=uid FOR UPDATE;
    principal:=(p_input->>'amountWon')::bigint-reward_portion;
    SELECT balance_won INTO spend FROM ledger_accounts WHERE id='user:'||uid;
    need:=principal-spend;
    IF need>0 THEN
      IF EXISTS(SELECT 1 FROM card_payments WHERE id=pid) THEN RAISE EXCEPTION 'CARD_STATE_CONFLICT'; END IF;
      PERFORM reserve_move(uid,false,need,NULL,eid,p_now);
      INSERT INTO card_reserve_allocations(payment_id,user_id,principal_won,reserve_won) VALUES(pid,uid,principal,need);
    END IF;
  END IF;
  IF action IN ('capture','reverse') THEN
    previous_release:=coalesce((reserve_payment_funding(pid)->'reserve'->>'releasedWon')::bigint,0);
  END IF;
  answer:=reserve_base_card_event_004(p_input,p_now);
  -- The persisted receipt also includes the split added before finalization.
  SELECT result INTO STRICT answer FROM card_payment_events WHERE event_id=eid;
  IF action IN ('capture','reverse') AND answer->'payment'->'funding' ? 'reserve' THEN
    release_delta:=(answer->'payment'->'funding'->'reserve'->>'releasedWon')::bigint-previous_release;
    IF release_delta>0 THEN PERFORM reserve_move(uid,true,release_delta,NULL,eid,p_now); END IF;
  END IF;
  RETURN answer;
END; $$;

REVOKE ALL ON FUNCTION reserve_on_signup(),reserve_post_journal(),reserve_principal_capacity(),reserve_move(text,boolean,bigint,text,text,bigint),
  reserve_snapshot(text),apply_reserve_command(jsonb,bigint),reserve_payment_funding(text),reserve_complete_receipt(),
  reserve_base_card_event_004(jsonb,bigint) FROM PUBLIC;
