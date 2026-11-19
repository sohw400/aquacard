-- Noncash card benefits have their own unit and immutable journal. TEST_KRW is
-- moved only between existing principal accounts and explicitly funded company accounts.
ALTER TABLE ledger_accounts DROP CONSTRAINT ledger_accounts_kind_guard, DROP CONSTRAINT ledger_accounts_balance_guard;
ALTER TABLE ledger_accounts
  ADD CONSTRAINT ledger_accounts_kind_guard CHECK (kind IN ('user_spend','user_card_hold','sandbox_control','sandbox_card_settlement','reward_budget','reward_backing','reward_cashback_reserved')),
  ADD CONSTRAINT ledger_accounts_balance_guard CHECK (
    (kind IN ('user_spend','user_card_hold') AND user_id IS NOT NULL AND balance_won BETWEEN 0 AND 9007199254740991)
    OR (kind = 'sandbox_control' AND user_id IS NULL AND balance_won <= 0)
    OR (kind IN ('sandbox_card_settlement','reward_budget','reward_backing','reward_cashback_reserved') AND user_id IS NULL AND balance_won >= 0));
CREATE UNIQUE INDEX ledger_single_reward_company_kind ON ledger_accounts(kind)
  WHERE kind IN ('reward_budget','reward_backing','reward_cashback_reserved');
INSERT INTO ledger_accounts(id,user_id,kind) VALUES
  ('system:reward_budget',NULL,'reward_budget'),
  ('system:reward_backing',NULL,'reward_backing'),
  ('system:reward_cashback_reserved',NULL,'reward_cashback_reserved');

CREATE TABLE reward_program (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK(singleton),
  enabled BOOLEAN NOT NULL DEFAULT false
);
INSERT INTO reward_program(singleton) VALUES(true);
CREATE TABLE reward_wallets (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  available_won BIGINT NOT NULL DEFAULT 0 CHECK(available_won BETWEEN 0 AND 9007199254740991),
  held_won BIGINT NOT NULL DEFAULT 0 CHECK(held_won BETWEEN 0 AND 9007199254740991),
  adjustment_due_won BIGINT NOT NULL DEFAULT 0 CHECK(adjustment_due_won BETWEEN 0 AND 9007199254740991),
  use_first BOOLEAN NOT NULL DEFAULT true,
  preference_version BIGINT NOT NULL DEFAULT 0 CHECK(preference_version BETWEEN 0 AND 9007199254740991),
  CHECK(available_won + held_won <= 9007199254740991),
  CHECK(available_won = 0 OR adjustment_due_won = 0)
);
INSERT INTO reward_wallets(user_id) SELECT id FROM users;
CREATE FUNCTION reward_create_wallet() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
BEGIN INSERT INTO reward_wallets(user_id) VALUES(NEW.id); RETURN NEW; END;
$$;
CREATE TRIGGER users_create_reward_wallet AFTER INSERT ON users FOR EACH ROW EXECUTE FUNCTION reward_create_wallet();

