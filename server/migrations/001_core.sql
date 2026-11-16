CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  tag TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at BIGINT NOT NULL CHECK (created_at BETWEEN 0 AND 8640000000000000),
  CHECK (email = lower(btrim(email))),
  CHECK (tag = lower(btrim(tag)))
);

-- TEST_KRW is sandbox credit, not a live asset, deposit liability or partner balance.
CREATE TABLE ledger_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  currency TEXT NOT NULL DEFAULT 'TEST_KRW' CHECK (currency = 'TEST_KRW'),
  kind TEXT NOT NULL CHECK (kind IN ('user_spend', 'sandbox_control')),
  balance_won BIGINT NOT NULL DEFAULT 0,
  UNIQUE (id, currency),
  CHECK ((kind = 'user_spend' AND user_id IS NOT NULL AND balance_won BETWEEN 0 AND 9007199254740991)
    OR (kind = 'sandbox_control' AND user_id IS NULL AND balance_won <= 0))
);
CREATE UNIQUE INDEX ledger_single_sandbox ON ledger_accounts(kind) WHERE kind = 'sandbox_control';

-- One immutable row contains both equal legs. A one-sided journal cannot exist.
CREATE TABLE journals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('member_transfer', 'sandbox_credit')),
  currency TEXT NOT NULL DEFAULT 'TEST_KRW' CHECK (currency = 'TEST_KRW'),
  from_account_id TEXT NOT NULL,
  to_account_id TEXT NOT NULL,
  amount_won BIGINT NOT NULL CHECK (amount_won BETWEEN 1 AND 9007199254740991),
  sender_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  sender_name TEXT NOT NULL,
  sender_tag TEXT NOT NULL,
  recipient_name TEXT NOT NULL,
  recipient_tag TEXT NOT NULL,
  request_owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  request_payload TEXT NOT NULL,
  balance_after_won BIGINT NOT NULL CHECK (balance_after_won BETWEEN 0 AND 9007199254740991),
  created_at BIGINT NOT NULL CHECK (created_at BETWEEN 0 AND 8640000000000000),
  UNIQUE (request_owner_id, idempotency_key),
  FOREIGN KEY (from_account_id, currency) REFERENCES ledger_accounts(id, currency) ON DELETE RESTRICT,
  FOREIGN KEY (to_account_id, currency) REFERENCES ledger_accounts(id, currency) ON DELETE RESTRICT,
  CHECK (from_account_id <> to_account_id),
  CHECK ((kind = 'member_transfer' AND sender_id IS NOT NULL AND sender_id <> recipient_id AND request_owner_id = sender_id)
    OR (kind = 'sandbox_credit' AND sender_id IS NULL AND request_owner_id = recipient_id))
);
CREATE INDEX journals_outgoing ON journals(sender_id, created_at) WHERE kind = 'member_transfer';
CREATE INDEX journals_incoming ON journals(recipient_id, created_at);
CREATE VIEW journal_entries AS
  SELECT id AS journal_id, from_account_id AS account_id, -amount_won AS amount_won, currency, created_at FROM journals
  UNION ALL
  SELECT id AS journal_id, to_account_id AS account_id, amount_won, currency, created_at FROM journals;

CREATE FUNCTION ledger_reject_history_change() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  RAISE EXCEPTION 'Journal history is immutable' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER journals_immutable BEFORE UPDATE OR DELETE ON journals
FOR EACH ROW EXECUTE FUNCTION ledger_reject_history_change();
CREATE TRIGGER journals_no_truncate BEFORE TRUNCATE ON journals
FOR EACH STATEMENT EXECUTE FUNCTION ledger_reject_history_change();
CREATE TRIGGER ledger_account_identity_immutable BEFORE UPDATE OF id, user_id, kind, currency ON ledger_accounts
FOR EACH ROW EXECUTE FUNCTION ledger_reject_history_change();

CREATE FUNCTION ledger_guard_balance_projection() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.balance_won <> 0 THEN
      RAISE EXCEPTION 'Ledger accounts must start empty' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.balance_won IS DISTINCT FROM OLD.balance_won AND pg_trigger_depth() <> 2 THEN
    -- The journal posting trigger is the sole application path to the projection.
    -- No history-wide SUM is needed for each posting. Database operators remain trusted.
    RAISE EXCEPTION 'Ledger balance must be changed through the journal' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ledger_accounts_start_empty BEFORE INSERT ON ledger_accounts
FOR EACH ROW EXECUTE FUNCTION ledger_guard_balance_projection();
CREATE TRIGGER ledger_accounts_projection_guard BEFORE UPDATE OF balance_won ON ledger_accounts
FOR EACH ROW EXECUTE FUNCTION ledger_guard_balance_projection();

CREATE FUNCTION ledger_post_journal() RETURNS trigger
-- Only the trusted migration owner updates projections; the application role cannot.
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
  source ledger_accounts%ROWTYPE;
  target ledger_accounts%ROWTYPE;
BEGIN
  IF NEW.amount_won NOT BETWEEN 1 AND 9007199254740991 OR NEW.from_account_id = NEW.to_account_id THEN
    RAISE EXCEPTION 'Invalid journal amount or accounts' USING ERRCODE = '23514';
  END IF;
  -- Application commands use this same global lock order. The trigger also defends raw postings.
  PERFORM id FROM ledger_accounts WHERE id IN (NEW.from_account_id, NEW.to_account_id) ORDER BY id FOR UPDATE;
  SELECT * INTO source FROM ledger_accounts WHERE id = NEW.from_account_id;
  SELECT * INTO target FROM ledger_accounts WHERE id = NEW.to_account_id;
  IF source.id IS NULL OR target.id IS NULL OR target.kind <> 'user_spend'
    OR target.user_id IS DISTINCT FROM NEW.recipient_id OR source.currency <> NEW.currency OR target.currency <> NEW.currency THEN
    RAISE EXCEPTION 'Invalid journal accounts' USING ERRCODE = '23514';
  END IF;
  IF NEW.kind = 'member_transfer' THEN
    IF source.kind <> 'user_spend' OR source.user_id IS DISTINCT FROM NEW.sender_id
      OR source.balance_won < NEW.amount_won OR NEW.balance_after_won <> source.balance_won - NEW.amount_won THEN
      RAISE EXCEPTION 'Invalid sender balance or account' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.kind = 'sandbox_credit' THEN
    IF source.kind <> 'sandbox_control' OR NEW.balance_after_won::numeric <> target.balance_won::numeric + NEW.amount_won THEN
      RAISE EXCEPTION 'Invalid sandbox posting' USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'Invalid journal kind' USING ERRCODE = '23514';
  END IF;
  IF target.balance_won > 9007199254740991 - NEW.amount_won
    OR source.balance_won::numeric - NEW.amount_won < '-9223372036854775808'::numeric THEN
    RAISE EXCEPTION 'Ledger amount is outside the supported range' USING ERRCODE = '22003';
  END IF;
  UPDATE ledger_accounts SET balance_won = balance_won - NEW.amount_won WHERE id = NEW.from_account_id;
  UPDATE ledger_accounts SET balance_won = balance_won + NEW.amount_won WHERE id = NEW.to_account_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER journals_post_balances AFTER INSERT ON journals
FOR EACH ROW EXECUTE FUNCTION ledger_post_journal();
REVOKE ALL ON FUNCTION ledger_post_journal() FROM PUBLIC;

INSERT INTO ledger_accounts(id, user_id, kind) VALUES ('system:sandbox', NULL, 'sandbox_control');
