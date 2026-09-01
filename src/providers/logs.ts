import type { CursorState, Env, FetchResult, LogEvent, Severity } from "../types";
import fixtures from "../../fixtures/incidents.json";

export interface LogSource {
  readonly name: string;
  /**
   * Events since the cursor, oldest first, plus the cursor to persist. The
   * caller advances only on success — see the note on the cursors table.
   */
  fetch(cursor: CursorState | null): Promise<FetchResult>;
}

interface Fixture {
  id: string;
  service: string;
  environment: string;
  severity: string;
  minutes_ago: number;
  version: string;
  exception_type: string;
  message: string;
  stack_trace: string;
  trace_id?: string;
}

/**
 * Seeded errors, timestamped relative to a base captured on the first run and
 * then held in the cursor. Pinning the base is what makes the cursor mean
 * anything here: rebasing to `now` on every call would push every event past
 * the last position forever, and the source would replay itself indefinitely.
 */
export function fixtureSource(): LogSource {
  return {
    name: "fixture",
    async fetch(cursor) {
      const base = cursor?.base ? Date.parse(cursor.base) : Date.now();
      const baseIso = new Date(base).toISOString();

      const events: LogEvent[] = (fixtures as Fixture[])
        .map((f) => ({
          id: f.id,
          service: f.service,
          environment: f.environment,
          severity: f.severity as Severity,
          occurredAt: new Date(base - f.minutes_ago * 60_000).toISOString(),
          version: f.version,
          exceptionType: f.exception_type,
          message: f.message,
          stackTrace: f.stack_trace,
          traceId: f.trace_id ?? null,
        }))
        .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));

      const fresh = cursor?.position
        ? events.filter((e) => e.occurredAt > cursor.position!)
        : events;

      return {
        events: fresh,
        cursor: { position: newest(fresh, cursor?.position ?? null), base: baseIso },
      };
    },
  };
}

/** Live Elasticsearch. The swap is one line in index.ts. */
export function elasticsearchSource(env: Env): LogSource {
  const base = env.ELASTICSEARCH_URL!.replace(/\/+$/, "");
  return {
    name: "elasticsearch",
    async fetch(cursor) {
      const since = cursor?.position ?? null;
      const range = since ? { range: { "@timestamp": { gt: since } } } : { match_all: {} };

      const res = await fetch(`${base}/logs-*/_search`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `ApiKey ${env.ELASTICSEARCH_API_KEY}`,
        },
        body: JSON.stringify({
          size: 50,
          sort: [{ "@timestamp": "asc" }],
          query: { bool: { filter: [{ terms: { "log.level": ["error", "fatal"] } }, range] } },
          _source: [
            "@timestamp",
            "service.name",
            "service.environment",
            "service.version",
            "log.level",
            "error.type",
            "error.message",
            "error.stack_trace",
            // ECS correlation fields. transaction.id is the fallback for
            // sources that tag the request but not the distributed trace.
            "trace.id",
            "transaction.id",
          ],
        }),
      });

      if (!res.ok) {
        // Throwing here leaves the cursor untouched, so the window is retried.
        throw new Error(`elasticsearch ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }

      const body = (await res.json()) as { hits: { hits: Array<{ _id: string; _source: any }> } };
      const events = body.hits.hits.map((hit) => {
        const s = hit._source;
        return {
          id: hit._id,
          service: s["service.name"] ?? s.service?.name ?? "unknown",
          environment: s["service.environment"] ?? s.service?.environment ?? "production",
          severity: (s["log.level"] === "fatal" ? "critical" : "high") as Severity,
          occurredAt: s["@timestamp"],
          version: s["service.version"] ?? s.service?.version ?? "",
          exceptionType: s["error.type"] ?? s.error?.type ?? "Error",
          message: s["error.message"] ?? s.error?.message ?? "",
          stackTrace: s["error.stack_trace"] ?? s.error?.stack_trace ?? "",
          traceId:
            s["trace.id"] ?? s.trace?.id ?? s["transaction.id"] ?? s.transaction?.id ?? null,
        };
      });

      return { events, cursor: { position: newest(events, since) } };
    },
  };
}

function newest(events: LogEvent[], fallback: string | null): string | null {
  return events.reduce<string | null>(
    (max, e) => (max === null || e.occurredAt > max ? e.occurredAt : max),
    fallback,
  );
}

/**
 * Events pushed to POST /ingest rather than polled.
 *
 * The cursor is the last consumed row id. Rows are left in place rather than
 * deleted on read, so a crash mid-run replays the window instead of losing it;
 * `prune` clears what is safely behind the cursor.
 */
export function httpSource(db: D1Database): LogSource {
  return {
    name: "http",
    async fetch(cursor) {
      const after = Number(cursor?.position ?? 0) || 0;
      const { results } = await db
        .prepare(
          `SELECT id, payload_json FROM inbox WHERE id > ?1 ORDER BY id LIMIT 50`,
        )
        .bind(after)
        .all<{ id: number; payload_json: string }>();

      const rows = results ?? [];
      const events: LogEvent[] = [];
      let highest = after;

      for (const row of rows) {
        highest = Math.max(highest, row.id);
        try {
          events.push(normalisePushed(JSON.parse(row.payload_json), row.id));
        } catch {
          // A single malformed payload must not stall the whole queue behind
          // it; the cursor still advances past this row.
        }
      }

      return { events, cursor: { position: String(highest) } };
    },
  };
}

/** Shapes a pushed payload into a LogEvent, filling in what it omits. */
export function normalisePushed(raw: any, id: number | string): LogEvent {
  const severity = String(raw.severity ?? "high").toLowerCase();
  return {
    id: String(raw.id ?? `inbox-${id}`),
    service: String(raw.service ?? "unknown"),
    environment: String(raw.environment ?? "production"),
    severity: (["critical", "high", "medium", "low"].includes(severity)
      ? severity
      : "high") as Severity,
    occurredAt: String(raw.occurredAt ?? raw.timestamp ?? new Date().toISOString()),
    version: String(raw.version ?? ""),
    exceptionType: String(raw.exceptionType ?? raw.type ?? "Error"),
    message: String(raw.message ?? ""),
    stackTrace: String(raw.stackTrace ?? raw.stack ?? ""),
    traceId: raw.traceId ?? raw.trace_id ?? null,
  };
}