CREATE TABLE reward_commands (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  scope TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('preference','fund_budget','program','grant')),
  user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  canonical_input JSONB NOT NULL CHECK(jsonb_typeof(canonical_input)='object'),
  result JSONB CHECK(result IS NULL OR jsonb_typeof(result)='object'),
  created_at BIGINT NOT NULL CHECK(created_at BETWEEN 0 AND 8640000000000000),
  UNIQUE(scope,idempotency_key)
);
CREATE TABLE reward_cashback_months (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  month TEXT NOT NULL CHECK(month ~ '^[0-9]{4}-[0-9]{2}$'),
  reserved_won BIGINT NOT NULL DEFAULT 0 CHECK(reserved_won BETWEEN 0 AND 10000),
  awarded_won BIGINT NOT NULL DEFAULT 0 CHECK(awarded_won BETWEEN 0 AND 9007199254740991),
  reversed_won BIGINT NOT NULL DEFAULT 0 CHECK(reversed_won BETWEEN 0 AND awarded_won),
  PRIMARY KEY(user_id,month),
  CHECK(reserved_won + awarded_won - reversed_won <= 10000)
);
CREATE TABLE card_reward_allocations (
  payment_id TEXT PRIMARY KEY REFERENCES card_payments(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  policy_version TEXT NOT NULL DEFAULT 'standard-v1',
  month TEXT NOT NULL CHECK(month ~ '^[0-9]{4}-[0-9]{2}$'),
  rate_bps INTEGER NOT NULL CHECK(rate_bps IN (0,100)),
  principal_authorized_won BIGINT NOT NULL,
  principal_held_won BIGINT NOT NULL,
  principal_captured_won BIGINT NOT NULL DEFAULT 0,
  principal_released_won BIGINT NOT NULL DEFAULT 0,
  principal_refunded_won BIGINT NOT NULL DEFAULT 0,
  reward_authorized_won BIGINT NOT NULL,
  reward_held_won BIGINT NOT NULL,
  reward_captured_won BIGINT NOT NULL DEFAULT 0,
  reward_released_won BIGINT NOT NULL DEFAULT 0,
  reward_refunded_won BIGINT NOT NULL DEFAULT 0,
  cashback_initial_reserved_won BIGINT NOT NULL DEFAULT 0 CHECK(cashback_initial_reserved_won BETWEEN 0 AND 10000),
  cashback_pending_won BIGINT NOT NULL DEFAULT 0 CHECK(cashback_pending_won BETWEEN 0 AND cashback_initial_reserved_won),
  cashback_awarded_won BIGINT NOT NULL DEFAULT 0 CHECK(cashback_awarded_won BETWEEN 0 AND cashback_initial_reserved_won),
  cashback_reversed_won BIGINT NOT NULL DEFAULT 0 CHECK(cashback_reversed_won BETWEEN 0 AND cashback_awarded_won),
  cashback_offset_won BIGINT NOT NULL DEFAULT 0 CHECK(cashback_offset_won BETWEEN 0 AND cashback_awarded_won),
  cashback_eligible_won_at_close BIGINT CHECK(cashback_eligible_won_at_close BETWEEN 0 AND 9007199254740991),
  principal_refunded_at_close BIGINT CHECK(principal_refunded_at_close BETWEEN 0 AND 9007199254740991),
  closed_at BIGINT CHECK(closed_at BETWEEN 0 AND 8640000000000000),
  FOREIGN KEY(user_id,month) REFERENCES reward_cashback_months(user_id,month),
  CHECK(principal_authorized_won BETWEEN 0 AND 9007199254740991 AND reward_authorized_won BETWEEN 0 AND 9007199254740991),
  CHECK(principal_held_won>=0 AND principal_captured_won>=0 AND principal_released_won>=0 AND principal_refunded_won BETWEEN 0 AND principal_captured_won),
  CHECK(reward_held_won>=0 AND reward_captured_won>=0 AND reward_released_won>=0 AND reward_refunded_won BETWEEN 0 AND reward_captured_won),
  CHECK(principal_authorized_won=principal_held_won+principal_captured_won+principal_released_won),
  CHECK(reward_authorized_won=reward_held_won+reward_captured_won+reward_released_won),
  CHECK(principal_authorized_won+reward_authorized_won<=9007199254740991),
  CHECK((closed_at IS NULL AND cashback_eligible_won_at_close IS NULL AND principal_refunded_at_close IS NULL)
    OR (closed_at IS NOT NULL AND cashback_pending_won=0 AND cashback_eligible_won_at_close IS NOT NULL AND principal_refunded_at_close IS NOT NULL))
);
CREATE INDEX card_reward_allocations_owner ON card_reward_allocations(user_id,month,payment_id);

CREATE TABLE reward_journals (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id TEXT NOT NULL REFERENCES reward_wallets(user_id) ON DELETE RESTRICT,
  currency TEXT NOT NULL DEFAULT 'TEST_AQUA_REWARD' CHECK(currency='TEST_AQUA_REWARD'),
  kind TEXT NOT NULL CHECK(kind IN ('grant','cashback','card_authorize','card_capture','card_release','card_refund','cashback_reversal','adjustment_offset')),
  amount_won BIGINT NOT NULL CHECK(amount_won BETWEEN 1 AND 9007199254740991),
  available_delta_won BIGINT NOT NULL,
  held_delta_won BIGINT NOT NULL,
  adjustment_delta_won BIGINT NOT NULL,
  issuer_delta_won BIGINT GENERATED ALWAYS AS (-(available_delta_won+held_delta_won-adjustment_delta_won)) STORED,
  payment_id TEXT REFERENCES card_payments(id) ON DELETE RESTRICT,
  card_event_id TEXT REFERENCES card_payment_events(event_id) ON DELETE RESTRICT,
  command_id TEXT REFERENCES reward_commands(id) ON DELETE RESTRICT,
  component TEXT NOT NULL,
  created_at BIGINT NOT NULL CHECK(created_at BETWEEN 0 AND 8640000000000000),
  CHECK((card_event_id IS NOT NULL AND command_id IS NULL AND payment_id IS NOT NULL)
    OR (card_event_id IS NULL AND command_id IS NOT NULL AND payment_id IS NULL)),
  UNIQUE(card_event_id,component), UNIQUE(command_id,component)
);
CREATE INDEX reward_journals_owner ON reward_journals(user_id,created_at DESC,id DESC);
CREATE VIEW reward_entries AS
  SELECT id AS journal_id,'reward:'||user_id AS account_id,user_id,currency,available_delta_won AS amount_won,created_at FROM reward_journals WHERE available_delta_won<>0
  UNION ALL SELECT id,'reward_hold:'||user_id,user_id,currency,held_delta_won,created_at FROM reward_journals WHERE held_delta_won<>0
  UNION ALL SELECT id,'reward_due:'||user_id,user_id,currency,-adjustment_delta_won,created_at FROM reward_journals WHERE adjustment_delta_won<>0
  UNION ALL SELECT id,'system:reward_issuer',NULL,currency,issuer_delta_won,created_at FROM reward_journals WHERE issuer_delta_won<>0;
CREATE VIEW reward_history AS SELECT id,user_id,kind,amount_won,payment_id,created_at,
  available_delta_won,held_delta_won,adjustment_delta_won FROM reward_journals;

-- Private cash plans make every privileged company posting auditable and prevent
-- a caller-set GUC from authorizing a raw INSERT into the public KRW journal.
CREATE TABLE reward_cash_plans (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  journal_id TEXT NOT NULL UNIQUE DEFAULT gen_random_uuid()::text,
  card_event_id TEXT REFERENCES card_payment_events(event_id) ON DELETE RESTRICT,
  command_id TEXT REFERENCES reward_commands(id) ON DELETE RESTRICT,
  component TEXT NOT NULL,
  from_account_id TEXT NOT NULL REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  to_account_id TEXT NOT NULL REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  amount_won BIGINT NOT NULL CHECK(amount_won BETWEEN 1 AND 9007199254740991),
  created_at BIGINT NOT NULL CHECK(created_at BETWEEN 0 AND 8640000000000000),
  CHECK((card_event_id IS NOT NULL) <> (command_id IS NOT NULL)),
  UNIQUE(card_event_id,component), UNIQUE(command_id,component),
  FOREIGN KEY(journal_id) REFERENCES journals(id) DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE journals ADD COLUMN reward_component TEXT, ADD COLUMN reward_command_id TEXT REFERENCES reward_commands(id),
  ADD COLUMN reward_plan_id TEXT UNIQUE REFERENCES reward_cash_plans(id),
  ALTER COLUMN recipient_id DROP NOT NULL, ALTER COLUMN request_owner_id DROP NOT NULL,
  DROP CONSTRAINT journals_card_event_kind_key, DROP CONSTRAINT journals_kind_guard,
  DROP CONSTRAINT journals_owner_guard, DROP CONSTRAINT journals_card_link_guard;
CREATE UNIQUE INDEX journals_legacy_card_event_kind ON journals(card_event_id,kind) WHERE reward_component IS NULL;
CREATE UNIQUE INDEX journals_reward_card_component ON journals(card_event_id,reward_component) WHERE reward_component IS NOT NULL;
CREATE UNIQUE INDEX journals_reward_command_component ON journals(reward_command_id,reward_component) WHERE reward_command_id IS NOT NULL;
ALTER TABLE journals ADD CONSTRAINT journals_kind_guard CHECK(kind IN ('member_transfer','sandbox_credit','card_authorize','card_reverse','card_capture','card_refund','reward_funding')),
  ADD CONSTRAINT journals_owner_guard CHECK(
    (kind='member_transfer' AND sender_id IS NOT NULL AND recipient_id IS NOT NULL AND request_owner_id IS NOT NULL AND sender_id<>recipient_id AND request_owner_id=sender_id)
    OR (kind='sandbox_credit' AND sender_id IS NULL AND recipient_id IS NOT NULL AND request_owner_id IS NOT NULL AND request_owner_id=recipient_id)
    OR (kind IN ('card_authorize','card_reverse','card_capture','card_refund') AND sender_id IS NOT NULL AND recipient_id IS NOT NULL AND request_owner_id IS NOT NULL AND sender_id=recipient_id AND request_owner_id=recipient_id)
    OR (kind='reward_funding' AND reward_plan_id IS NOT NULL)),
  ADD CONSTRAINT journals_card_link_guard CHECK(
    (reward_plan_id IS NOT NULL AND reward_component IS NOT NULL AND kind='reward_funding'
      AND ((card_event_id IS NOT NULL AND card_payment_id IS NOT NULL AND reward_command_id IS NULL)
        OR (card_event_id IS NULL AND card_payment_id IS NULL AND reward_command_id IS NOT NULL)))
    OR (reward_plan_id IS NULL AND reward_component IS NULL AND reward_command_id IS NULL AND (
      (kind IN ('member_transfer','sandbox_credit') AND card_payment_id IS NULL AND card_event_id IS NULL AND idempotency_key NOT LIKE '$card:%')
      OR (kind IN ('card_authorize','card_reverse','card_capture','card_refund') AND card_payment_id IS NOT NULL AND card_event_id IS NOT NULL AND idempotency_key LIKE '$card:%'))));

-- Copy the old command to a new, private OID. The original OID is replaced below,
-- so existing runtime EXECUTE grants cannot continue to call a legacy implementation.
DO $$ DECLARE definition TEXT; BEGIN
  SELECT pg_get_functiondef('apply_sandbox_card_event(jsonb,bigint)'::regprocedure) INTO definition;
  EXECUTE replace(definition,'apply_sandbox_card_event(','apply_sandbox_card_event_legacy_003(');
END; $$;
REVOKE ALL ON FUNCTION apply_sandbox_card_event_legacy_003(JSONB,BIGINT) FROM PUBLIC;

CREATE FUNCTION reward_private_context(p_command TEXT,p_event TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE SET search_path FROM CURRENT AS $$
  SELECT (p_command IS NOT NULL AND p_event IS NULL
      AND p_command=nullif(current_setting('aqua.reward_command_id',true),'')
      AND EXISTS(SELECT 1 FROM reward_commands WHERE id=p_command AND result IS NULL))
    OR (p_event IS NOT NULL AND p_command IS NULL
      AND p_event=nullif(current_setting('aqua.card_event_id',true),'')
      AND EXISTS(SELECT 1 FROM card_payment_events WHERE event_id=p_event AND result IS NULL));
$$;
CREATE FUNCTION reward_guard_projection() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE command reward_commands%ROWTYPE; event card_payment_events%ROWTYPE;
BEGIN
  IF current_user IS DISTINCT FROM pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=TG_RELID)) THEN
    RAISE EXCEPTION 'Reward projection is protected' USING ERRCODE='55000';
  END IF;
  SELECT * INTO command FROM reward_commands WHERE id=nullif(current_setting('aqua.reward_command_id',true),'') AND result IS NULL;
  SELECT * INTO event FROM card_payment_events WHERE event_id=nullif(current_setting('aqua.card_event_id',true),'') AND result IS NULL;
  IF TG_TABLE_NAME='reward_wallets' THEN
    IF TG_OP='INSERT' THEN
      IF NEW.available_won<>0 OR NEW.held_won<>0 OR NEW.adjustment_due_won<>0 OR NOT NEW.use_first OR NEW.preference_version<>0 THEN
        RAISE EXCEPTION 'Reward wallets must start empty' USING ERRCODE='55000';
      END IF;
    ELSIF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
      RAISE EXCEPTION 'Reward wallet identity is immutable' USING ERRCODE='55000';
    ELSIF command.kind='preference' AND command.user_id=NEW.user_id THEN
      IF ROW(NEW.available_won,NEW.held_won,NEW.adjustment_due_won) IS DISTINCT FROM ROW(OLD.available_won,OLD.held_won,OLD.adjustment_due_won)
        OR NEW.preference_version<>OLD.preference_version+1 THEN RAISE EXCEPTION 'Reward projection is protected' USING ERRCODE='55000'; END IF;
    ELSIF pg_trigger_depth()<>2 OR (command.id IS NULL AND event.event_id IS NULL)
      OR ROW(NEW.use_first,NEW.preference_version) IS DISTINCT FROM ROW(OLD.use_first,OLD.preference_version) THEN
      RAISE EXCEPTION 'Reward projection is protected' USING ERRCODE='55000';
    END IF;
  ELSIF TG_TABLE_NAME='reward_program' THEN
    IF command.kind IS DISTINCT FROM 'program' THEN RAISE EXCEPTION 'Reward program is protected' USING ERRCODE='55000'; END IF;
  ELSIF event.event_id IS NULL OR event.user_id<>NEW.user_id THEN
    RAISE EXCEPTION 'Reward projection requires an unfinished card command' USING ERRCODE='55000';
  ELSIF TG_OP='UPDATE' AND TG_TABLE_NAME='reward_cashback_months' THEN
    IF ROW(NEW.user_id,NEW.month) IS DISTINCT FROM ROW(OLD.user_id,OLD.month) THEN RAISE EXCEPTION 'Reward month is immutable' USING ERRCODE='55000'; END IF;
  ELSIF TG_OP='UPDATE' AND TG_TABLE_NAME='card_reward_allocations' THEN
    IF ROW(NEW.payment_id,NEW.user_id,NEW.policy_version,NEW.month,NEW.rate_bps,NEW.principal_authorized_won,NEW.reward_authorized_won,NEW.cashback_initial_reserved_won)
      IS DISTINCT FROM ROW(OLD.payment_id,OLD.user_id,OLD.policy_version,OLD.month,OLD.rate_bps,OLD.principal_authorized_won,OLD.reward_authorized_won,OLD.cashback_initial_reserved_won) THEN
      RAISE EXCEPTION 'Reward allocation identity is immutable' USING ERRCODE='55000';
    END IF;
    IF OLD.closed_at IS NOT NULL AND ROW(NEW.closed_at,NEW.cashback_eligible_won_at_close,NEW.principal_refunded_at_close,NEW.cashback_awarded_won,NEW.cashback_offset_won)
      IS DISTINCT FROM ROW(OLD.closed_at,OLD.cashback_eligible_won_at_close,OLD.principal_refunded_at_close,OLD.cashback_awarded_won,OLD.cashback_offset_won) THEN
      RAISE EXCEPTION 'Reward closure basis is immutable' USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER reward_wallets_guard BEFORE INSERT OR UPDATE ON reward_wallets FOR EACH ROW EXECUTE FUNCTION reward_guard_projection();
CREATE TRIGGER reward_program_guard BEFORE UPDATE ON reward_program FOR EACH ROW EXECUTE FUNCTION reward_guard_projection();
CREATE TRIGGER reward_months_guard BEFORE INSERT OR UPDATE ON reward_cashback_months FOR EACH ROW EXECUTE FUNCTION reward_guard_projection();
CREATE TRIGGER card_reward_allocations_guard BEFORE INSERT OR UPDATE ON card_reward_allocations FOR EACH ROW EXECUTE FUNCTION reward_guard_projection();

CREATE FUNCTION reward_guard_command() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF current_user IS DISTINCT FROM pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=TG_RELID)) THEN
    RAISE EXCEPTION 'Reward command history is immutable' USING ERRCODE='55000';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.result IS NOT NULL THEN RAISE EXCEPTION 'Reward command must start unfinished' USING ERRCODE='55000'; END IF;
  ELSIF NEW.id IS DISTINCT FROM nullif(current_setting('aqua.reward_command_id',true),'')
    OR OLD.result IS NOT NULL OR NEW.result IS NULL
    OR (to_jsonb(NEW)-'result') IS DISTINCT FROM (to_jsonb(OLD)-'result') THEN
    RAISE EXCEPTION 'Reward command history is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER reward_commands_guard BEFORE INSERT OR UPDATE ON reward_commands FOR EACH ROW EXECUTE FUNCTION reward_guard_command();
CREATE FUNCTION reward_guard_private_insert() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF current_user IS DISTINCT FROM pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=TG_RELID))
    OR NOT reward_private_context(NEW.command_id,NEW.card_event_id) THEN
    RAISE EXCEPTION 'Reward journals require a private unfinished command' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER reward_journals_guard BEFORE INSERT ON reward_journals FOR EACH ROW EXECUTE FUNCTION reward_guard_private_insert();
