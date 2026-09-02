import type { BriefRow, Commit, IncidentRow } from "../types";

const SEVERITY_DOT: Record<string, string> = {
  critical: "\u{1F534}",
  high: "\u{1F7E0}",
  medium: "\u{1F7E1}",
  low: "⚪",
};

export interface RenderInput {
  incident: IncidentRow;
  brief: BriefRow;
  repo: string;
  /** Built by the code host, because only it knows how its URLs are shaped. */
  fileHref?: string | null;
  /** This deployment's incident page, so the message can lead back to it. */
  incidentUrl?: string | null;
  ticketUrl?: string | null;
  /** Which tracker filed it — "GitHub" is not always the answer. */
  ticketProvider?: string | null;
  disposition?: string | null;
}

/**
 * The surface a developer actually reads. Ordered the way someone triaging
 * reads it: what broke, why we think so, where to look, what to check first.
 */
export function renderBrief(input: RenderInput): any[] {
  const { incident, brief, repo } = input;
  const commits: Commit[] = safeParse(brief.cited_commits);
  const questions: string[] = safeParse(brief.open_questions);

  const blocks: any[] = [];

  blocks.push({
    type: "header",
    text: { type: "plain_text", text: truncate(`${incident.service} — ${incident.exception_type}`, 150) },
  });

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: [
          `${SEVERITY_DOT[incident.severity] ?? ""} *${incident.severity}*`,
          incident.environment,
          incident.version || null,
          `${incident.occurrences} ${incident.occurrences === 1 ? "occurrence" : "occurrences"}`,
          `first seen ${relativeTime(incident.first_seen)}`,
          // The way across to whatever else happened in that request.
          incident.trace_id ? `trace \`${incident.trace_id}\`` : null,
        ]
          .filter(Boolean)
          .join("  ·  "),
      },
    ],
  });

  blocks.push({ type: "section", text: { type: "mrkdwn", text: brief.summary } });

  blocks.push({ type: "divider" });

  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: `*Suspected cause*\n${brief.suspected_cause}` },
  });

  if (brief.cited_file) {
    const location = brief.cited_line ? `${brief.cited_file}:${brief.cited_line}` : brief.cited_file;
    const href = input.fileHref ?? fileUrl(repo, brief.cited_file, brief.cited_line);
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Where*\n<${href}|\`${location}\`>` },
    });
  }

  const changed: string[] = [`*What changed*\n${brief.what_changed}`];
  if (commits.length) {
    changed.push(
      "",
      ...commits.map(
        (c) => `• <${c.url}|\`${c.shortSha}\`>  ${c.message}  _${c.author}, ${relativeTime(c.committedAt)}_`,
      ),
    );
  }
  blocks.push({ type: "section", text: { type: "mrkdwn", text: truncate(changed.join("\n"), 3000) } });

  if (questions.length) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*First checks*\n${questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}`,
      },
    });
  }

  blocks.push(actionsBlock(input));

  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: footer(input, commits.length) }],
  });

  /**
   * Recording whether the cause was right happens on the incident page, and
   * that is the product's precision metric. Without a link there was no route
   * to it from the surface people actually read.
   */
  if (input.incidentUrl) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `<${input.incidentUrl}|Open in FixBat> — full trace, timeline, and whether this cause was right`,
        },
      ],
    });
  }

  return blocks;
}

function actionsBlock(input: RenderInput): any {
  const { incident, ticketUrl, disposition } = input;

  if (ticketUrl) {
    return {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Issue filed — <${ticketUrl}|view in ${input.ticketProvider ?? "the tracker"}>`,
        },
      ],
    };
  }

  if (disposition === "not_helpful" || disposition === "cost_me_time") {
    const label = disposition === "cost_me_time" ? "marked as time lost" : "marked not helpful";
    return { type: "context", elements: [{ type: "mrkdwn", text: `Dismissed — ${label}. Thanks.` }] };
  }

  return {
    type: "actions",
    block_id: `brief_actions:${incident.id}`,
    elements: [
      {
        type: "button",
        action_id: "file_issue",
        style: "primary",
        text: { type: "plain_text", text: "File issue" },
        value: incident.id,
      },
      {
        type: "button",
        action_id: "not_helpful",
        text: { type: "plain_text", text: "Not helpful" },
        value: incident.id,
      },
      {
        type: "button",
        action_id: "cost_me_time",
        text: { type: "plain_text", text: "Sent me the wrong way" },
        value: incident.id,
      },
    ],
  };
}

function footer(input: RenderInput, commitCount: number): string {
  const { brief } = input;
  const parts = [
    commitCount ? `${commitCount} commit${commitCount === 1 ? "" : "s"} reviewed` : "no commits found",
    brief.source === "simulated" ? "simulated brief" : brief.model,
  ];
  if (brief.spend_usd > 0) parts.push(`$${brief.spend_usd.toFixed(3)}`);
  if (brief.duration_ms > 0) parts.push(`${(brief.duration_ms / 1000).toFixed(1)}s`);
  return parts.join("  ·  ");
}

/**
 * Fallback for a host we have no URL shape for. Only reached when a caller
 * does not supply fileHref.
 */
export function fallbackText(incident: IncidentRow, brief: BriefRow): string {
  return `${incident.service} — ${incident.exception_type}: ${brief.summary}`;
}

function fileUrl(repo: string, path: string, line: number | null): string {
  const anchor = line ? `#L${line}` : "";
  return `https://github.com/${repo}/blob/HEAD/${path}${anchor}`;
}

/** Plain-text fallback shown in notifications and by clients that cannot render blocks. */

export function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;

  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return "just now";

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days}d ago`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function safeParse<T>(json: string): T[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
