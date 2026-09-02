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

  // ---- log sources ----
  SENTRY_TOKEN?: string;
  SENTRY_ORG?: string;
  SENTRY_PROJECT?: string;
  /** Self-hosted Sentry. Defaults to https://sentry.io. */
  SENTRY_URL?: string;
  DATADOG_API_KEY?: string;
  DATADOG_APP_KEY?: string;
  /** e.g. datadoghq.eu. Defaults to datadoghq.com. */
  DATADOG_SITE?: string;
  /** Overrides the default `status:error` search. */
  DATADOG_QUERY?: string;

  // ---- code hosts ----
  GITLAB_TOKEN?: string;
  /** Self-managed GitLab. Defaults to https://gitlab.com. */
  GITLAB_URL?: string;
  AZDO_TOKEN?: string;
  AZDO_ORG?: string;
  AZDO_PROJECT?: string;

  // ---- issue trackers ----
  JIRA_URL?: string;
  JIRA_EMAIL?: string;
  JIRA_TOKEN?: string;
  JIRA_PROJECT_KEY?: string;
  JIRA_ISSUE_TYPE?: string;
  LINEAR_TOKEN?: string;
  LINEAR_TEAM_ID?: string;
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
  /**
   * Set by sources that already know which frame is the application's —
   * Sentry tags every frame with `in_app`, which is better information than
   * re-deriving it from rendered text. Null means "parse the stack trace".
   */
  resolvedFrame?: StackFrame | null;
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
  /** Real source around the failing line, when the repo could be read. */
  source: { path: string; startLine: number; lines: string[] } | null;
  /** What the recent commits actually changed in that file. */
  diffs: Array<{ sha: string; patch: string }>;
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
  /** This deployment's own origin, so posted briefs can link back to it. */
  base_url: string;
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
