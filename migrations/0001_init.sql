-- 0001_init.sql — initial schema.
--
-- Additive only. Migrations run against live data on every deploy, so nothing
-- here may drop or rewrite a table. Add a new numbered file for later changes.

-- Which services we diagnose, and where their briefs go. An error from a
-- service with no row here has no repo to correlate against, so it is recorded
-- as unmapped rather than diagnosed.
CREATE TABLE IF NOT EXISTS services (
  name          TEXT PRIMARY KEY,
  repo          TEXT NOT NULL,
  slack_channel TEXT NOT NULL,
  team          TEXT NOT NULL DEFAULT '',
  enabled       INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- Single row. The kill switch and the daily cap are the two controls that stop
-- a misfiring cursor from costing money or flooding a channel.
CREATE TABLE IF NOT EXISTS settings (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  kill_switch        INTEGER NOT NULL DEFAULT 0 CHECK (kill_switch IN (0, 1)),
  kill_switch_reason TEXT NOT NULL DEFAULT '',
  daily_brief_limit  INTEGER NOT NULL DEFAULT 50 CHECK (daily_brief_limit >= 0),
  updated_at         TEXT NOT NULL
);

-- Where each log source last read to. Advanced only after a successful fetch:
-- an advanced cursor over a failed window skips it permanently and silently,
-- which is the most damaging failure this pipeline has available to it.
CREATE TABLE IF NOT EXISTS cursors (
  source     TEXT PRIMARY KEY,
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS incidents (
  id             TEXT PRIMARY KEY,
  fingerprint    TEXT NOT NULL UNIQUE,
  service        TEXT NOT NULL,
  environment    TEXT NOT NULL DEFAULT 'production',
  severity       TEXT NOT NULL CHECK (severity IN ('critical','high','medium','low')),
  exception_type TEXT NOT NULL,
  message        TEXT NOT NULL,
  stack_trace    TEXT NOT NULL,
  version        TEXT NOT NULL DEFAULT '',
  occurrences    INTEGER NOT NULL DEFAULT 1 CHECK (occurrences > 0),
  first_seen     TEXT NOT NULL,
  last_seen      TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('new','briefed','posted','filed','dismissed','unmapped')),
  slack_channel  TEXT,
  slack_ts       TEXT,

  -- Correctness, tracked separately from usefulness. `filed` says the brief was
  -- worth acting on; only these say the diagnosis was right.
  resolution     TEXT CHECK (resolution IS NULL OR resolution IN ('cause_confirmed','cause_wrong')),
  resolved_at    TEXT,
  resolved_by    TEXT,

  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS briefs (
  id              TEXT PRIMARY KEY,
  incident_id     TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  summary         TEXT NOT NULL,
  suspected_cause TEXT NOT NULL,
  what_changed    TEXT NOT NULL,
  open_questions  TEXT NOT NULL DEFAULT '[]',
  cited_file      TEXT,
  cited_line      INTEGER,
  cited_commits   TEXT NOT NULL DEFAULT '[]',
  source          TEXT NOT NULL,
  model           TEXT NOT NULL DEFAULT '',
  spend_usd       REAL NOT NULL DEFAULT 0,
  duration_ms     INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  UNIQUE (incident_id)
);

CREATE TABLE IF NOT EXISTS tickets (
  id          TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  provider    TEXT NOT NULL DEFAULT 'github',
  external_id TEXT NOT NULL,
  url         TEXT NOT NULL,
  created_by  TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  UNIQUE (incident_id)
);

CREATE TABLE IF NOT EXISTS dispositions (
  id            TEXT PRIMARY KEY,
  incident_id   TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('filed','not_helpful','cost_me_time')),
  slack_user_id TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id TEXT,
  kind        TEXT NOT NULL,
  detail      TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_incidents_last_seen  ON incidents(last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_incidents_status     ON incidents(status);
CREATE INDEX IF NOT EXISTS idx_incidents_service    ON incidents(service);
CREATE INDEX IF NOT EXISTS idx_incidents_resolution ON incidents(resolution);
CREATE INDEX IF NOT EXISTS idx_events_incident      ON events(incident_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_dispositions_inc     ON dispositions(incident_id);
CREATE INDEX IF NOT EXISTS idx_briefs_created       ON briefs(created_at);

INSERT OR IGNORE INTO settings (id, kill_switch, daily_brief_limit, updated_at)
VALUES (1, 0, 50, datetime('now'));

INSERT OR IGNORE INTO services (name, repo, slack_channel, team, enabled, created_at, updated_at) VALUES
  ('checkout-service',  'acme/checkout-service',  '#incidents-checkout',  'Checkout',  1, datetime('now'), datetime('now')),
  ('payments-api',      'acme/payments-api',      '#incidents-payments',  'Payments',  1, datetime('now'), datetime('now')),
  ('inventory-worker',  'acme/inventory-worker',  '#incidents-inventory', 'Inventory', 1, datetime('now'), datetime('now'));
