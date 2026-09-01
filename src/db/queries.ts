import type {
  BriefRow,
  Commit,
  DiagnosisResult,
  IncidentRow,
  IncidentStatus,
  LogEvent,
  Resolution,
  ServiceRow,
  SettingsRow,
  CursorState,
} from "../types";

const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

export interface UpsertResult {
  incident: IncidentRow;
  isNew: boolean;
}

/**
 * The one guardrail that is not optional. A repeat of a known fingerprint bumps
 * the counter instead of minting a second incident, so one bad deploy produces
 * one Slack message rather than four hundred.
 */
export async function upsertIncident(
  db: D1Database,
  event: LogEvent,
  fingerprint: string,
  isDemo = false,
): Promise<UpsertResult> {
  const ts = now();

  const incident = await db
    .prepare(
      `INSERT INTO incidents (
         id, fingerprint, service, environment, severity, exception_type, message,
         stack_trace, version, occurrences, first_seen, last_seen, status,
         is_demo, created_at, updated_at, trace_id
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1, ?10, ?10, 'new', ?12, ?11, ?11, ?13)
       ON CONFLICT (fingerprint) DO UPDATE SET
         occurrences = occurrences + 1,
         last_seen   = excluded.last_seen,
         severity    = excluded.severity,
         version     = excluded.version,
         updated_at  = excluded.updated_at,
         -- Latest wins: an incident that is firing now is best debugged from
         -- its most recent trace, which is likeliest to still be in the APM's
         -- retention window. COALESCE so an occurrence that carries no trace
         -- does not erase one that did.
         trace_id    = COALESCE(excluded.trace_id, incidents.trace_id)
       RETURNING *`,
    )
    .bind(
      uuid(),
      fingerprint,
      event.service,
      event.environment,
      event.severity,
      event.exceptionType,
      event.message,
      event.stackTrace,
      event.version,
      event.occurredAt,
      ts,
      isDemo ? 1 : 0,
      event.traceId ?? null,
    )
    .first<IncidentRow>();

  if (!incident) throw new Error("upsert returned no row");
  return { incident, isNew: incident.occurrences === 1 };
}

/**
 * `cited_commits` stores the full commit objects the model cited, not just their
 * SHAs, so the renderer can show author and message without a second lookup.
 */
export async function saveBrief(
  db: D1Database,
  incidentId: string,
  result: DiagnosisResult,
  available: Commit[],
): Promise<void> {
  const { brief } = result;
  const cited = brief.citedCommits.length
    ? available.filter((c) => brief.citedCommits.some((s) => c.sha.startsWith(s) || c.shortSha === s))
    : available;
  await db
    .prepare(
      `INSERT INTO briefs (
         id, incident_id, summary, suspected_cause, what_changed, open_questions,
         cited_file, cited_line, cited_commits, source, model, spend_usd,
         duration_ms, created_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
       ON CONFLICT (incident_id) DO UPDATE SET
         summary         = excluded.summary,
         suspected_cause = excluded.suspected_cause,
         what_changed    = excluded.what_changed,
         open_questions  = excluded.open_questions,
         cited_file      = excluded.cited_file,
         cited_line      = excluded.cited_line,
         cited_commits   = excluded.cited_commits,
         source          = excluded.source,
         model           = excluded.model,
         spend_usd       = excluded.spend_usd,
         duration_ms     = excluded.duration_ms`,
    )
    .bind(
      uuid(),
      incidentId,
      brief.summary,
      brief.suspectedCause,
      brief.whatChanged,
      JSON.stringify(brief.openQuestions),
      brief.citedFile,
      brief.citedLine,
      JSON.stringify(cited),
      result.source,
      result.model,
      result.spendUsd,
      result.durationMs,
      now(),
    )
    .run();
}

