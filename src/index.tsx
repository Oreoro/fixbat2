import { Hono } from "hono";
import * as db from "./db/queries";
import { run, type Deps } from "./pipeline";
import {
  datadogSource,
  elasticsearchSource,
  fixtureSource,
  httpSource,
  sentrySource,
  type LogSource,
} from "./providers/logs";
import { anthropicDiagnoser, simulatedDiagnoser } from "./providers/model";
import {
  azureDevOpsRepo,
  githubRepo,
  gitlabRepo,
  simulatedRepo,
  type RepoSource,
} from "./providers/repo";
import {
  azureDevOpsWorkItems,
  githubIssues,
  gitlabIssues,
  jiraTickets,
  linearTickets,
  simulatedTickets,
  type TicketProvider,
} from "./providers/tickets";
import { dismiss, fileIssue, handleInteraction } from "./slack/actions";
import { renderBrief } from "./slack/blocks";
import { slackClient } from "./slack/client";
import { verifySlackSignature } from "./slack/verify";
import { IncidentPage, IncidentsPage, MetricsPage, ServicesPage } from "./ui/pages";
import { renderPage } from "./ui/shell";
import { CSS, CSS_HREF, JS, JS_HREF } from "./ui/css";
import type { Env, Resolution, SettingsRow } from "./types";
import {
  authenticate,
  type AuthResult,
  checkAdmin,
  checkThrottle,
  claimDeployment,
  clearCookie,
  clearFailures,
  clientId,
  mintSession,
  publicReadEnabled,
  recordFailure,
  sessionCookie,
} from "./auth";
import { createUser, identify, listUsers, setUserDisabled, timingSafeEqual } from "./users";
import { deleteSecret, listSecrets, MANAGED_SECRETS, putSecret, resolveEnv } from "./secrets";
import { summarise, verifyAll } from "./providers/verify";
import { ClaimPage, ErrorPage, SetupPage, SignInPage } from "./ui/setup";

/**
 * Each provider is real when its credential is present and simulated when it is
 * not, so the whole pipeline runs end to end with nothing configured.
 */
async function depsFor(env: Env): Promise<Deps> {
  const [resolved, settings] = await Promise.all([resolveEnv(env), db.getSettings(env.DB)]);
  return deps(resolved, settings.log_source);
}

/**
 * Which source the pipeline reads.
 *
 * `auto` takes the first one whose credentials are present, most specific
 * first, and falls back to the bundled samples. An explicit value pins it, so
 * a client with more than one configured is never guessing which is live.
 */
function chooseLogSource(env: Env, choice: string): LogSource {
  switch (choice) {
    case "elasticsearch":
      return elasticsearchSource(env);
    case "http":
      return httpSource(env.DB);
    case "fixture":
      return fixtureSource();
    case "sentry":
      return sentrySource(env);
    case "datadog":
      return datadogSource(env);
  }
  if (env.SENTRY_TOKEN && env.SENTRY_ORG && env.SENTRY_PROJECT) return sentrySource(env);
  if (env.DATADOG_API_KEY && env.DATADOG_APP_KEY) return datadogSource(env);
  if (env.ELASTICSEARCH_URL) return elasticsearchSource(env);
  if (env.INGEST_TOKEN) return httpSource(env.DB);
  return fixtureSource();
}

/**
 * The code host. Only one can be live at a time, because a service's `repo`
 * column is a single identifier and means something different to each.
 */
function chooseRepo(env: Env): RepoSource {
  if (env.GITHUB_TOKEN) return githubRepo(env);
  if (env.GITLAB_TOKEN) return gitlabRepo(env);
  if (env.AZDO_TOKEN && env.AZDO_ORG && env.AZDO_PROJECT) return azureDevOpsRepo(env);
  return simulatedRepo(env);
}

/**
 * Where briefs become tickets. Chosen independently of the code host: keeping
 * code on GitHub and work in Jira is the common case, not the exception.
 * A dedicated tracker wins over the code host's own issues.
 */