CREATE TRIGGER reward_cash_plans_guard BEFORE INSERT ON reward_cash_plans FOR EACH ROW EXECUTE FUNCTION reward_guard_private_insert();
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['reward_commands','reward_journals','reward_cash_plans','reward_wallets','reward_cashback_months','card_reward_allocations','reward_program'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION ledger_reject_history_change()',t||'_no_delete',t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION ledger_reject_history_change()',t||'_no_truncate',t);
    IF t IN ('reward_journals','reward_cash_plans') THEN
      EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION ledger_reject_history_change()',t||'_immutable',t);
    END IF;
  END LOOP;
END; $$;

CREATE FUNCTION reward_post_units_projection() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE w reward_wallets%ROWTYPE; a BIGINT; h BIGINT; d BIGINT;
BEGIN
  IF NOT reward_private_context(NEW.command_id,NEW.card_event_id) THEN RAISE EXCEPTION 'Reward journal context is invalid' USING ERRCODE='55000'; END IF;
  IF (NEW.kind IN ('grant','cashback','card_refund') AND NOT (NEW.held_delta_won=0 AND NEW.available_delta_won>=0 AND NEW.adjustment_delta_won<=0 AND NEW.available_delta_won-NEW.adjustment_delta_won=NEW.amount_won))
    OR (NEW.kind='card_authorize' AND ROW(NEW.available_delta_won,NEW.held_delta_won,NEW.adjustment_delta_won) IS DISTINCT FROM ROW(-NEW.amount_won,NEW.amount_won,0::BIGINT))
    OR (NEW.kind='card_capture' AND ROW(NEW.available_delta_won,NEW.held_delta_won,NEW.adjustment_delta_won) IS DISTINCT FROM ROW(0::BIGINT,-NEW.amount_won,0::BIGINT))
    OR (NEW.kind='card_release' AND NOT (NEW.held_delta_won=-NEW.amount_won AND NEW.available_delta_won>=0 AND NEW.adjustment_delta_won<=0 AND NEW.available_delta_won-NEW.adjustment_delta_won=NEW.amount_won))
    OR (NEW.kind='cashback_reversal' AND NOT (NEW.held_delta_won=0 AND NEW.available_delta_won<=0 AND NEW.adjustment_delta_won>=0 AND -NEW.available_delta_won+NEW.adjustment_delta_won=NEW.amount_won))
    OR (NEW.kind='adjustment_offset' AND ROW(NEW.available_delta_won,NEW.held_delta_won,NEW.adjustment_delta_won) IS DISTINCT FROM ROW(-NEW.amount_won,0::BIGINT,-NEW.amount_won)) THEN
    RAISE EXCEPTION 'Invalid noncash reward journal' USING ERRCODE='23514';
  END IF;
  SELECT * INTO w FROM reward_wallets WHERE user_id=NEW.user_id FOR UPDATE;
  a:=w.available_won+NEW.available_delta_won; h:=w.held_won+NEW.held_delta_won; d:=w.adjustment_due_won+NEW.adjustment_delta_won;
  IF w.user_id IS NULL OR a<0 OR h<0 OR d<0 OR a+h>9007199254740991 OR d>9007199254740991 THEN
    RAISE EXCEPTION 'REWARD_BALANCE_LIMIT' USING ERRCODE='P0001';
  END IF;
  UPDATE reward_wallets SET available_won=a,held_won=h,adjustment_due_won=d WHERE user_id=w.user_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER reward_journals_post AFTER INSERT ON reward_journals FOR EACH ROW EXECUTE FUNCTION reward_post_units_projection();

CREATE FUNCTION reward_post_units(p_user TEXT,p_kind TEXT,p_amount BIGINT,p_available BIGINT,p_held BIGINT,p_due BIGINT,p_payment TEXT,p_component TEXT,p_now BIGINT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE cmd TEXT:=nullif(current_setting('aqua.reward_command_id',true),''); evt TEXT:=nullif(current_setting('aqua.card_event_id',true),'');
BEGIN
  IF p_amount=0 THEN RETURN; END IF;
  IF cmd IS NOT NULL AND EXISTS(SELECT 1 FROM reward_commands WHERE id=cmd AND result IS NULL) THEN evt:=NULL; ELSE cmd:=NULL; END IF;
  IF NOT reward_private_context(cmd,evt) THEN RAISE EXCEPTION 'Reward command context is invalid' USING ERRCODE='55000'; END IF;
  INSERT INTO reward_journals(user_id,kind,amount_won,available_delta_won,held_delta_won,adjustment_delta_won,payment_id,card_event_id,command_id,component,created_at)
    VALUES(p_user,p_kind,p_amount,p_available,p_held,p_due,p_payment,evt,cmd,p_component,p_now);
END;
$$;

CREATE FUNCTION reward_apply_cash_plan(p journals) RETURNS journals
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE plan reward_cash_plans%ROWTYPE; c reward_commands%ROWTYPE; e card_payment_events%ROWTYPE;
  source ledger_accounts%ROWTYPE; target ledger_accounts%ROWTYPE; owner_key TEXT; legal BOOLEAN:=false; held BIGINT;
BEGIN
  SELECT * INTO plan FROM reward_cash_plans WHERE id=p.reward_plan_id;
  IF plan.id IS NULL OR NOT reward_private_context(plan.command_id,plan.card_event_id)
    OR ROW(p.id,p.from_account_id,p.to_account_id,p.amount_won,p.reward_component,p.card_event_id,p.reward_command_id,p.created_at)
      IS DISTINCT FROM ROW(plan.journal_id,plan.from_account_id,plan.to_account_id,plan.amount_won,plan.component,plan.card_event_id,plan.command_id,plan.created_at)
    OR p.kind<>'reward_funding' OR p.balance_after_won<>0 THEN RAISE EXCEPTION 'Invalid private reward cash plan' USING ERRCODE='55000'; END IF;
  IF plan.command_id IS NOT NULL THEN
    SELECT * INTO c FROM reward_commands WHERE id=plan.command_id; owner_key:=c.user_id;
    legal:=(c.kind='fund_budget' AND plan.component='budget_fund' AND plan.from_account_id='system:sandbox' AND plan.to_account_id='system:reward_budget' AND plan.amount_won=(c.canonical_input->>'amountWon')::BIGINT)
      OR (c.kind='grant' AND plan.component='grant_backing' AND plan.from_account_id='system:reward_budget' AND plan.to_account_id='system:reward_backing');
  ELSE
    SELECT * INTO e FROM card_payment_events WHERE event_id=plan.card_event_id; owner_key:=e.user_id;
    IF p.card_payment_id IS DISTINCT FROM e.payment_id THEN RAISE EXCEPTION 'Invalid reward card cash link' USING ERRCODE='55000'; END IF;
    legal:=CASE plan.component
      WHEN 'principal_authorize' THEN e.kind='authorize' AND plan.from_account_id='user:'||owner_key AND plan.to_account_id='hold:'||owner_key
      WHEN 'principal_capture' THEN e.kind='capture' AND plan.from_account_id='hold:'||owner_key AND plan.to_account_id='system:card_settlement'
      WHEN 'principal_release' THEN e.kind IN ('capture','reverse') AND plan.from_account_id='hold:'||owner_key AND plan.to_account_id='user:'||owner_key
      WHEN 'principal_refund' THEN e.kind='refund' AND plan.from_account_id='system:card_settlement' AND plan.to_account_id='user:'||owner_key
      WHEN 'reward_capture' THEN e.kind='capture' AND plan.from_account_id='system:reward_backing' AND plan.to_account_id='system:card_settlement'
      WHEN 'reward_refund' THEN e.kind='refund' AND plan.from_account_id='system:card_settlement' AND plan.to_account_id='system:reward_backing'
      WHEN 'cashback_reserve' THEN e.kind='authorize' AND plan.from_account_id='system:reward_budget' AND plan.to_account_id='system:reward_cashback_reserved'
      WHEN 'cashback_backing' THEN plan.from_account_id='system:reward_cashback_reserved' AND plan.to_account_id='system:reward_backing'
      WHEN 'cashback_release' THEN plan.from_account_id='system:reward_cashback_reserved' AND plan.to_account_id='system:reward_budget'
      WHEN 'release_offset' THEN e.kind IN ('capture','reverse') AND plan.from_account_id='system:reward_backing' AND plan.to_account_id='system:reward_budget'
      WHEN 'refund_offset' THEN e.kind='refund' AND plan.from_account_id='system:reward_backing' AND plan.to_account_id='system:reward_budget'
      WHEN 'cashback_clawback' THEN e.kind='refund' AND plan.from_account_id='system:reward_backing' AND plan.to_account_id='system:reward_budget'
      ELSE false END;
  END IF;
  IF NOT coalesce(legal,false) OR p.request_owner_id IS DISTINCT FROM owner_key OR p.recipient_id IS DISTINCT FROM owner_key OR p.sender_id IS DISTINCT FROM owner_key THEN
    RAISE EXCEPTION 'Invalid reward funding matrix' USING ERRCODE='23514';
  END IF;
  PERFORM id FROM ledger_accounts WHERE id IN(plan.from_account_id,plan.to_account_id) ORDER BY id FOR UPDATE;
  SELECT * INTO source FROM ledger_accounts WHERE id=plan.from_account_id;
  SELECT * INTO target FROM ledger_accounts WHERE id=plan.to_account_id;
  IF source.id IS NULL OR target.id IS NULL OR p.currency<>'TEST_KRW' OR source.currency<>p.currency OR target.currency<>p.currency THEN
    RAISE EXCEPTION 'Invalid reward cash currency' USING ERRCODE='23514';
  END IF;
  IF source.kind<>'sandbox_control' AND source.balance_won<p.amount_won THEN
    IF source.kind IN ('reward_budget','reward_cashback_reserved') THEN RAISE EXCEPTION 'REWARD_BUDGET_UNAVAILABLE' USING ERRCODE='P0001'; END IF;
    RAISE EXCEPTION 'REWARD_BACKING_MISMATCH' USING ERRCODE='P0001';
  END IF;
  IF target.kind='user_spend' AND plan.component<>'principal_release' THEN
    SELECT balance_won INTO held FROM ledger_accounts WHERE id='hold:'||owner_key;
    IF p.amount_won>9007199254740991-target.balance_won-held THEN RAISE EXCEPTION 'RECIPIENT_BALANCE_LIMIT' USING ERRCODE='P0001'; END IF;
  END IF;
  IF target.balance_won::numeric+p.amount_won>9223372036854775807::numeric OR source.balance_won::numeric-p.amount_won<(-9223372036854775808)::numeric THEN
    RAISE EXCEPTION 'LEDGER_CAPACITY' USING ERRCODE='P0001';
  END IF;
  UPDATE ledger_accounts SET balance_won=balance_won-p.amount_won WHERE id=source.id;
  UPDATE ledger_accounts SET balance_won=balance_won+p.amount_won WHERE id=target.id;
  RETURN p;
END;
$$;
DO $$ DECLARE definition TEXT; BEGIN
  SELECT pg_get_functiondef('ledger_post_journal()'::regprocedure) INTO definition;
  EXECUTE replace(definition,E'BEGIN\n',E'BEGIN\n  IF NEW.reward_plan_id IS NOT NULL THEN RETURN reward_apply_cash_plan(NEW); END IF;\n');
END; $$;

CREATE FUNCTION reward_post_cash(p_component TEXT,p_from TEXT,p_to TEXT,p_amount BIGINT,p_now BIGINT) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE cmd TEXT:=nullif(current_setting('aqua.reward_command_id',true),''); evt TEXT:=nullif(current_setting('aqua.card_event_id',true),'');
  plan reward_cash_plans%ROWTYPE; owner_key TEXT; payment_key TEXT;
BEGIN
  IF p_amount=0 THEN RETURN; END IF;
  IF cmd IS NOT NULL AND EXISTS(SELECT 1 FROM reward_commands WHERE id=cmd AND result IS NULL) THEN
    evt:=NULL; SELECT user_id INTO owner_key FROM reward_commands WHERE id=cmd;
  ELSE
    cmd:=NULL; SELECT user_id,payment_id INTO owner_key,payment_key FROM card_payment_events WHERE event_id=evt;
  END IF;
  IF NOT reward_private_context(cmd,evt) THEN RAISE EXCEPTION 'Reward cash command context is invalid' USING ERRCODE='55000'; END IF;
  INSERT INTO reward_cash_plans(card_event_id,command_id,component,from_account_id,to_account_id,amount_won,created_at)
    VALUES(evt,cmd,p_component,p_from,p_to,p_amount,p_now) RETURNING * INTO plan;
  INSERT INTO journals(id,kind,from_account_id,to_account_id,amount_won,sender_id,recipient_id,sender_name,sender_tag,recipient_name,recipient_tag,
    request_owner_id,idempotency_key,request_payload,balance_after_won,created_at,card_payment_id,card_event_id,reward_component,reward_command_id,reward_plan_id)
    VALUES(plan.journal_id,'reward_funding',p_from,p_to,p_amount,owner_key,owner_key,'테스트 리워드','sandbox-reward','테스트 리워드','sandbox-reward',
      owner_key,'$reward:'||plan.id,'{}',0,p_now,payment_key,evt,p_component,cmd,plan.id);
END;
$$;
-- Read and operator commands for the independent noncash reward ledger.
CREATE FUNCTION rewards_snapshot(p_user_id TEXT,p_now BIGINT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE w reward_wallets%ROWTYPE; m reward_cashback_months%ROWTYPE; month_key TEXT; active BOOLEAN; history JSONB;
BEGIN
  IF p_now IS NULL OR p_now<0 OR p_now>8639999967600000 THEN RAISE EXCEPTION 'INVALID_REWARD_COMMAND' USING ERRCODE='22023'; END IF;
  SELECT * INTO w FROM reward_wallets WHERE user_id=p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'USER_NOT_FOUND'; END IF;
  month_key:=to_char(to_timestamp(p_now::double precision/1000) AT TIME ZONE 'Asia/Seoul','YYYY-MM');
  SELECT * INTO m FROM reward_cashback_months WHERE user_id=p_user_id AND month=month_key;
  SELECT enabled INTO active FROM reward_program WHERE singleton;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',h.id,'kind',h.kind,'amountWon',h.amount_won,
    'paymentId',h.payment_id,'createdAt',h.created_at,'availableDeltaWon',h.available_delta_won,
    'heldDeltaWon',h.held_delta_won,'adjustmentDeltaWon',h.adjustment_delta_won)
    ORDER BY h.created_at DESC,h.id DESC),'[]'::jsonb) INTO history
    FROM (SELECT * FROM reward_history WHERE user_id=p_user_id ORDER BY created_at DESC,id DESC LIMIT 50) h;
  RETURN jsonb_build_object('availableWon',w.available_won,'heldWon',w.held_won,'adjustmentDueWon',w.adjustment_due_won,
    'useFirst',w.use_first,'preferenceVersion',w.preference_version,'programActive',active,
    'policy',jsonb_build_object('version','standard-v1','rateBps',100,'monthlyCapWon',10000),
    'cashback',jsonb_build_object('month',month_key,'confirmedWon',COALESCE(m.awarded_won-m.reversed_won,0),
      'pendingWon',COALESCE(m.reserved_won,0),'reversedWon',COALESCE(m.reversed_won,0),
      'remainingWon',10000-COALESCE(m.reserved_won+m.awarded_won-m.reversed_won,0)), 'history',history);