export async function setStatus(
  db: D1Database,
  incidentId: string,
  status: IncidentStatus,
): Promise<void> {
  await db
    .prepare(`UPDATE incidents SET status = ?2, updated_at = ?3 WHERE id = ?1`)
    .bind(incidentId, status, now())
    .run();
}

export async function setSlackMessage(
  db: D1Database,
  incidentId: string,
  channel: string,
  ts: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE incidents
         SET slack_channel = ?2, slack_ts = ?3, status = 'posted', updated_at = ?4
       WHERE id = ?1`,
    )
    .bind(incidentId, channel, ts, now())
    .run();
}

export async function getIncident(db: D1Database, id: string): Promise<IncidentRow | null> {
  return db.prepare(`SELECT * FROM incidents WHERE id = ?1`).bind(id).first<IncidentRow>();
}

export async function getBrief(db: D1Database, incidentId: string): Promise<BriefRow | null> {
  return db
    .prepare(`SELECT * FROM briefs WHERE incident_id = ?1`)
    .bind(incidentId)
    .first<BriefRow>();
}

export async function getCursor(db: D1Database, source: string): Promise<CursorState | null> {
  const row = await db
    .prepare(`SELECT state_json FROM cursors WHERE source = ?1`)
    .bind(source)
    .first<{ state_json: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.state_json) as CursorState;
  } catch {
    return null;
  }
}

export async function setCursor(
  db: D1Database,
  source: string,
  state: CursorState,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO cursors (source, state_json, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT (source) DO UPDATE SET state_json = excluded.state_json,
                                          updated_at = excluded.updated_at`,
    )
    .bind(source, JSON.stringify(state), now())
    .run();
}

export async function getService(db: D1Database, name: string): Promise<ServiceRow | null> {
  return db
    .prepare(`SELECT * FROM services WHERE name = ?1 AND enabled = 1`)
    .bind(name)
    .first<ServiceRow>();
}

export async function listServices(db: D1Database): Promise<ServiceRow[]> {
  const { results } = await db.prepare(`SELECT * FROM services ORDER BY name`).all<ServiceRow>();
  return results ?? [];
}

