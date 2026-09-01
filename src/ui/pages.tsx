import type { ReactNode } from "react";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Banner } from "@cloudflare/kumo/components/banner";
import { Breadcrumbs } from "@cloudflare/kumo/components/breadcrumbs";
import { Button } from "@cloudflare/kumo/components/button";
import { Empty } from "@cloudflare/kumo/components/empty";
import { Input } from "@cloudflare/kumo/components/input";
import { Link } from "@cloudflare/kumo/components/link";
import { Meter } from "@cloudflare/kumo/components/meter";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Table } from "@cloudflare/kumo/components/table";
import { Text } from "@cloudflare/kumo/components/text";
import { Toolbar } from "@cloudflare/kumo/components/toolbar";

import type { EventRow, IncidentWithBrief, Metrics, ServiceStat } from "../db/queries";
import { relativeTime } from "../slack/blocks";
import type { BriefRow, Commit, IncidentRow, ServiceRow, SettingsRow } from "../types";
import { Island } from "./islands";
import { Columns, KeyValue, PageHeader, Panel, PanelBody, Shell } from "./shell";

export interface Filters {
  service?: string;
  severity?: string;
  status?: string;
  q?: string;
}

const SEVERITY_BADGE: Record<string, "red" | "orange" | "blue" | "neutral"> = {
  critical: "red",
  high: "orange",
  medium: "blue",
  low: "neutral",
};

const SEVERITY_DOT: Record<string, string> = {
  critical: "bg-kumo-danger",
  high: "bg-kumo-warning",
  medium: "bg-kumo-info",
  low: "bg-kumo-fill",
};

const SEVERITY_ORDER = ["critical", "high", "medium", "low"] as const;

function haltReason(s: SettingsRow) {
  return s.kill_switch ? s.kill_switch_reason || "no reason given" : null;
}

function Time({ iso, children }: { iso?: string | null; children: ReactNode }) {
  return iso ? (
    <time dateTime={iso} title={iso}>
      {children}
    </time>
  ) : (
    <>{children}</>
  );
}

/**
 * Row height has to be predictable for the table to scan well, and CSS
 * line-clamp cannot constrain a cell in an auto-layout table — the column just
 * grows. Clamping the string is the reliable fix.
 */
