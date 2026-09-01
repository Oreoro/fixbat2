# FixBat

Turns a production error into a brief that says what broke, where, and what
changed near it recently — then posts it to Slack with three buttons.

Runs on Cloudflare Workers + D1. Every integration is optional: whatever you
don't configure stays simulated, so the platform works end to end from the first
deploy and you can wire in real services one at a time.

---

## Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/YOUR-ORG/fixbat)

One click. Cloudflare forks the repo into your account, provisions the D1
database, applies migrations and deploys. Then open the URL it gives you and
press **Claim deployment** — FixBat generates your admin token, shows it once,
and stores only its hash.

From there, **Load demo data** puts realistic incidents in front of you
immediately. No credentials, nothing external contacted.

> Replace `YOUR-ORG/fixbat` in the button URL with your fork.

**Claim it promptly.** Between deploy and claim the deployment has no
administrator, so whoever opens the URL first becomes one. Deploying from CI?
Set `ADMIN_TOKEN` as a Worker secret and the claim step is skipped entirely — an
explicit secret always wins.

### Or from a terminal

```bash
git clone <your-fork> fixbat && cd fixbat
npm install
npm run setup
```

`npm run setup` is interactive and idempotent. It signs you in to Cloudflare,
creates the D1 database, runs migrations, generates an `ADMIN_TOKEN`, prompts
for whichever integrations you want to be real, registers your services, deploys
and verifies the result. Re-run it any time — nothing is dropped.

Verify the environment first without changing anything:

```bash
npm run setup -- --check
```

The Worker and its database are both called `fixbat`. To deploy against a
database that already exists under another name, set it once:

```bash
FIXBAT_DB_NAME=my-existing-db npm run setup
```

When setup finishes you get a URL that already works, using bundled sample
errors, and the `ADMIN_TOKEN` printed once. Open `/setup` on that URL, sign in
with the token, and finish onboarding in the browser — registering services,
checking which integrations are live and running the first pipeline pass all
happen there. No curl required.

### Local development

```bash
cp .env.example .dev.vars     # optional — every value can stay blank
npm run db:local              # apply migrations to the local database
npm run dev                   # http://localhost:8787
```

Then open http://localhost:8787 and claim it — that is the same first run a
client gets. To drive it from a terminal instead, set `ADMIN_TOKEN` in
`.dev.vars` and pass it; every admin route requires it:

```bash
curl -X POST localhost:8787/admin/ingest -H "authorization: Bearer $ADMIN_TOKEN"
```

### Docker

FixBat deploys to Cloudflare's edge, so Docker is for a reproducible local and
CI environment, not production hosting. The image runs the same `workerd`
runtime wrangler uses.

```bash
docker compose up --build     # http://localhost:8787
```

`.dev.vars` is picked up automatically if it exists, and the local database
survives rebuilds in a named volume. Migrations are applied on start, so a
first run against the empty volume comes up with a working schema rather than
500ing on every route.

---

## Configuration

**Nothing is required.** FixBat runs entirely on bundled sample data until you
connect something.

Credentials can be added two ways, and the app tells you which is in use:

1. **From the UI** — `/setup` → *Connect your tools*. Values are encrypted with
   AES-GCM before storage. Suits a one-click deployment with no terminal.
2. **As Worker secrets** — `npx wrangler secret put ANTHROPIC_API_KEY`. Stronger,
   and **always takes precedence** over anything stored through the UI, so you
   can start in the browser and move a credential later without changing
   anything else.

> On the UI option: the encryption key lives in the same database as the
> ciphertext. That protects against database exports, dashboard browsing and log
> leakage — **not** against someone who already has full read access to your D1.
> Use Worker secrets where that distinction matters.

If a credential is wrong, the setup page says so — the pipeline surfaces the
provider's own error (`401 authentication_error: API key is invalid`) rather
than failing quietly.