export async function upsertService(
  db: D1Database,
  s: { name: string; repo: string; slack_channel: string; team?: string; enabled?: boolean },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO services (name, repo, slack_channel, team, enabled, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
       ON CONFLICT (name) DO UPDATE SET
         repo = excluded.repo, slack_channel = excluded.slack_channel,
         team = excluded.team, enabled = excluded.enabled, updated_at = excluded.updated_at`,
    )
    .bind(s.name, s.repo, s.slack_channel, s.team ?? "", s.enabled === false ? 0 : 1, now())
    .run();
}

export async function getSettings(db: D1Database): Promise<SettingsRow> {
  const row = await db.prepare(`SELECT * FROM settings WHERE id = 1`).first<SettingsRow>();
  if (row) return row;
  await db
    .prepare(`INSERT OR IGNORE INTO settings (id, kill_switch, daily_brief_limit, updated_at)
              VALUES (1, 0, 50, ?1)`)
    .bind(now())
    .run();
  return (await db.prepare(`SELECT * FROM settings WHERE id = 1`).first<SettingsRow>())!;
}

export async function updateSettings(
  db: D1Database,
  patch: {
    kill_switch?: boolean;
    kill_switch_reason?: string;
    daily_brief_limit?: number;
    trace_url_template?: string;
  },
): Promise<void> {
  const current = await getSettings(db);
  await db
    .prepare(
      `UPDATE settings SET kill_switch = ?1, kill_switch_reason = ?2,
              daily_brief_limit = ?3, trace_url_template = ?5, updated_at = ?4 WHERE id = 1`,
    )
    .bind(
      patch.kill_switch === undefined ? current.kill_switch : patch.kill_switch ? 1 : 0,
      patch.kill_switch_reason ?? current.kill_switch_reason,
      patch.daily_brief_limit ?? current.daily_brief_limit,
      now(),
      patch.trace_url_template ?? current.trace_url_template,
    )
    .run();
}

/** Briefs written since midnight UTC — what the daily cap is measured against. */
export async function briefsToday(db: D1Database): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM briefs WHERE created_at >= ?1`)
    .bind(new Date().toISOString().slice(0, 10))
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function setResolution(
  db: D1Database,
  incidentId: string,
  resolution: Resolution,
  by: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE incidents SET resolution = ?2, resolved_at = ?3, resolved_by = ?4, updated_at = ?3
       WHERE id = ?1`,
    )
    .bind(incidentId, resolution, now(), by)
    .run();
}

export interface Metrics {
  total: number;
  posted: number;
  filed: number;
  dismissedNotHelpful: number;
  dismissedHarmful: number;
  unmapped: number;
  causeConfirmed: number;
  causeWrong: number;
  undispositioned: number;
  unresolved: number;
  spendUsd: number;
  occurrences: number;
  medianBriefMs: number;
}

/**
 * Precision is computed only over incidents someone actually resolved. An
 * untouched brief is unknown, never counted as correct — so the denominator is
 * reported alongside the rate rather than hidden inside it.
 */
export async function metrics(db: D1Database): Promise<Metrics> {
  const row = await db
    .prepare(
      `SELECT
         COUNT(*)                                                        AS total,
         SUM(status = 'posted')                                          AS posted,
         SUM(status = 'filed')                                           AS filed,
         SUM(status = 'unmapped')                                        AS unmapped,
         SUM(resolution = 'cause_confirmed')                             AS causeConfirmed,
         SUM(resolution = 'cause_wrong')                                 AS causeWrong,
         SUM(resolution IS NULL AND status != 'unmapped')                AS unresolved,
         SUM(occurrences)                                                AS occurrences
       FROM incidents`,
    )
    .first<any>();

  const disp = await db
    .prepare(
      `SELECT
         SUM(kind = 'not_helpful')   AS notHelpful,
         SUM(kind = 'cost_me_time')  AS harmful
       FROM dispositions`,
    )
    .first<any>();

  const spend = await db
    .prepare(`SELECT COALESCE(SUM(spend_usd), 0) AS s, COUNT(*) AS n FROM briefs`)
    .first<{ s: number; n: number }>();

  const durations = await db
    .prepare(`SELECT duration_ms FROM briefs ORDER BY duration_ms`)
    .all<{ duration_ms: number }>();
  const ds = (durations.results ?? []).map((d) => d.duration_ms);
  const median = ds.length ? ds[Math.floor(ds.length / 2)] : 0;

  const dispositioned = await db
    .prepare(`SELECT COUNT(DISTINCT incident_id) AS n FROM dispositions`)
    .first<{ n: number }>();

  return {
    total: row?.total ?? 0,
    posted: row?.posted ?? 0,
    filed: row?.filed ?? 0,
    unmapped: row?.unmapped ?? 0,
    causeConfirmed: row?.causeConfirmed ?? 0,
    causeWrong: row?.causeWrong ?? 0,
    unresolved: row?.unresolved ?? 0,
    occurrences: row?.occurrences ?? 0,
    dismissedNotHelpful: disp?.notHelpful ?? 0,
    dismissedHarmful: disp?.harmful ?? 0,
    undispositioned: (row?.total ?? 0) - (dispositioned?.n ?? 0),
    spendUsd: spend?.s ?? 0,
    medianBriefMs: median,
  };
}

export interface ServiceStat {
  service: string;
  incidents: number;
  occurrences: number;
  filed: number;
  confirmed: number;
  wrong: number;
}

export async function metricsByService(db: D1Database): Promise<ServiceStat[]> {
  const { results } = await db
    .prepare(
      `SELECT i.service                                    AS service,
              COUNT(*)                                     AS incidents,
              SUM(i.occurrences)                           AS occurrences,
              SUM(t.id IS NOT NULL)                        AS filed,
              SUM(i.resolution = 'cause_confirmed')        AS confirmed,
              SUM(i.resolution = 'cause_wrong')            AS wrong
         FROM incidents i
         LEFT JOIN tickets t ON t.incident_id = i.id
        GROUP BY i.service
        ORDER BY occurrences DESC, incidents DESC`,
    )
    .all<ServiceStat>();
  return results ?? [];
}

export interface EventRow {
  id: number;
  incident_id: string | null;
  kind: string;
  detail: string;
  actor: string | null;
  created_at: string;
}

export async function listEvents(db: D1Database, incidentId: string): Promise<EventRow[]> {
  const { results } = await db
    .prepare(`SELECT * FROM events WHERE incident_id = ?1 ORDER BY id DESC LIMIT 50`)
    .bind(incidentId)
    .all<EventRow>();
  return results ?? [];
}

export interface IncidentWithBrief extends IncidentRow {
  summary: string | null;
  suspected_cause: string | null;
  cited_file: string | null;
  cited_line: number | null;
  brief_source: string | null;
  ticket_url: string | null;
  disposition: string | null;
  team: string | null;
  repo: string | null;
}

export async function listIncidents(db: D1Database, limit = 50): Promise<IncidentWithBrief[]> {
  const { results } = await db
    .prepare(
      `SELECT i.*,
              b.summary, b.suspected_cause, b.cited_file, b.cited_line,
              b.source AS brief_source,
              t.url AS ticket_url,
              s.team, s.repo,
              (SELECT kind FROM dispositions d
                WHERE d.incident_id = i.id
                ORDER BY d.created_at DESC LIMIT 1) AS disposition
         FROM incidents i
         LEFT JOIN briefs   b ON b.incident_id = i.id
         LEFT JOIN tickets  t ON t.incident_id = i.id
         LEFT JOIN services s ON s.name = i.service
        ORDER BY i.last_seen DESC
        LIMIT ?1`,
    )
    .bind(limit)
    .all<IncidentWithBrief>();
  return results ?? [];
}

/**
 * The ticket and latest disposition for ONE incident.
 *
 * Both were previously read by scanning `listIncidents(db, 200)` and calling
 * `.find()` on the result. Past 200 incidents that scan silently stops
 * containing the row: the incident page dropped its Issue link, and the Slack
 * message re-rendered as if it had never been filed — bringing the "File
 * issue" button back and inviting a duplicate.
 */
export interface IncidentExtras {
  ticket_url: string | null;
  disposition: string | null;
}

export async function getIncidentExtras(
  db: D1Database,
  incidentId: string,
): Promise<IncidentExtras> {
  const row = await db
    .prepare(
      `SELECT t.url AS ticket_url,
              (SELECT kind FROM dispositions d
                WHERE d.incident_id = ?1
                ORDER BY d.created_at DESC LIMIT 1) AS disposition
         FROM incidents i
         LEFT JOIN tickets t ON t.incident_id = i.id
        WHERE i.id = ?1`,
    )
    .bind(incidentId)
    .first<IncidentExtras>();
  return row ?? { ticket_url: null, disposition: null };
}

/**
 * UNIQUE(incident_id) plus INSERT OR IGNORE means a double-clicked button
 * produces one ticket and a link to it, with no locking.
 */
export async function claimTicket(
  db: D1Database,
  incidentId: string,
  ticket: { externalId: string; url: string; createdBy: string },
): Promise<{ url: string; alreadyExisted: boolean }> {
  // The insert itself is the claim. Reading first and then inserting leaves a
  // window where two concurrent clicks both see nothing and both proceed —
  // `changes` is what tells us which one actually won.
  const insert = await db
    .prepare(
      `INSERT OR IGNORE INTO tickets (id, incident_id, provider, external_id, url, created_by, created_at)
       VALUES (?1, ?2, 'github', ?3, ?4, ?5, ?6)`,
    )
    .bind(uuid(), incidentId, ticket.externalId, ticket.url, ticket.createdBy, now())
    .run();

  const row = await db
    .prepare(`SELECT url FROM tickets WHERE incident_id = ?1`)
    .bind(incidentId)
    .first<{ url: string }>();

  return { url: row?.url ?? ticket.url, alreadyExisted: insert.meta.changes === 0 };
}

export async function recordDisposition(
  db: D1Database,
  incidentId: string,
  kind: "filed" | "not_helpful" | "cost_me_time",
  slackUserId: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO dispositions (id, incident_id, kind, slack_user_id, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    )
    .bind(uuid(), incidentId, kind, slackUserId, now())
    .run();
}

export async function logEvent(
  db: D1Database,
  incidentId: string | null,
  kind: string,
  detail = "",
  actor: string | null = null,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO events (incident_id, kind, detail, actor, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    )
    .bind(incidentId, kind, detail, actor, now())
    .run();
}

/** Admin actions, newest first — who changed what, and when. */
/** Recent pipeline failures — a wrong credential shows up here first. */
export async function recentFailures(db: D1Database, limit = 5): Promise<EventRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM events
        WHERE kind IN ('pipeline_error', 'blame_unavailable', 'refused')
        ORDER BY id DESC LIMIT ?1`,
    )
    .bind(limit)
    .all<EventRow>();
  return results ?? [];
}

