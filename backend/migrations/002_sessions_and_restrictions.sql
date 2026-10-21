-- ============================================================
-- Migracion 002: sesiones server-side + restriccion por ubicacion
-- ============================================================

-- Restriccion operativa por ubicacion habitual
ALTER TABLE users ADD COLUMN IF NOT EXISTS restrict_to_location boolean NOT NULL DEFAULT false;

-- Sesiones activas (logout real, control de conectados, cierre por inactividad)
CREATE TABLE IF NOT EXISTS sessions (
  id             varchar(64) PRIMARY KEY,
  user_id        integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip             varchar(60),
  user_agent     varchar(255),
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  revoked_reason varchar(80)
);
CREATE INDEX IF NOT EXISTS idx_sessions_user   ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(revoked_at, expires_at);
