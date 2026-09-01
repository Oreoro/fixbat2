-- 0005 — integration credentials entered through the UI.
--
-- A deploy button cannot run `wrangler secret put`, so a client who never opens
-- a terminal needs somewhere to put an API key. These are encrypted with
-- AES-GCM before storage.
--
-- Honest limitation: the key lives in this same database (deployment.key_material).
-- That protects against database exports, dashboard browsing and log leakage —
-- not against someone who already has full read access to your D1. Worker
-- secrets set with `wrangler secret put` remain available and take precedence.
--
-- Additive only.

CREATE TABLE IF NOT EXISTS integration_secrets (
  name       TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  iv         TEXT NOT NULL,
  hint       TEXT NOT NULL DEFAULT '',
  updated_by TEXT,
  updated_at TEXT NOT NULL
);

ALTER TABLE deployment ADD COLUMN key_material TEXT;