function chooseTickets(env: Env): TicketProvider {
  if (env.JIRA_URL && env.JIRA_TOKEN && env.JIRA_PROJECT_KEY) return jiraTickets(env);
  if (env.LINEAR_TOKEN && env.LINEAR_TEAM_ID) return linearTickets(env);
  if (env.GITHUB_TOKEN) return githubIssues(env);
  if (env.GITLAB_TOKEN) return gitlabIssues(env);
  if (env.AZDO_TOKEN && env.AZDO_ORG && env.AZDO_PROJECT) return azureDevOpsWorkItems(env);
  return simulatedTickets();
}

function deps(env: Env, logSource = "auto"): Deps {
  return {
    env,
    logs: chooseLogSource(env, logSource),
    repo: chooseRepo(env),
    tickets: chooseTickets(env),
    diagnoser: env.ANTHROPIC_API_KEY ? anthropicDiagnoser(env) : simulatedDiagnoser(),
    slack: slackClient(env),
  };
}

/**
 * Request-scoped caches.
 *
 * Authentication is consulted by the middleware, again by the page to greet the
 * user, and again to decide whether the admin controls render — three times a
 * render, two D1 queries each. Settings and the decrypted credential overlay
 * were read repeatedly for the same reason. Computing each once per request
 * took /setup from 20 queries to single figures.
 *
 * Deliberately per request, not global: a Worker isolate serves many requests
 * and caching auth across them would be a serious bug.
 */
type Vars = {
  auth?: AuthResult;
  settings?: SettingsRow;
  renv?: Env;
  deps?: Deps;
};

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

async function authOf(c: any): Promise<AuthResult> {
  const cached = c.get("auth");
  if (cached) return cached;
  const result = await authenticate(c.env, c.req.raw);
  c.set("auth", result);
  return result;
}

const stateOf = async (c: any) => (await authOf(c)).state;

async function actorOf(c: any): Promise<string> {
  const { identity } = await authOf(c);
  return identity ? identity.name : clientId(c.req.raw);
}

async function settingsOf(c: any): Promise<SettingsRow> {
  const cached = c.get("settings");
  if (cached) return cached;
  const row = await db.getSettings(c.env.DB);
  c.set("settings", row);
  return row;
}

async function envOf(c: any): Promise<Env> {
  const cached = c.get("renv");
  if (cached) return cached;
  const resolved = await resolveEnv(c.env);
  c.set("renv", resolved);
  return resolved;
}

async function depsOf(c: any): Promise<Deps> {
  const cached = c.get("deps");
  if (cached) return cached;
  const built = deps(await envOf(c), (await settingsOf(c)).log_source);
  c.set("deps", built);
  return built;
}

/**
 * The pages render no third-party script and no inline script beyond the theme
 * stamp, so the policy can be tight. 'unsafe-inline' covers that one stamp and
 * Kumo's inline style attributes; everything executable is same-origin.
 */
app.use("*", async (c, next) => {
  await next();
  if (!c.res.headers.get("content-type")?.includes("text/html")) return;
  c.res.headers.set(
    "content-security-policy",
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "object-src 'none'",
    ].join("; "),
  );
  c.res.headers.set("x-content-type-options", "nosniff");
  c.res.headers.set("referrer-policy", "strict-origin-when-cross-origin");
  c.res.headers.set("x-frame-options", "DENY");
  c.res.headers.set("permissions-policy", "geolocation=(), microphone=(), camera=()");
  if (new URL(c.req.url).protocol === "https:") {
    c.res.headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  }
});

/** A crash should explain itself, not dump a bare 500 on the client. */
app.onError((err, c) => {
  console.error("unhandled", err);
  const wantsHtml = c.req.header("accept")?.includes("text/html");
  if (!wantsHtml) return c.json({ error: "internal_error" }, 500);
  return c.html(
    renderPage(<ErrorPage cssHref={CSS_HREF} title="Something went wrong" detail={String(err)} />),
    500,
  );
});