END;
$$;
REVOKE ALL ON FUNCTION rewards_snapshot(TEXT,BIGINT) FROM PUBLIC;

CREATE FUNCTION apply_reward_preference(p_input JSONB,p_now BIGINT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
<<reward_command>>
DECLARE uid TEXT; request_key TEXT; scope_key TEXT; requested BOOLEAN; expected BIGINT;
  w reward_wallets%ROWTYPE; prior reward_commands%ROWTYPE; command_id TEXT; result JSONB;
  previous_context TEXT:=current_setting('aqua.reward_command_id',true);
BEGIN
  IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'INVALID_REWARD_COMMAND' USING ERRCODE='22023'; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p_input))<>4 OR NOT(p_input ?& ARRAY['userId','useFirst','expectedVersion','idempotencyKey'])
    OR jsonb_typeof(p_input->'userId') IS DISTINCT FROM 'string' OR (p_input->>'userId')!~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    OR jsonb_typeof(p_input->'idempotencyKey') IS DISTINCT FROM 'string' OR (p_input->>'idempotencyKey')!~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    OR jsonb_typeof(p_input->'useFirst') IS DISTINCT FROM 'boolean' OR jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number'
    OR (p_input->>'expectedVersion')!~'^[0-9]+$' OR p_now IS NULL OR p_now<0 OR p_now>8639999967600000
    THEN RAISE EXCEPTION 'INVALID_REWARD_COMMAND' USING ERRCODE='22023'; END IF;
  IF (p_input->>'expectedVersion')::numeric>9007199254740991 THEN RAISE EXCEPTION 'INVALID_REWARD_COMMAND' USING ERRCODE='22023'; END IF;
  uid:=p_input->>'userId'; request_key:=p_input->>'idempotencyKey'; scope_key:='pref:'||uid;
  requested:=(p_input->>'useFirst')::boolean; expected:=(p_input->>'expectedVersion')::bigint;
  SELECT * INTO prior FROM reward_commands WHERE scope=scope_key AND idempotency_key=request_key;
  IF FOUND THEN
    IF prior.canonical_input<>p_input THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
    IF prior.result IS NULL THEN RAISE EXCEPTION 'INVALID_REWARD_COMMAND'; END IF;
    RETURN prior.result;
  END IF;
  SELECT * INTO w FROM reward_wallets WHERE user_id=uid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'USER_NOT_FOUND'; END IF;
  SELECT * INTO prior FROM reward_commands WHERE scope=scope_key AND idempotency_key=request_key;
  IF FOUND THEN
    IF prior.canonical_input<>p_input THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
    RETURN prior.result;
  END IF;
  IF w.preference_version<>expected THEN RAISE EXCEPTION 'PREFERENCE_CHANGED'; END IF;
  IF w.preference_version=9007199254740991 THEN RAISE EXCEPTION 'REWARD_BALANCE_LIMIT'; END IF;
  INSERT INTO reward_commands(scope,kind,user_id,idempotency_key,canonical_input,created_at)
    VALUES(scope_key,'preference',uid,request_key,p_input,p_now) RETURNING id INTO command_id;
  PERFORM set_config('aqua.reward_command_id',command_id,true);
  UPDATE reward_wallets SET use_first=requested,preference_version=preference_version+1 WHERE user_id=uid;
  result:=jsonb_build_object('useFirst',requested,'version',w.preference_version+1);
  UPDATE reward_commands SET result=reward_command.result WHERE id=command_id;
  PERFORM set_config('aqua.reward_command_id',COALESCE(previous_context,''),true);
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION apply_reward_preference(JSONB,BIGINT) FROM PUBLIC;

CREATE FUNCTION operator_fund_reward_budget(p_input JSONB,p_now BIGINT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
<<reward_command>>
DECLARE request_key TEXT; amount BIGINT; prior reward_commands%ROWTYPE; command_id TEXT; result JSONB;
  budget BIGINT; control BIGINT; previous_context TEXT:=current_setting('aqua.reward_command_id',true);
BEGIN
  IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'INVALID_REWARD_COMMAND' USING ERRCODE='22023'; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p_input))<>2 OR NOT(p_input ?& ARRAY['amountWon','idempotencyKey'])
    OR jsonb_typeof(p_input->'idempotencyKey') IS DISTINCT FROM 'string' OR (p_input->>'idempotencyKey')!~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    OR jsonb_typeof(p_input->'amountWon') IS DISTINCT FROM 'number' OR (p_input->>'amountWon')!~'^[0-9]+$'
    OR p_now IS NULL OR p_now<0 OR p_now>8639999967600000 THEN RAISE EXCEPTION 'INVALID_REWARD_COMMAND' USING ERRCODE='22023'; END IF;
  IF (p_input->>'amountWon')::numeric NOT BETWEEN 1 AND 9007199254740991 THEN RAISE EXCEPTION 'INVALID_AMOUNT' USING ERRCODE='22023'; END IF;
  amount:=(p_input->>'amountWon')::bigint; request_key:=p_input->>'idempotencyKey';
  SELECT * INTO prior FROM reward_commands WHERE scope='fund_budget' AND idempotency_key=request_key;
  IF FOUND THEN
    IF prior.canonical_input<>p_input THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
    RETURN prior.result;
  END IF;
  PERFORM 1 FROM ledger_accounts WHERE id IN ('system:sandbox','system:reward_budget','system:reward_backing','system:reward_cashback_reserved') ORDER BY id FOR UPDATE;
  SELECT * INTO prior FROM reward_commands WHERE scope='fund_budget' AND idempotency_key=request_key;
  IF FOUND THEN
    IF prior.canonical_input<>p_input THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
    RETURN prior.result;
  END IF;
  SELECT balance_won INTO budget FROM ledger_accounts WHERE id='system:reward_budget';
  SELECT balance_won INTO control FROM ledger_accounts WHERE id='system:sandbox';
  IF budget::numeric+amount>9223372036854775807 OR control::numeric-amount<(-9223372036854775808)::numeric THEN RAISE EXCEPTION 'LEDGER_CAPACITY'; END IF;
  INSERT INTO reward_commands(scope,kind,idempotency_key,canonical_input,created_at)
    VALUES('fund_budget','fund_budget',request_key,p_input,p_now) RETURNING id INTO command_id;
  PERFORM set_config('aqua.reward_command_id',command_id,true);
  PERFORM reward_post_cash('budget_fund','system:sandbox','system:reward_budget',amount,p_now);
  result:=jsonb_build_object('amountWon',amount,'budgetWon',(budget+amount)::text);
  UPDATE reward_commands SET result=reward_command.result WHERE id=command_id;
  PERFORM set_config('aqua.reward_command_id',COALESCE(previous_context,''),true);
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION operator_fund_reward_budget(JSONB,BIGINT) FROM PUBLIC;

