-- 0006 — mark the bundled sample services as demo data.
--
-- 0001 seeds checkout-service, payments-api and inventory-worker so a new
-- deployment shows something working before anything is connected. It inserted
-- them before `is_demo` existed (added in 0002), so they defaulted to 0 and
-- every deployment has been carrying three fabricated services indistinguishable
-- from ones the client registered themselves.
--
-- That mattered for three reasons:
--   • "Clear demo data" deletes WHERE is_demo = 1, so it could never remove them
--     and seedDemoServices' ON CONFLICT DO NOTHING could never upgrade them;
--   • the services page listed three services the client had never added;
--   • with a live GitHub and Slack token, a real error from a service that
--     happens to be called `checkout-service` would be correlated against
--     acme/checkout-service — a repository the client does not own — posted to
--     #incidents-checkout, and "File issue" would try to open an issue there.
--
-- Only rows still identical to what 0001 wrote are touched, so a client who has
-- repointed one of these names at their own repo keeps it as a real service.
--
-- Additive only.

UPDATE services
   SET is_demo = 1
 WHERE is_demo = 0
   AND (name, repo, slack_channel) IN (
     VALUES
       ('checkout-service', 'acme/checkout-service',  '#incidents-checkout'),
       ('payments-api',     'acme/payments-api',      '#incidents-payments'),
       ('inventory-worker', 'acme/inventory-worker',  '#incidents-inventory')
   );