| Secret | Without it | With it |
|---|---|---|
| `ADMIN_TOKEN` | deployment must be claimed in the browser (one-click path) | explicit secret for CI; skips the claim step |
| `ANTHROPIC_API_KEY` | canned briefs keyed to sample errors | real briefs from Claude |
| `SLACK_BOT_TOKEN` | briefs stored, not posted | briefs posted to each service's channel |
| `SLACK_SIGNING_SECRET` | buttons return 503 | buttons work |
| `GITHUB_TOKEN` | plausible fake commit history | real commits, real issues |
| `ELASTICSEARCH_URL` + `_API_KEY` | bundled sample errors | your live logs |
| `PUBLIC_READ` | UI requires sign-in (default) | incident data readable anonymously |

Repos and Slack channels are per-service, not global:

```bash
curl -X POST "$URL/admin/services" \
  -H "authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"name":"checkout-service","repo":"acme/checkout",
       "slack_channel":"#incidents-checkout","team":"Checkout"}'
```

---

## Administration

The admin secret comes from one of two places:

- **`ADMIN_TOKEN` as a Worker secret** — set it and it always wins. Use this for
  CI and scripted installs.
- **Claimed at first run** — a deploy button cannot set a secret, so an
  unclaimed deployment sends every admin route to `/setup/claim`. Claiming
  generates a token, shows it once, and stores only its SHA-256. The claim is
  atomic and one-time; a second attempt is rejected and audited.

Either way, two ways to authenticate:

- **`Authorization: Bearer <token>`** for scripts and CI.
- **A session cookie** for the browser. `/setup/signin` exchanges the token for
  a cookie holding an HMAC of it plus an expiry — never the token itself, so a
  stolen cookie expires and cannot be replayed against the API. `HttpOnly`,
  `SameSite=Strict`, `Secure` over HTTPS, 12-hour lifetime.

Rotating the secret invalidates every existing session:

```bash
npx wrangler secret put ADMIN_TOKEN
```

### People

Each administrator has their own token. The audit trail records **who** did
something rather than which IP it came from, and access can be revoked for one
person without rotating anything for anyone else.

- The first person to claim a deployment becomes its **owner**.
- Owners and admins can add more people from `/setup`; each new token is shown
  once and stored only as a SHA-256.
- Disabling someone invalidates their token and their session immediately, but
  keeps their name in the audit trail so past actions stay readable.
- The last active owner cannot be disabled — that would leave the deployment
  unadministerable.
- `ADMIN_TOKEN` remains valid for CI and is attributed to a reserved identity
  rather than a person.

### Visibility

Incident briefs contain production stack traces, internal file paths, repo names
and team ownership, so **the UI requires a sign-in by default**. `/health`, the
static assets, the Slack webhook and the sign-in/claim pages stay open.

Recording whether a cause was right always requires a session — that signal is
the product's precision metric and must not be writable anonymously.

Set `PUBLIC_READ=true` to opt a deployment into anonymous read access.

## Routes

| Route | Auth | What it does |
|---|---|---|
| `GET /` | session¹ | Incident list — triage view |
| `GET /incident/:id` | session¹ | Brief, evidence, timeline, stack trace |
| `GET /metrics` | session¹ | Hit rate, adoption, volume and cost |
| `GET /services` | session¹ | Registry and control state |
| `GET /health` | public | Provider status, today's brief count |
| `GET /setup` | session | Browser onboarding — services, integrations, run/pause |
| `POST /setup/signin` | — | Exchange the admin token for a session cookie |
| `GET /setup/claim` | unclaimed only | First-run claim for one-click installs |
| `GET /preview/:id` | session¹ | Block Kit JSON + Block Kit Builder link |
| `POST /incident/:id/resolve` | session | Record whether the cause was right |
| `POST /slack/actions` | signature | Slack button handler |
| `POST /admin/ingest` | bearer | Run the pipeline |
| `POST /admin/reset` | bearer | Clear all incident data |
| `POST /admin/services` | bearer | Add or update a service |
| `POST /admin/settings` | bearer | Kill switch, daily limit |

¹ Open to anonymous readers when `PUBLIC_READ=true`.

---

## How it works

