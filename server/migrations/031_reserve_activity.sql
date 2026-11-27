CREATE INDEX reserve_entries_member_history ON reserve_entries(user_id,created_at DESC,id DESC);

CREATE FUNCTION member_reserve_activity(member TEXT,before_ms BIGINT,before_id TEXT,page_size INTEGER)
RETURNS SETOF JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
  SELECT jsonb_build_object('id',e.id,'createdAt',e.created_at,'amountWon',e.amount_won,'direction',e.direction,
    'source',CASE WHEN e.command_id IS NOT NULL THEN 'wallet' ELSE 'card' END)
  FROM reserve_entries e
  WHERE e.user_id=member AND (before_ms IS NULL OR (e.created_at,e.id)<(before_ms,before_id))
  ORDER BY e.created_at DESC,e.id DESC LIMIT least(greatest(page_size,0),26)
$$;
REVOKE ALL ON FUNCTION member_reserve_activity(TEXT,BIGINT,TEXT,INTEGER) FROM PUBLIC;
