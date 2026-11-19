-- Card authorizations move TEST_KRW into a per-member hold account. Captures and
-- refunds settle against a sandbox control account; no issuer or live money is used.
ALTER TABLE ledger_accounts DROP CONSTRAINT ledger_accounts_user_id_key;
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
    WHERE conrelid = 'ledger_accounts'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%kind%'
  LOOP EXECUTE format('ALTER TABLE ledger_accounts DROP CONSTRAINT %I', c.conname); END LOOP;
END;
$$;
ALTER TABLE ledger_accounts
  ADD CONSTRAINT ledger_accounts_user_kind_key UNIQUE (user_id, kind),
  ADD CONSTRAINT ledger_accounts_kind_guard CHECK (kind IN ('user_spend', 'user_card_hold', 'sandbox_control', 'sandbox_card_settlement')),
  ADD CONSTRAINT ledger_accounts_balance_guard CHECK (
    (kind IN ('user_spend', 'user_card_hold') AND user_id IS NOT NULL AND balance_won BETWEEN 0 AND 9007199254740991)
    OR (kind = 'sandbox_control' AND user_id IS NULL AND balance_won <= 0)
    OR (kind = 'sandbox_card_settlement' AND user_id IS NULL AND balance_won >= 0));
CREATE UNIQUE INDEX ledger_single_card_settlement ON ledger_accounts(kind) WHERE kind = 'sandbox_card_settlement';
INSERT INTO ledger_accounts(id, user_id, kind) SELECT 'hold:' || id, id, 'user_card_hold' FROM users;
INSERT INTO ledger_accounts(id, user_id, kind) VALUES ('system:card_settlement', NULL, 'sandbox_card_settlement');

-- Rolling releases may still create only the original spend account on signup.
-- Enforce the paired empty hold account in the schema rather than the API version.
CREATE FUNCTION ledger_create_card_hold_account() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  INSERT INTO ledger_accounts(id, user_id, kind) VALUES ('hold:' || NEW.user_id, NEW.user_id, 'user_card_hold')
    ON CONFLICT (user_id, kind) DO NOTHING;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ledger_accounts_create_card_hold AFTER INSERT ON ledger_accounts
FOR EACH ROW WHEN (NEW.kind = 'user_spend') EXECUTE FUNCTION ledger_create_card_hold_account();
REVOKE ALL ON FUNCTION ledger_create_card_hold_account() FROM PUBLIC;

CREATE TABLE card_payments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  merchant_name TEXT NOT NULL CHECK (char_length(merchant_name) BETWEEN 1 AND 100),
  status TEXT NOT NULL CHECK (status IN ('authorized', 'partially_captured', 'captured', 'cancelled', 'partially_refunded', 'refunded')),
  authorized_won BIGINT NOT NULL CHECK (authorized_won BETWEEN 0 AND 9007199254740991),
  held_won BIGINT NOT NULL CHECK (held_won BETWEEN 0 AND 9007199254740991),
  captured_won BIGINT NOT NULL CHECK (captured_won BETWEEN 0 AND 9007199254740991),
  released_won BIGINT NOT NULL CHECK (released_won BETWEEN 0 AND 9007199254740991),
  refunded_won BIGINT NOT NULL CHECK (refunded_won BETWEEN 0 AND captured_won),
  created_at BIGINT NOT NULL CHECK (created_at BETWEEN 0 AND 8640000000000000),
  updated_at BIGINT NOT NULL CHECK (updated_at BETWEEN created_at AND 8640000000000000),
  UNIQUE (id, user_id),
  CHECK (authorized_won = held_won + captured_won + released_won),
  CHECK (status = CASE
    WHEN refunded_won > 0 THEN CASE WHEN held_won = 0 AND refunded_won = captured_won THEN 'refunded' ELSE 'partially_refunded' END
    WHEN captured_won > 0 THEN CASE WHEN held_won > 0 THEN 'partially_captured' ELSE 'captured' END
    WHEN held_won > 0 THEN 'authorized' ELSE 'cancelled' END)
);
CREATE INDEX card_payments_owner ON card_payments(user_id, created_at DESC, id);

