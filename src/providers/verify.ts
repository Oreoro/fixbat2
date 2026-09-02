import type { Env } from "../types";
import { callExternal } from "./http";

/**
 * Does this credential actually work?
 *
 * The whole failure mode this product keeps running into is looking healthy
 * while doing nothing real. A wrong key is exactly that: the pipeline falls
 * back to simulated, /health reports a provider name, and the client waits for
 * briefs that never come. Every check here is a cheap identity call — the
 * provider's own "who am I" — so the answer is definitive rather than inferred.
 */

export interface Check {
  /** The role this credential fills, matching /health's provider names. */
  role: "logs" | "repo" | "tickets" | "briefs" | "slack";
  name: string;
  configured: boolean;
  /** null when there is nothing configured to check. */
  ok: boolean | null;
  detail: string;
}

async function probe(
  role: Check["role"],
  name: string,
  configured: boolean,
  run: () => Promise<Response>,
  describe: (res: Response) => Promise<string> = async () => "connected",
): Promise<Check> {
  if (!configured) {
    return { role, name, configured: false, ok: null, detail: "not configured" };
  }
  try {
    const res = await run();
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 120);
      return {
        role,
        name,
        configured: true,
        ok: false,
        // The provider's own words beat anything we would invent.
        detail: `${res.status}${body ? `: ${body}` : ""}`,
      };
    }
    return { role, name, configured: true, ok: true, detail: await describe(res) };
  } catch (error) {
    return { role, name, configured: true, ok: false, detail: String(error).slice(0, 160) };
  }
}

const json = async (res: Response) => (await res.json().catch(() => ({}))) as any;