export async function auditTrail(db: D1Database, limit = 20): Promise<EventRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM events WHERE actor IS NOT NULL ORDER BY id DESC LIMIT ?1`,
    )
    .bind(limit)
    .all<EventRow>();
  return results ?? [];
}

/** Seeds the bundled sample services so a new deployment can be seen working. */
export async function seedDemoServices(db: D1Database): Promise<number> {
  const demo = [
    ["checkout-service", "acme/checkout-service", "#incidents-checkout", "Checkout"],
    ["payments-api", "acme/payments-api", "#incidents-payments", "Payments"],
    ["inventory-worker", "acme/inventory-worker", "#incidents-inventory", "Inventory"],
  ];
  const ts = now();
  await db.batch(
    demo.map(([name, repo, channel, team]) =>
      db
        .prepare(
          `INSERT INTO services (name, repo, slack_channel, team, enabled, is_demo, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, 1, 1, ?5, ?5)
           ON CONFLICT (name) DO NOTHING`,
        )
        .bind(name, repo, channel, team, ts),
    ),
  );
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM services WHERE is_demo = 1`)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Removes only what the demo loader created; real services are untouched. */
export async function clearDemo(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(
      `DELETE FROM events
        WHERE actor IS NULL
          AND incident_id IN (SELECT id FROM incidents WHERE is_demo = 1)`,
    ),
    db.prepare(`DELETE FROM incidents WHERE is_demo = 1`),
    db.prepare(`DELETE FROM services WHERE is_demo = 1`),
    db.prepare(`DELETE FROM cursors WHERE source = 'fixture'`),
  ]);
}

export async function demoState(db: D1Database): Promise<{ services: number; incidents: number }> {
  const row = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM services WHERE is_demo = 1) AS services,
              (SELECT COUNT(*) FROM incidents WHERE is_demo = 1) AS incidents`,
    )
    .first<{ services: number; incidents: number }>();
  return row ?? { services: 0, incidents: 0 };
}

/**
 * Clears incident data. The admin audit trail deliberately survives — an
 * operator should not be able to erase the record of their own actions by
 * resetting the database.
 */
export async function reset(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(`DELETE FROM cursors`),
    db.prepare(`DELETE FROM events WHERE actor IS NULL`),
    db.prepare(`DELETE FROM dispositions`),
    db.prepare(`DELETE FROM tickets`),
    db.prepare(`DELETE FROM briefs`),
    db.prepare(`DELETE FROM incidents`),
  ]);
}