CREATE FUNCTION operator_set_reward_program(p_input JSONB,p_now BIGINT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
<<reward_command>>
DECLARE request_key TEXT; requested BOOLEAN; prior reward_commands%ROWTYPE; command_id TEXT; result JSONB;
  previous_context TEXT:=current_setting('aqua.reward_command_id',true);
BEGIN
  IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'INVALID_REWARD_COMMAND' USING ERRCODE='22023'; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p_input))<>2 OR NOT(p_input ?& ARRAY['enabled','idempotencyKey'])
    OR jsonb_typeof(p_input->'idempotencyKey') IS DISTINCT FROM 'string' OR (p_input->>'idempotencyKey')!~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    OR jsonb_typeof(p_input->'enabled') IS DISTINCT FROM 'boolean' OR p_now IS NULL OR p_now<0 OR p_now>8639999967600000
    THEN RAISE EXCEPTION 'INVALID_REWARD_COMMAND' USING ERRCODE='22023'; END IF;
  request_key:=p_input->>'idempotencyKey'; requested:=(p_input->>'enabled')::boolean;
  SELECT * INTO prior FROM reward_commands WHERE scope='program' AND idempotency_key=request_key;
  IF FOUND THEN
    IF prior.canonical_input<>p_input THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
    RETURN prior.result;
  END IF;
  PERFORM 1 FROM ledger_accounts WHERE id IN ('system:reward_budget','system:reward_backing','system:reward_cashback_reserved') ORDER BY id FOR UPDATE;
  PERFORM 1 FROM reward_program WHERE singleton FOR UPDATE;
  SELECT * INTO prior FROM reward_commands WHERE scope='program' AND idempotency_key=request_key;
  IF FOUND THEN
    IF prior.canonical_input<>p_input THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
    RETURN prior.result;
  END IF;
  INSERT INTO reward_commands(scope,kind,idempotency_key,canonical_input,created_at)
    VALUES('program','program',request_key,p_input,p_now) RETURNING id INTO command_id;
  PERFORM set_config('aqua.reward_command_id',command_id,true);
  UPDATE reward_program SET enabled=requested WHERE singleton;
  result:=jsonb_build_object('enabled',requested);
  UPDATE reward_commands SET result=reward_command.result WHERE id=command_id;
  PERFORM set_config('aqua.reward_command_id',COALESCE(previous_context,''),true);
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION operator_set_reward_program(JSONB,BIGINT) FROM PUBLIC;

CREATE FUNCTION operator_grant_rewards(p_input JSONB,p_now BIGINT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
<<reward_command>>
DECLARE uid TEXT; request_key TEXT; scope_key TEXT; amount BIGINT; offset_won BIGINT; net BIGINT;
  w reward_wallets%ROWTYPE; prior reward_commands%ROWTYPE; command_id TEXT; result JSONB;
  active BOOLEAN; budget BIGINT; backing BIGINT; previous_context TEXT:=current_setting('aqua.reward_command_id',true);
BEGIN
  IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'INVALID_REWARD_COMMAND' USING ERRCODE='22023'; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p_input))<>3 OR NOT(p_input ?& ARRAY['userId','amountWon','idempotencyKey'])
    OR jsonb_typeof(p_input->'userId') IS DISTINCT FROM 'string' OR (p_input->>'userId')!~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    OR jsonb_typeof(p_input->'idempotencyKey') IS DISTINCT FROM 'string' OR (p_input->>'idempotencyKey')!~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    OR jsonb_typeof(p_input->'amountWon') IS DISTINCT FROM 'number' OR (p_input->>'amountWon')!~'^[0-9]+$'
    OR p_now IS NULL OR p_now<0 OR p_now>8639999967600000 THEN RAISE EXCEPTION 'INVALID_REWARD_COMMAND' USING ERRCODE='22023'; END IF;
  IF (p_input->>'amountWon')::numeric NOT BETWEEN 1 AND 9007199254740991 THEN RAISE EXCEPTION 'INVALID_AMOUNT' USING ERRCODE='22023'; END IF;
  uid:=p_input->>'userId'; request_key:=p_input->>'idempotencyKey'; amount:=(p_input->>'amountWon')::bigint; scope_key:='grant';
  SELECT * INTO prior FROM reward_commands WHERE scope=scope_key AND idempotency_key=request_key;
  IF FOUND THEN
    IF prior.canonical_input<>p_input THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
    RETURN prior.result;
  END IF;
  PERFORM 1 FROM ledger_accounts WHERE id IN ('system:reward_budget','system:reward_backing','system:reward_cashback_reserved') ORDER BY id FOR UPDATE;
  SELECT * INTO w FROM reward_wallets WHERE user_id=uid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'USER_NOT_FOUND'; END IF;
  SELECT * INTO prior FROM reward_commands WHERE scope=scope_key AND idempotency_key=request_key;
  IF FOUND THEN
    IF prior.canonical_input<>p_input THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
    RETURN prior.result;
  END IF;
  SELECT enabled INTO active FROM reward_program WHERE singleton;
  IF NOT active THEN RAISE EXCEPTION 'REWARD_PROGRAM_INACTIVE'; END IF;
  offset_won:=LEAST(w.adjustment_due_won,amount); net:=amount-offset_won;
  IF w.available_won::numeric+w.held_won+net>9007199254740991 THEN RAISE EXCEPTION 'REWARD_BALANCE_LIMIT'; END IF;
  SELECT balance_won INTO budget FROM ledger_accounts WHERE id='system:reward_budget';
  SELECT balance_won INTO backing FROM ledger_accounts WHERE id='system:reward_backing';
  IF budget<net THEN RAISE EXCEPTION 'REWARD_BUDGET_UNAVAILABLE'; END IF;
  IF backing::numeric+net>9223372036854775807 THEN RAISE EXCEPTION 'LEDGER_CAPACITY'; END IF;
  INSERT INTO reward_commands(scope,kind,user_id,idempotency_key,canonical_input,created_at)
    VALUES(scope_key,'grant',uid,request_key,p_input,p_now) RETURNING id INTO command_id;
  PERFORM set_config('aqua.reward_command_id',command_id,true);
  PERFORM reward_post_cash('grant_backing','system:reward_budget','system:reward_backing',net,p_now);
  PERFORM reward_post_units(uid,'grant',amount,net,0,-offset_won,NULL,'grant',p_now);
  result:=jsonb_build_object('amountWon',amount,'availableWon',w.available_won+net,'adjustmentDueWon',w.adjustment_due_won-offset_won,'offsetWon',offset_won);
  UPDATE reward_commands SET result=reward_command.result WHERE id=command_id;
  PERFORM set_config('aqua.reward_command_id',COALESCE(previous_context,''),true);
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION operator_grant_rewards(JSONB,BIGINT) FROM PUBLIC;

CREATE FUNCTION reward_card_canonical(p JSONB) RETURNS JSONB LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE k TEXT; allowed TEXT[]; n NUMERIC; name TEXT;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'INVALID_CARD_EVENT' USING ERRCODE='22023'; END IF;
  FOREACH k IN ARRAY ARRAY['eventId','paymentId','userId','kind'] LOOP
    IF jsonb_typeof(p->k) IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'INVALID_CARD_EVENT' USING ERRCODE='22023'; END IF;
  END LOOP;
  FOREACH k IN ARRAY ARRAY['eventId','paymentId','userId'] LOOP
    IF p->>k !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN RAISE EXCEPTION 'INVALID_CARD_EVENT' USING ERRCODE='22023'; END IF;
  END LOOP;
  k:=p->>'kind'; allowed:=ARRAY['eventId','paymentId','userId','kind'];
  IF k NOT IN ('authorize','capture','reverse','refund') THEN RAISE EXCEPTION 'INVALID_CARD_EVENT' USING ERRCODE='22023'; END IF;
  IF k<>'reverse' THEN
    allowed:=allowed||ARRAY['amountWon'];
    IF jsonb_typeof(p->'amountWon') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'INVALID_CARD_EVENT' USING ERRCODE='22023'; END IF;
    n:=(p->>'amountWon')::NUMERIC;
    IF n NOT BETWEEN 1 AND 9007199254740991 OR n<>trunc(n) THEN RAISE EXCEPTION 'INVALID_CARD_EVENT' USING ERRCODE='22023'; END IF;
    p:=jsonb_set(p,'{amountWon}',to_jsonb(n::BIGINT));
  END IF;
  IF k='authorize' THEN
    allowed:=allowed||ARRAY['merchantName'];
    IF jsonb_typeof(p->'merchantName') IS DISTINCT FROM 'string' OR char_length(p->>'merchantName')>100 OR p->>'merchantName'~'[[:cntrl:]]' THEN
      RAISE EXCEPTION 'INVALID_CARD_EVENT' USING ERRCODE='22023';
    END IF;
    name:=regexp_replace(p->>'merchantName','^[[:space:]]+|[[:space:]]+$','','g');
    IF char_length(name)<1 THEN RAISE EXCEPTION 'INVALID_CARD_EVENT' USING ERRCODE='22023'; END IF;
    p:=jsonb_set(p,'{merchantName}',to_jsonb(name));
  ELSIF k='capture' THEN
    allowed:=allowed||ARRAY['finalCapture'];
    IF jsonb_typeof(p->'finalCapture') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'INVALID_CARD_EVENT' USING ERRCODE='22023'; END IF;
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(p) x WHERE x<>ALL(allowed)) THEN RAISE EXCEPTION 'INVALID_CARD_EVENT' USING ERRCODE='22023'; END IF;
  RETURN p;
END;
$$;

CREATE FUNCTION reward_credit_units(p_user TEXT,p_kind TEXT,p_amount BIGINT,p_payment TEXT,p_component TEXT,p_now BIGINT) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE due BIGINT; offset_won BIGINT;
BEGIN
  SELECT adjustment_due_won INTO due FROM reward_wallets WHERE user_id=p_user;
  offset_won:=least(due,p_amount);
  PERFORM reward_post_units(p_user,p_kind,p_amount,p_amount-offset_won,CASE WHEN p_kind='card_release' THEN -p_amount ELSE 0 END,-offset_won,p_payment,p_component,p_now);
  RETURN offset_won;