`src/pipeline.ts` is the whole flow, top to bottom:

```
fetch events → fingerprint → dedupe → gather evidence
             → diagnose → store brief → post to Slack
```

Four gates run in cost order, so nothing expensive runs unprotected:

| Gate | Rejects | Cost |
|---|---|---|
| Kill switch | everything, when set | one row read |
| Service registry | unmapped services | one row read |
| Fingerprint dedupe | repeats → bumps `occurrences` | one hash + upsert |
| Daily limit | briefs past the cap → retried later | one count |

**Dedupe is the guardrail that is not optional.** The fingerprint is
`sha256(service + environment + exception type + first application stack frame)`,
with the line number dropped so an edit above the fault does not mint a new
incident. Without it one bad deploy floods the channel.

**The trace id is stored beside the fingerprint, never inside it.** They answer
different questions: the fingerprint asks *which bug is this*, a trace id asks
*what else happened in the request this fired in*. A trace id is unique per
request, so hashing one into the fingerprint would give every occurrence its own
identity and destroy dedupe entirely — the flood the fingerprint exists to
prevent. FixBat reads `trace.id` (falling back to `transaction.id`) from the log
source, keeps the most recent one per incident, and shows it on the incident
page. `test/trace.py` holds that separation in place.

**The cursor advances only after a successful fetch.** If the log source throws,
the window is retried rather than skipped — advancing over a failed window would
skip it permanently and silently.

**The model gets no tools.** Evidence is assembled deterministically before the
call; the model receives a fixed packet and returns typed JSON.

**Briefs post as drafted.** There is no verification gate. If one is ever wanted
it goes in `pipeline.ts` between the brief being written and anyone seeing it —
the comment marks the spot.

---

## Measurement

Two signals, deliberately separate:

- **Adoption** — filing an issue says a brief was worth acting on.
- **Correctness** — `cause_confirmed` / `cause_wrong`, recorded on the incident
  page when the incident is actually resolved.

Precision is computed over resolved incidents only. An untouched brief is
`unknown`, never counted as correct, and the unresolved count sits next to the
rate rather than hidden inside it. With nothing resolved the page shows a dash,
not a zero.

---

## Frontend

Built from Cloudflare's [Kumo](https://github.com/cloudflare/kumo) component
library — `Badge`, `Breadcrumbs`, `Button`, `ClipboardText`, `CloudflareLogo`,
`Collapsible`, `Empty`, `Grid`, `Input`, `LayerCard`, `Link`, `Meter`, `Surface`,
`Table`, `Text`, `Toolbar`.

Kumo is React on Base UI, so pages are React rendered to a string in the Worker.
Only two interactive islands hydrate (the fingerprint copy field and the stack
trace disclosure); everything else is static HTML that works with JS disabled.

`npm run build` compiles the stylesheet and the island bundle; it runs
automatically before `dev` and `deploy`.

Three things that are easy to get wrong when working on this:

- The Tailwind `@source` list **must include Kumo's dist**, or the library's own
  component classes are never emitted and every Badge renders unstyled.
- `text-kumo-base` is a **surface** token, not a text colour. Text tokens are
  `text-kumo-default`, `text-kumo-strong`, `text-kumo-subtle`.
- Kumo's theme is driven entirely by `data-mode` and has no
  `prefers-color-scheme` rules, so a one-line inline script stamps it from the
  OS preference before first paint.

`npx @cloudflare/kumo doc <Component>` prints the API for any component.

---

## Database

Migrations live in `migrations/` and are **additive only** — they run against
live data on every deploy, so nothing may drop or rewrite a table.

```bash
npm run db:local          # apply to the local database
npm run db:remote         # apply to production
npm run db:reset:local    # wipe and re-apply locally
```

To change the schema, add a new numbered file. Never edit an applied one.

`wrangler.jsonc` deliberately carries **no `database_id`**. It is optional in
wrangler's schema and it names one database in one Cloudflare account, so a
committed one would point every client's deployment at somebody else's data.
The Deploy button provisions a database and writes it; `npm run setup` does the
same from a terminal.

