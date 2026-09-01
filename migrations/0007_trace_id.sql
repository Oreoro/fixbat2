-- 0007 — per-request correlation.
--
-- The fingerprint answers "which bug is this, and is it new". It deliberately
-- strips everything volatile — the line number, the timestamp, digits and UUIDs
-- in the message — so that repeated occurrences collapse into one incident.
--
-- That is the wrong axis for "what else happened in the request that produced
-- this". A trace id answers that, and it is the most volatile field there is:
-- putting it anywhere near the fingerprint would give every occurrence a unique
-- identity and defeat dedupe entirely. So it is stored alongside, never hashed.
--
-- Nullable on purpose: not every log source emits one, and every incident
-- recorded before this migration has none.
--
-- Additive only.

ALTER TABLE incidents ADD COLUMN trace_id TEXT;

CREATE INDEX IF NOT EXISTS idx_incidents_trace ON incidents(trace_id);

-- Where to send someone who clicks a trace id. Different clients run different
-- APMs, so the link is a template with a {traceId} placeholder rather than a
-- hardcoded vendor URL, e.g.
--   https://kibana.example.com/app/apm/traces/{traceId}
-- Empty means the id is shown as copyable text and nothing more.
ALTER TABLE settings ADD COLUMN trace_url_template TEXT NOT NULL DEFAULT '';
