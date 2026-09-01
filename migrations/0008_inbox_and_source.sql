-- 0008 — pushed events, and an explicit choice of log source.
--
-- Every source so far has been polled. A client whose errors live somewhere
-- FixBat cannot reach — an internal collector, a custom shipper, anything
-- behind their own network — needs to push instead. Events land here and the
-- `http` source drains them, so the pipeline is identical either way.
--
-- The cursor for this source is the last consumed row id, which is why the key
-- is a monotonic INTEGER rather than a uuid.
--
-- Additive only.

CREATE TABLE IF NOT EXISTS inbox (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at  TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_inbox_received ON inbox(received_at);

-- Which source the pipeline reads. 'auto' picks the first one whose credentials
-- are configured, in the order documented in providers/logs.ts, and falls back
-- to the bundled samples. An explicit value pins it, so a client with several
-- configured is never guessing which one is live.
ALTER TABLE settings ADD COLUMN log_source TEXT NOT NULL DEFAULT 'auto';
