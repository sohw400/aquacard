-- Public session identifiers are independent of the bearer secret and its hash.
-- Existing logins stay valid but must verify their password before remote revocation.
ALTER TABLE auth_sessions
  ADD COLUMN session_id UUID NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN device_label TEXT NOT NULL DEFAULT '알 수 없는 기기',
  ADD COLUMN last_seen_at BIGINT,
  ADD COLUMN reauthenticated_at BIGINT;

UPDATE auth_sessions SET last_seen_at = created_at;

ALTER TABLE auth_sessions
  ALTER COLUMN last_seen_at SET NOT NULL,
  ADD CONSTRAINT auth_sessions_public_id_unique UNIQUE (session_id),
  ADD CONSTRAINT auth_sessions_device_label CHECK (
    device_label ~ '^(iPhone|iPad|Android|Windows|Mac|Linux|알 수 없는 기기)( · (Safari|Chrome|Firefox|Edge|Samsung Internet))?$'
  ),
  ADD CONSTRAINT auth_sessions_last_seen CHECK (last_seen_at >= created_at AND last_seen_at < expires_at),
  ADD CONSTRAINT auth_sessions_reauthenticated CHECK (
    reauthenticated_at IS NULL OR (reauthenticated_at >= created_at AND reauthenticated_at < expires_at)
  );

CREATE INDEX auth_sessions_user_recent ON auth_sessions(user_id, last_seen_at DESC, session_id);

-- The API exposes at most twenty devices. Revoke older legacy sessions during
-- cutover so no usable bearer can remain hidden outside that management list.
DELETE FROM auth_sessions WHERE token_hash IN (
  SELECT token_hash FROM (
    SELECT token_hash, row_number() OVER (PARTITION BY user_id ORDER BY created_at DESC, session_id DESC) AS position
    FROM auth_sessions
  ) ranked WHERE position > 20
);