END;
$$;

CREATE FUNCTION reward_close_allocation(p_payment TEXT,p_now BIGINT) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE a card_reward_allocations%ROWTYPE; eligible BIGINT; award BIGINT; offset_won BIGINT; net BIGINT;
BEGIN
  SELECT * INTO a FROM card_reward_allocations WHERE payment_id=p_payment;
  IF a.closed_at IS NOT NULL OR a.principal_held_won+a.reward_held_won<>0 THEN RETURN; END IF;
  eligible:=a.principal_captured_won-a.principal_refunded_won;
  award:=least(eligible/100,a.cashback_initial_reserved_won);
  offset_won:=reward_credit_units(a.user_id,'cashback',award,p_payment,'cashback',p_now); net:=award-offset_won;
  PERFORM reward_post_cash('cashback_backing','system:reward_cashback_reserved','system:reward_backing',net,p_now);
  PERFORM reward_post_cash('cashback_release','system:reward_cashback_reserved','system:reward_budget',a.cashback_pending_won-net,p_now);
  UPDATE reward_cashback_months SET reserved_won=reserved_won-a.cashback_pending_won,awarded_won=awarded_won+award WHERE user_id=a.user_id AND month=a.month;
  UPDATE card_reward_allocations SET cashback_pending_won=0,cashback_awarded_won=award,cashback_offset_won=offset_won,
    cashback_eligible_won_at_close=eligible,principal_refunded_at_close=a.principal_refunded_won,closed_at=p_now WHERE payment_id=p_payment;
END;
$$;

CREATE FUNCTION reward_card_result(p_payment TEXT) RETURNS JSONB LANGUAGE plpgsql STABLE SET search_path FROM CURRENT AS $$
DECLARE p card_payments%ROWTYPE; a card_reward_allocations%ROWTYPE; spend BIGINT; held BIGINT; payment JSONB;
BEGIN
  SELECT * INTO p FROM card_payments WHERE id=p_payment;
  SELECT * INTO a FROM card_reward_allocations WHERE payment_id=p_payment;
  SELECT balance_won INTO spend FROM ledger_accounts WHERE id='user:'||p.user_id;
  SELECT balance_won INTO held FROM ledger_accounts WHERE id='hold:'||p.user_id;
  payment:=jsonb_build_object('id',p.id,'merchantName',p.merchant_name,'status',p.status,'authorizedWon',p.authorized_won,
    'heldWon',p.held_won,'capturedWon',p.captured_won,'releasedWon',p.released_won,'refundedWon',p.refunded_won,'createdAt',p.created_at,'updatedAt',p.updated_at,
    'funding',jsonb_build_object('principal',jsonb_build_object('authorizedWon',a.principal_authorized_won,'heldWon',a.principal_held_won,'capturedWon',a.principal_captured_won,'releasedWon',a.principal_released_won,'refundedWon',a.principal_refunded_won),
      'rewards',jsonb_build_object('authorizedWon',a.reward_authorized_won,'heldWon',a.reward_held_won,'capturedWon',a.reward_captured_won,'releasedWon',a.reward_released_won,'refundedWon',a.reward_refunded_won)),
    'cashback',jsonb_build_object('policyVersion',a.policy_version,'month',a.month,'rateBps',a.rate_bps,'pendingWon',a.cashback_pending_won,
      'awardedWon',a.cashback_awarded_won,'reversedWon',a.cashback_reversed_won,'offsetWon',a.cashback_offset_won,'closedAt',a.closed_at));
  RETURN jsonb_build_object('payment',payment,'balanceWon',spend,'heldBalanceWon',held,'totalBalanceWon',spend+held);
END;
$$;

