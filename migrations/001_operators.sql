-- migrations/001_operators.sql
-- No BEGIN/COMMIT here — scripts/migrate.ts wraps each migration file in sql.begin.

CREATE TABLE IF NOT EXISTS operators (
  id              BIGSERIAL PRIMARY KEY,
  username        TEXT        NOT NULL,
  role            TEXT        NOT NULL DEFAULT 'viewer'
                              CHECK (role IN ('admin', 'operator', 'viewer')),
  password_hash   TEXT        NOT NULL,
  disabled        BOOLEAN     NOT NULL DEFAULT FALSE,
  failed_attempts INTEGER     NOT NULL DEFAULT 0,
  locked_until    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at   TIMESTAMPTZ
);

-- Case-insensitive uniqueness without the citext extension.
CREATE UNIQUE INDEX IF NOT EXISTS operators_username_lower_uq
  ON operators (LOWER(username));

-- Reserved: DB-backed username lockout (covers distributed attacks that
-- the in-process IP limiter cannot see). Application logic lands in a follow-up;
-- the columns are here so no second migration is needed.
CREATE INDEX IF NOT EXISTS operators_locked_until_idx
  ON operators (locked_until)
  WHERE locked_until IS NOT NULL;