CREATE TABLE card_payment_events (
  event_id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('authorize', 'capture', 'reverse', 'refund')),
  canonical_input JSONB NOT NULL CHECK (jsonb_typeof(canonical_input) = 'object'),
  result JSONB CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
  created_at BIGINT NOT NULL CHECK (created_at BETWEEN 0 AND 8640000000000000),
  FOREIGN KEY (payment_id, user_id) REFERENCES card_payments(id, user_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX card_payment_events_payment ON card_payment_events(payment_id, created_at, event_id);

ALTER TABLE journals
  DROP CONSTRAINT journals_kind_check,
  ADD COLUMN card_payment_id TEXT REFERENCES card_payments(id) ON DELETE RESTRICT,
  ADD COLUMN card_event_id TEXT REFERENCES card_payment_events(event_id) ON DELETE RESTRICT;
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
    WHERE conrelid = 'journals'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%request_owner_id%'
  LOOP EXECUTE format('ALTER TABLE journals DROP CONSTRAINT %I', c.conname); END LOOP;
END;
$$;
ALTER TABLE journals
  ADD CONSTRAINT journals_kind_guard CHECK (kind IN ('member_transfer', 'sandbox_credit', 'card_authorize', 'card_reverse', 'card_capture', 'card_refund')),
  ADD CONSTRAINT journals_owner_guard CHECK (
    (kind = 'member_transfer' AND sender_id IS NOT NULL AND sender_id <> recipient_id AND request_owner_id = sender_id)
    OR (kind = 'sandbox_credit' AND sender_id IS NULL AND request_owner_id = recipient_id)
    OR (kind IN ('card_authorize', 'card_reverse', 'card_capture', 'card_refund')
      AND sender_id = recipient_id AND request_owner_id = recipient_id)),
  ADD CONSTRAINT journals_card_link_guard CHECK (
    (kind IN ('member_transfer', 'sandbox_credit') AND card_payment_id IS NULL AND card_event_id IS NULL AND idempotency_key NOT LIKE '$card:%')
    OR (kind IN ('card_authorize', 'card_reverse', 'card_capture', 'card_refund')
      AND card_payment_id IS NOT NULL AND card_event_id IS NOT NULL AND idempotency_key LIKE '$card:%')),
  ADD CONSTRAINT journals_card_event_kind_key UNIQUE (card_event_id, kind);

-- These guards permit projection changes only from the journal posting trigger.
-- The SECURITY DEFINER command below is a normal function, so posting remains at
-- trigger depth 1 and both the original balance guard and this guard run at 2.
CREATE FUNCTION card_guard_payment_projection() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE e card_payment_events%ROWTYPE;
BEGIN
  IF current_user IS DISTINCT FROM pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'card_payments'::regclass)) THEN
    RAISE EXCEPTION 'Card payment projection is protected' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO e FROM card_payment_events
    WHERE event_id = nullif(current_setting('aqua.card_event_id', true), '');
  IF e.event_id IS NULL OR e.result IS NOT NULL OR e.payment_id <> NEW.id OR e.user_id <> NEW.user_id THEN
    RAISE EXCEPTION 'CARD_STATE_CONFLICT' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF pg_trigger_depth() <> 1 OR e.kind <> 'authorize'
      OR NEW.authorized_won <> 0 OR NEW.held_won <> 0 OR NEW.captured_won <> 0
      OR NEW.released_won <> 0 OR NEW.refunded_won <> 0 OR NEW.status <> 'cancelled'
      OR NEW.merchant_name IS DISTINCT FROM e.canonical_input->>'merchantName'
      OR NEW.created_at <> e.created_at OR NEW.updated_at <> e.created_at THEN
      RAISE EXCEPTION 'CARD_STATE_CONFLICT' USING ERRCODE = 'P0001';
    END IF;
  ELSIF pg_trigger_depth() <> 2
    OR ROW(NEW.id, NEW.user_id, NEW.merchant_name, NEW.created_at)
      IS DISTINCT FROM ROW(OLD.id, OLD.user_id, OLD.merchant_name, OLD.created_at) THEN
    RAISE EXCEPTION 'Card payment projection is immutable outside journal posting' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER card_payments_projection_guard BEFORE INSERT OR UPDATE ON card_payments
FOR EACH ROW EXECUTE FUNCTION card_guard_payment_projection();
CREATE TRIGGER card_payments_no_delete BEFORE DELETE ON card_payments
FOR EACH ROW EXECUTE FUNCTION ledger_reject_history_change();
CREATE TRIGGER card_payments_no_truncate BEFORE TRUNCATE ON card_payments
FOR EACH STATEMENT EXECUTE FUNCTION ledger_reject_history_change();

