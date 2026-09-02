import type { CursorState, Env, FetchResult, LogEvent, Severity, StackFrame } from "../types";
import { callExternal, expectOk } from "./http";
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

      const res = await callExternal(`${base}/logs-*/_search`, {
        what: "elasticsearch",
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
 * deleted on read, so a crash mid-run replays the window instead of losing it,
 * and are cleared later once they are safely behind the cursor.
 */
const INBOX_RETENTION_DAYS = 7;

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

      /**
       * Clear what is both already consumed and old. Bounded by the cursor as
       * it stood at the *start* of this fetch, so nothing read in this run is
       * removed, and by age, so a recent window can still be replayed by hand.
       * Without this the table grew for ever.
       */
      const cutoff = new Date(
        Date.now() - INBOX_RETENTION_DAYS * 24 * 60 * 60 * 1000,
      ).toISOString();
      await db
        .prepare(`DELETE FROM inbox WHERE id <= ?1 AND received_at < ?2`)
        .bind(after, cutoff)
        .run();

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

/**
 * Sentry.
 *
 * Sentry has already done the work this pipeline would otherwise do from text:
 * every frame carries `in_app`, so the application frame is known rather than
 * inferred. That frame is passed through as `resolvedFrame` and a readable
 * trace is rendered alongside it for the brief and the incident page.
 *
 * The cursor is the last event's dateCreated. Sentry returns newest-first, so
 * the page is reversed before the pipeline sees it — every source in here
 * yields oldest-first.
 */
export function sentrySource(env: Env): LogSource {
  const host = (env.SENTRY_URL || "https://sentry.io").replace(/\/+$/, "");
  const org = env.SENTRY_ORG ?? "";
  const project = env.SENTRY_PROJECT ?? "";

  return {
    name: "sentry",
    async fetch(cursor) {
      const res = await callExternal(`${host}/api/0/projects/${org}/${project}/events/?full=true`, {
        what: "sentry",
        headers: { authorization: `Bearer ${env.SENTRY_TOKEN}`, accept: "application/json" },
      });
      if (!res.ok) {
        throw new Error(`sentry ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }

      const since = cursor?.position ?? null;
      const body = (await res.json()) as any[];
      const events: LogEvent[] = [];

      for (const e of Array.isArray(body) ? body.slice().reverse() : []) {
        const occurredAt = e.dateCreated ?? e.dateReceived ?? new Date().toISOString();
        if (since && occurredAt <= since) continue;

        const exception = (e.entries ?? []).find((x: any) => x.type === "exception");
        const value = exception?.data?.values?.[exception.data.values.length - 1];
        const frames: any[] = value?.stacktrace?.frames ?? [];

        events.push({
          id: String(e.eventID ?? e.id ?? occurredAt),
          // Sentry has no standard service field: the project is the unit.
          // A `service` tag wins where clients set one.
          service: tagOf(e, "service") ?? project ?? "unknown",
          environment: tagOf(e, "environment") ?? "production",
          severity: e.level === "fatal" ? "critical" : "high",
          occurredAt,
          version: tagOf(e, "release") ?? "",
          exceptionType: String(value?.type ?? e.type ?? "Error"),
          message: String(value?.value ?? e.title ?? e.message ?? ""),
          stackTrace: renderSentryFrames(value?.type, value?.value, frames),
          traceId: tagOf(e, "trace") ?? null,
          resolvedFrame: sentryAppFrame(frames),
        });
      }

      return { events, cursor: { position: newest(events, since) } };
    },
  };
}

function tagOf(e: any, key: string): string | null {
  const tag = (e.tags ?? []).find((t: any) => t.key === key);
  return tag?.value ?? null;
}

/** Sentry orders frames oldest-first; the deepest in_app frame is the fault. */
function sentryAppFrame(frames: any[]): StackFrame | null {
  for (let i = frames.length - 1; i >= 0; i--) {
    const f = frames[i];
    if (f?.inApp === true || f?.in_app === true) {
      return {
        fn: String(f.function ?? "unknown"),
        file: String(f.filename ?? f.absPath ?? f.module ?? "unknown"),
        line: Number(f.lineNo ?? f.lineno ?? 0),
      };
    }
  }
  return null;
}

function renderSentryFrames(type: string | undefined, value: string | undefined, frames: any[]): string {
  const head = `${type ?? "Error"}: ${value ?? ""}`;
  const body = frames
    .slice()
    .reverse()
    .map(
      (f) =>
        `    at ${f.function ?? "unknown"} (${f.filename ?? f.absPath ?? "unknown"}:${f.lineNo ?? f.lineno ?? 0}:0)`,
    );
  return [head, ...body].join("\n");
}

/**
 * Datadog logs.
 *
 * Errors arrive as flat attributes rather than a structured exception, so the
 * stack trace is whatever the application logged and the language matchers do
 * the attribution.
 */
export function datadogSource(env: Env): LogSource {
  const site = env.DATADOG_SITE || "datadoghq.com";

  return {
    name: "datadog",
    async fetch(cursor) {
      const since = cursor?.position ?? null;
      const res = await callExternal(`https://api.${site}/api/v2/logs/events/search`, {
        what: "datadog",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "DD-API-KEY": env.DATADOG_API_KEY ?? "",
          "DD-APPLICATION-KEY": env.DATADOG_APP_KEY ?? "",
        },
        body: JSON.stringify({
          filter: {
            query: env.DATADOG_QUERY || "status:error",
            from: since ?? "now-1h",
            to: "now",
          },
          sort: "timestamp",
          page: { limit: 50 },
        }),
      });

      if (!res.ok) {
        throw new Error(`datadog ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }

      const body = (await res.json()) as { data?: any[] };
      const events: LogEvent[] = (body.data ?? []).map((row) => {
        const a = row.attributes ?? {};
        const attrs = a.attributes ?? {};
        return {
          id: String(row.id ?? a.timestamp ?? ""),
          service: String(a.service ?? attrs.service ?? "unknown"),
          environment: String(attrs.env ?? a.env ?? "production"),
          severity: (String(a.status ?? "").toLowerCase() === "critical"
            ? "critical"
            : "high") as Severity,
          occurredAt: String(a.timestamp ?? new Date().toISOString()),
          version: String(attrs.version ?? ""),
          exceptionType: String(attrs.error?.kind ?? attrs["error.kind"] ?? "Error"),
          message: String(attrs.error?.message ?? attrs["error.message"] ?? a.message ?? ""),
          stackTrace: String(attrs.error?.stack ?? attrs["error.stack"] ?? ""),
          traceId: attrs.dd?.trace_id ?? attrs["dd.trace_id"] ?? null,
        };
      });

      return { events, cursor: { position: newest(events, since) } };
    },
  };
}

