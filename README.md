# FixBat

Turns a production error into a brief that says what broke, where, and what
changed near it recently — then posts it to Slack with three buttons.

Runs on Cloudflare Workers + D1. Every integration is optional: whatever you
don't configure stays simulated, so the platform works end to end from the first
deploy and you can wire in real services one at a time.

---

## Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Oreoro/fixbat2)

One click. Cloudflare forks the repo into your account, provisions the D1
database, applies migrations and deploys. Then open the URL it gives you and
press **Claim deployment** — FixBat generates your admin token, shows it once,
and stores only its hash.

From there, **Load demo data** puts realistic incidents in front of you
immediately. No credentials, nothing external contacted.

> The button deploys whatever repository its URL names. If you fork this,
> change `Oreoro/fixbat2` in that URL to your own fork before sharing it.

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

## Checking your credentials

A wrong key looks exactly like an unconfigured one: the provider falls back to
simulated and the deployment goes on reporting healthy. So don't infer it — ask:

```bash
curl -X POST "$URL/admin/verify" -H "authorization: Bearer $ADMIN_TOKEN"
```

Every check is the provider's own identity call — `auth.test` for Slack,
`/user` for GitHub, `myself` for Jira — so the answer is definitive and comes
back in the provider's own words (`401: Bad credentials`). The same thing is a
button on `/setup`. It costs nothing except a single one-token Anthropic call.

Every outbound call has a 10-second deadline and retries twice on 429 or 5xx,
honouring `Retry-After`. Reads retry; anything that creates a ticket or posts to
Slack does not, because a retry after a request that actually landed would file
the issue twice.

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
| `SENTRY_TOKEN` + `_ORG` + `_PROJECT` | bundled sample errors | Sentry, which also tells us which frames are yours |
| `DATADOG_API_KEY` + `_APP_KEY` | bundled sample errors | Datadog error logs |
| `INGEST_TOKEN` | nothing to push to | `POST /ingest` accepts errors you push |
| `GITLAB_TOKEN` / `AZDO_TOKEN` | plausible fake commit history | GitLab or Azure DevOps instead of GitHub |
| `JIRA_*` / `LINEAR_*` | briefs file to the code host | briefs file to Jira or Linear |
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
| `POST /admin/settings` | bearer | Kill switch, daily limit, trace links, log source |
| `POST /incident/:id/file` | session | File the brief as a ticket |
| `POST /incident/:id/dismiss` | session | Record that a brief was not useful |
| `GET /setup/signin` | — | Sign-in form |
| `POST /setup/signout` | — | Clear the session cookie |
| `POST /dev/ingest`, `/dev/reset` | bearer | Aliases kept so older scripts keep working |
| `POST /admin/verify` | bearer | Check every configured credential actually works |
| `POST /ingest` | ingest token | Push errors FixBat cannot reach |

¹ Open to anonymous readers when `PUBLIC_READ=true`.

The remaining `/setup/*` endpoints — claim, demo, services, users, secrets,
kill, ingest, verify — are form actions for the browser pages above rather than
an API to script against. `/admin/*` is the scriptable surface.

---

## What it connects to

Each role is chosen independently, because clients mix them — code on GitHub,
work in Jira, errors in Sentry.

| Role | Supported | Chosen by |
|---|---|---|
| **Log source** | Sentry, Datadog, Elasticsearch, pushed via `POST /ingest`, bundled samples | most specific credentials present; `log_source` pins one explicitly |
| **Code host** | GitHub, GitLab, Azure DevOps | first token present |
| **Issue tracker** | Jira, Linear, GitHub Issues, GitLab Issues, Azure DevOps Work Items | a dedicated tracker wins over the code host's own issues |
| **Runtimes** | JavaScript, Python, JVM, .NET, Ruby, PHP, Go | detected per stack trace |

Anything unconfigured stays simulated, so a client can adopt one at a time.

### Pushing errors instead of being polled

For logs FixBat cannot reach — an internal collector, a custom shipper,
anything behind your own network:

```bash
curl -X POST "$URL/ingest" -H "authorization: Bearer $INGEST_TOKEN" \
  -H 'content-type: application/json' \
  -d '[{"service":"checkout-service","exceptionType":"TypeError",
        "message":"Cannot read properties of undefined",
        "stackTrace":"...","occurredAt":"2026-09-02T10:00:00Z"}]'
```

Up to 100 events per request. Events are kept for seven days after they are
consumed, so a recent window can be replayed by hand, then cleared — the table
does not grow without bound. `INGEST_TOKEN` is deliberately **not** the admin
token: it is distributed to every application that reports errors, so it must
not also grant administration. Events are buffered and drained on the next run,
so nothing at the edge calls the model or costs money.

### Reading the actual code

With a code host token, the brief is written from real source: the failing line
and its surroundings, plus what the recent commits actually changed in that
file. That is the difference between "this commit looks related" and "line 142
reads `summary.total`, but `buildOrderSummary` only sets `total` after this
call". Without a token it degrades to commit subjects rather than inventing
source — the rubric forbids citing anything absent from the evidence.

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

**An incident that was never briefed is retried, not written off.** A repeat is
only a duplicate if the original has a brief *and* was delivered. Anything else
— an error that arrived before its service was registered, one deferred by the
daily cap, one whose delivery failed — is unfinished work, and the next run
completes it. Re-diagnosis is skipped when a brief already exists, so recovery
costs a delivery, never a second model call.

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
default limit of 50 bounds spend at about $5/day. The cap is counted live
against the day's briefs rather than from a figure taken when a run starts, so
a manual ingest overlapping the cron cannot spend it twice.

---

## Tests

```bash
npm run dev      # in one shell
npm test         # in another
```

285 checks over ten suites, all against a real server — no mocks.

`test/audit.py` walks the whole product from an empty deployment — claim, demo,
triage, dedupe, Slack, resolution, guardrails, security headers, audit trail.
`test/users.py` covers multi-administrator access and revocation.
`test/secrets.py` covers credentials entered through the UI.
`test/onboarding.py` covers what a new deployment ships with and whether the
cron uses credentials entered in the browser — the failures a health check
cannot see, because the product stays green while doing nothing real.
`test/trace.py` covers per-request correlation, and reimplements the
fingerprint independently so that folding a trace id into it fails the build.
`test/pipeline.py` covers recovery: incidents that arrived before their service
was registered, ticket lookups past the first 200 incidents, and a filing that
died mid-flight.
`test/languages.py` pushes one real stack trace per runtime through `/ingest`,
each with a framework frame *above* the application frame, so a parser that
took the first readable line would fail all seven.
`test/providers.py` covers which provider is live and why, including that the
issue tracker is chosen independently of the code host.
`test/api.py` is the API contract: every route, the credentials it demands, the
codes it returns and how it answers something malformed.
`test/slack.py` asserts against the blocks Slack actually receives — the link
back to the incident, the trace id, and that file and ticket links follow the
client's own host rather than assuming GitHub.

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

One thing to keep true:

- **The Deploy button points at `Oreoro/fixbat2`.** That repository has to stay
  public for the button to work — Cloudflare reads it as an anonymous visitor.
  Anyone forking this must repoint that URL at their own fork first, or they
  will be handing their clients somebody else's code.

---

## Deliberately absent

No Durable Objects (D1 unique constraints handle dedupe and click idempotency),
no Workflows (the pipeline is short enough to read as a function), no confidence
score, no verification gate, no PR drafting, no auto-filing. Each was considered
and cut.