app.notFound((c) => {
  const wantsHtml = c.req.header("accept")?.includes("text/html");
  if (!wantsHtml) return c.json({ error: "not_found" }, 404);
  return c.html(
    renderPage(
      <ErrorPage
        cssHref={CSS_HREF}
        title="Not found"
        detail="That page does not exist. It may have been an incident that was cleared."
      />,
    ),
    404,
  );
});

/**
 * Anything that mutates state or costs money sits behind a bearer token. When
 * ADMIN_TOKEN is unset the routes are open — fine for `wrangler dev`, which is
 * why deploying without setting it is refused below.
 */
const admin = async (c: any, next: any) => {
  const state = await stateOf(c);
  if (state === "denied") return c.text("unauthorized", 401);
  if (state === "unclaimed") return c.text("deployment not claimed — open /setup", 409);
  return next();
};

/** Same check, but a browser gets redirected to sign in rather than a 401. */
const adminPage = async (c: any, next: any) => {
  const state = await stateOf(c);
  if (state === "unclaimed") return c.redirect("/setup/claim", 302);
  if (state === "denied") return c.redirect("/setup/signin", 302);
  return next();
};

const isHttps = (c: any) => new URL(c.req.url).protocol === "https:";

/**
 * Reading an incident means reading a production stack trace, so pages are
 * private unless the operator opts in. Sign-in, claim, health and static assets
 * stay open, and Slack authenticates by signature rather than session.
 */
const ALWAYS_OPEN = new Set(["/health", "/kumo.css", "/client.js", "/slack/actions", "/ingest"]);

const viewer = async (c: any, next: any) => {
  const path = new URL(c.req.url).pathname;
  if (ALWAYS_OPEN.has(path) || path.startsWith("/setup/")) return next();
  if (publicReadEnabled(c.env)) return next();

  const state = await stateOf(c);
  if (state === "unclaimed") return c.redirect("/setup/claim", 302);
  if (state === "denied") return c.redirect("/setup/signin", 302);
  return next();
};
const originOf = (c: any) => new URL(c.req.url).origin;
const whoIs = async (c: any) => (await authOf(c)).identity?.name ?? null;

/* ------------------------------------------------------------------ read */

app.get("/", viewer, async (c) => {
  const [incidents, settings, services] = await Promise.all([
    db.listIncidents(c.env.DB, 200),
    settingsOf(c),
    db.listServices(c.env.DB),
  ]);
  const filters = {
    service: c.req.query("service") || undefined,
    severity: c.req.query("severity") || undefined,
    status: c.req.query("status") || undefined,
    q: c.req.query("q") || undefined,
  };
  const d = await depsOf(c);
  const simulated = [
    d.logs.name === "fixture" ? "logs" : null,
    d.diagnoser.name === "simulated" ? "briefs" : null,
    d.repo.name === "simulated" ? "repo" : null,
    d.slack.live ? null : "slack",
  ].filter(Boolean);
  const mode = simulated.length ? `simulated: ${simulated.join(", ")}` : "all providers live";
  return c.html(
    renderPage(
      <IncidentsPage
        all={incidents}
        slackLive={Boolean(c.env.SLACK_BOT_TOKEN)}
        settings={settings}
        filters={filters}
        mode={mode}
        cssHref={CSS_HREF}
        jsHref={JS_HREF}
        who={await whoIs(c)}
        serviceCount={services.length}
        adminLocked={(await stateOf(c)) !== "unclaimed"}
      />,
    ),
  );
});

app.get("/metrics", viewer, async (c) => {
  const [m, settings, byService] = await Promise.all([
    db.metrics(c.env.DB),
    settingsOf(c),
    db.metricsByService(c.env.DB),
  ]);
  return c.html(renderPage(<MetricsPage m={m} settings={settings} byService={byService} cssHref={CSS_HREF}
        jsHref={JS_HREF} />));
});

