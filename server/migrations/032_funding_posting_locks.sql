CREATE OR REPLACE FUNCTION funding_post(o funding_operations,phase text,now_ms bigint) RETURNS void LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
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
  -- The plan and journal both reference these accounts. Acquire the balances in
  -- the shared ledger order before either FK can acquire a weaker KEY SHARE lock.
  PERFORM id FROM ledger_accounts WHERE id IN (source_id,target_id) ORDER BY id FOR UPDATE;
  INSERT INTO funding_cash_postings(funding_id,phase,from_id,to_id,amount_won) VALUES(o.id,phase,source_id,target_id,amount) RETURNING id INTO plan_id;
  INSERT INTO journals(id,kind,from_account_id,to_account_id,amount_won,sender_id,recipient_id,sender_name,sender_tag,recipient_name,recipient_tag,
    request_owner_id,idempotency_key,request_payload,balance_after_won,created_at)
  VALUES(plan_id::text,'coin_funding',source_id,target_id,amount,o.user_id,o.user_id,'코인 입출금','sandbox-funding','코인 입출금','sandbox-funding',
    o.user_id,'$funding:'||plan_id::text,phase,0,now_ms);
END; $$;
