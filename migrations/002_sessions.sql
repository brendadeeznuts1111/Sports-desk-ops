-- migrations/002_sessions.sql
-- No BEGIN/COMMIT here — scripts/migrate.ts wraps each migration file in sql.begin.

-- Raw tokens are never stored: only their SHA-256 hex.
-- ON DELETE CASCADE removes sessions when an operator is hard-deleted;
-- the `disabled` flag is soft, so sessionVerify also JOINs operators.disabled.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT        PRIMARY KEY,
  operator_id  BIGINT      NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip           TEXT,
  user_agent   TEXT
);

-- Lookups: by operator (revoke-all / admin views).
CREATE INDEX IF NOT EXISTS sessions_operator_id_idx ON sessions (operator_id);
-- Cleanup sweeps: by expiry.
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at);
-- Idle sweeps: partial index; only rows that can be idle-stale.
CREATE INDEX IF NOT EXISTS sessions_last_seen_idx ON sessions (last_seen_at);