---

## Operations

```bash
# Pause everything
curl -X POST "$URL/admin/settings" -H "authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"kill_switch":true,"kill_switch_reason":"tuning the rubric"}'

# Change the daily spend ceiling
curl -X POST "$URL/admin/settings" -H "authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' -d '{"daily_brief_limit":25}'

# Make trace ids clickable — {traceId} is substituted per incident.
# Without this the id is shown as copyable text and nothing more.
curl -X POST "$URL/admin/settings" -H "authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"trace_url_template":"https://kibana.example.com/app/apm/traces/{traceId}"}'
```

The cron runs every 5 minutes. Cost is roughly $0.10 per brief on Opus 5, so the
default limit of 50 bounds spend at about $5/day.

---

## Tests

```bash
npm run dev      # in one shell
npm test         # in another
```

116 checks over five suites, all against a real server — no mocks.

`test/audit.py` walks the whole product from an empty deployment — claim, demo,
triage, dedupe, Slack, resolution, guardrails, security headers, audit trail.
`test/users.py` covers multi-administrator access and revocation.
`test/secrets.py` covers credentials entered through the UI.
`test/onboarding.py` covers what a new deployment ships with and whether the
cron uses credentials entered in the browser — the failures a health check
cannot see, because the product stays green while doing nothing real.
`test/trace.py` covers per-request correlation, and reimplements the
fingerprint independently so that folding a trace id into it fails the build.

`npm run dev` passes `--test-scheduled`, which is what lets the suite trigger
the cron on demand at `/__scheduled`. The tests read the database name from
`wrangler.jsonc` and locate the repo from their own path, so they run from
anywhere; set `FIXBAT_URL` to point them at a deployment instead of localhost.

## Onboarding a client

Each client runs their **own deployment** — their own Worker, their own D1,
their own admin tokens. Nothing is shared between clients and we hold none of
their data. Onboarding is therefore: give them the repo, and let the product
walk them through the rest.

1. **Send them the Deploy button** (or the repo, for `npm run setup`). They need
   a Cloudflare account and nothing else.
2. **They claim it.** The first person to open the URL becomes the owner and
   gets a token, shown once. Tell them to do this immediately — until it is
   claimed, whoever opens it first becomes the owner.
3. **They connect what they have**, from `/setup` → *Connect your tools*. Every
   integration is independent and optional; anything they skip stays simulated
   and the product still works end to end.
4. **They register their services.** FixBat only diagnoses a service listed in
   the registry, because an unmapped service has no repository to correlate
   against. Unmapped errors are recorded, not silently dropped.
5. **They clear the demo data** once their own incidents are flowing.

What to check with them afterwards:

- `/health` names each provider as live or simulated. If they expected a real
  provider and see a simulated one, the credential did not take.
- `/setup` shows recent pipeline failures. A wrong credential surfaces there
  first — including a log source that cannot be reached, which is the most
  common thing to get wrong.
- The cron runs every 5 minutes. At roughly $0.10 per brief on Opus 5, the
  default cap of 50 bounds their spend at about $5/day; agree a number with
  them and set it from `/setup`.

### Publishing this for your clients

Two things to settle before the first client:

- **The Deploy button URL contains `YOUR-ORG/fixbat`.** Replace it with your own
  public repository — the button deploys whatever repository the URL names, so a
  stale placeholder either 404s or, worse, deploys something that is not yours.
- **There is no `LICENSE` file.** Clients run this code in their own Cloudflare
  account, which means copying and modifying it; with no licence they have no
  stated right to do so. Which licence is a commercial decision, not a technical
  one — pick it, then add the file. MIT if you want clients to fork freely; a
  proprietary licence granting customer use if it is a paid product.

---

## Deliberately absent

No Durable Objects (D1 unique constraints handle dedupe and click idempotency),
no Workflows (the pipeline is short enough to read as a function), no confidence
score, no verification gate, no PR drafting, no auto-filing. Each was considered
and cut.