function clamp(text: string, max = 150): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > max - 24 ? lastSpace : max).trimEnd()}…`;
}

function safeParse<T>(json: string): T[] {
  try {
    const p = JSON.parse(json);
    return Array.isArray(p) ? p : [];
  } catch {
    return [];
  }
}

/** Coarse triage state, which is what someone actually filters on. */
function bucket(i: IncidentWithBrief): string {
  if (i.ticket_url) return "filed";
  if (i.disposition === "not_helpful" || i.disposition === "cost_me_time") return "dismissed";
  if (i.status === "unmapped") return "unmapped";
  return "open";
}

/** Free-text match across the fields someone would actually search by. */
function matchesQuery(i: IncidentWithBrief, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return [i.service, i.exception_type, i.message, i.summary, i.suspected_cause, i.cited_file, i.version, i.team]
    .filter(Boolean)
    .some((v) => String(v).toLowerCase().includes(needle));
}

function StatePill({ i }: { i: IncidentWithBrief }) {
  if (i.resolution === "cause_confirmed") return <Badge variant="green">cause right</Badge>;
  if (i.resolution === "cause_wrong") return <Badge variant="red">cause wrong</Badge>;
  if (i.ticket_url) return <Badge variant="green">filed</Badge>;
  if (i.disposition === "cost_me_time") return <Badge variant="red">wrong way</Badge>;
  if (i.disposition === "not_helpful") return <Badge variant="neutral">dismissed</Badge>;
  if (i.status === "unmapped") return <Badge variant="neutral">unmapped</Badge>;
  return <Badge variant="blue">open</Badge>;
}

/* ------------------------------------------------------------- onboarding */

/**
 * A fresh install lands here, so this has to teach rather than say "no data".
 * Which message shows depends on how far through setup they actually are.
 */
function FirstRun({ hasServices, adminLocked }: { hasServices: boolean; adminLocked: boolean }) {
  return (
    <div className="rounded-xl border border-kumo-line bg-kumo-base p-8">
      <h2 className="m-0">
        <Text variant="heading">
          {hasServices ? "Waiting for the first error" : "Finish setting up"}
        </Text>
      </h2>
      <div className="mt-1 mb-5 max-w-[64ch]">
        <Text variant="secondary" size="sm">
          {hasServices
            ? "Your services are registered. FixBat writes a brief the first time one of them throws — the cron polls every 5 minutes, or you can run the pipeline now."
            : "FixBat only diagnoses services listed in the registry, so nothing will appear here until you add one. Setup takes about a minute and needs no terminal."}
        </Text>
      </div>

      <a
        href="/setup"
        className="inline-flex items-center gap-2 rounded-lg bg-kumo-brand px-4 py-2 text-sm font-semibold text-white no-underline hover:opacity-90"
      >
        {hasServices ? "Open setup" : "Start setup"} &rarr;
      </a>

      {!adminLocked ? (
        <div className="mt-5 rounded-lg border border-kumo-danger bg-kumo-danger/10 p-3">
          <Text size="sm">
            <strong>ADMIN_TOKEN is not set.</strong> Every admin endpoint on this deployment is
            open. Run <code className="font-mono">npm run setup</code> before exposing it.
          </Text>
        </div>
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------------- overview */

/** Severity counts, as filter links. The fastest read of "what is on fire". */
function SeverityStrip({ all, f }: { all: IncidentWithBrief[]; f: Filters }) {
  const open = all.filter((i) => bucket(i) === "open");
  const counts = SEVERITY_ORDER.map((s) => ({
    severity: s,
    total: open.filter((i) => i.severity === s).length,
  })).filter((c) => c.total > 0);

  if (!counts.length) return null;

  return (
    <div className="mb-4 flex flex-wrap gap-2">
      {counts.map((c) => {
        const on = f.severity === c.severity;
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries({ ...f, severity: on ? undefined : c.severity }))
          if (v) qs.set(k, v);
        return (
          <a
            key={c.severity}
            href={qs.toString() ? `/?${qs}` : "/"}
            aria-pressed={on}
            className={`flex items-baseline gap-2 rounded-lg border px-3 py-2 no-underline ${
              on
                ? "border-kumo-brand bg-kumo-brand/10"
                : "border-kumo-line bg-kumo-base hover:bg-kumo-elevated"
            }`}
          >
            <span className={`h-2 w-2 flex-none self-center rounded-full ${SEVERITY_DOT[c.severity]}`} />
            <span className="text-lg font-semibold tabular-nums text-kumo-strong">{c.total}</span>
            <Text variant="secondary" size="xs">
              {c.severity} open
            </Text>
          </a>
        );
      })}
    </div>
  );
}

function FilterBar({ all, f }: { all: IncidentWithBrief[]; f: Filters }) {
  const chip = (patch: Filters, label: string, n: number, on: boolean) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...f, ...patch })) if (v) qs.set(k, v);
    return (
      <a
        key={label}
        href={qs.toString() ? `/?${qs}` : "/"}
        aria-pressed={on}
        className={
          on
            ? "inline-flex items-center gap-1.5 rounded-md bg-kumo-brand px-2 py-0.5 text-xs font-semibold text-white no-underline"
            : "inline-flex items-center gap-1.5 rounded-md border border-kumo-line bg-kumo-base px-2 py-0.5 text-xs text-kumo-subtle no-underline hover:bg-kumo-tint hover:text-kumo-default"
        }
      >
        {label}
        <span className="tabular-nums opacity-65">{n}</span>
      </a>
    );
  };

  const services = [...new Set(all.map((i) => i.service))].sort();
  const states = (["open", "filed", "dismissed", "unmapped"] as const).filter((s) =>
    all.some((i) => bucket(i) === s),
  );
  const dirty = Boolean(f.service || f.severity || f.status || f.q);

  return (
    <Toolbar
      aria-label="Filter incidents"
      className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border border-kumo-line bg-kumo-elevated px-3 py-2"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <Text variant="secondary" size="xs">
          service
        </Text>
        {services.map((s) =>
          chip(
            { service: f.service === s ? undefined : s },
            s,
            all.filter((i) => i.service === s).length,
            f.service === s,
          ),
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Text variant="secondary" size="xs">
          state
        </Text>
        {states.map((s) =>
          chip(
            { status: f.status === s ? undefined : s },
            s,
            all.filter((i) => bucket(i) === s).length,
            f.status === s,
          ),
        )}
      </div>
      {dirty ? (
        <a
          href="/"
          className="inline-flex items-center rounded-md border border-dashed border-kumo-line px-2 py-0.5 text-xs text-kumo-subtle no-underline hover:text-kumo-default"
        >
          clear
        </a>
      ) : null}
      <span className="flex-1" />
      <form method="get" action="/" className="w-56">
        {f.service ? <input type="hidden" name="service" value={f.service} /> : null}
        {f.severity ? <input type="hidden" name="severity" value={f.severity} /> : null}
        {f.status ? <input type="hidden" name="status" value={f.status} /> : null}
        <Input
          type="search"
          name="q"
          size="sm"
          defaultValue={f.q ?? ""}
          placeholder="Search briefs…"
          aria-label="Search incident briefs"
        />
      </form>
    </Toolbar>
  );
}

/**
 * A dense table, not cards. Triage means scanning thirty incidents, so each one
 * gets a row: severity, where, what, how often, how recent, what state.
 */
function IncidentTable({ rows }: { rows: IncidentWithBrief[] }) {
  return (
    <LayerCard className="overflow-hidden p-0">
      <Table layout="auto">
        <Table.Header>
          <Table.Row>
            <Table.Head className="w-8" aria-label="Severity" />
            <Table.Head>Service</Table.Head>
            <Table.Head>Error</Table.Head>
            <Table.Head>Suspected cause</Table.Head>
            <Table.Head className="text-right">Seen</Table.Head>
            <Table.Head className="text-right">Last</Table.Head>
            <Table.Head>State</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {rows.map((i) => (
            <Table.Row key={i.id}>
              <Table.Cell className="align-top">
                <span
                  title={i.severity}
                  className={`mt-1.5 block h-2 w-2 rounded-full ${SEVERITY_DOT[i.severity]}`}
                />
              </Table.Cell>
              <Table.Cell className="align-top">
                <a href={`/incident/${i.id}`} className="font-mono text-xs font-semibold no-underline">
                  {i.service}
                </a>
                {i.team ? (
                  <div className="mt-0.5">
                    <Text variant="secondary" size="xs">
                      {i.team}
                    </Text>
                  </div>
                ) : null}
              </Table.Cell>
              <Table.Cell className="max-w-[15rem] align-top">
                <a href={`/incident/${i.id}`} className="text-xs no-underline">
                  {i.exception_type}
                </a>
                {i.cited_file ? (
                  <div className="mt-0.5 truncate font-mono text-[11px] text-kumo-subtle">
                    {i.cited_file}
                    {i.cited_line ? `:${i.cited_line}` : ""}
                  </div>
                ) : null}
              </Table.Cell>
              <Table.Cell className="max-w-[28rem] align-top">
                <a href={`/incident/${i.id}`} className="block text-xs leading-5 no-underline">
                  {clamp(i.suspected_cause || i.summary || i.message)}
                </a>
              </Table.Cell>
              <Table.Cell className="text-right align-top font-mono text-xs tabular-nums text-kumo-subtle">
                {i.occurrences}&times;
              </Table.Cell>
              <Table.Cell className="text-right align-top font-mono text-xs whitespace-nowrap text-kumo-subtle">
                <Time iso={i.last_seen}>{relativeTime(i.last_seen)}</Time>
              </Table.Cell>
              <Table.Cell className="align-top">
                <StatePill i={i} />
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    </LayerCard>
  );
}

export function IncidentsPage({
  all,
  slackLive,
  settings,
  filters,
  mode,
  cssHref,
  jsHref,
  serviceCount,
  adminLocked,
  who,
}: {
  all: IncidentWithBrief[];
  slackLive: boolean;
  settings: SettingsRow;
  filters: Filters;
  mode?: string;
  cssHref: string;
  jsHref?: string;
  serviceCount: number;
  adminLocked: boolean;
  who?: string | null;
}) {
  const shown = all
    .filter(
      (i) =>
        (!filters.service || i.service === filters.service) &&
        (!filters.severity || i.severity === filters.severity) &&
        (!filters.status || bucket(i) === filters.status) &&
        (!filters.q || matchesQuery(i, filters.q)),
    )
    // Open work first, then most severe, then most recent.
    .sort((a, b) => {
      const openDiff = Number(bucket(b) === "open") - Number(bucket(a) === "open");
      if (openDiff) return openDiff;
      const sev = SEVERITY_ORDER.indexOf(a.severity as never) - SEVERITY_ORDER.indexOf(b.severity as never);
      if (sev) return sev;
      return b.last_seen.localeCompare(a.last_seen);
    });

  const active = Boolean(filters.service || filters.severity || filters.status || filters.q);
  const open = all.filter((i) => bucket(i) === "open").length;

  return (
    <Shell
      cssHref={cssHref}
      jsHref={jsHref}
      title="FixBat — incidents"
      active="incidents"
      halted={haltReason(settings)}
      mode={mode}
      who={who}
    >
      <PageHeader
        title="Incidents"
        sub={
          slackLive
            ? "Briefs are posted to Slack as they are written."
            : "Slack is not configured — briefs are generated and stored, but not posted."
        }
        stats={[
          { label: "needs triage", value: open },
          { label: "incidents", value: all.length },
          { label: "occurrences", value: all.reduce((n, i) => n + i.occurrences, 0) },
        ]}
      />

      {all.length === 0 ? (
        <FirstRun hasServices={serviceCount > 0} adminLocked={adminLocked} />
      ) : (
        <>
          <SeverityStrip all={all} f={filters} />
          <FilterBar all={all} f={filters} />
          {shown.length ? (
            <>
              <IncidentTable rows={shown} />
              {active ? (
                <div className="mt-2">
                  <Text variant="secondary" size="xs">
                    Showing {shown.length} of {all.length}.
                  </Text>
                </div>
              ) : null}
            </>
          ) : (
            <Empty
              title={filters.q ? `Nothing matches “${filters.q}”` : "No incidents match this filter"}
              description="Try widening the search, or clear the filters."
              contents={<Link href="/">Clear filters</Link>}
            />
          )}
        </>
      )}
    </Shell>
  );
}

/* ---------------------------------------------------------------- detail */

export interface DetailInput {
  incident: IncidentRow;
  brief: BriefRow | null;
  service: ServiceRow | null;
  events: EventRow[];
  ticketUrl: string | null;
  disposition?: string | null;
  error?: string;
  settings: SettingsRow;
  cssHref: string;
  jsHref?: string;
  who?: string | null;
}

export function IncidentPage(d: DetailInput) {
  const { incident, brief, service } = d;
  const commits: Commit[] = brief ? safeParse(brief.cited_commits) : [];
  const questions: string[] = brief ? safeParse(brief.open_questions) : [];

  return (
    <Shell
      cssHref={d.cssHref}
      jsHref={d.jsHref}
      title={`${incident.service} — ${incident.exception_type}`}
      active="incidents"
      halted={haltReason(d.settings)}
      who={d.who}
    >
      <PageHeader
        crumbs={
          <Breadcrumbs size="sm">
            <Breadcrumbs.Link href="/">Incidents</Breadcrumbs.Link>
            <Breadcrumbs.Separator />
            <Breadcrumbs.Link href={`/?service=${encodeURIComponent(incident.service)}`}>
              {incident.service}
            </Breadcrumbs.Link>
            <Breadcrumbs.Separator />
            <Breadcrumbs.Current>{incident.exception_type}</Breadcrumbs.Current>
          </Breadcrumbs>
        }
        title={incident.exception_type}
        sub={incident.message}
        stats={[
          { label: "occurrences", value: incident.occurrences },
          {
            label: "severity",
            value: <Badge variant={SEVERITY_BADGE[incident.severity] ?? "neutral"}>{incident.severity}</Badge>,
          },
        ]}
      />

      <Panel title="Brief">
        <PanelBody>
          {brief ? (
            <>
              <div className="mb-4 max-w-[80ch]">
                <Text size="base">{brief.summary}</Text>
              </div>
              <KeyValue
                rows={[
                  ["Suspected cause", brief.suspected_cause],
                  ["What changed", brief.what_changed],
                  ...(brief.cited_file
                    ? ([
                        [
                          "Where",
                          <Link
                            href={`https://github.com/${service?.repo ?? ""}/blob/HEAD/${brief.cited_file}${brief.cited_line ? `#L${brief.cited_line}` : ""}`}
                            className="font-mono text-xs"
                          >
                            {brief.cited_file}
                            {brief.cited_line ? `:${brief.cited_line}` : ""}
                          </Link>,
                        ],
                      ] as Array<[string, ReactNode]>)
                    : []),
                  ...(questions.length
                    ? ([
                        [
                          "First checks",
                          <ol className="m-0 list-decimal space-y-1 pl-4">
                            {questions.map((q, n) => (
                              <li key={n}>{q}</li>
                            ))}
                          </ol>,
                        ],
                      ] as Array<[string, ReactNode]>)
                    : []),
                  ...(commits.length
                    ? ([
                        [
                          "Commits",
                          <div className="space-y-1">
                            {commits.map((c) => (
                              <div key={c.sha}>
                                <Link href={c.url} className="font-mono text-xs">
                                  {c.shortSha}
                                </Link>{" "}
                                {c.message}{" "}
                                <span className="text-kumo-subtle">
                                  — {c.author}, <Time iso={c.committedAt}>{relativeTime(c.committedAt)}</Time>
                                </span>
                              </div>
                            ))}
                          </div>,
                        ],
                      ] as Array<[string, ReactNode]>)
                    : []),
                ]}
              />
            </>
          ) : (
            <Text variant="secondary" size="sm">
              No brief — status is {incident.status}.
            </Text>
          )}
        </PanelBody>
      </Panel>

      {d.error ? (
        <div className="mb-3">
          <Banner variant="error">Could not file the issue: {d.error}</Banner>
        </div>
      ) : null}

      <Panel title="Triage">
        <PanelBody>
          {d.ticketUrl ? (
            <Text size="sm">
              Issue filed — <Link href={d.ticketUrl}>{d.ticketUrl}</Link>
            </Text>
          ) : d.disposition === "not_helpful" || d.disposition === "cost_me_time" ? (
            <Text size="sm">
              Dismissed as{" "}
              <strong>{d.disposition === "cost_me_time" ? "time lost" : "not helpful"}</strong>.
            </Text>
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                <form method="post" action={`/incident/${incident.id}/file`}>
                  <Button type="submit" variant="primary">
                    File issue
                  </Button>
                </form>
                <form method="post" action={`/incident/${incident.id}/dismiss`}>
                  <input type="hidden" name="kind" value="not_helpful" />
                  <Button type="submit" variant="secondary">
                    Not helpful
                  </Button>
                </form>
                <form method="post" action={`/incident/${incident.id}/dismiss`}>
                  <input type="hidden" name="kind" value="cost_me_time" />
                  <Button type="submit" variant="secondary">
                    Sent me the wrong way
                  </Button>
                </form>
              </div>
              <div className="mt-3 max-w-[70ch]">
                <Text variant="secondary" size="sm">
                  The same actions the Slack buttons take. &ldquo;Sent me the wrong way&rdquo; is
                  worth recording — a confidently wrong brief is the failure mode that makes this
                  tool net-negative, and it is invisible if nobody can report it.
                </Text>
              </div>
            </>
          )}
        </PanelBody>
      </Panel>

      <Panel title="Was the suspected cause right?">
        <PanelBody>
          {incident.resolution ? (
            <Text size="sm">
              Recorded as{" "}
              <strong>{incident.resolution === "cause_confirmed" ? "correct" : "wrong"}</strong>
              {incident.resolved_by ? ` by ${incident.resolved_by}` : ""},{" "}
              <Time iso={incident.resolved_at}>{relativeTime(incident.resolved_at ?? "")}</Time>.
            </Text>
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                <form method="post" action={`/incident/${incident.id}/resolve`}>
                  <input type="hidden" name="resolution" value="cause_confirmed" />
                  <Button type="submit" variant="secondary">
                    Cause was right
                  </Button>
                </form>
                <form method="post" action={`/incident/${incident.id}/resolve`}>
                  <input type="hidden" name="resolution" value="cause_wrong" />
                  <Button type="submit" variant="secondary">
                    Cause was wrong
                  </Button>
                </form>
              </div>
              <div className="mt-3 max-w-[70ch]">
                <Text variant="secondary" size="sm">
                  The only signal that measures whether the diagnosis was correct. Filing an issue
                  says it was worth acting on, which is a different thing.
                </Text>
              </div>
            </>
          )}
        </PanelBody>
      </Panel>

      <Columns>
        <Panel title="Details">
          <PanelBody>
            <KeyValue
              rows={[
                [
                  "Service",
                  <>
                    {incident.service}
                    {service?.team ? <span className="text-kumo-subtle"> ({service.team})</span> : null}
                  </>,
                ],
                ["Repo", service ? service.repo : <span className="text-kumo-subtle">unmapped</span>],
                ["Environment", incident.environment],
                ["Version", incident.version || "unknown"],
                ["Status", incident.status],
                ["First seen", <Time iso={incident.first_seen}>{relativeTime(incident.first_seen)}</Time>],
                ["Last seen", <Time iso={incident.last_seen}>{relativeTime(incident.last_seen)}</Time>],
                [
                  "Fingerprint",
                  <Island name="copy" props={{ text: incident.fingerprint, label: "Copy fingerprint" }} />,
                ],
                ...(d.ticketUrl
                  ? ([["Issue", <Link href={d.ticketUrl}>{d.ticketUrl}</Link>]] as Array<[string, ReactNode]>)
                  : []),
                ...(brief
                  ? ([
                      [
                        "Brief cost",
                        brief.source === "simulated"
                          ? "simulated"
                          : `$${brief.spend_usd.toFixed(4)} · ${brief.model}`,
                      ],
                    ] as Array<[string, ReactNode]>)
                  : []),
              ]}
            />
          </PanelBody>
        </Panel>

        <Panel title="Timeline">
          {d.events.length ? (
            <Table>
              <Table.Body>
                {d.events.map((e) => (
                  <Table.Row key={e.id}>
                    <Table.Cell className="px-4 py-2 font-mono text-xs">{e.kind}</Table.Cell>
                    <Table.Cell className="px-4 py-2 text-xs text-kumo-subtle">{e.detail}</Table.Cell>
                    <Table.Cell className="px-4 py-2 text-right font-mono text-xs whitespace-nowrap text-kumo-subtle">
                      <Time iso={e.created_at}>{relativeTime(e.created_at)}</Time>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          ) : (
            <PanelBody>
              <Text variant="secondary" size="sm">
                No events.
              </Text>
            </PanelBody>
          )}
        </Panel>
      </Columns>

      <Panel title="Stack trace">
        <PanelBody>
          <Island name="trace" props={{ trace: incident.stack_trace }} />
        </PanelBody>
      </Panel>
    </Shell>
  );
}

/* --------------------------------------------------------------- metrics */

export function MetricsPage({
  m,
  settings,
  byService,
  cssHref,
  jsHref,
  who,
}: {
  m: Metrics;
  settings: SettingsRow;
  byService: ServiceStat[];
  cssHref: string;
  jsHref?: string;
  who?: string | null;
}) {
  const resolved = m.causeConfirmed + m.causeWrong;
  const rate = resolved ? Math.round((m.causeConfirmed / resolved) * 100) : null;

  return (
    <Shell
      cssHref={cssHref}
      jsHref={jsHref}
      title="FixBat — measurement"
      active="metrics"
      halted={haltReason(settings)}
      who={who}
    >
      <PageHeader
        title="Measurement"
        sub="Precision is computed over resolved incidents only. A brief nobody resolved counts as unknown, never as correct."
      />

      <Columns>
        <Panel title="Hypothesis hit rate">
          <PanelBody>
            <div
              className={`text-3xl font-semibold tabular-nums ${
                rate === null ? "text-kumo-subtle" : rate >= 60 ? "text-kumo-success" : "text-kumo-danger"
              }`}
            >
              {rate === null ? "—" : `${rate}%`}
            </div>
            {resolved ? (
              <div className="my-3">
                <Meter label="Correct diagnoses" value={m.causeConfirmed} max={resolved} showValue />
              </div>
            ) : (
              <div className="my-3 h-1.5 rounded-full bg-kumo-fill" aria-hidden="true" />
            )}
            <div className="flex flex-wrap gap-3">
              <Text variant="secondary" size="xs">
                {m.causeConfirmed} right · {m.causeWrong} wrong · {m.unresolved} unresolved
              </Text>
            </div>
            <div className="mt-3">
              <Text variant="secondary" size="sm">
                {resolved
                  ? `Correct on ${m.causeConfirmed} of ${resolved} resolved briefs. ${m.unresolved} never resolved.`
                  : "Nothing has been resolved yet, so there is no precision number. That is the honest answer, not a zero."}
              </Text>
            </div>
          </PanelBody>
        </Panel>

        <Panel title="Adoption">
          <PanelBody>
            <KeyValue
              rows={[
                ["Filed", m.filed],
                ["Not helpful", m.dismissedNotHelpful],
                ["Sent wrong way", m.dismissedHarmful],
                ["No response", m.undispositioned],
                ["Unmapped", m.unmapped],
              ]}
            />
            <div className="mt-3">
              <Text variant="secondary" size="sm">
                Filing measures whether a brief was worth acting on — useful, but not the same as
                whether the diagnosis was right.
              </Text>
            </div>
          </PanelBody>
        </Panel>

        <Panel title="Volume & cost">
          <PanelBody>
            <KeyValue
              rows={[
                ["Incidents", m.total],
                ["Occurrences", m.occurrences],
                ["Deduped away", Math.max(0, m.occurrences - m.total)],
                ["Total spend", `$${m.spendUsd.toFixed(4)}`],
                ["Median brief", `${m.medianBriefMs} ms`],
                ["Daily limit", settings.daily_brief_limit],
              ]}
            />
          </PanelBody>
        </Panel>
      </Columns>

      <Panel title="By service">
        {byService.length ? (
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.Head className="px-4 py-2 text-xs font-semibold text-kumo-subtle">Service</Table.Head>
                <Table.Head className="px-4 py-2 text-right text-xs font-semibold text-kumo-subtle">Incidents</Table.Head>
                <Table.Head className="px-4 py-2 text-right text-xs font-semibold text-kumo-subtle">Occurrences</Table.Head>
                <Table.Head className="px-4 py-2 text-right text-xs font-semibold text-kumo-subtle">Filed</Table.Head>
                <Table.Head className="px-4 py-2 text-right text-xs font-semibold text-kumo-subtle">Resolved</Table.Head>
                <Table.Head className="px-4 py-2 text-xs font-semibold text-kumo-subtle">Hit rate</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {byService.map((s) => {
                const res = s.confirmed + s.wrong;
                const r = res ? Math.round((s.confirmed / res) * 100) : null;
                return (
                  <Table.Row key={s.service}>
                    <Table.Cell className="px-4 py-2">
                      <Link href={`/?service=${encodeURIComponent(s.service)}`} className="font-mono text-xs">
                        {s.service}
                      </Link>
                    </Table.Cell>
                    <Table.Cell className="px-4 py-2 text-right font-mono text-xs tabular-nums">{s.incidents}</Table.Cell>
                    <Table.Cell className="px-4 py-2 text-right font-mono text-xs tabular-nums">{s.occurrences}</Table.Cell>
                    <Table.Cell className="px-4 py-2 text-right font-mono text-xs tabular-nums">{s.filed}</Table.Cell>
                    <Table.Cell className="px-4 py-2 text-right font-mono text-xs tabular-nums">{res}</Table.Cell>
                    <Table.Cell className="w-40 px-4 py-2">
                      {r === null ? (
                        <Text variant="secondary" size="xs">
                          —
                        </Text>
                      ) : (
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs tabular-nums">{r}%</span>
                          <div className="flex-1">
                            <Meter label={`${s.service} hit rate`} value={s.confirmed} max={res} />
                          </div>
                        </div>
                      )}
                    </Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table>
        ) : (
          <PanelBody>
            <Text variant="secondary" size="sm">
              No incidents yet.
            </Text>
          </PanelBody>
        )}
      </Panel>
    </Shell>
  );
}

/* -------------------------------------------------------------- services */

export function ServicesPage({
  services,
  settings,
  byService,
  cssHref,
  jsHref,
  adminLocked,
  who,
}: {
  services: ServiceRow[];
  settings: SettingsRow;
  byService: ServiceStat[];
  cssHref: string;
  jsHref?: string;
  adminLocked: boolean;
  who?: string | null;
}) {
  const stat = (name: string) => byService.find((s) => s.service === name);

  return (
    <Shell
      cssHref={cssHref}
      jsHref={jsHref}
      title="FixBat — services"
      active="services"
      halted={haltReason(settings)}
      who={who}
    >
      <PageHeader
        title="Service registry"
        sub="An error from a service with no entry here has no repository to correlate against, so it is recorded as unmapped rather than diagnosed."
        stats={[
          { label: "enabled", value: services.filter((s) => s.enabled).length },
          { label: "registered", value: services.length },
        ]}
      />

      <Panel title="Registered services">
        {services.length ? (
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.Head className="px-4 py-2 text-xs font-semibold text-kumo-subtle">Service</Table.Head>
                <Table.Head className="px-4 py-2 text-xs font-semibold text-kumo-subtle">Repo</Table.Head>
                <Table.Head className="px-4 py-2 text-xs font-semibold text-kumo-subtle">Channel</Table.Head>
                <Table.Head className="px-4 py-2 text-xs font-semibold text-kumo-subtle">Team</Table.Head>
                <Table.Head className="px-4 py-2 text-right text-xs font-semibold text-kumo-subtle">Incidents</Table.Head>
                <Table.Head className="px-4 py-2 text-xs font-semibold text-kumo-subtle">State</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {services.map((s) => (
                <Table.Row key={s.name}>
                  <Table.Cell className="px-4 py-2">
                    <Link href={`/?service=${encodeURIComponent(s.name)}`} className="font-mono text-xs">
                      {s.name}
                    </Link>
                  </Table.Cell>
                  <Table.Cell className="px-4 py-2 font-mono text-xs">{s.repo}</Table.Cell>
                  <Table.Cell className="px-4 py-2 font-mono text-xs">{s.slack_channel}</Table.Cell>
                  <Table.Cell className="px-4 py-2 text-xs">
                    {s.team || (
                      <Text variant="secondary" size="xs">
                        —
                      </Text>
                    )}
                  </Table.Cell>
                  <Table.Cell className="px-4 py-2 text-right font-mono text-xs tabular-nums">
                    {stat(s.name)?.incidents ?? 0}
                  </Table.Cell>
                  <Table.Cell className="px-4 py-2">
                    {s.enabled ? <Badge variant="green">enabled</Badge> : <Badge variant="neutral">disabled</Badge>}
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        ) : (
          <PanelBody>
            <Empty
              title="No services registered"
              description="FixBat records errors from unregistered services as unmapped and does not diagnose them."
            />
          </PanelBody>
        )}
      </Panel>

      <Panel title="Add a service">
        <PanelBody>
          <pre className="m-0 overflow-x-auto rounded-lg border border-kumo-hairline bg-kumo-recessed p-3 font-mono text-xs leading-6">
            {`curl -X POST /admin/services \\
  -H "authorization: Bearer $ADMIN_TOKEN" \\
  -H 'content-type: application/json' \\
  -d '{"name":"checkout-service","repo":"acme/checkout",
       "slack_channel":"#incidents","team":"Checkout"}'`}
          </pre>
        </PanelBody>
      </Panel>

      <Panel title="Controls">
        <PanelBody>
          <KeyValue
            rows={[
              [
                "Kill switch",
                settings.kill_switch ? (
                  <>
                    <Badge variant="red">active</Badge>{" "}
                    <span className="text-kumo-subtle">{settings.kill_switch_reason}</span>
                  </>
                ) : (
                  <Badge variant="green">off</Badge>
                ),
              ],
              ["Daily limit", `${settings.daily_brief_limit} briefs`],
              [
                "Admin API",
                adminLocked ? (
                  <Badge variant="green">locked</Badge>
                ) : (
                  <Badge variant="red">open — set ADMIN_TOKEN</Badge>
                ),
              ],
            ]}
          />
          <div className="mt-3 max-w-[70ch]">
            <Text variant="secondary" size="sm">
              Set through the admin API with a bearer token, so a stray click cannot pause the
              pipeline or change what it costs.
            </Text>
          </div>
        </PanelBody>
      </Panel>
    </Shell>
  );
}
