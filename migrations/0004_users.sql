-- 0004 — named administrators.
--
-- Replaces the single shared token with per-person tokens, so the audit trail
-- records who did something rather than which IP it came from. The ADMIN_TOKEN
-- secret still works and is attributed to a reserved "ci" identity.
--
-- Additive only.

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  token_hash  TEXT NOT NULL UNIQUE,
  role        TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('owner','admin')),
  disabled    INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
  created_by  TEXT,
  created_at  TEXT NOT NULL,
  last_seen_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_users_active ON users(disabled);