app.get("/services", viewer, async (c) => {
  const [services, settings, byService] = await Promise.all([
    db.listServices(c.env.DB),
    settingsOf(c),
    db.metricsByService(c.env.DB),
  ]);
  return c.html(
    renderPage(
      <ServicesPage
        services={services}
        settings={settings}
        byService={byService}
        cssHref={CSS_HREF}
        jsHref={JS_HREF}
        adminLocked={(await stateOf(c)) !== "unclaimed"}
        who={await whoIs(c)}
      />,
    ),
  );
});

app.get("/incident/:id", viewer, async (c) => {
  const id = c.req.param("id");
  const incident = await db.getIncident(c.env.DB, id);
  if (!incident) return c.text("not found", 404);

  const [brief, service, events, settings, extras] = await Promise.all([
    db.getBrief(c.env.DB, id),
    db.getService(c.env.DB, incident.service),
    db.listEvents(c.env.DB, id),
    settingsOf(c),
    db.getIncidentExtras(c.env.DB, id),
  ]);

  return c.html(
    renderPage(
      <IncidentPage
        incident={incident}
        brief={brief}
        service={service}
        events={events}
        settings={settings}
        ticketUrl={extras.ticket_url}
        disposition={extras.disposition}
        error={c.req.query("error") ?? undefined}
        who={await whoIs(c)}
        cssHref={CSS_HREF}
        jsHref={JS_HREF}
      />,
    ),
  );
});

/** Kumo's precompiled stylesheet, served once and cached rather than inlined. */
app.get("/client.js", (c) =>
  c.body(JS, 200, {
    "content-type": "text/javascript; charset=utf-8",
    "cache-control": "public, max-age=31536000, immutable",
  }),
);

app.get("/kumo.css", (c) =>
  c.body(CSS, 200, {
    "content-type": "text/css; charset=utf-8",
    "cache-control": "public, max-age=31536000, immutable",
  }),
);

app.get("/health", async (c) => {
  const d = await depsOf(c);
  const settings = await settingsOf(c);
  return c.json({
    ok: true,
    killSwitch: Boolean(settings.kill_switch),
    briefsToday: await db.briefsToday(c.env.DB),
    dailyLimit: settings.daily_brief_limit,
    providers: {
      logs: d.logs.name,
      repo: d.repo.name,
      tickets: d.tickets.name,
      diagnoser: d.diagnoser.name,
      slack: d.slack.live ? "live" : "simulated",
    },
  });
});

/** Iterate on the brief design here rather than by reposting to Slack. */
app.get("/preview/:id", viewer, async (c) => {
  const id = c.req.param("id");
  const incident = await db.getIncident(c.env.DB, id);
  const brief = incident ? await db.getBrief(c.env.DB, id) : null;
  if (!incident || !brief) return c.json({ error: "not found" }, 404);

  const service = await db.getService(c.env.DB, incident.service);
  const blocks = renderBrief({ incident, brief, repo: service?.repo ?? "" });
  return c.json({
    blocks,
    builder: `https://app.slack.com/block-kit-builder#${encodeURIComponent(JSON.stringify({ blocks }))}`,
  });
});

/* ----------------------------------------------------------------- write */

/** The correctness signal. Deliberately separate from filing an issue. */
app.post("/incident/:id/resolve", adminPage, async (c) => {
  const id = c.req.param("id");
  const form = await c.req.parseBody();
  const resolution = String(form.resolution ?? "") as Resolution;
  if (resolution !== "cause_confirmed" && resolution !== "cause_wrong") {
    return c.text("bad resolution", 400);
  }

  await db.setResolution(c.env.DB, id, resolution, await actorOf(c));
  await db.logEvent(c.env.DB, id, "resolved", resolution, await actorOf(c));
  return c.redirect(`/incident/${id}`, 303);
});

/**
 * Triage from the browser. These are the same actions the Slack buttons take —
 * without them a client who has not connected Slack could never file or
 * dismiss, and the adoption metric would sit at zero forever.
 */