CREATE FUNCTION card_guard_event_history() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF current_user IS DISTINCT FROM pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'card_payment_events'::regclass))
    OR nullif(current_setting('aqua.card_event_id', true), '') IS DISTINCT FROM NEW.event_id THEN
    RAISE EXCEPTION 'Card event history is immutable' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.result IS NOT NULL OR NEW.canonical_input->>'eventId' IS DISTINCT FROM NEW.event_id
      OR NEW.canonical_input->>'paymentId' IS DISTINCT FROM NEW.payment_id
      OR NEW.canonical_input->>'userId' IS DISTINCT FROM NEW.user_id
      OR NEW.canonical_input->>'kind' IS DISTINCT FROM NEW.kind THEN
      RAISE EXCEPTION 'CARD_STATE_CONFLICT' USING ERRCODE = 'P0001';
    END IF;
  ELSIF OLD.result IS NOT NULL OR NEW.result IS NULL
    OR ROW(NEW.event_id, NEW.payment_id, NEW.user_id, NEW.kind, NEW.canonical_input, NEW.created_at)
      IS DISTINCT FROM ROW(OLD.event_id, OLD.payment_id, OLD.user_id, OLD.kind, OLD.canonical_input, OLD.created_at)
    OR NEW.result->'payment'->>'id' IS DISTINCT FROM NEW.payment_id THEN
    RAISE EXCEPTION 'Card event history is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER card_payment_events_history_guard BEFORE INSERT OR UPDATE ON card_payment_events
FOR EACH ROW EXECUTE FUNCTION card_guard_event_history();
CREATE TRIGGER card_payment_events_no_delete BEFORE DELETE ON card_payment_events
FOR EACH ROW EXECUTE FUNCTION ledger_reject_history_change();
CREATE TRIGGER card_payment_events_no_truncate BEFORE TRUNCATE ON card_payment_events
FOR EACH STATEMENT EXECUTE FUNCTION ledger_reject_history_change();

-- Deferred checks prevent an operator's half-written seed or event from committing.
CREATE FUNCTION card_require_complete_event() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE e card_payment_events%ROWTYPE; n BIGINT;
BEGIN
  SELECT * INTO e FROM card_payment_events WHERE event_id = NEW.event_id;
  IF e.result IS NULL THEN RAISE EXCEPTION 'CARD_EVENT_INCOMPLETE' USING ERRCODE = '23514'; END IF;
  SELECT count(*) INTO n FROM journals WHERE card_event_id = e.event_id;
  IF (e.kind = 'authorize' AND (n <> 1 OR NOT EXISTS (SELECT 1 FROM journals WHERE card_event_id = e.event_id AND kind = 'card_authorize')))
    OR (e.kind = 'reverse' AND (n <> 1 OR NOT EXISTS (SELECT 1 FROM journals WHERE card_event_id = e.event_id AND kind = 'card_reverse')))
    OR (e.kind = 'refund' AND (n <> 1 OR NOT EXISTS (SELECT 1 FROM journals WHERE card_event_id = e.event_id AND kind = 'card_refund')))
    OR (e.kind = 'capture' AND (n NOT BETWEEN 1 AND 2 OR NOT EXISTS (SELECT 1 FROM journals WHERE card_event_id = e.event_id AND kind = 'card_capture')
      OR (coalesce((e.canonical_input->>'finalCapture')::boolean, false) AND (e.result->'payment'->>'heldWon')::BIGINT <> 0))) THEN
    RAISE EXCEPTION 'CARD_EVENT_INCOMPLETE' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER card_payment_event_complete AFTER INSERT OR UPDATE ON card_payment_events
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION card_require_complete_event();

CREATE FUNCTION card_require_authorized_payment() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM card_payments p JOIN journals j ON j.card_payment_id = p.id
    JOIN card_payment_events e ON e.event_id = j.card_event_id
    WHERE p.id = NEW.id AND p.authorized_won > 0 AND j.kind = 'card_authorize'
      AND e.kind = 'authorize' AND e.result IS NOT NULL) THEN
    RAISE EXCEPTION 'CARD_PAYMENT_INCOMPLETE' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER card_payment_authorized AFTER INSERT ON card_payments
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION card_require_authorized_payment();

