-- Synthetic fixed-price routes only. All financial postings use the same TEST_KRW journal as card authorizations.
CREATE TABLE funding_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id text NOT NULL REFERENCES users(id),
  direction text NOT NULL CHECK(direction IN ('deposit','withdrawal')), asset text NOT NULL, network text NOT NULL,
  status text NOT NULL CHECK(status IN ('quoted','awaiting','observed','confirmed','credited','reorg_review','reversed',
    'held','dispatched','unknown','settled','released','cancelled')),
  destination text NOT NULL, price_won bigint NOT NULL CHECK(price_won>0),
  gross_won bigint NOT NULL CHECK(gross_won BETWEEN 1000 AND 100000000),
  fee_won bigint NOT NULL CHECK(fee_won>=0), network_fee_won bigint NOT NULL CHECK(network_fee_won>=0),
  net_won bigint GENERATED ALWAYS AS (gross_won-fee_won-network_fee_won) STORED CHECK(net_won>0),
  units numeric(30,8) NOT NULL CHECK(units>0), required_confirmations int NOT NULL CHECK(required_confirmations>0),
  transfer_ref text, created_at bigint NOT NULL, updated_at bigint NOT NULL, expires_at bigint NOT NULL
);
CREATE INDEX funding_owner_history ON funding_operations(user_id,created_at DESC,id DESC);
CREATE TABLE funding_member_commands (
  user_id text NOT NULL REFERENCES users(id), request_key text NOT NULL, input jsonb NOT NULL, result jsonb NOT NULL,
  PRIMARY KEY(user_id,request_key)
);
CREATE TABLE funding_events (
  event_id text PRIMARY KEY, funding_id uuid NOT NULL REFERENCES funding_operations(id),
  input jsonb NOT NULL, result jsonb NOT NULL, actor name NOT NULL DEFAULT session_user, created_at bigint NOT NULL
);
-- A tx reference includes its output/log index. Ownership survives forks/restarts and cannot migrate to a second deposit.
CREATE TABLE funding_chain_receipts (
  network text NOT NULL, transfer_ref text NOT NULL, funding_id uuid NOT NULL REFERENCES funding_operations(id),
  PRIMARY KEY(network,transfer_ref)
);
CREATE TABLE funding_cash_postings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), funding_id uuid NOT NULL REFERENCES funding_operations(id),
  phase text NOT NULL CHECK(phase IN ('credit','reorg','hold','release','settle','fee','network_fee')),
  from_id text NOT NULL REFERENCES ledger_accounts(id), to_id text NOT NULL REFERENCES ledger_accounts(id),
  amount_won bigint NOT NULL CHECK(amount_won>0), UNIQUE(funding_id,phase)
);
-- Extend the current release's checks without weakening existing journal and account types.
DO $$ DECLARE c record; ref regclass; old_check text; BEGIN
  FOR c IN SELECT * FROM (VALUES
    ('ledger_accounts','ledger_accounts_kind_guard','kind=''funding_system'''),
    ('ledger_accounts','ledger_accounts_balance_guard','kind=''funding_system'' AND user_id IS NULL AND id IN (''system:funding_hold'',''system:funding_settled'',''system:funding_fee'',''system:funding_network_fee'') AND balance_won>=0'),
    ('journals','journals_kind_guard','kind=''coin_funding'''),
    ('journals','journals_owner_guard','kind=''coin_funding'' AND sender_id IS NOT NULL AND sender_id=recipient_id AND sender_id=request_owner_id'),
    ('journals','journals_card_link_guard','kind=''coin_funding'' AND card_event_id IS NULL AND card_payment_id IS NULL AND reward_plan_id IS NULL AND reward_component IS NULL AND reward_command_id IS NULL')
  ) s(tbl,con,extra) LOOP
    ref:=c.tbl::regclass;
    SELECT pg_get_expr(conbin,conrelid) INTO STRICT old_check FROM pg_constraint WHERE conrelid=ref AND conname=c.con;
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I, ADD CONSTRAINT %I CHECK ((%s) OR (%s))',ref,c.con,c.con,old_check,c.extra);
  END LOOP;
