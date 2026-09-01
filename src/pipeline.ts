import { fingerprint, firstAppFrame } from "./fingerprint";
import * as db from "./db/queries";
import type { Diagnoser } from "./providers/model";
import type { LogSource } from "./providers/logs";
import { toRepoPath, type RepoSource } from "./providers/repo";
import { fallbackText, renderBrief } from "./slack/blocks";
import type { SlackClient } from "./slack/client";
import type { Commit, CursorState, Env, Evidence, LogEvent } from "./types";

export interface Deps {
  env: Env;
  logs: LogSource;
  repo: RepoSource;
  diagnoser: Diagnoser;
  slack: SlackClient;
}

export interface RunSummary {
  cursorFrom: string | null;
  cursorTo: string | null;
  fetched: number;
  briefed: number;
  deduped: number;
  unmapped: number;
  capped: number;
  failed: number;
  halted: string | null;
  incidents: Array<{ id: string; service: string; status: string; occurrences: number }>;
}

/**
 * Fetch, fingerprint, dedupe, gather evidence, diagnose, post. In order, with
 * the cheap rejections first so nothing expensive runs unprotected.
 */
export async function run(deps: Deps): Promise<RunSummary> {
  const { env, logs } = deps;
  const summary: RunSummary = {
    cursorFrom: null,
    cursorTo: null,
    fetched: 0,
    briefed: 0,
    deduped: 0,
    unmapped: 0,
    capped: 0,
    failed: 0,
    halted: null,
    incidents: [],
  };

  const settings = await db.getSettings(env.DB);
  if (settings.kill_switch) {
    summary.halted = settings.kill_switch_reason || "kill switch active";
    await db.logEvent(env.DB, null, "halted", summary.halted);
    return summary;
  }

  let budget = settings.daily_brief_limit - (await db.briefsToday(env.DB));

  // Read from where we left off. A throw here leaves the cursor untouched, so
  // the window is retried rather than silently skipped.
  const cursor = await db.getCursor(env.DB, logs.name);
  summary.cursorFrom = cursor?.position ?? null;

  /**
   * A wrong log-source URL or key is the likeliest thing to be misconfigured on
   * a new deployment, and it throws here — ahead of the per-event try/catch
   * below. Allowed to propagate it took the whole run down without writing
   * anything, so the "recent failures" banner on /setup, which reads these
   * events, stayed empty and the client had nothing to go on.
   *
   * The cursor is deliberately left where it was: the window is retried rather
   * than skipped.
   */
  let events: LogEvent[];
  let next: CursorState;
  try {
    ({ events, cursor: next } = await logs.fetch(cursor));
  } catch (error) {
    summary.failed++;
    summary.halted = `could not read from ${logs.name}: ${String(error)}`;
    await db.logEvent(env.DB, null, "pipeline_error", summary.halted);
    return summary;
  }

  summary.fetched = events.length;

  for (const event of events) {
    try {
      const outcome = await handle(deps, event, budget);
      if (outcome.kind === "deduped") summary.deduped++;
      else if (outcome.kind === "unmapped") summary.unmapped++;
      else if (outcome.kind === "capped") summary.capped++;
      else {
        summary.briefed++;
        budget--;
      }
      if (outcome.incident) summary.incidents.push(outcome.incident);
    } catch (error) {
      summary.failed++;
      await db.logEvent(env.DB, null, "pipeline_error", `${event.id}: ${String(error)}`);
      console.error(`[${event.id}]`, error);
    }
  }

  // Advanced after the fetch succeeded. A single event that failed to process
  // is recorded in `events` as pipeline_error and not retried — retrying it
  // forever would wedge the cursor behind one bad record.
  await db.setCursor(env.DB, logs.name, next);
  summary.cursorTo = next.position;

  return summary;
}

type Outcome = {
  kind: "briefed" | "deduped" | "unmapped" | "capped";
  incident?: { id: string; service: string; status: string; occurrences: number };
};