CREATE OR REPLACE FUNCTION ledger_post_journal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
  source ledger_accounts%ROWTYPE; target ledger_accounts%ROWTYPE;
  p card_payments%ROWTYPE; e card_payment_events%ROWTYPE;
  authorized BIGINT; held BIGINT; captured BIGINT; released BIGINT; refunded BIGINT;
  spend_balance BIGINT; target_hold BIGINT; next_status TEXT;
BEGIN
  IF NEW.amount_won NOT BETWEEN 1 AND 9007199254740991 OR NEW.from_account_id = NEW.to_account_id THEN
    RAISE EXCEPTION 'Invalid journal amount or accounts' USING ERRCODE = '23514';
  END IF;
  PERFORM id FROM ledger_accounts WHERE id IN (NEW.from_account_id, NEW.to_account_id) ORDER BY id FOR UPDATE;
  SELECT * INTO source FROM ledger_accounts WHERE id = NEW.from_account_id;
  SELECT * INTO target FROM ledger_accounts WHERE id = NEW.to_account_id;
  IF source.id IS NULL OR target.id IS NULL OR source.currency <> NEW.currency OR target.currency <> NEW.currency THEN
    RAISE EXCEPTION 'Invalid journal accounts' USING ERRCODE = '23514';
  END IF;

  IF NEW.kind IN ('member_transfer', 'sandbox_credit') THEN
    IF NEW.card_payment_id IS NOT NULL OR NEW.card_event_id IS NOT NULL OR NEW.idempotency_key LIKE '$card:%'
      OR target.kind <> 'user_spend' OR target.user_id IS DISTINCT FROM NEW.recipient_id
      OR target.id <> 'user:' || NEW.recipient_id THEN
      RAISE EXCEPTION 'Invalid recipient ledger account' USING ERRCODE = '23514';
    END IF;
    IF NEW.kind = 'member_transfer' THEN
      IF source.kind <> 'user_spend' OR source.user_id IS DISTINCT FROM NEW.sender_id
        OR source.id <> 'user:' || NEW.sender_id OR source.balance_won < NEW.amount_won
        OR NEW.balance_after_won <> source.balance_won - NEW.amount_won THEN
        RAISE EXCEPTION 'Invalid sender ledger account' USING ERRCODE = '23514';
      END IF;
    ELSIF source.kind <> 'sandbox_control' OR source.id <> 'system:sandbox'
      OR NEW.balance_after_won::numeric <> target.balance_won::numeric + NEW.amount_won THEN
      RAISE EXCEPTION 'Invalid sandbox posting' USING ERRCODE = '23514';
    END IF;
    -- The locked recipient spend account is also the aggregate-balance mutex.
    -- Card commands lock it before changing hold balances; no lock inversion is needed.
    SELECT balance_won INTO target_hold FROM ledger_accounts
      WHERE id = 'hold:' || target.user_id AND user_id = target.user_id AND kind = 'user_card_hold';
    IF target_hold IS NULL THEN RAISE EXCEPTION 'INVALID_LEDGER' USING ERRCODE = 'P0001'; END IF;
    IF NEW.amount_won > 9007199254740991 - target.balance_won - target_hold THEN
      RAISE EXCEPTION 'RECIPIENT_BALANCE_LIMIT' USING ERRCODE = 'P0001';
    END IF;
  ELSE
    SELECT * INTO e FROM card_payment_events WHERE event_id = NEW.card_event_id;
    IF e.event_id IS NULL OR e.result IS NOT NULL
      OR nullif(current_setting('aqua.card_event_id', true), '') IS DISTINCT FROM e.event_id
      OR e.payment_id IS DISTINCT FROM NEW.card_payment_id
      OR NEW.request_owner_id IS DISTINCT FROM e.user_id OR NEW.sender_id IS DISTINCT FROM e.user_id
      OR NEW.recipient_id IS DISTINCT FROM e.user_id
      OR NEW.idempotency_key <> '$card:' || e.event_id || ':' || NEW.kind
      OR NEW.request_payload IS DISTINCT FROM e.canonical_input::text OR NEW.created_at <> e.created_at THEN
      RAISE EXCEPTION 'CARD_STATE_CONFLICT' USING ERRCODE = 'P0001';
    END IF;
    SELECT * INTO p FROM card_payments WHERE id = e.payment_id FOR UPDATE;
    IF p.id IS NULL OR p.user_id <> e.user_id THEN RAISE EXCEPTION 'CARD_OWNER_MISMATCH' USING ERRCODE = 'P0001'; END IF;
    authorized := p.authorized_won; held := p.held_won; captured := p.captured_won;
    released := p.released_won; refunded := p.refunded_won;
    SELECT balance_won INTO spend_balance FROM ledger_accounts WHERE id = 'user:' || e.user_id;
    IF NEW.kind = 'card_authorize' THEN
      IF e.kind <> 'authorize' OR authorized <> 0 OR held <> 0 OR captured <> 0 OR released <> 0 OR refunded <> 0
        OR NEW.amount_won <> (e.canonical_input->>'amountWon')::BIGINT
        OR source.id <> 'user:' || e.user_id OR source.kind <> 'user_spend' OR source.user_id <> e.user_id
        OR target.id <> 'hold:' || e.user_id OR target.kind <> 'user_card_hold' OR target.user_id <> e.user_id
        OR NEW.balance_after_won <> source.balance_won - NEW.amount_won THEN
        RAISE EXCEPTION 'CARD_STATE_CONFLICT' USING ERRCODE = 'P0001';
      END IF;
      authorized := NEW.amount_won; held := NEW.amount_won;
    ELSIF NEW.kind = 'card_capture' THEN
      IF e.kind <> 'capture' OR NEW.amount_won <> (e.canonical_input->>'amountWon')::BIGINT OR held < NEW.amount_won
        OR source.id <> 'hold:' || e.user_id OR source.kind <> 'user_card_hold' OR source.user_id <> e.user_id
        OR target.id <> 'system:card_settlement' OR target.kind <> 'sandbox_card_settlement'
        OR NEW.balance_after_won <> spend_balance THEN
        RAISE EXCEPTION 'CARD_STATE_CONFLICT' USING ERRCODE = 'P0001';
      END IF;
      held := held - NEW.amount_won; captured := captured + NEW.amount_won;
    ELSIF NEW.kind = 'card_reverse' THEN
      IF (e.kind <> 'reverse' AND NOT (e.kind = 'capture' AND (e.canonical_input->>'finalCapture')::boolean
          AND EXISTS (SELECT 1 FROM journals WHERE card_event_id = e.event_id AND kind = 'card_capture')))
        OR held <= 0 OR NEW.amount_won <> held
        OR source.id <> 'hold:' || e.user_id OR source.kind <> 'user_card_hold' OR source.user_id <> e.user_id
        OR target.id <> 'user:' || e.user_id OR target.kind <> 'user_spend' OR target.user_id <> e.user_id
        OR NEW.balance_after_won <> target.balance_won + NEW.amount_won THEN
        RAISE EXCEPTION 'CARD_STATE_CONFLICT' USING ERRCODE = 'P0001';
      END IF;
      held := 0; released := released + NEW.amount_won;
    ELSIF NEW.kind = 'card_refund' THEN
      IF e.kind <> 'refund' OR NEW.amount_won <> (e.canonical_input->>'amountWon')::BIGINT
        OR NEW.amount_won > captured - refunded
        OR source.id <> 'system:card_settlement' OR source.kind <> 'sandbox_card_settlement'
        OR target.id <> 'user:' || e.user_id OR target.kind <> 'user_spend' OR target.user_id <> e.user_id
        OR NEW.balance_after_won <> target.balance_won + NEW.amount_won THEN
        RAISE EXCEPTION 'CARD_STATE_CONFLICT' USING ERRCODE = 'P0001';
      END IF;
      SELECT balance_won INTO target_hold FROM ledger_accounts WHERE id = 'hold:' || e.user_id;
      IF NEW.amount_won > 9007199254740991 - target.balance_won - target_hold THEN
        RAISE EXCEPTION 'RECIPIENT_BALANCE_LIMIT' USING ERRCODE = 'P0001';
      END IF;
      refunded := refunded + NEW.amount_won;
    ELSE
      RAISE EXCEPTION 'CARD_STATE_CONFLICT' USING ERRCODE = 'P0001';
    END IF;
    IF source.balance_won < NEW.amount_won THEN RAISE EXCEPTION 'INSUFFICIENT_FUNDS' USING ERRCODE = 'P0001'; END IF;
    next_status := CASE
      WHEN refunded > 0 THEN CASE WHEN held = 0 AND refunded = captured THEN 'refunded' ELSE 'partially_refunded' END
      WHEN captured > 0 THEN CASE WHEN held > 0 THEN 'partially_captured' ELSE 'captured' END
      WHEN held > 0 THEN 'authorized' ELSE 'cancelled' END;
    UPDATE card_payments SET authorized_won = authorized, held_won = held, captured_won = captured,
      released_won = released, refunded_won = refunded, status = next_status,
      updated_at = greatest(updated_at, NEW.created_at) WHERE id = p.id;
  END IF;
  IF target.balance_won::numeric + NEW.amount_won > '9223372036854775807'::numeric
    OR source.balance_won::numeric - NEW.amount_won < '-9223372036854775808'::numeric THEN
    RAISE EXCEPTION 'Ledger amount is outside the supported range' USING ERRCODE = '22003';
  END IF;
  UPDATE ledger_accounts SET balance_won = balance_won - NEW.amount_won WHERE id = NEW.from_account_id;
  UPDATE ledger_accounts SET balance_won = balance_won + NEW.amount_won WHERE id = NEW.to_account_id;
  RETURN NEW;
