-- 0003 — deployment identity, so a one-click install can be claimed without a
-- terminal.
--
-- A deploy button cannot run `wrangler secret put`, so a fresh deployment has
-- no ADMIN_TOKEN. The first person to open it claims it: the app generates a
-- token, shows it once, and stores only its SHA-256 here.
--
-- Additive only.

CREATE TABLE IF NOT EXISTS deployment (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  token_hash TEXT,
  claimed_at TEXT,
  claimed_by TEXT
);

INSERT OR IGNORE INTO deployment (id, token_hash, claimed_at, claimed_by)
VALUES (1, NULL, NULL, NULL);