app.post("/incident/:id/file", adminPage, async (c) => {
  const id = c.req.param("id");
  const actor = await actorOf(c);
  const incident = await db.getIncident(c.env.DB, id);
  if (!incident) return c.text("not found", 404);

  try {
    await fileIssue(await depsOf(c), incident, actor);
  } catch (error) {
    return c.redirect(`/incident/${id}?error=${encodeURIComponent(String(error).slice(0, 140))}`, 303);
  }
  return c.redirect(`/incident/${id}`, 303);
});

app.post("/incident/:id/dismiss", adminPage, async (c) => {
  const id = c.req.param("id");
  const form = await c.req.parseBody();
  const kind = String(form.kind ?? "");
  if (kind !== "not_helpful" && kind !== "cost_me_time") return c.text("bad kind", 400);

  await dismiss(await depsOf(c), id, kind, await actorOf(c));
  return c.redirect(`/incident/${id}`, 303);
});

app.post("/slack/actions", async (c) => {
  const raw = await c.req.text();
  const env = await resolveEnv(c.env);

  if (!env.SLACK_SIGNING_SECRET) return c.text("slack not configured", 503);
  if (!(await verifySlackSignature(env.SLACK_SIGNING_SECRET, c.req.raw.headers, raw))) {
    return c.text("bad signature", 401);
  }

  const encoded = new URLSearchParams(raw).get("payload");
  if (!encoded) return c.text("no payload", 400);
  const payload = JSON.parse(encoded);

  // Slack needs an answer within three seconds; the work continues after.
  c.executionCtx.waitUntil(
    handleInteraction(deps(env), payload).catch((error) => {
      console.error("interaction failed", error);
    }),
  );
  return c.body(null, 200);
});

/* ----------------------------------------------------------------- setup */

/**
 * First run. A deploy button cannot set a secret, so a fresh deployment has no
 * admin token until someone claims it here.
 */
app.get("/setup/claim", async (c) => {
  const state = await stateOf(c);
  if (state !== "unclaimed") return c.redirect("/setup/signin", 302);
  return c.html(renderPage(<ClaimPage cssHref={CSS_HREF} origin={originOf(c)} />));
});

app.post("/setup/claim", async (c) => {
  const form = await c.req.parseBody();
  const name = String(form.name ?? "").trim();
  const result = await claimDeployment(c.env, name);

  if ("error" in result) {
    await db.logEvent(c.env.DB, null, "claim_rejected", result.error, await actorOf(c));
    return c.redirect("/setup/signin", 303);
  }

  await db.logEvent(c.env.DB, null, "deployment_claimed", `owner ${result.name}`, result.name);
  const identity = await identify(c.env, result.token);
  if (identity) {
    c.header("set-cookie", sessionCookie(await mintSession(c.env, identity), isHttps(c)));
  }
  return c.html(
    renderPage(
      <ClaimPage cssHref={CSS_HREF} origin={originOf(c)} token={result.token} name={result.name} />,
    ),
  );
});

app.get("/setup/signin", async (c) => {
  const state = await stateOf(c);
  if (state === "ok") return c.redirect("/setup", 302);
  if (state === "unclaimed") return c.redirect("/setup/claim", 302);
  return c.html(
    renderPage(
      <SignInPage
        cssHref={CSS_HREF}
        jsHref={JS_HREF}
        unconfigured={false}
        error={
          c.req.query("locked")
            ? `Too many failed attempts. Try again in ${c.req.query("locked")} minutes.`
            : c.req.query("error")
              ? "That token was not accepted."
              : undefined
        }
      />,
    ),
  );
});