END;
$$;
-- CREATE OR REPLACE preserves the original AFTER INSERT trigger and its ACL.
REVOKE ALL ON FUNCTION ledger_post_journal() FROM PUBLIC;

CREATE FUNCTION apply_sandbox_card_event(p_input JSONB, p_now BIGINT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
  event_key TEXT; payment_key TEXT; owner_key TEXT; event_kind TEXT; merchant TEXT;
  amount_won BIGINT; numeric_amount NUMERIC; final_capture BOOLEAN;
  allowed_keys TEXT[]; canonical JSONB; previous_context TEXT;
  e card_payment_events%ROWTYPE; p card_payments%ROWTYPE;
  spend_balance BIGINT; hold_balance BIGINT; journal_amount BIGINT;
  from_id TEXT; to_id TEXT; journal_kind TEXT; balance_after BIGINT;
  journal_kinds TEXT[]; step INTEGER; locked_count INTEGER; answer JSONB;
BEGIN
  IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR p_now IS NULL OR p_now NOT BETWEEN 0 AND 8640000000000000 THEN
    RAISE EXCEPTION 'INVALID_CARD_EVENT' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_input->'eventId') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_input->'paymentId') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_input->'userId') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_input->'kind') IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION 'INVALID_CARD_EVENT' USING ERRCODE = '22023';
  END IF;
  event_key := p_input->>'eventId'; payment_key := p_input->>'paymentId'; owner_key := p_input->>'userId'; event_kind := p_input->>'kind';
  IF event_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    OR payment_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    OR owner_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    OR event_kind NOT IN ('authorize', 'capture', 'reverse', 'refund') THEN
    RAISE EXCEPTION 'INVALID_CARD_EVENT' USING ERRCODE = '22023';
  END IF;
  allowed_keys := ARRAY['eventId', 'paymentId', 'userId', 'kind'];
  IF event_kind IN ('authorize', 'capture', 'refund') THEN
    allowed_keys := allowed_keys || ARRAY['amountWon'];
    IF jsonb_typeof(p_input->'amountWon') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'INVALID_CARD_EVENT' USING ERRCODE = '22023'; END IF;
    numeric_amount := (p_input->>'amountWon')::NUMERIC;
    IF numeric_amount NOT BETWEEN 1 AND 9007199254740991 OR numeric_amount <> trunc(numeric_amount) THEN
      RAISE EXCEPTION 'INVALID_CARD_EVENT' USING ERRCODE = '22023';
    END IF;
    amount_won := numeric_amount::BIGINT;
  END IF;
  IF event_kind = 'authorize' THEN
    allowed_keys := allowed_keys || ARRAY['merchantName'];
    IF jsonb_typeof(p_input->'merchantName') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'INVALID_CARD_EVENT' USING ERRCODE = '22023'; END IF;
    IF p_input->>'merchantName' ~ '[[:cntrl:]]' OR char_length(p_input->>'merchantName') > 100 THEN
      RAISE EXCEPTION 'INVALID_CARD_EVENT' USING ERRCODE = '22023';
    END IF;
    merchant := regexp_replace(p_input->>'merchantName', '^[[:space:]]+|[[:space:]]+$', '', 'g');
    IF char_length(merchant) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'INVALID_CARD_EVENT' USING ERRCODE = '22023'; END IF;
  ELSIF event_kind = 'capture' THEN
    allowed_keys := allowed_keys || ARRAY['finalCapture'];
    IF jsonb_typeof(p_input->'finalCapture') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'INVALID_CARD_EVENT' USING ERRCODE = '22023'; END IF;
    final_capture := (p_input->>'finalCapture')::BOOLEAN;
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_input) AS k WHERE k <> ALL(allowed_keys)) THEN
    RAISE EXCEPTION 'INVALID_CARD_EVENT' USING ERRCODE = '22023';
  END IF;
  canonical := jsonb_build_object('eventId', event_key, 'paymentId', payment_key, 'userId', owner_key, 'kind', event_kind);
  IF amount_won IS NOT NULL THEN canonical := canonical || jsonb_build_object('amountWon', amount_won); END IF;
  IF event_kind = 'authorize' THEN canonical := canonical || jsonb_build_object('merchantName', merchant); END IF;
  IF event_kind = 'capture' THEN canonical := canonical || jsonb_build_object('finalCapture', final_capture); END IF;

  SELECT * INTO e FROM card_payment_events WHERE event_id = event_key;
  IF FOUND THEN
    IF e.canonical_input IS DISTINCT FROM canonical THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE = 'P0001'; END IF;
    IF e.result IS NULL THEN RAISE EXCEPTION 'CARD_STATE_CONFLICT' USING ERRCODE = 'P0001'; END IF;
    RETURN e.result;
  END IF;
  SELECT * INTO p FROM card_payments WHERE id = payment_key;
  IF FOUND AND p.user_id <> owner_key THEN RAISE EXCEPTION 'CARD_OWNER_MISMATCH' USING ERRCODE = 'P0001'; END IF;
  IF event_kind <> 'authorize' AND p.id IS NULL THEN RAISE EXCEPTION 'CARD_PAYMENT_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = owner_key) THEN RAISE EXCEPTION 'USER_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  PERFORM id FROM ledger_accounts
    WHERE id IN ('user:' || owner_key, 'hold:' || owner_key, 'system:card_settlement') ORDER BY id FOR UPDATE;
  GET DIAGNOSTICS locked_count = ROW_COUNT;
  IF locked_count <> 3 THEN RAISE EXCEPTION 'INVALID_LEDGER' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO p FROM card_payments WHERE id = payment_key FOR UPDATE;
  SELECT * INTO e FROM card_payment_events WHERE event_id = event_key;
  IF e.event_id IS NOT NULL THEN
    IF e.canonical_input IS DISTINCT FROM canonical THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE = 'P0001'; END IF;
    IF e.result IS NULL THEN RAISE EXCEPTION 'CARD_STATE_CONFLICT' USING ERRCODE = 'P0001'; END IF;
    RETURN e.result;
  END IF;
  IF p.id IS NOT NULL AND p.user_id <> owner_key THEN RAISE EXCEPTION 'CARD_OWNER_MISMATCH' USING ERRCODE = 'P0001'; END IF;
  IF event_kind = 'authorize' AND p.id IS NOT NULL THEN RAISE EXCEPTION 'CARD_STATE_CONFLICT' USING ERRCODE = 'P0001'; END IF;
  IF event_kind <> 'authorize' AND p.id IS NULL THEN RAISE EXCEPTION 'CARD_PAYMENT_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  SELECT balance_won INTO spend_balance FROM ledger_accounts WHERE id = 'user:' || owner_key;
  IF event_kind = 'authorize' AND spend_balance < amount_won THEN RAISE EXCEPTION 'INSUFFICIENT_FUNDS' USING ERRCODE = 'P0001'; END IF;
  IF event_kind = 'capture' AND p.held_won < amount_won THEN RAISE EXCEPTION 'CARD_STATE_CONFLICT' USING ERRCODE = 'P0001'; END IF;
  IF event_kind = 'reverse' AND p.held_won <= 0 THEN RAISE EXCEPTION 'CARD_STATE_CONFLICT' USING ERRCODE = 'P0001'; END IF;
  IF event_kind = 'refund' AND p.captured_won - p.refunded_won < amount_won THEN RAISE EXCEPTION 'CARD_STATE_CONFLICT' USING ERRCODE = 'P0001'; END IF;
  IF event_kind = 'refund' THEN
    SELECT balance_won INTO hold_balance FROM ledger_accounts WHERE id = 'hold:' || owner_key;
    IF amount_won > 9007199254740991 - spend_balance - hold_balance THEN
      RAISE EXCEPTION 'RECIPIENT_BALANCE_LIMIT' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  previous_context := current_setting('aqua.card_event_id', true);
  PERFORM set_config('aqua.card_event_id', event_key, true);
  INSERT INTO card_payment_events(event_id, payment_id, user_id, kind, canonical_input, created_at)
    VALUES (event_key, payment_key, owner_key, event_kind, canonical, p_now);
  IF event_kind = 'authorize' THEN
    INSERT INTO card_payments(id, user_id, merchant_name, status, authorized_won, held_won, captured_won, released_won, refunded_won, created_at, updated_at)
      VALUES (payment_key, owner_key, merchant, 'cancelled', 0, 0, 0, 0, 0, p_now, p_now);
    journal_kinds := ARRAY['card_authorize'];
  ELSIF event_kind = 'capture' THEN
    journal_kinds := ARRAY['card_capture'];
    IF final_capture AND p.held_won > amount_won THEN journal_kinds := journal_kinds || ARRAY['card_reverse']; END IF;
  ELSIF event_kind = 'reverse' THEN journal_kinds := ARRAY['card_reverse'];
  ELSE journal_kinds := ARRAY['card_refund'];
  END IF;
  FOREACH journal_kind IN ARRAY journal_kinds LOOP
    SELECT * INTO p FROM card_payments WHERE id = payment_key;
    SELECT balance_won INTO spend_balance FROM ledger_accounts WHERE id = 'user:' || owner_key;
    journal_amount := CASE WHEN journal_kind = 'card_reverse' THEN p.held_won ELSE amount_won END;
    IF journal_kind = 'card_authorize' THEN
      from_id := 'user:' || owner_key; to_id := 'hold:' || owner_key; balance_after := spend_balance - journal_amount;
    ELSIF journal_kind = 'card_capture' THEN
      from_id := 'hold:' || owner_key; to_id := 'system:card_settlement'; balance_after := spend_balance;
    ELSIF journal_kind = 'card_reverse' THEN
      from_id := 'hold:' || owner_key; to_id := 'user:' || owner_key; balance_after := spend_balance + journal_amount;
    ELSE
      from_id := 'system:card_settlement'; to_id := 'user:' || owner_key; balance_after := spend_balance + journal_amount;
    END IF;
    INSERT INTO journals(id, kind, from_account_id, to_account_id, amount_won, sender_id, recipient_id,
      sender_name, sender_tag, recipient_name, recipient_tag, request_owner_id, idempotency_key, request_payload,
      balance_after_won, created_at, card_payment_id, card_event_id)
      VALUES ('card:' || event_key || ':' || journal_kind, journal_kind, from_id, to_id, journal_amount, owner_key, owner_key,
        p.merchant_name, 'sandbox-card', p.merchant_name, 'sandbox-card', owner_key,
        '$card:' || event_key || ':' || journal_kind, canonical::text, balance_after, p_now, payment_key, event_key);
  END LOOP;
  SELECT * INTO p FROM card_payments WHERE id = payment_key;
  SELECT balance_won INTO spend_balance FROM ledger_accounts WHERE id = 'user:' || owner_key;
  SELECT balance_won INTO hold_balance FROM ledger_accounts WHERE id = 'hold:' || owner_key;
  answer := jsonb_build_object('payment', jsonb_build_object(
    'id', p.id, 'merchantName', p.merchant_name, 'status', p.status, 'authorizedWon', p.authorized_won,
    'heldWon', p.held_won, 'capturedWon', p.captured_won, 'releasedWon', p.released_won, 'refundedWon', p.refunded_won,
    'createdAt', p.created_at, 'updatedAt', p.updated_at),
    'balanceWon', spend_balance, 'heldBalanceWon', hold_balance, 'totalBalanceWon', spend_balance + hold_balance);
  UPDATE card_payment_events SET result = answer WHERE event_id = event_key;
  PERFORM set_config('aqua.card_event_id', coalesce(previous_context, ''), true);
  RETURN answer;
END;
$$;
REVOKE ALL ON FUNCTION apply_sandbox_card_event(JSONB, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION card_guard_payment_projection(), card_guard_event_history(),
  card_require_complete_event(), card_require_authorized_payment() FROM PUBLIC;
