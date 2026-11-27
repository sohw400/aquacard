-- The simulator emits UUIDs, so other historical uses of the two text prefixes
-- remain ordinary event/payment IDs. A payment that already occupied a generated
-- UUID before the simulator existed keeps its original settlement lifecycle.
CREATE OR REPLACE FUNCTION private_sync_event_guard() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
  is_authorization BOOLEAN := NEW.canonical_input->>'kind'='authorize';
  reserved_event BOOLEAN := NEW.event_id ~ '^sync-auth:[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$';
  reserved_payment BOOLEAN := NEW.payment_id ~ '^sync-pay:[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$';
  rid UUID;
BEGIN
  IF NOT reserved_event AND (NOT is_authorization OR NOT reserved_payment) THEN RETURN NEW; END IF;
  IF reserved_event THEN rid := substr(NEW.event_id,11)::uuid; END IF;
  -- decide_sandbox_authorization always refuses this UUID when a legacy payment
  -- occupies its derived payment key. Its corresponding event key can still be
  -- used to settle that particular legacy payment, under normal event uniqueness.
  IF NOT is_authorization AND reserved_payment AND NEW.payment_id='sync-pay:'||rid::text
      AND EXISTS (SELECT 1 FROM card_payments WHERE id=NEW.payment_id)
      AND NOT EXISTS (SELECT 1 FROM sandbox_sync_requests WHERE id=rid) THEN RETURN NEW; END IF;
  IF NOT is_authorization OR NOT reserved_event OR NEW.payment_id<>'sync-pay:'||rid::text THEN
    RAISE EXCEPTION 'SYNC_AUTHORIZATION_REQUIRED';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM sandbox_sync_requests r WHERE r.id=rid
      AND NOT EXISTS (SELECT 1 FROM sandbox_sync_decisions d WHERE d.request_id=r.id)) THEN RAISE EXCEPTION 'SYNC_AUTHORIZATION_REQUIRED'; END IF;
  RETURN NEW;
END;
$$;
