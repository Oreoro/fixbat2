export type Severity = "critical" | "high" | "medium" | "low";

export interface Env {
  DB: D1Database;
  ADMIN_TOKEN?: string;
  /** Set to "true" to make incident data readable without signing in. */
  PUBLIC_READ?: string;
  ANTHROPIC_API_KEY?: string;
  SLACK_BOT_TOKEN?: string;
  SLACK_SIGNING_SECRET?: string;
  GITHUB_TOKEN?: string;
  ELASTICSEARCH_URL?: string;
  ELASTICSEARCH_API_KEY?: string;
  /** Bearer credential for POST /ingest. Deliberately not ADMIN_TOKEN: it is
   *  distributed to every application that reports errors. */
  INGEST_TOKEN?: string;
}

/** One error event as it arrives from a log source. */
export interface LogEvent {
  id: string;
  service: string;
  environment: string;
  severity: Severity;
  occurredAt: string;
  version: string;
  exceptionType: string;
  message: string;
  stackTrace: string;
  /**
   * Correlation id for the request this error happened in, when the source
   * emits one. Context only — never part of the fingerprint, because a value
   * that is unique per request would give every occurrence its own identity.
   */
  traceId: string | null;
}

/**
 * Where a log source last read to. `base` is only used by the fixture source,
 * which needs a pinned origin for its relative timestamps.
 */
export interface CursorState {
  position: string | null;
  base?: string;
}

export interface FetchResult {
  events: LogEvent[];
  cursor: CursorState;
}

/** A frame we managed to attribute to the application (not a dependency). */
export interface StackFrame {
  fn: string;
  file: string;
  line: number;
}

export interface Commit {
  sha: string;
  shortSha: string;
  author: string;
  message: string;
  committedAt: string;
  url: string;
}

/** What the diagnoser is given. Deterministically assembled, never model-chosen. */
export interface Evidence {
  event: LogEvent;
  occurrences: number;
  frame: StackFrame | null;
  commits: Commit[];
  repo: string;
  team: string;
}

/** What the diagnoser returns. Typed fields, because the renderer needs them apart. */
export interface Brief {
  summary: string;
  suspectedCause: string;
  whatChanged: string;
  openQuestions: string[];
  citedFile: string | null;
  citedLine: number | null;
  citedCommits: string[];
}

export interface DiagnosisResult {
  brief: Brief;
  source: "simulated" | "anthropic";
  model: string;
  spendUsd: number;
  durationMs: number;
}

export type IncidentStatus =
  | "new"
  | "briefed"
  | "posted"
  | "filed"
  | "dismissed"
  | "unmapped";

export type Resolution = "cause_confirmed" | "cause_wrong";

export interface ServiceRow {
  name: string;
  repo: string;
  slack_channel: string;
  team: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface SettingsRow {
  id: number;
  kill_switch: number;
  kill_switch_reason: string;
  daily_brief_limit: number;
  /** Link target for a trace id, with a {traceId} placeholder. Empty = no link. */
  trace_url_template: string;
  /** 'auto' or an explicit source name. See chooseLogSource in index.tsx. */
  log_source: string;
  updated_at: string;
}

export interface IncidentRow {
  id: string;
  fingerprint: string;
  service: string;
  environment: string;
  severity: Severity;
  exception_type: string;
  message: string;
  stack_trace: string;
  version: string;
  occurrences: number;
  first_seen: string;
  last_seen: string;
  status: IncidentStatus;
  slack_channel: string | null;
  slack_ts: string | null;
  trace_id: string | null;
  resolution: Resolution | null;
  resolved_at: string | null;
  resolved_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface BriefRow {
  id: string;
  incident_id: string;
  summary: string;
  suspected_cause: string;
  what_changed: string;
  open_questions: string;
  cited_file: string | null;
  cited_line: number | null;
  cited_commits: string;
  source: string;
  model: string;
  spend_usd: number;
  duration_ms: number;
  created_at: string;
}