END; $$;
INSERT INTO ledger_accounts(id,kind) VALUES ('system:funding_hold','funding_system'),('system:funding_settled','funding_system'),
  ('system:funding_fee','funding_system'),('system:funding_network_fee','funding_system');

CREATE FUNCTION funding_post_journal() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE plan funding_cash_postings%ROWTYPE; owner_id text; source_balance bigint; target_balance bigint;
BEGIN
  SELECT p.* INTO plan FROM funding_cash_postings p WHERE p.id::text=NEW.id;
  SELECT user_id INTO owner_id FROM funding_operations WHERE id=plan.funding_id;
  IF plan.id IS NULL OR NEW.request_owner_id IS DISTINCT FROM owner_id OR NEW.sender_id IS DISTINCT FROM owner_id
    OR NEW.recipient_id IS DISTINCT FROM owner_id OR NEW.from_account_id<>plan.from_id OR NEW.to_account_id<>plan.to_id
    OR NEW.amount_won<>plan.amount_won OR NEW.idempotency_key<>'$funding:'||plan.id::text THEN
    RAISE EXCEPTION 'FUNDING_POSTING_INVALID';
  END IF;
  PERFORM id FROM ledger_accounts WHERE id IN (plan.from_id,plan.to_id) ORDER BY id FOR UPDATE;
  SELECT balance_won INTO STRICT source_balance FROM ledger_accounts WHERE id=plan.from_id;
  SELECT balance_won INTO STRICT target_balance FROM ledger_accounts WHERE id=plan.to_id;
  IF plan.from_id<>'system:sandbox' AND source_balance<plan.amount_won THEN RAISE EXCEPTION 'FUNDING_BALANCE_LOW'; END IF;
  IF plan.to_id='user:'||owner_id AND target_balance::numeric+plan.amount_won+
    (SELECT balance_won FROM ledger_accounts WHERE id='hold:'||owner_id)>9007199254740991 THEN RAISE EXCEPTION 'RECIPIENT_BALANCE_LIMIT'; END IF;
  UPDATE ledger_accounts SET balance_won=balance_won-plan.amount_won WHERE id=plan.from_id;
  UPDATE ledger_accounts SET balance_won=balance_won+plan.amount_won WHERE id=plan.to_id;
  RETURN NEW;
END; $$;
-- Retain any earlier trigger predicate (including the reserve posting branch).
DO $$ DECLARE definition text; BEGIN
  SELECT pg_get_triggerdef(oid) INTO STRICT definition FROM pg_trigger WHERE tgrelid='journals'::regclass AND tgname='journals_post_balances';
  DROP TRIGGER journals_post_balances ON journals;
  IF position(' WHEN (' IN definition)>0 THEN
    definition:=replace(definition,' WHEN (',' WHEN (NEW.kind <> ''coin_funding'' AND ');
  ELSE
    definition:=replace(definition,' EXECUTE FUNCTION ',' WHEN (NEW.kind <> ''coin_funding'') EXECUTE FUNCTION ');
  END IF;
  EXECUTE definition;
END; $$;
CREATE TRIGGER funding_journals_post_balances AFTER INSERT ON journals FOR EACH ROW
  WHEN (NEW.kind='coin_funding') EXECUTE FUNCTION funding_post_journal();

CREATE FUNCTION funding_post(o funding_operations,phase text,now_ms bigint) RETURNS void LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE source_id text; target_id text; amount bigint; plan_id uuid;
BEGIN
  SELECT x.f,x.t,x.n INTO STRICT source_id,target_id,amount FROM (VALUES
    ('credit','system:sandbox','user:'||o.user_id,o.gross_won),
    ('reorg','user:'||o.user_id,'system:sandbox',o.gross_won),
    ('hold','user:'||o.user_id,'system:funding_hold',o.gross_won),
    ('release','system:funding_hold','user:'||o.user_id,o.gross_won),
    ('settle','system:funding_hold','system:funding_settled',o.net_won),
    ('fee','system:funding_hold','system:funding_fee',o.fee_won),
    ('network_fee','system:funding_hold','system:funding_network_fee',o.network_fee_won)
  ) x(p,f,t,n) WHERE x.p=phase;
  IF amount=0 THEN RETURN; END IF;
  INSERT INTO funding_cash_postings(funding_id,phase,from_id,to_id,amount_won) VALUES(o.id,phase,source_id,target_id,amount) RETURNING id INTO plan_id;
  INSERT INTO journals(id,kind,from_account_id,to_account_id,amount_won,sender_id,recipient_id,sender_name,sender_tag,recipient_name,recipient_tag,
    request_owner_id,idempotency_key,request_payload,balance_after_won,created_at)
  VALUES(plan_id::text,'coin_funding',source_id,target_id,amount,o.user_id,o.user_id,'코인 입출금','sandbox-funding','코인 입출금','sandbox-funding',
    o.user_id,'$funding:'||plan_id::text,phase,0,now_ms);