app.post("/setup/signin", async (c) => {
  const id = clientId(c.req.raw);
  const throttle = await checkThrottle(c.env.DB, id);
  if (throttle.locked) {
    await db.logEvent(c.env.DB, null, "signin_locked", id, "anonymous");
    return c.redirect(`/setup/signin?locked=${throttle.retryAfterMinutes}`, 303);
  }

  const form = await c.req.parseBody();
  const supplied = String(form.token ?? "");
  const identity = supplied ? await identify(c.env, supplied) : null;

  if (!identity) {
    await recordFailure(c.env.DB, id);
    await db.logEvent(c.env.DB, null, "signin_failed", id, "anonymous");
    return c.redirect("/setup/signin?error=1", 303);
  }

  await clearFailures(c.env.DB, id);
  await db.logEvent(c.env.DB, null, "signin", `from ${id}`, identity.name);
  c.header("set-cookie", sessionCookie(await mintSession(c.env, identity), isHttps(c)));
  return c.redirect("/setup", 303);
});

app.post("/setup/signout", (c) => {
  c.header("set-cookie", clearCookie(isHttps(c)));
  return c.redirect("/setup/signin", 303);
});

app.get("/setup", adminPage, async (c) => {
  const d = await depsOf(c);
  const [services, settings, incidents] = await Promise.all([
    db.listServices(c.env.DB),
    settingsOf(c),
    db.listIncidents(c.env.DB, 1),
  ]);
  const [m, demo, audit, failures, users, auth] = await Promise.all([
    db.metrics(c.env.DB),
    db.demoState(c.env.DB),
    db.auditTrail(c.env.DB, 10),
    db.recentFailures(c.env.DB, 5),
    listUsers(c.env.DB),
    authOf(c),
  ]);
  const stored = await listSecrets(c.env);
  const secrets = MANAGED_SECRETS.map((spec) => {
    const row = stored.find((r) => r.name === spec.name);
    return {
      ...spec,
      // A Worker secret wins, and cannot be edited from here.
      fromEnv: Boolean((c.env as unknown as Record<string, unknown>)[spec.name]),
      hint: row?.hint ?? null,
      updatedBy: row?.updated_by ?? null,
    };
  });
  return c.html(
    renderPage(
      <SetupPage
        cssHref={CSS_HREF}
        jsHref={JS_HREF}
        services={services}
        settings={settings}
        incidentCount={m.total}
        demo={demo}
        audit={audit}
        users={users}
        secrets={secrets}
        failures={failures}
        me={auth.identity}
        origin={originOf(c)}
        newToken={c.req.query("token") ? { token: c.req.query("token")!, name: c.req.query("who") ?? "" } : undefined}
        error={c.req.query("error") ?? undefined}
        notice={c.req.query("added") ? `Registered ${c.req.query("added")}.` : c.req.query("ran") ? `Pipeline run: ${c.req.query("ran")}.` : undefined}
        providers={{
          logs: d.logs.name,
          repo: d.repo.name,
          diagnoser: d.diagnoser.name,
          slack: d.slack.live ? "live" : "simulated",
        }}
      />,
    ),
  );
});

app.post("/setup/demo", adminPage, async (c) => {
  const actor = await actorOf(c);
  await db.seedDemoServices(c.env.DB);
  const r = await run(await depsOf(c));
  await db.logEvent(c.env.DB, null, "demo_loaded", `${r.briefed} briefed`, actor);
  return c.redirect(
    `/setup?ran=${encodeURIComponent(`demo data loaded — ${r.briefed} briefs written`)}`,
    303,
  );
});

app.post("/setup/demo/clear", adminPage, async (c) => {
  await db.clearDemo(c.env.DB);
  await db.logEvent(c.env.DB, null, "demo_cleared", "", await actorOf(c));
  return c.redirect("/setup?ran=demo%20data%20cleared", 303);
});

app.post("/setup/secrets", adminPage, async (c) => {
  const f = await c.req.parseBody();
  const name = String(f.name ?? "");
  const actor = await actorOf(c);
  const result = await putSecret(c.env, name, String(f.value ?? ""), actor);

  if (result.error) return c.redirect(`/setup?error=${encodeURIComponent(result.error)}`, 303);
  // The value itself is never logged — only that it changed.
  await db.logEvent(c.env.DB, null, "secret_set", name, actor);
  return c.redirect(`/setup?ran=${encodeURIComponent(`${name} saved`)}`, 303);
});

