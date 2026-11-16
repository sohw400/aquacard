CREATE TABLE auth_sessions (
  token_hash TEXT PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL CHECK (created_at BETWEEN 0 AND 8640000000000000),
  expires_at BIGINT NOT NULL CHECK (expires_at > created_at AND expires_at <= 8640000000000000)
);
CREATE INDEX auth_sessions_user ON auth_sessions(user_id);
CREATE INDEX auth_sessions_expiry ON auth_sessions(expires_at);

CREATE TABLE auth_recovery (
  token_hash TEXT PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL CHECK (created_at BETWEEN 0 AND 8640000000000000),
  expires_at BIGINT NOT NULL CHECK (expires_at > created_at AND expires_at <= 8640000000000000),
  used_at BIGINT CHECK (used_at IS NULL OR (used_at >= created_at AND used_at < expires_at))
);
CREATE INDEX auth_recovery_user ON auth_recovery(user_id);
CREATE INDEX auth_recovery_expiry ON auth_recovery(expires_at);

CREATE TABLE auth_rate_limits (
  scope TEXT NOT NULL CHECK (length(scope) BETWEEN 1 AND 48),
  key_hash TEXT NOT NULL CHECK (key_hash ~ '^[a-f0-9]{64}$'),
  -- Zero is only the uncommitted UPSERT seed; the same transaction increments it.
  attempts INTEGER NOT NULL CHECK (attempts >= 0),
  expires_at BIGINT NOT NULL CHECK (expires_at BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (scope, key_hash)
);
CREATE INDEX auth_rate_expiry ON auth_rate_limits(expires_at);
