-- 0009 — the deployment's own address.
--
-- A brief posted to Slack had no way back to FixBat. That matters more than it
-- sounds: recording whether the cause was right — the product's precision
-- metric — happens on the incident page, and nothing in the message pointed
-- there. The pipeline runs from cron with no request to derive an origin from,
-- so it has to be stored.
--
-- Additive only.

ALTER TABLE settings ADD COLUMN base_url TEXT NOT NULL DEFAULT '';