app.post("/setup/secrets/delete", adminPage, async (c) => {
  const f = await c.req.parseBody();
  const name = String(f.name ?? "");
  const actor = await actorOf(c);
  await deleteSecret(c.env, name);
  await db.logEvent(c.env.DB, null, "secret_removed", name, actor);
  return c.redirect(`/setup?ran=${encodeURIComponent(`${name} removed`)}`, 303);
});

app.post("/setup/users", adminPage, async (c) => {
  const f = await c.req.parseBody();
  const actor = await actorOf(c);
  const created = await createUser(c.env.DB, String(f.name ?? ""), "admin", actor);

  if ("error" in created) return c.redirect(`/setup?error=${encodeURIComponent(created.error)}`, 303);
  await db.logEvent(c.env.DB, null, "user_created", created.user.name, actor);
  return c.redirect(
    `/setup?token=${encodeURIComponent(created.token)}&who=${encodeURIComponent(created.user.name)}`,
    303,
  );
});

app.post("/setup/users/toggle", adminPage, async (c) => {
  const f = await c.req.parseBody();
  const actor = await actorOf(c);
  const disable = String(f.disabled ?? "") === "1";
  const result = await setUserDisabled(c.env.DB, String(f.id ?? ""), disable);

  if (result.error) return c.redirect(`/setup?error=${encodeURIComponent(result.error)}`, 303);
  await db.logEvent(c.env.DB, null, disable ? "user_disabled" : "user_enabled", String(f.name ?? ""), actor);
  return c.redirect("/setup", 303);
});

app.post("/setup/services", adminPage, async (c) => {
  const f = await c.req.parseBody();
  const name = String(f.name ?? "").trim();
  const repo = String(f.repo ?? "").trim();
  const channel = String(f.slack_channel ?? "").trim();
  if (!name || !repo || !channel) return c.redirect("/setup", 303);

  await db.upsertService(c.env.DB, {
    name,
    repo,
    slack_channel: channel.startsWith("#") ? channel : `#${channel}`,
    team: String(f.team ?? "").trim(),
  });
  await db.logEvent(c.env.DB, null, "service_registered", name, await actorOf(c));
  return c.redirect(`/setup?added=${encodeURIComponent(name)}`, 303);
});

app.post("/setup/ingest", adminPage, async (c) => {
  const r = await run(await depsOf(c));
  await db.logEvent(c.env.DB, null, "manual_ingest", `${r.briefed} briefed`, await actorOf(c));
  const summary = r.halted
    ? `paused — ${r.halted}`
    : `${r.briefed} briefed, ${r.deduped} deduped, ${r.unmapped} unmapped`;
  return c.redirect(`/setup?ran=${encodeURIComponent(summary)}`, 303);
});

app.post("/setup/kill", adminPage, async (c) => {
  const f = await c.req.parseBody();
  const on = String(f.kill_switch ?? "") === "1";
  await db.updateSettings(c.env.DB, {
    kill_switch: on,
    kill_switch_reason: on ? "paused from the setup page" : "",
  });
  await db.logEvent(c.env.DB, null, on ? "paused" : "resumed", "", await actorOf(c));
  return c.redirect("/setup", 303);
});

/* ----------------------------------------------------------------- admin */

/**
 * Push endpoint for clients whose errors FixBat cannot reach.
 *
 * Authenticated with INGEST_TOKEN rather than the admin token, because this
 * credential is distributed to every application that reports errors and must
 * not also grant administration. Events are buffered; the `http` source drains
 * them on the next run, so nothing here calls the model or costs money.
 */
