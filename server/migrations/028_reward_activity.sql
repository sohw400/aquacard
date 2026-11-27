-- Keep the existing snapshot contract for older clients. Dashboard polling can skip journal rows.

CREATE FUNCTION member_reward_summary(p_user_id TEXT,p_now BIGINT) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE w reward_wallets%ROWTYPE; m reward_cashback_months%ROWTYPE; month_key TEXT; active BOOLEAN;
BEGIN
  IF p_now IS NULL OR p_now<0 OR p_now>8639999967600000 THEN RAISE EXCEPTION 'INVALID_REWARD_COMMAND' USING ERRCODE='22023'; END IF;
  SELECT * INTO w FROM reward_wallets WHERE user_id=p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'USER_NOT_FOUND'; END IF;
  month_key:=to_char(to_timestamp(p_now::double precision/1000) AT TIME ZONE 'Asia/Seoul','YYYY-MM');
  SELECT * INTO m FROM reward_cashback_months WHERE user_id=p_user_id AND month=month_key;
  SELECT enabled INTO active FROM reward_program WHERE singleton;
  RETURN jsonb_build_object('availableWon',w.available_won,'heldWon',w.held_won,'adjustmentDueWon',w.adjustment_due_won,
    'useFirst',w.use_first,'preferenceVersion',w.preference_version,'programActive',active,
    'policy',jsonb_build_object('version','standard-v1','rateBps',100,'monthlyCapWon',10000),
    'cashback',jsonb_build_object('month',month_key,'confirmedWon',COALESCE(m.awarded_won-m.reversed_won,0),
      'pendingWon',COALESCE(m.reserved_won,0),'reversedWon',COALESCE(m.reversed_won,0),
      'remainingWon',10000-COALESCE(m.reserved_won+m.awarded_won-m.reversed_won,0)), 'history','[]'::jsonb);
END;
$$;

CREATE FUNCTION member_reward_activity(member TEXT, before_ms BIGINT, before_id TEXT, page_size INTEGER)
RETURNS SETOF JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
  SELECT jsonb_build_object('id',j.id,'kind',j.kind,'amountWon',j.amount_won,'paymentId',j.payment_id,
    'createdAt',j.created_at,'availableDeltaWon',j.available_delta_won,'heldDeltaWon',j.held_delta_won,'adjustmentDeltaWon',j.adjustment_delta_won)
    || CASE WHEN p.reward_command_id IS NULL THEN '{}'::jsonb ELSE '{"origin":"reserve"}'::jsonb END
  FROM reward_journals j LEFT JOIN reserve_reward_payouts p ON j.kind='grant' AND p.user_id=j.user_id AND p.reward_command_id=j.command_id
  WHERE j.user_id=member AND (before_ms IS NULL OR (j.created_at,j.id)<(before_ms,before_id))
  ORDER BY j.created_at DESC,j.id DESC LIMIT least(greatest(page_size,0),26)
$$;
REVOKE ALL ON FUNCTION member_reward_summary(TEXT,BIGINT), member_reward_activity(TEXT,BIGINT,TEXT,INTEGER) FROM PUBLIC;
