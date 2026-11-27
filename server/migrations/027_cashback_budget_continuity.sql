-- A full advertised cashback amount is reserved at authorization, or this new
-- purchase explicitly receives none. An earlier commitment never uses this fallback.
ALTER TABLE card_reward_allocations ADD COLUMN cashback_budget_limited_at BIGINT CHECK(
  cashback_budget_limited_at IS NULL OR (cashback_budget_limited_at BETWEEN 0 AND 8640000000000000 AND rate_bps=0 AND cashback_initial_reserved_won=0));
CREATE INDEX cashback_budget_limited_recent ON card_reward_allocations(cashback_budget_limited_at)
  WHERE cashback_budget_limited_at IS NOT NULL;
CREATE TRIGGER cashback_budget_basis_immutable BEFORE UPDATE OF cashback_budget_limited_at ON card_reward_allocations
  FOR EACH ROW WHEN(OLD.cashback_budget_limited_at IS DISTINCT FROM NEW.cashback_budget_limited_at) EXECUTE FUNCTION ledger_reject_history_change();

-- Leave the accounting and immutable previous receipts from 004/017 intact.
-- Replace just the locked new-authorization budget decision and its INSERT.
DO $$ DECLARE body TEXT; old_guard TEXT:='IF budget<quota THEN RAISE EXCEPTION ''REWARD_BUDGET_UNAVAILABLE''; END IF;';
  old_columns TEXT:='reward_held_won,cashback_initial_reserved_won,cashback_pending_won)';
  old_values TEXT:='principal,principal,rewards,rewards,quota,quota);';
BEGIN
  body:=pg_get_functiondef('reserve_base_card_event_004(jsonb,bigint)'::regprocedure);
  IF strpos(body,old_guard)=0 OR strpos(body,old_columns)=0 OR strpos(body,old_values)=0
      OR strpos(body,'quota BIGINT;')=0 THEN RAISE EXCEPTION 'Unexpected authorization implementation'; END IF;
  body:=replace(body,'quota BIGINT;','quota BIGINT; budget_limited_at BIGINT;');
  body:=replace(body,old_guard,'IF budget<quota THEN budget_limited_at:=p_now; quota:=0; rate:=0; END IF;');
  body:=replace(body,old_columns,'reward_held_won,cashback_initial_reserved_won,cashback_pending_won,cashback_budget_limited_at)');
  body:=replace(body,old_values,'principal,principal,rewards,rewards,quota,quota,budget_limited_at);');
  EXECUTE body;
END; $$;
CREATE FUNCTION cashback_budget_receipt() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM card_reward_allocations WHERE payment_id=NEW.payment_id AND cashback_budget_limited_at IS NOT NULL) THEN
    NEW.result:=jsonb_set(NEW.result,'{payment,cashback,reason}','"budget_unavailable"');
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER b_cashback_budget_receipt BEFORE UPDATE OF result ON card_payment_events
  FOR EACH ROW WHEN(OLD.result IS NULL AND NEW.result IS NOT NULL) EXECUTE FUNCTION cashback_budget_receipt();

CREATE FUNCTION reward_budget_health(p_now BIGINT) RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
  SELECT jsonb_build_object('budgetLow',program.enabled AND budget.balance_won<10000,'unfunded24h',
    (SELECT count(*) FROM card_reward_allocations WHERE cashback_budget_limited_at BETWEEN p_now-86400000 AND p_now))
  FROM ledger_accounts budget CROSS JOIN reward_program program WHERE budget.id='system:reward_budget' AND program.singleton
$$;
REVOKE ALL ON FUNCTION cashback_budget_receipt(),reward_budget_health(bigint) FROM PUBLIC;
