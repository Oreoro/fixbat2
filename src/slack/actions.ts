import * as db from "../db/queries";
import { refreshPostedMessage, type Deps } from "../pipeline";
import type { BriefRow, IncidentRow } from "../types";

type ActionId = "file_issue" | "not_helpful" | "cost_me_time";

interface Interaction {
  user?: { id?: string };
  actions?: Array<{ action_id?: string; value?: string }>;
}

/**
 * Buttons carry an incident id, never brief content — the handler re-reads the
 * record so it acts on current state rather than whatever was rendered.
 */
/** Records a dismissal. Shared by the Slack buttons and the web UI. */
export async function dismiss(
  deps: Deps,
  incidentId: string,
  kind: "not_helpful" | "cost_me_time",
  by: string,
): Promise<void> {
  await db.recordDisposition(deps.env.DB, incidentId, kind, by);
  await db.setStatus(deps.env.DB, incidentId, "dismissed");
  await db.logEvent(deps.env.DB, incidentId, kind, by);
  await refreshPostedMessage(deps, incidentId);
}

export async function handleInteraction(deps: Deps, payload: Interaction): Promise<void> {
  const action = payload.actions?.[0];
  const incidentId = action?.value;
  const actionId = action?.action_id as ActionId | undefined;
  const userId = payload.user?.id ?? "";
  if (!incidentId || !actionId) return;

  const incident = await db.getIncident(deps.env.DB, incidentId);
  if (!incident) return;

  if (actionId === "file_issue") {
    await fileIssue(deps, incident, userId);
  } else {
    await db.recordDisposition(deps.env.DB, incidentId, actionId, userId);
    await db.setStatus(deps.env.DB, incidentId, "dismissed");
    await db.logEvent(deps.env.DB, incidentId, actionId, userId);
  }

  await refreshPostedMessage(deps, incidentId);
}

export async function fileIssue(deps: Deps, incident: IncidentRow, userId: string): Promise<void> {
  // Returning quietly here meant the button appeared to work and nothing
  // happened. The web route turns this into a visible message; the Slack
  // handler logs it.
  const brief = await db.getBrief(deps.env.DB, incident.id);
  if (!brief) throw new Error("This incident has no brief yet, so there is nothing to file.");

  const existing = await db.claimTicket(deps.env.DB, incident.id, {
    externalId: "",
    url: "",
    createdBy: userId,
  });

  // Someone already filed this one; the refresh below will show their link.
  // A reservation with no url is an issue creation that never finished — the
  // worker was evicted between claiming the row and writing the result. Left
  // alone it blocked the incident from ever being filed again, because every
  // later attempt matched the empty row and returned as a duplicate. Only a
  // reservation that carries a real url is a genuine double-click.
  if (existing.alreadyExisted && existing.url) {
    await db.logEvent(deps.env.DB, incident.id, "file_issue_duplicate", userId);
    return;
  }

  // claimTicket inserted a placeholder row to win the race; fill it in for real.
  // If the call fails, release the claim so the button stays usable.
  const service = await db.getService(deps.env.DB, incident.service);
  const repo = service?.repo ?? "";

  let issue;
  try {
    issue = await deps.repo.createIssue(
      repo,
      `${incident.service}: ${incident.exception_type} — ${truncate(incident.message, 80)}`,
      issueBody(incident, brief, repo),
    );
  } catch (error) {
    await deps.env.DB.prepare(`DELETE FROM tickets WHERE incident_id = ?1 AND url = ''`)
      .bind(incident.id)
      .run();
    await db.logEvent(deps.env.DB, incident.id, "file_issue_failed", String(error));
    throw error;
  }

  await deps.env.DB.prepare(
    `UPDATE tickets SET external_id = ?2, url = ?3 WHERE incident_id = ?1`,
  )
    .bind(incident.id, issue.externalId, issue.url)
    .run();

  await db.recordDisposition(deps.env.DB, incident.id, "filed", userId);
  await db.setStatus(deps.env.DB, incident.id, "filed");
  await db.logEvent(deps.env.DB, incident.id, "filed", issue.url);
}

function issueBody(incident: IncidentRow, brief: BriefRow, repo: string): string {
  const questions: string[] = safeParse(brief.open_questions);
  const location = brief.cited_file
    ? `${brief.cited_file}${brief.cited_line ? `:${brief.cited_line}` : ""}`
    : "not attributed";

  return [
    brief.summary,
    "",
    "### Suspected cause",
    brief.suspected_cause,
    "",
    "### What changed",
    brief.what_changed,
    "",
    "### First checks",
    ...questions.map((q, i) => `${i + 1}. ${q}`),
    "",
    "### Details",
    `- Service: \`${incident.service}\` (${incident.environment})`,
    `- Version: \`${incident.version || "unknown"}\``,
    `- Location: \`${location}\``,
    `- Occurrences: ${incident.occurrences}, first seen ${incident.first_seen}`,
    "",
    "<details><summary>Stack trace</summary>",
    "",
    "```",
    incident.stack_trace,
    "```",
    "",
    "</details>",
    "",
    `_Filed from a FixBat incident brief. Machine-generated from ${repo} logs._`,
  ].join("\n");
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function safeParse<T>(json: string): T[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