export async function verifyAll(env: Env): Promise<Check[]> {
  const checks: Array<Promise<Check>> = [];

  checks.push(
    probe(
      "briefs",
      "Anthropic",
      Boolean(env.ANTHROPIC_API_KEY),
      () =>
        // One token, so verifying costs a fraction of a cent rather than a brief.
        callExternal("https://api.anthropic.com/v1/messages", {
          what: "anthropic",
          retry: false,
          method: "POST",
          headers: {
            "x-api-key": env.ANTHROPIC_API_KEY ?? "",
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 1,
            messages: [{ role: "user", content: "hi" }],
          }),
        }),
      async () => "key accepted",
    ),
  );

  checks.push(
    probe(
      "slack",
      "Slack",
      Boolean(env.SLACK_BOT_TOKEN),
      () =>
        callExternal("https://slack.com/api/auth.test", {
          what: "slack",
          method: "POST",
          headers: { authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
        }),
      async (res) => {
        // Slack answers 200 even when the token is rejected.
        const body = await json(res);
        if (!body.ok) throw new Error(`slack rejected the token: ${body.error ?? "unknown"}`);
        return `connected as ${body.user ?? "bot"} in ${body.team ?? "workspace"}`;
      },
    ),
  );

  checks.push(
    probe(
      "repo",
      "GitHub",
      Boolean(env.GITHUB_TOKEN),
      () =>
        callExternal("https://api.github.com/user", {
          what: "github",
          headers: {
            authorization: `Bearer ${env.GITHUB_TOKEN}`,
            accept: "application/vnd.github+json",
            "user-agent": "fixbat",
          },
        }),
      async (res) => `connected as ${(await json(res)).login ?? "user"}`,
    ),
  );

  checks.push(
    probe(
      "repo",
      "GitLab",
      Boolean(env.GITLAB_TOKEN),
      () =>
        callExternal(`${(env.GITLAB_URL || "https://gitlab.com").replace(/\/+$/, "")}/api/v4/user`, {
          what: "gitlab",
          headers: { "private-token": env.GITLAB_TOKEN ?? "" },
        }),
      async (res) => `connected as ${(await json(res)).username ?? "user"}`,
    ),
  );

  checks.push(
    probe(
      "repo",
      "Azure DevOps",
      Boolean(env.AZDO_TOKEN && env.AZDO_ORG),
      () =>
        callExternal(`https://dev.azure.com/${env.AZDO_ORG}/_apis/projects?api-version=7.1`, {
          what: "azuredevops",
          headers: { authorization: `Basic ${btoa(`:${env.AZDO_TOKEN ?? ""}`)}` },
        }),
      async (res) => `${(await json(res)).count ?? 0} project(s) visible`,
    ),
  );

  checks.push(
    probe(
      "tickets",
      "Jira",
      Boolean(env.JIRA_URL && env.JIRA_TOKEN && env.JIRA_EMAIL),
      () =>
        callExternal(`${(env.JIRA_URL ?? "").replace(/\/+$/, "")}/rest/api/3/myself`, {
          what: "jira",
          headers: {
            authorization: `Basic ${btoa(`${env.JIRA_EMAIL ?? ""}:${env.JIRA_TOKEN ?? ""}`)}`,
            accept: "application/json",
          },
        }),
      async (res) => `connected as ${(await json(res)).emailAddress ?? "user"}`,
    ),
  );

  checks.push(
    probe(
      "tickets",
      "Linear",
      Boolean(env.LINEAR_TOKEN),
      () =>
        callExternal("https://api.linear.app/graphql", {
          what: "linear",
          method: "POST",
          headers: { authorization: env.LINEAR_TOKEN ?? "", "content-type": "application/json" },
          body: JSON.stringify({ query: "{ viewer { name } }" }),
        }),
      async (res) => {
        const body = await json(res);
        if (body.errors?.length) throw new Error(body.errors[0]?.message ?? "rejected");
        return `connected as ${body.data?.viewer?.name ?? "user"}`;
      },
    ),
  );

  checks.push(
    probe(
      "logs",
      "Elasticsearch",
      Boolean(env.ELASTICSEARCH_URL),
      () =>
        callExternal(`${(env.ELASTICSEARCH_URL ?? "").replace(/\/+$/, "")}/_cluster/health`, {
          what: "elasticsearch",
          headers: { authorization: `ApiKey ${env.ELASTICSEARCH_API_KEY ?? ""}` },
        }),
      async (res) => `cluster ${(await json(res)).status ?? "reachable"}`,
    ),
  );

  checks.push(
    probe(
      "logs",
      "Sentry",
      Boolean(env.SENTRY_TOKEN && env.SENTRY_ORG && env.SENTRY_PROJECT),
      () =>
        callExternal(
          `${(env.SENTRY_URL || "https://sentry.io").replace(/\/+$/, "")}/api/0/projects/${env.SENTRY_ORG}/${env.SENTRY_PROJECT}/`,
          { what: "sentry", headers: { authorization: `Bearer ${env.SENTRY_TOKEN}` } },
        ),
      async (res) => `project ${(await json(res)).slug ?? "found"}`,
    ),
  );

  checks.push(
    probe(
      "logs",
      "Datadog",
      Boolean(env.DATADOG_API_KEY && env.DATADOG_APP_KEY),
      () =>
        callExternal(`https://api.${env.DATADOG_SITE || "datadoghq.com"}/api/v1/validate`, {
          what: "datadog",
          headers: {
            "DD-API-KEY": env.DATADOG_API_KEY ?? "",
            "DD-APPLICATION-KEY": env.DATADOG_APP_KEY ?? "",
          },
        }),
      async () => "keys accepted",
    ),
  );

  // Run them together: ten sequential round trips would make the page feel broken.
  return Promise.all(checks);
}

/** One line a person can act on. */
export function summarise(checks: Check[]): string {
  const configured = checks.filter((c) => c.configured);
  const bad = configured.filter((c) => c.ok === false);
  if (!configured.length) return "Nothing is configured yet — everything is simulated.";
  if (!bad.length) return `All ${configured.length} configured connection(s) working.`;
  return `${bad.length} of ${configured.length} failed: ${bad
    .map((c) => `${c.name} (${c.detail})`)
    .join("; ")}`;
}