CREATE OR REPLACE FUNCTION card_guard_payment_projection() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE e card_payment_events%ROWTYPE; a card_reward_allocations%ROWTYPE;
BEGIN
  IF current_user IS DISTINCT FROM pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='card_payments'::regclass)) THEN RAISE EXCEPTION 'Card payment projection is protected' USING ERRCODE='55000'; END IF;
  SELECT * INTO e FROM card_payment_events WHERE event_id=nullif(current_setting('aqua.card_event_id',true),'');
  IF e.event_id IS NULL OR e.result IS NOT NULL OR e.payment_id<>NEW.id OR e.user_id<>NEW.user_id THEN RAISE EXCEPTION 'CARD_STATE_CONFLICT'; END IF;
  IF TG_OP='INSERT' THEN
    IF pg_trigger_depth()<>1 OR e.kind<>'authorize' OR NEW.authorized_won<>0 OR NEW.held_won<>0 OR NEW.captured_won<>0 OR NEW.released_won<>0 OR NEW.refunded_won<>0
      OR NEW.status<>'cancelled' OR NEW.merchant_name IS DISTINCT FROM e.canonical_input->>'merchantName' OR NEW.created_at<>e.created_at OR NEW.updated_at<>e.created_at THEN RAISE EXCEPTION 'CARD_STATE_CONFLICT'; END IF;
  ELSE
    SELECT * INTO a FROM card_reward_allocations WHERE payment_id=NEW.id;
    IF a.payment_id IS NOT NULL THEN
      IF pg_trigger_depth()<>1 OR nullif(current_setting('aqua.reward_finalize',true),'') IS DISTINCT FROM e.event_id
        OR ROW(NEW.authorized_won,NEW.held_won,NEW.captured_won,NEW.released_won,NEW.refunded_won)
          IS DISTINCT FROM ROW(a.principal_authorized_won+a.reward_authorized_won,a.principal_held_won+a.reward_held_won,a.principal_captured_won+a.reward_captured_won,a.principal_released_won+a.reward_released_won,a.principal_refunded_won+a.reward_refunded_won) THEN
        RAISE EXCEPTION 'Card reward composition requires atomic finalization' USING ERRCODE='55000';
      END IF;
    ELSIF pg_trigger_depth()<>2 THEN RAISE EXCEPTION 'Card payment projection is immutable outside journal posting' USING ERRCODE='55000'; END IF;
    IF ROW(NEW.id,NEW.user_id,NEW.merchant_name,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.user_id,OLD.merchant_name,OLD.created_at) THEN
      RAISE EXCEPTION 'Card payment identity is immutable' USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION apply_sandbox_card_event(p_input JSONB,p_now BIGINT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE input JSONB; event_key TEXT; payment_key TEXT; uid TEXT; k TEXT; amount BIGINT; month_key TEXT;
  e card_payment_events%ROWTYPE; p card_payments%ROWTYPE; a card_reward_allocations%ROWTYPE; w reward_wallets%ROWTYPE; m reward_cashback_months%ROWTYPE;
  active BOOLEAN; rate INTEGER; spend BIGINT; budget BIGINT; rewards BIGINT; principal BIGINT; quota BIGINT;
  target BIGINT; dr BIGINT; dp BIGINT; reward_release BIGINT; principal_release BIGINT; offset_won BIGINT; reversal BIGINT; burn BIGINT;
  next_captured BIGINT; next_refunded BIGINT; answer JSONB; previous_event TEXT:=current_setting('aqua.card_event_id',true);
  previous_command TEXT:=current_setting('aqua.reward_command_id',true); previous_finalize TEXT:=current_setting('aqua.reward_finalize',true);
BEGIN
  IF p_now IS NULL OR p_now NOT BETWEEN 0 AND 8639999967600000 THEN RAISE EXCEPTION 'INVALID_CARD_EVENT' USING ERRCODE='22023'; END IF;
  input:=reward_card_canonical(p_input); event_key:=input->>'eventId'; payment_key:=input->>'paymentId'; uid:=input->>'userId'; k:=input->>'kind';
  IF k<>'reverse' THEN amount:=(input->>'amountWon')::BIGINT; END IF;
  SELECT * INTO e FROM card_payment_events WHERE event_id=event_key;
  IF FOUND THEN
    IF e.canonical_input IS DISTINCT FROM input THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
    IF e.result IS NULL THEN RAISE EXCEPTION 'CARD_STATE_CONFLICT'; END IF;
    RETURN e.result;
  END IF;
  SELECT * INTO p FROM card_payments WHERE id=payment_key;
  IF p.id IS NOT NULL AND p.user_id<>uid THEN RAISE EXCEPTION 'CARD_OWNER_MISMATCH'; END IF;
  SELECT * INTO a FROM card_reward_allocations WHERE payment_id=payment_key;
  IF p.id IS NOT NULL AND a.payment_id IS NULL THEN RETURN apply_sandbox_card_event_legacy_003(input,p_now); END IF;
  IF p.id IS NULL AND k<>'authorize' THEN RAISE EXCEPTION 'CARD_PAYMENT_NOT_FOUND'; END IF;
  PERFORM id FROM ledger_accounts WHERE id IN ('hold:'||uid,'user:'||uid,'system:card_settlement','system:reward_budget','system:reward_backing','system:reward_cashback_reserved') ORDER BY id FOR UPDATE;
  SELECT * INTO w FROM reward_wallets WHERE user_id=uid FOR UPDATE;
  IF w.user_id IS NULL THEN RAISE EXCEPTION 'USER_NOT_FOUND'; END IF;
  SELECT * INTO e FROM card_payment_events WHERE event_id=event_key;
  IF e.event_id IS NOT NULL THEN
    IF e.canonical_input IS DISTINCT FROM input THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
    RETURN e.result;
  END IF;
  SELECT * INTO a FROM card_reward_allocations WHERE payment_id=payment_key;
  SELECT enabled INTO active FROM reward_program WHERE singleton;
  IF k='authorize' AND NOT active AND (NOT w.use_first OR w.available_won=0) THEN RETURN apply_sandbox_card_event_legacy_003(input,p_now); END IF;
  month_key:=CASE WHEN a.payment_id IS NOT NULL THEN a.month ELSE to_char(to_timestamp(p_now::double precision/1000) AT TIME ZONE 'Asia/Seoul','YYYY-MM') END;
  PERFORM set_config('aqua.reward_command_id','',true);
  PERFORM set_config('aqua.card_event_id',event_key,true);
  INSERT INTO card_payment_events(event_id,payment_id,user_id,kind,canonical_input,created_at) VALUES(event_key,payment_key,uid,k,input,p_now);
  INSERT INTO reward_cashback_months(user_id,month) VALUES(uid,month_key) ON CONFLICT(user_id,month) DO NOTHING;
  SELECT * INTO m FROM reward_cashback_months WHERE user_id=uid AND month=month_key FOR UPDATE;
  SELECT * INTO p FROM card_payments WHERE id=payment_key FOR UPDATE;
  IF p.id IS NOT NULL AND p.user_id<>uid THEN RAISE EXCEPTION 'CARD_OWNER_MISMATCH'; END IF;
  SELECT balance_won INTO spend FROM ledger_accounts WHERE id='user:'||uid;
  IF k='authorize' THEN
    IF p.id IS NOT NULL THEN RAISE EXCEPTION 'CARD_STATE_CONFLICT'; END IF;
    rewards:=CASE WHEN w.use_first THEN least(w.available_won,amount) ELSE 0 END; principal:=amount-rewards;
    IF spend<principal THEN RAISE EXCEPTION 'INSUFFICIENT_FUNDS'; END IF;
    rate:=CASE WHEN active THEN 100 ELSE 0 END;
    quota:=CASE WHEN active THEN least(principal/100,10000-m.reserved_won-m.awarded_won+m.reversed_won) ELSE 0 END;
    SELECT balance_won INTO budget FROM ledger_accounts WHERE id='system:reward_budget';
    IF budget<quota THEN RAISE EXCEPTION 'REWARD_BUDGET_UNAVAILABLE'; END IF;
    INSERT INTO card_payments(id,user_id,merchant_name,status,authorized_won,held_won,captured_won,released_won,refunded_won,created_at,updated_at)
      VALUES(payment_key,uid,input->>'merchantName','cancelled',0,0,0,0,0,p_now,p_now);
    INSERT INTO card_reward_allocations(payment_id,user_id,month,rate_bps,principal_authorized_won,principal_held_won,reward_authorized_won,reward_held_won,cashback_initial_reserved_won,cashback_pending_won)
      VALUES(payment_key,uid,month_key,rate,principal,principal,rewards,rewards,quota,quota);
    PERFORM reward_post_cash('principal_authorize','user:'||uid,'hold:'||uid,principal,p_now);
    PERFORM reward_post_units(uid,'card_authorize',rewards,-rewards,rewards,0,payment_key,'authorize',p_now);
    PERFORM reward_post_cash('cashback_reserve','system:reward_budget','system:reward_cashback_reserved',quota,p_now);
    UPDATE reward_cashback_months SET reserved_won=reserved_won+quota WHERE user_id=uid AND month=month_key;
  ELSIF k='capture' THEN
    IF p.id IS NULL OR amount>p.held_won THEN RAISE EXCEPTION 'CARD_STATE_CONFLICT'; END IF;
    next_captured:=p.captured_won+amount;
    target:=div(a.reward_authorized_won::NUMERIC*next_captured,p.authorized_won)::BIGINT;
    dr:=target-a.reward_captured_won; dp:=amount-dr;
    PERFORM reward_post_cash('principal_capture','hold:'||uid,'system:card_settlement',dp,p_now);
    PERFORM reward_post_cash('reward_capture','system:reward_backing','system:card_settlement',dr,p_now);
    PERFORM reward_post_units(uid,'card_capture',dr,0,-dr,0,payment_key,'capture',p_now);
    principal_release:=CASE WHEN (input->>'finalCapture')::BOOLEAN THEN a.principal_held_won-dp ELSE 0 END;
    reward_release:=CASE WHEN (input->>'finalCapture')::BOOLEAN THEN a.reward_held_won-dr ELSE 0 END;
    PERFORM reward_post_cash('principal_release','hold:'||uid,'user:'||uid,principal_release,p_now);
    offset_won:=reward_credit_units(uid,'card_release',reward_release,payment_key,'release',p_now);
    PERFORM reward_post_cash('release_offset','system:reward_backing','system:reward_budget',offset_won,p_now);
    UPDATE card_reward_allocations SET principal_held_won=principal_held_won-dp-principal_release,principal_captured_won=principal_captured_won+dp,principal_released_won=principal_released_won+principal_release,
      reward_held_won=reward_held_won-dr-reward_release,reward_captured_won=reward_captured_won+dr,reward_released_won=reward_released_won+reward_release WHERE payment_id=payment_key;
  ELSIF k='reverse' THEN
    IF p.id IS NULL OR p.held_won=0 THEN RAISE EXCEPTION 'CARD_STATE_CONFLICT'; END IF;
    PERFORM reward_post_cash('principal_release','hold:'||uid,'user:'||uid,a.principal_held_won,p_now);
    offset_won:=reward_credit_units(uid,'card_release',a.reward_held_won,payment_key,'release',p_now);
    PERFORM reward_post_cash('release_offset','system:reward_backing','system:reward_budget',offset_won,p_now);
    UPDATE card_reward_allocations SET principal_released_won=principal_released_won+principal_held_won,principal_held_won=0,
      reward_released_won=reward_released_won+reward_held_won,reward_held_won=0 WHERE payment_id=payment_key;
  ELSE
    IF p.id IS NULL OR amount>p.captured_won-p.refunded_won THEN RAISE EXCEPTION 'CARD_STATE_CONFLICT'; END IF;
    next_refunded:=p.refunded_won+amount;
    target:=div(a.reward_authorized_won::NUMERIC*next_refunded,p.authorized_won)::BIGINT;
    dr:=target-a.reward_refunded_won; dp:=amount-dr;
    PERFORM reward_post_cash('principal_refund','system:card_settlement','user:'||uid,dp,p_now);
    PERFORM reward_post_cash('reward_refund','system:card_settlement','system:reward_backing',dr,p_now);
    offset_won:=reward_credit_units(uid,'card_refund',dr,payment_key,'refund',p_now);
    PERFORM reward_post_cash('refund_offset','system:reward_backing','system:reward_budget',offset_won,p_now);
    UPDATE card_reward_allocations SET principal_refunded_won=principal_refunded_won+dp,reward_refunded_won=reward_refunded_won+dr WHERE payment_id=payment_key;
    IF a.closed_at IS NOT NULL AND a.cashback_eligible_won_at_close>0 THEN
      reversal:=div(a.cashback_awarded_won::NUMERIC*(a.principal_refunded_won+dp-a.principal_refunded_at_close),a.cashback_eligible_won_at_close)::BIGINT-a.cashback_reversed_won;
      IF reversal>0 THEN
        SELECT * INTO w FROM reward_wallets WHERE user_id=uid;
        burn:=least(w.available_won,reversal);
        PERFORM reward_post_units(uid,'cashback_reversal',reversal,-burn,0,reversal-burn,payment_key,'cashback_reversal',p_now);
        PERFORM reward_post_cash('cashback_clawback','system:reward_backing','system:reward_budget',burn,p_now);
        UPDATE reward_cashback_months SET reversed_won=reversed_won+reversal WHERE user_id=uid AND month=month_key;
        UPDATE card_reward_allocations SET cashback_reversed_won=cashback_reversed_won+reversal WHERE payment_id=payment_key;
      END IF;
    END IF;
  END IF;
  PERFORM reward_close_allocation(payment_key,p_now);
  SELECT * INTO a FROM card_reward_allocations WHERE payment_id=payment_key;
  PERFORM set_config('aqua.reward_finalize',event_key,true);
  UPDATE card_payments SET authorized_won=a.principal_authorized_won+a.reward_authorized_won,
    held_won=a.principal_held_won+a.reward_held_won,captured_won=a.principal_captured_won+a.reward_captured_won,
    released_won=a.principal_released_won+a.reward_released_won,refunded_won=a.principal_refunded_won+a.reward_refunded_won,
    status=CASE WHEN a.principal_refunded_won+a.reward_refunded_won>0 THEN CASE WHEN a.principal_held_won+a.reward_held_won=0 AND a.principal_refunded_won+a.reward_refunded_won=a.principal_captured_won+a.reward_captured_won THEN 'refunded' ELSE 'partially_refunded' END
      WHEN a.principal_captured_won+a.reward_captured_won>0 THEN CASE WHEN a.principal_held_won+a.reward_held_won>0 THEN 'partially_captured' ELSE 'captured' END
      WHEN a.principal_held_won+a.reward_held_won>0 THEN 'authorized' ELSE 'cancelled' END,
    updated_at=greatest(updated_at,p_now) WHERE id=payment_key;
  answer:=reward_card_result(payment_key);
  UPDATE card_payment_events SET result=answer WHERE event_id=event_key;
  PERFORM set_config('aqua.card_event_id',coalesce(previous_event,''),true);
  PERFORM set_config('aqua.reward_command_id',coalesce(previous_command,''),true);
  PERFORM set_config('aqua.reward_finalize',coalesce(previous_finalize,''),true);
  RETURN answer;
END;
$$;

-- COMPONENT_COMPLETION_FUNCTIONS
CREATE FUNCTION reward_expect_cash(p_event TEXT,p_component TEXT,p_amount BIGINT) RETURNS VOID
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE plan reward_cash_plans%ROWTYPE;
BEGIN
  SELECT * INTO plan FROM reward_cash_plans WHERE card_event_id=p_event AND component=p_component;
  IF (p_amount=0 AND plan.id IS NOT NULL) OR (p_amount>0 AND (plan.id IS NULL OR plan.amount_won<>p_amount
    OR NOT EXISTS(SELECT 1 FROM journals WHERE id=plan.journal_id AND reward_plan_id=plan.id))) THEN
    RAISE EXCEPTION 'CARD_EVENT_INCOMPLETE' USING ERRCODE='23514';
  END IF;
END;
$$;
CREATE FUNCTION reward_expect_units(p_event TEXT,p_component TEXT,p_amount BIGINT) RETURNS VOID
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE j reward_journals%ROWTYPE;
BEGIN
  SELECT * INTO j FROM reward_journals WHERE card_event_id=p_event AND component=p_component;
  IF (p_amount=0 AND j.id IS NOT NULL) OR (p_amount>0 AND (j.id IS NULL OR j.amount_won<>p_amount)) THEN
    RAISE EXCEPTION 'CARD_EVENT_INCOMPLETE' USING ERRCODE='23514';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION card_require_complete_event() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE e card_payment_events%ROWTYPE; a card_reward_allocations%ROWTYPE; j reward_journals%ROWTYPE;
  n BIGINT; gross BIGINT; total BIGINT; ar BIGINT; dr BIGINT; dp BIGINT; release_p BIGINT; release_r BIGINT; expected BIGINT; previous BIGINT; off BIGINT;
BEGIN
  SELECT * INTO e FROM card_payment_events WHERE event_id=NEW.event_id;
  IF e.result IS NULL OR e.result->'payment'->>'id' IS DISTINCT FROM e.payment_id THEN RAISE EXCEPTION 'CARD_EVENT_INCOMPLETE' USING ERRCODE='23514'; END IF;
  SELECT * INTO a FROM card_reward_allocations WHERE payment_id=e.payment_id;
  IF a.payment_id IS NULL THEN
    SELECT count(*) INTO n FROM journals WHERE card_event_id=e.event_id;
    IF (e.kind='authorize' AND (n<>1 OR NOT EXISTS(SELECT 1 FROM journals WHERE card_event_id=e.event_id AND kind='card_authorize')))
      OR (e.kind='reverse' AND (n<>1 OR NOT EXISTS(SELECT 1 FROM journals WHERE card_event_id=e.event_id AND kind='card_reverse')))
      OR (e.kind='refund' AND (n<>1 OR NOT EXISTS(SELECT 1 FROM journals WHERE card_event_id=e.event_id AND kind='card_refund')))
      OR (e.kind='capture' AND (n NOT BETWEEN 1 AND 2 OR NOT EXISTS(SELECT 1 FROM journals WHERE card_event_id=e.event_id AND kind='card_capture')
        OR ((e.canonical_input->>'finalCapture')::boolean AND (e.result->'payment'->>'heldWon')::BIGINT<>0))) THEN
      RAISE EXCEPTION 'CARD_EVENT_INCOMPLETE' USING ERRCODE='23514';
    END IF;
    RETURN NULL;
  END IF;
  ar:=a.reward_authorized_won; total:=a.principal_authorized_won+ar;
  IF e.result->'payment'->'funding' IS NULL THEN RAISE EXCEPTION 'CARD_EVENT_INCOMPLETE' USING ERRCODE='23514'; END IF;
  IF e.kind='authorize' THEN
    PERFORM reward_expect_cash(e.event_id,'principal_authorize',a.principal_authorized_won);
    PERFORM reward_expect_units(e.event_id,'authorize',ar);
    PERFORM reward_expect_cash(e.event_id,'cashback_reserve',a.cashback_initial_reserved_won);
  ELSIF e.kind='capture' THEN
    gross:=(e.result->'payment'->>'capturedWon')::BIGINT;
    dr:=div(ar::NUMERIC*gross,total)::BIGINT-div(ar::NUMERIC*(gross-(e.canonical_input->>'amountWon')::BIGINT),total)::BIGINT;
    dp:=(e.canonical_input->>'amountWon')::BIGINT-dr;
    PERFORM reward_expect_cash(e.event_id,'principal_capture',dp);
    PERFORM reward_expect_cash(e.event_id,'reward_capture',dr);
    PERFORM reward_expect_units(e.event_id,'capture',dr);
    IF (e.canonical_input->>'finalCapture')::boolean THEN
      release_p:=a.principal_authorized_won-(gross-div(ar::NUMERIC*gross,total)::BIGINT);
      release_r:=ar-div(ar::NUMERIC*gross,total)::BIGINT;
      PERFORM reward_expect_cash(e.event_id,'principal_release',release_p);
      PERFORM reward_expect_units(e.event_id,'release',release_r);
    END IF;
  ELSIF e.kind='reverse' THEN
    gross:=(e.result->'payment'->>'capturedWon')::BIGINT;
    release_p:=a.principal_authorized_won-(gross-div(ar::NUMERIC*gross,total)::BIGINT);
    release_r:=ar-div(ar::NUMERIC*gross,total)::BIGINT;
    PERFORM reward_expect_cash(e.event_id,'principal_release',release_p);
    PERFORM reward_expect_units(e.event_id,'release',release_r);
  ELSE
    gross:=(e.result->'payment'->>'refundedWon')::BIGINT;
    dr:=div(ar::NUMERIC*gross,total)::BIGINT-div(ar::NUMERIC*(gross-(e.canonical_input->>'amountWon')::BIGINT),total)::BIGINT;
    dp:=(e.canonical_input->>'amountWon')::BIGINT-dr;
    PERFORM reward_expect_cash(e.event_id,'principal_refund',dp);
    PERFORM reward_expect_cash(e.event_id,'reward_refund',dr);
    PERFORM reward_expect_units(e.event_id,'refund',dr);
    SELECT * INTO j FROM reward_journals WHERE card_event_id=e.event_id AND component='refund';
    PERFORM reward_expect_cash(e.event_id,'refund_offset',coalesce(-j.adjustment_delta_won,0));
    IF a.closed_at IS NOT NULL AND a.cashback_eligible_won_at_close>0 THEN
      gross:=(e.result->'payment'->'funding'->'principal'->>'refundedWon')::BIGINT;
      expected:=div(a.cashback_awarded_won::NUMERIC*greatest(gross-a.principal_refunded_at_close,0),a.cashback_eligible_won_at_close)::BIGINT;
      previous:=div(a.cashback_awarded_won::NUMERIC*greatest(gross-dp-a.principal_refunded_at_close,0),a.cashback_eligible_won_at_close)::BIGINT;
      PERFORM reward_expect_units(e.event_id,'cashback_reversal',expected-previous);
      SELECT * INTO j FROM reward_journals WHERE card_event_id=e.event_id AND component='cashback_reversal';
      PERFORM reward_expect_cash(e.event_id,'cashback_clawback',coalesce(-j.available_delta_won,0));
    END IF;
  END IF;
  IF e.kind IN ('capture','reverse') THEN
    SELECT * INTO j FROM reward_journals WHERE card_event_id=e.event_id AND component='release';
    PERFORM reward_expect_cash(e.event_id,'release_offset',coalesce(-j.adjustment_delta_won,0));
    IF (e.result->'payment'->>'heldWon')::BIGINT=0 THEN
      expected:=least(((e.result->'payment'->'funding'->'principal'->>'capturedWon')::BIGINT-(e.result->'payment'->'funding'->'principal'->>'refundedWon')::BIGINT)/100,a.cashback_initial_reserved_won);
      PERFORM reward_expect_units(e.event_id,'cashback',expected);
      SELECT * INTO j FROM reward_journals WHERE card_event_id=e.event_id AND component='cashback';
      off:=coalesce(-j.adjustment_delta_won,0);
      PERFORM reward_expect_cash(e.event_id,'cashback_backing',expected-off);
      PERFORM reward_expect_cash(e.event_id,'cashback_release',a.cashback_initial_reserved_won-expected+off);
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION card_require_authorized_payment() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE p card_payments%ROWTYPE; a card_reward_allocations%ROWTYPE;
BEGIN
  SELECT * INTO p FROM card_payments WHERE id=NEW.id;
  SELECT * INTO a FROM card_reward_allocations WHERE payment_id=NEW.id;
  IF a.payment_id IS NOT NULL THEN
    IF p.authorized_won<=0 OR ROW(p.authorized_won,p.held_won,p.captured_won,p.released_won,p.refunded_won)
      IS DISTINCT FROM ROW(a.principal_authorized_won+a.reward_authorized_won,a.principal_held_won+a.reward_held_won,a.principal_captured_won+a.reward_captured_won,a.principal_released_won+a.reward_released_won,a.principal_refunded_won+a.reward_refunded_won)
      OR NOT EXISTS(SELECT 1 FROM card_payment_events WHERE payment_id=p.id AND kind='authorize' AND result IS NOT NULL) THEN
      RAISE EXCEPTION 'CARD_PAYMENT_INCOMPLETE' USING ERRCODE='23514';
    END IF;
  ELSIF NOT EXISTS(SELECT 1 FROM card_payments cp JOIN journals j ON j.card_payment_id=cp.id JOIN card_payment_events e ON e.event_id=j.card_event_id
    WHERE cp.id=NEW.id AND cp.authorized_won>0 AND j.kind='card_authorize' AND e.kind='authorize' AND e.result IS NOT NULL) THEN
    RAISE EXCEPTION 'CARD_PAYMENT_INCOMPLETE' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION reward_require_complete_command() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE c reward_commands%ROWTYPE; j reward_journals%ROWTYPE; plan reward_cash_plans%ROWTYPE; expected BIGINT;
BEGIN
  SELECT * INTO c FROM reward_commands WHERE id=NEW.id;
  IF c.result IS NULL THEN RAISE EXCEPTION 'REWARD_COMMAND_INCOMPLETE' USING ERRCODE='23514'; END IF;
  IF c.kind='grant' THEN
    SELECT * INTO j FROM reward_journals WHERE command_id=c.id AND component='grant';
    IF j.id IS NULL OR j.amount_won<>(c.canonical_input->>'amountWon')::BIGINT OR j.user_id<>c.user_id THEN RAISE EXCEPTION 'REWARD_COMMAND_INCOMPLETE' USING ERRCODE='23514'; END IF;
    expected:=j.available_delta_won;
    SELECT * INTO plan FROM reward_cash_plans WHERE command_id=c.id AND component='grant_backing';
  ELSIF c.kind='fund_budget' THEN
    expected:=(c.canonical_input->>'amountWon')::BIGINT;
    SELECT * INTO plan FROM reward_cash_plans WHERE command_id=c.id AND component='budget_fund';
  ELSE RETURN NULL;
  END IF;
  IF (expected=0 AND plan.id IS NOT NULL) OR (expected>0 AND (plan.id IS NULL OR plan.amount_won<>expected
    OR NOT EXISTS(SELECT 1 FROM journals WHERE id=plan.journal_id AND reward_plan_id=plan.id))) THEN RAISE EXCEPTION 'REWARD_COMMAND_INCOMPLETE' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER reward_commands_complete AFTER INSERT OR UPDATE ON reward_commands
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reward_require_complete_command();
CREATE FUNCTION reward_require_allocation_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE p card_payments%ROWTYPE; a card_reward_allocations%ROWTYPE;
BEGIN
  SELECT * INTO p FROM card_payments WHERE id=NEW.payment_id;
  SELECT * INTO a FROM card_reward_allocations WHERE payment_id=NEW.payment_id;
  IF ROW(p.authorized_won,p.held_won,p.captured_won,p.released_won,p.refunded_won)
    IS DISTINCT FROM ROW(a.principal_authorized_won+a.reward_authorized_won,a.principal_held_won+a.reward_held_won,a.principal_captured_won+a.reward_captured_won,a.principal_released_won+a.reward_released_won,a.principal_refunded_won+a.reward_refunded_won) THEN
    RAISE EXCEPTION 'CARD_PAYMENT_INCOMPLETE' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER reward_allocations_complete AFTER INSERT OR UPDATE ON card_reward_allocations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reward_require_allocation_complete();

-- Apply explicit ACLs to every helper created in this migration. The deployment
-- grants only snapshot/preference/card wrapper execution to its runtime login.
DO $$ DECLARE f record; BEGIN
  FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p
    WHERE p.pronamespace=current_schema()::regnamespace AND
      (p.proname LIKE 'reward\_%' ESCAPE '\' OR p.proname IN ('rewards_snapshot','apply_reward_preference','operator_fund_reward_budget','operator_set_reward_program','operator_grant_rewards','apply_sandbox_card_event','apply_sandbox_card_event_legacy_003'))
  LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature); END LOOP;
END; $$;
REVOKE ALL ON FUNCTION card_require_complete_event(),card_require_authorized_payment() FROM PUBLIC;