app.post("/ingest", async (c) => {
  const env = await resolveEnv(c.env);
  if (!env.INGEST_TOKEN) {
    return c.json({ error: "ingest is not configured — set INGEST_TOKEN" }, 503);
  }

  const header = c.req.header("authorization") ?? "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!supplied || !timingSafeEqual(env.INGEST_TOKEN, supplied)) {
    return c.json({ error: "unauthorized" }, 401);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "body must be JSON" }, 400);
  }

  const items = Array.isArray(body) ? body : [body];
  if (!items.length) return c.json({ ok: true, accepted: 0 });
  if (items.length > 100) return c.json({ error: "at most 100 events per request" }, 413);

  const now = new Date().toISOString();
  await c.env.DB.batch(
    items.map((item) =>
      c.env.DB.prepare(`INSERT INTO inbox (received_at, payload_json) VALUES (?1, ?2)`).bind(
        now,
        JSON.stringify(item),
      ),
    ),
  );

  return c.json({ ok: true, accepted: items.length });
});

/**
 * Does each credential actually work?
 *
 * Without this a wrong key is indistinguishable from an unconfigured one: the
 * provider falls back to simulated and the deployment goes on looking healthy.
 * Each check is the provider's own identity call, so the answer is definitive.
 */
app.post("/admin/verify", admin, async (c) => {
  const checks = await verifyAll(await envOf(c));
  await db.logEvent(c.env.DB, null, "connections_verified", summarise(checks), await actorOf(c));
  return c.json({ ok: checks.every((x) => x.ok !== false), checks, summary: summarise(checks) });
});

app.post("/setup/verify", adminPage, async (c) => {
  const checks = await verifyAll(await envOf(c));
  const summary = summarise(checks);
  await db.logEvent(c.env.DB, null, "connections_verified", summary, await actorOf(c));
  const failed = checks.some((x) => x.ok === false);
  return c.redirect(
    `/setup?${failed ? "error" : "ran"}=${encodeURIComponent(summary)}`,
    303,
  );
});

app.post("/admin/ingest", admin, async (c) => c.json(await run(await depsOf(c))));

app.post("/admin/reset", admin, async (c) => {
  await db.reset(c.env.DB);
  return c.json({ ok: true });
});

app.post("/admin/services", admin, async (c) => {
  const body = await c.req.json<{
    name: string;
    repo: string;
    slack_channel: string;
    team?: string;
    enabled?: boolean;
  }>();
  if (!body?.name || !body?.repo || !body?.slack_channel) {
    return c.json({ error: "name, repo and slack_channel are required" }, 400);
  }
  await db.upsertService(c.env.DB, body);
  return c.json({ ok: true, services: await db.listServices(c.env.DB) });
});

app.post("/admin/settings", admin, async (c) => {
  const body = await c.req.json<{
    kill_switch?: boolean;
    kill_switch_reason?: string;
    daily_brief_limit?: number;
    trace_url_template?: string;
    log_source?: string;
  }>();
  await db.updateSettings(c.env.DB, body ?? {});
  // read through, not from the request cache: this is after a write
  return c.json({ ok: true, settings: await db.getSettings(c.env.DB) });
});

/* --------------------------------------------------------------- aliases */
// Kept so local scripts and docs written against /dev/* keep working.
app.post("/dev/ingest", admin, async (c) => c.json(await run(await depsOf(c))));
app.post("/dev/reset", admin, async (c) => {
  await db.reset(c.env.DB);
  return c.json({ ok: true });
});

export default {
  fetch: app.fetch,

  /**
   * The cron is the only path that runs unattended, so it has to resolve
   * UI-stored credentials the same way the routes do.
   *
   * `deps(env)` here reads the raw bindings and therefore sees only Worker
   * secrets. A client who connected their tools from /setup would have had
   * every scheduled pass run against fixtures and canned briefs, posting
   * nothing to Slack — while /health, which does resolve them, went on
   * reporting the providers as live. Silent, and invisible to a health check.
   */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        try {
          const summary = await run(await depsFor(env));
          console.log("scheduled run", JSON.stringify(summary));
        } catch (error) {
          // An unhandled rejection here would lose the run with no trace. The
          // event is what surfaces it on /setup.
          console.error("scheduled run failed", error);
          await db.logEvent(env.DB, null, "pipeline_error", `scheduled run: ${String(error)}`);
        }
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
