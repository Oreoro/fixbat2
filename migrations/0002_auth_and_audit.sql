-- 0002 — sign-in throttling and admin attribution.
--
-- Additive only.

-- Failed sign-in attempts, so ADMIN_TOKEN cannot be brute-forced. One row per
-- client, cleared on success and expired by the lockout window.
CREATE TABLE IF NOT EXISTS auth_attempts (
  client_id    TEXT PRIMARY KEY,
  failures     INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0),
  first_failed TEXT NOT NULL,
  last_failed  TEXT NOT NULL
);

-- Who performed an admin action. Nullable so existing rows stay valid.
ALTER TABLE events ADD COLUMN actor TEXT;

-- Marks data seeded by the demo loader so it can be cleared again without
-- touching anything real the client has since added.
ALTER TABLE incidents ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0;
ALTER TABLE services  ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_incidents_demo ON incidents(is_demo);