async function handle(deps: Deps, event: LogEvent, budget: number): Promise<Outcome> {
  const { env, repo, diagnoser, slack, logs } = deps;

  // Gate 1 — a service with no registry entry has no repo to correlate
  // against, so there is nothing a brief could say. Recorded, not diagnosed.
  const service = await db.getService(env.DB, event.service);

  const fp = await fingerprint(event);
  // Fixture-sourced incidents are demo data, so they can be cleared cleanly.
  const { incident, isNew } = await db.upsertIncident(env.DB, event, fp, logs.name === "fixture");

  if (!service) {
    await db.setStatus(env.DB, incident.id, "unmapped");
    await db.logEvent(env.DB, incident.id, "unmapped", event.service);
    return { kind: "unmapped" };
  }

  // Gate 2 — a repeat of something already briefed bumps the count on the
  // existing message rather than posting a second one.
  if (!isNew) {
    await db.logEvent(env.DB, incident.id, "deduped", `occurrence ${incident.occurrences}`);
    await refreshPostedMessage(deps, incident.id);
    return { kind: "deduped", incident: brief(incident) };
  }

  // Gate 3 — daily cap. Queued as `new`, so a later run picks it up.
  if (budget <= 0) {
    await db.logEvent(env.DB, incident.id, "capped", "daily brief limit reached");
    return { kind: "capped", incident: brief(incident) };
  }

  const frame = firstAppFrame(event.stackTrace);
  let commits: Commit[] = [];
  if (frame) {
    try {
      commits = await repo.recentCommitsTouching(service.repo, toRepoPath(frame.file), 3);
    } catch (error) {
      // A missing blame window is worth less than a missing brief. Carry on.
      await db.logEvent(env.DB, incident.id, "blame_unavailable", String(error));
    }
  }

  const evidence: Evidence = {
    event,
    occurrences: incident.occurrences,
    frame,
    commits,
    repo: service.repo,
    team: service.team,
  };

  const diagnosis = await diagnoser.diagnose(evidence);
  await db.saveBrief(env.DB, incident.id, diagnosis, commits);
  await db.setStatus(env.DB, incident.id, "briefed");
  await db.logEvent(
    env.DB,
    incident.id,
    "briefed",
    `${diagnosis.source} in ${diagnosis.durationMs}ms`,
  );

  // The brief posts as drafted. If a verification step is ever wanted, it goes
  // exactly here — between the brief being written and anyone seeing it.
  const row = await db.getBrief(env.DB, incident.id);
  if (row) {
    const blocks = renderBrief({ incident, brief: row, repo: service.repo });
    const posted = await slack.post(
      service.slack_channel,
      fallbackText(incident, row),
      blocks,
    );
    await db.setSlackMessage(env.DB, incident.id, posted.channel, posted.ts);
    await db.logEvent(env.DB, incident.id, "posted", slack.live ? posted.ts : "simulated");
  }

  return { kind: "briefed", incident: { ...brief(incident), status: "posted" } };
}

function brief(incident: { id: string; service: string; status: string; occurrences: number }) {
  return {
    id: incident.id,
    service: incident.service,
    status: incident.status,
    occurrences: incident.occurrences,
  };
}

/** Re-render a posted message in place, so counts and button state stay current. */
export async function refreshPostedMessage(deps: Deps, incidentId: string): Promise<void> {
  const { env, slack } = deps;

  const incident = await db.getIncident(env.DB, incidentId);
  const row = incident ? await db.getBrief(env.DB, incidentId) : null;
  if (!incident || !row || !incident.slack_channel || !incident.slack_ts) return;

  const service = await db.getService(env.DB, incident.service);
  const listed = await db.listIncidents(env.DB, 200);
  const current = listed.find((r) => r.id === incidentId);

  const blocks = renderBrief({
    incident,
    brief: row,
    repo: service?.repo ?? "",
    ticketUrl: current?.ticket_url ?? null,
    disposition: current?.disposition ?? null,
  });

  await slack.update(
    incident.slack_channel,
    incident.slack_ts,
    fallbackText(incident, row),
    blocks,
  );
}