END; $$;
CREATE FUNCTION funding_summary(o funding_operations) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path FROM CURRENT AS $$
  SELECT jsonb_build_object('id',o.id,'direction',o.direction,'asset',o.asset,'network',o.network,'status',o.status,
    'destination',o.destination,'priceWon',o.price_won,'grossWon',o.gross_won,'feeWon',o.fee_won,'networkFeeWon',o.network_fee_won,
    'netWon',o.net_won,'units',trim_scale(o.units)::text,'requiredConfirmations',o.required_confirmations,
    'createdAt',o.created_at,'updatedAt',o.updated_at,'expiresAt',o.expires_at)
$$;
CREATE FUNCTION funding_member_history(p_user text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
  SELECT coalesce(jsonb_agg(funding_summary(o) ORDER BY o.created_at DESC,o.id DESC),'[]'::jsonb)
    FROM (SELECT * FROM funding_operations WHERE user_id=p_user ORDER BY
      CASE WHEN status IN ('awaiting','observed','confirmed','reorg_review','held','dispatched','unknown') THEN 0 ELSE 1 END,
      created_at DESC,id DESC LIMIT 50) o
$$;
CREATE FUNCTION funding_intent(p_user text,p_key text,p_input jsonb,p_now bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE o funding_operations%ROWTYPE; cmd funding_member_commands%ROWTYPE; answer jsonb; action text:=p_input->>'action';
  direction text:=p_input->>'direction'; asset text:=p_input->>'asset'; network text:=p_input->>'network';
  rate bigint; network_cost bigint; fee bigint:=0; gross numeric; quantity numeric; dest text; op_id uuid;
BEGIN
  IF p_user IS NULL OR p_key IS NULL OR p_key !~ '^[A-Za-z0-9_-]{8,128}$' OR jsonb_typeof(p_input) IS DISTINCT FROM 'object'
    OR p_now IS NULL OR p_now NOT BETWEEN 0 AND 8639999967600000 THEN RAISE EXCEPTION 'INVALID_FUNDING_INPUT'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('funding/member/'||p_user||'/'||p_key,0));
  SELECT * INTO cmd FROM funding_member_commands WHERE user_id=p_user AND request_key=p_key;
  IF FOUND THEN
    IF cmd.input<>p_input THEN RAISE EXCEPTION 'FUNDING_KEY_CONFLICT'; END IF;
    RETURN cmd.result;
  END IF;
  IF action='quote' THEN
    PERFORM customer_require_active(ARRAY[p_user]);
    PERFORM pg_advisory_xact_lock(hashtextextended('funding/open/'||p_user,0));
    IF (SELECT count(*) FROM funding_operations WHERE user_id=p_user AND
       (status IN ('awaiting','observed','confirmed','reorg_review','held','dispatched','unknown') OR (status='quoted' AND expires_at>p_now)))>=20
      THEN RAISE EXCEPTION 'FUNDING_OPEN_LIMIT'; END IF;
    IF direction NOT IN ('deposit','withdrawal') OR direction IS NULL OR asset IS NULL OR network IS NULL
      OR jsonb_typeof(p_input->'quantity') IS DISTINCT FROM 'string' OR p_input->>'quantity' !~ '^(0|[1-9][0-9]{0,9})(\.[0-9]{1,8})?$'
      OR p_input - ARRAY['action','direction','asset','network','quantity','destination'] <> '{}'::jsonb THEN RAISE EXCEPTION 'INVALID_FUNDING_INPUT'; END IF;
    SELECT x.rate,x.cost INTO rate,network_cost FROM (VALUES ('KRWS','polygon',1,140),('KRWS','ethereum',1,2800),
      ('USDC','polygon',1400,140),('USDC','ethereum',1400,2800),('USDT','ethereum',1400,2800),
      ('BTC','bitcoin',150000000,1500),('ETH','ethereum',4000000,2000)) x(a,n,rate,cost) WHERE x.a=asset AND x.n=network;
    IF rate IS NULL THEN RAISE EXCEPTION 'INVALID_FUNDING_INPUT'; END IF;
    op_id:=gen_random_uuid();
    quantity:=(p_input->>'quantity')::numeric;
    IF direction='deposit' THEN
      IF p_input ? 'destination' THEN RAISE EXCEPTION 'INVALID_FUNDING_INPUT'; END IF;
      gross:=floor(quantity*rate); network_cost:=0;
      dest:='aqua-test:'||network||':'||op_id::text;
    ELSE
      gross:=quantity; dest:=p_input->>'destination';
      IF gross<>trunc(gross) OR dest IS NULL OR dest !~ ('^aqua-test:'||network||':[a-z][a-z0-9-]{1,39}$') THEN RAISE EXCEPTION 'INVALID_FUNDING_INPUT'; END IF;
      IF asset<>'KRWS' THEN fee:=ceil(gross*0.005); END IF;
      quantity:=trunc((gross-fee-network_cost)/rate,8);
    END IF;
    IF gross NOT BETWEEN 1000 AND 100000000 OR quantity<=0 OR gross<=fee+network_cost THEN RAISE EXCEPTION 'INVALID_FUNDING_INPUT'; END IF;
    INSERT INTO funding_operations(id,user_id,direction,asset,network,status,destination,price_won,gross_won,fee_won,network_fee_won,
      units,required_confirmations,created_at,updated_at,expires_at)
    VALUES(op_id,p_user,direction,asset,network,'quoted',dest,rate,gross,fee,network_cost,quantity,
      CASE network WHEN 'ethereum' THEN 12 ELSE 2 END,p_now,p_now,p_now+60000) RETURNING * INTO o;
  ELSE
    IF p_input - ARRAY['action','id']<>'{}'::jsonb OR jsonb_typeof(p_input->'id') IS DISTINCT FROM 'string'
      OR (p_input->>'id') !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RAISE EXCEPTION 'INVALID_FUNDING_INPUT'; END IF;
    SELECT * INTO o FROM funding_operations WHERE id=(p_input->>'id')::uuid AND user_id=p_user FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'FUNDING_NOT_FOUND'; END IF;
    IF action='cancel' AND o.status IN ('quoted','awaiting','held') THEN
      IF o.status='held' THEN PERFORM funding_post(o,'release',p_now); END IF;
      o.status:='cancelled';
    ELSIF action IN ('accept_deposit','accept_withdrawal') AND action='accept_'||o.direction AND o.status='quoted' THEN
      PERFORM customer_require_active(ARRAY[p_user]);
      IF p_now>=o.expires_at OR p_now<o.created_at THEN RAISE EXCEPTION 'FUNDING_QUOTE_EXPIRED'; END IF;
      IF o.direction='withdrawal' THEN
        IF EXISTS(SELECT 1 FROM funding_operations WHERE user_id=p_user AND status='reorg_review') THEN RAISE EXCEPTION 'FUNDING_REVIEW_REQUIRED'; END IF;
        PERFORM funding_post(o,'hold',p_now); o.status:='held';
      ELSE o.status:='awaiting'; END IF;
    ELSE RAISE EXCEPTION 'FUNDING_STATE_CONFLICT'; END IF;
    UPDATE funding_operations SET status=o.status,updated_at=greatest(updated_at,p_now) WHERE id=o.id RETURNING * INTO o;
  END IF;
  answer:=funding_summary(o);
  INSERT INTO funding_member_commands(user_id,request_key,input,result) VALUES(p_user,p_key,p_input,answer);
  RETURN answer;
END; $$;
ALTER TABLE funding_operations ADD COLUMN block_ref text;
CREATE TABLE funding_invalid_blocks (
  funding_id uuid NOT NULL REFERENCES funding_operations(id), block_ref text NOT NULL, PRIMARY KEY(funding_id,block_ref)
);

CREATE FUNCTION funding_operator_event(p_input jsonb,p_now bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE o funding_operations%ROWTYPE; prior funding_events%ROWTYPE; answer jsonb;
  evt text:=p_input->>'eventId'; action text:=p_input->>'action'; ref text:=p_input->>'transferRef'; block text:=p_input->>'blockRef';
  expected_fields text[]:=ARRAY['id','action','eventId']; observed_owner uuid;
BEGIN
  IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR evt IS NULL OR evt !~ '^[a-zA-Z0-9_-]{8,100}$'
    OR p_input->>'id' IS NULL OR (p_input->>'id') !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
    OR p_now IS NULL OR p_now NOT BETWEEN 0 AND 8639999967600000 THEN RAISE EXCEPTION 'INVALID_FUNDING_INPUT'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('funding/event/'||evt,0));
  SELECT * INTO prior FROM funding_events WHERE event_id=evt;
  IF FOUND THEN
    IF prior.input<>p_input THEN RAISE EXCEPTION 'FUNDING_KEY_CONFLICT'; END IF;
    RETURN prior.result;
  END IF;
  SELECT * INTO o FROM funding_operations WHERE id=(p_input->>'id')::uuid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FUNDING_NOT_FOUND'; END IF;
  IF action IN ('observe','confirm','reorg') THEN
    expected_fields:=expected_fields||ARRAY['transferRef','blockRef'];
    IF ref IS NULL OR ref !~ '^sim-tx:[a-z0-9-]{1,64}:[0-9]{1,6}$'
      OR block IS NULL OR block !~ '^sim-block:[a-z0-9-]{1,64}$' THEN RAISE EXCEPTION 'INVALID_FUNDING_INPUT'; END IF;
  END IF;
  IF action='observe' AND o.status='awaiting' AND o.direction='deposit' THEN
    expected_fields:=expected_fields||ARRAY['asset','network','units','destination'];
    IF o.asset IS DISTINCT FROM p_input->>'asset' OR o.network IS DISTINCT FROM p_input->>'network'
      OR o.destination IS DISTINCT FROM p_input->>'destination' OR jsonb_typeof(p_input->'units') IS DISTINCT FROM 'string'
      OR (p_input->>'units') !~ '^(0|[1-9][0-9]{0,9})(\.[0-9]{1,8})?$'
      OR (p_input->>'units')::numeric<>o.units THEN RAISE EXCEPTION 'FUNDING_OBSERVATION_MISMATCH'; END IF;
    IF EXISTS(SELECT 1 FROM funding_invalid_blocks WHERE funding_id=o.id AND block_ref=block) THEN RAISE EXCEPTION 'FUNDING_STATE_CONFLICT'; END IF;
    INSERT INTO funding_chain_receipts(network,transfer_ref,funding_id) VALUES(o.network,ref,o.id) ON CONFLICT DO NOTHING;
    SELECT funding_id INTO STRICT observed_owner FROM funding_chain_receipts WHERE network=o.network AND transfer_ref=ref;
    IF observed_owner<>o.id THEN RAISE EXCEPTION 'FUNDING_DUPLICATE_TRANSFER'; END IF;
    o.status:='observed'; o.transfer_ref:=ref; o.block_ref:=block;
  ELSIF action='confirm' AND o.status='observed' AND ref=o.transfer_ref AND block=o.block_ref THEN
    expected_fields:=expected_fields||ARRAY['confirmations'];
    IF jsonb_typeof(p_input->'confirmations') IS DISTINCT FROM 'number'
      OR (p_input->>'confirmations') !~ '^[0-9]{1,7}$' OR (p_input->>'confirmations')::integer<o.required_confirmations THEN
      RAISE EXCEPTION 'FUNDING_CONFIRMATIONS_REQUIRED'; END IF;
    o.status:='confirmed';
  ELSIF action='convert' AND o.status='confirmed' THEN
    PERFORM customer_require_active(ARRAY[o.user_id]);
    PERFORM funding_post(o,'credit',p_now); o.status:='credited';
  ELSIF action='reorg' AND o.direction='deposit' AND o.status IN ('observed','confirmed','credited') AND ref=o.transfer_ref AND block=o.block_ref THEN
    INSERT INTO funding_invalid_blocks VALUES(o.id,block);
    o.status:=CASE WHEN o.status='credited' THEN 'reorg_review' ELSE 'awaiting' END;
    IF o.status='awaiting' THEN o.transfer_ref:=NULL; o.block_ref:=NULL; END IF;
  ELSIF action='compensate' AND o.status='reorg_review' THEN
    PERFORM funding_post(o,'reorg',p_now); o.status:='reversed';
  ELSIF action='dispatch' AND o.status='held' THEN
    PERFORM customer_require_active(ARRAY[o.user_id]);
    IF EXISTS(SELECT 1 FROM funding_operations WHERE user_id=o.user_id AND status='reorg_review') THEN RAISE EXCEPTION 'FUNDING_REVIEW_REQUIRED'; END IF;
    o.status:='dispatched';
  ELSIF action='unknown' AND o.status='dispatched' THEN o.status:='unknown';
  ELSIF action IN ('not_sent','reject','settle') AND o.status IN ('dispatched','unknown') THEN
    -- Trusted synthetic adapter result for the same durable dispatch key. A network timeout is never evidence of rejection.
    expected_fields:=expected_fields||ARRAY['dispatchKey','proofRef'];
    IF p_input->>'dispatchKey' IS DISTINCT FROM o.id::text OR p_input->>'proofRef' IS NULL
      OR p_input->>'proofRef' !~ '^sim-proof:[a-z0-9-]{1,64}$' THEN RAISE EXCEPTION 'FUNDING_OBSERVATION_MISMATCH'; END IF;
    IF action='not_sent' THEN o.status:='held';
    ELSIF action='reject' THEN PERFORM funding_post(o,'release',p_now); o.status:='released';
    ELSE
      expected_fields:=expected_fields||ARRAY['transferRef'];
      IF ref IS NULL OR ref !~ '^sim-tx:[a-z0-9-]{1,64}:[0-9]{1,6}$' THEN RAISE EXCEPTION 'INVALID_FUNDING_INPUT'; END IF;
      INSERT INTO funding_chain_receipts(network,transfer_ref,funding_id) VALUES(o.network,ref,o.id) ON CONFLICT DO NOTHING;
      SELECT funding_id INTO STRICT observed_owner FROM funding_chain_receipts WHERE network=o.network AND transfer_ref=ref;
      IF observed_owner<>o.id THEN RAISE EXCEPTION 'FUNDING_DUPLICATE_TRANSFER'; END IF;
      PERFORM funding_post(o,'settle',p_now); PERFORM funding_post(o,'fee',p_now); PERFORM funding_post(o,'network_fee',p_now);
      o.status:='settled'; o.transfer_ref:=ref;
    END IF;
  ELSE RAISE EXCEPTION 'FUNDING_STATE_CONFLICT'; END IF;
  IF NOT p_input ?& expected_fields OR p_input-expected_fields<>'{}'::jsonb THEN RAISE EXCEPTION 'INVALID_FUNDING_INPUT'; END IF;
  UPDATE funding_operations SET status=o.status,transfer_ref=o.transfer_ref,block_ref=o.block_ref,updated_at=greatest(updated_at,p_now)
    WHERE id=o.id RETURNING * INTO o;
  answer:=funding_summary(o);
  INSERT INTO funding_events(event_id,funding_id,input,result,created_at) VALUES(evt,o.id,p_input,answer,p_now);
  RETURN answer;
END; $$;

REVOKE ALL ON funding_operations,funding_cash_postings,funding_member_commands,funding_events,funding_chain_receipts,funding_invalid_blocks FROM PUBLIC;
REVOKE ALL ON FUNCTION funding_summary(funding_operations),funding_post(funding_operations,text,bigint),funding_post_journal(),
  funding_intent(text,text,jsonb,bigint),funding_operator_event(jsonb,bigint),funding_member_history(text) FROM PUBLIC;
