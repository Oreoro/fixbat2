import type { Env } from "../types";
import { callExternal } from "./http";

/**
 * Where a brief becomes a ticket.
 *
 * Deliberately separate from RepoSource. Filing is not the code host's job:
 * plenty of teams keep their code on GitHub and their work in Jira or Linear,
 * and baking issue creation into the repo provider made that impossible to
 * express. The two are chosen independently.
 */

export interface Ticket {
  externalId: string;
  url: string;
}

/** What a ticket is filed against — resolved from the service registry. */
export interface TicketTarget {
  /** Repository the incident's service maps to, for hosts that file per-repo. */
  repo: string;
  /** Owning team, used by trackers that route by team rather than repository. */
  team: string;
}

export interface TicketProvider {
  readonly name: string;
  /** False when nothing is configured, so the UI can say filing is simulated. */
  readonly live: boolean;
  create(target: TicketTarget, title: string, body: string): Promise<Ticket>;
}

async function failOn(res: Response, what: string): Promise<void> {
  if (!res.ok) throw new Error(`${what} ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

// -------------------------------------------------------- GitHub Issues ----

export function githubIssues(env: Env): TicketProvider {
  return {
    name: "github",
    live: true,
    async create(target, title, body) {
      const res = await callExternal(`https://api.github.com/repos/${target.repo}/issues`, {
        what: "github issue",
        retry: false,
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${env.GITHUB_TOKEN}`,
          "content-type": "application/json",
          "user-agent": "fixbat",
        },
        body: JSON.stringify({ title, body }),
      });
      await failOn(res, "github issue");
      const issue = (await res.json()) as { number: number; html_url: string };
      return { externalId: String(issue.number), url: issue.html_url };
    },
  };
}

// -------------------------------------------------------- GitLab Issues ----

export function gitlabIssues(env: Env): TicketProvider {
  const host = (env.GITLAB_URL || "https://gitlab.com").replace(/\/+$/, "");
  return {
    name: "gitlab",
    live: true,
    async create(target, title, body) {
      const res = await callExternal(
        `${host}/api/v4/projects/${encodeURIComponent(target.repo)}/issues`,
        {
          what: "gitlab issue",
          retry: false,
          method: "POST",
          headers: { "private-token": env.GITLAB_TOKEN ?? "", "content-type": "application/json" },
          body: JSON.stringify({ title, description: body }),
        },
      );
      await failOn(res, "gitlab issue");
      const issue = (await res.json()) as { iid: number; web_url: string };
      return { externalId: String(issue.iid), url: issue.web_url };
    },
  };
}

// ------------------------------------------------------------------ Jira ----

/**
 * Jira Cloud. Authenticates with an email plus API token over basic auth.
 * Body is sent as Atlassian Document Format, which is required by the v3 API —
 * plain strings are rejected.
 */
export function jiraTickets(env: Env): TicketProvider {
  const host = (env.JIRA_URL ?? "").replace(/\/+$/, "");
  return {
    name: "jira",
    live: true,
    async create(_target, title, body) {
      const res = await callExternal(`${host}/rest/api/3/issue`, {
        what: "jira issue",
        retry: false,
        method: "POST",
        headers: {
          authorization: `Basic ${btoa(`${env.JIRA_EMAIL ?? ""}:${env.JIRA_TOKEN ?? ""}`)}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          fields: {
            project: { key: env.JIRA_PROJECT_KEY },
            issuetype: { name: env.JIRA_ISSUE_TYPE || "Bug" },
            summary: title.slice(0, 255),
            description: adf(body),
          },
        }),
      });
      await failOn(res, "jira issue");
      const issue = (await res.json()) as { key: string };
      return { externalId: issue.key, url: `${host}/browse/${issue.key}` };
    },
  };
}

/**
 * Markdown-ish text as Atlassian Document Format. Each line becomes its own
 * paragraph, which keeps the brief readable without pulling in a converter.
 */
function adf(text: string) {
  return {
    type: "doc",
    version: 1,
    content: text.split("\n").map((line) => ({
      type: "paragraph",
      content: line.trim() ? [{ type: "text", text: line }] : [],
    })),
  };
}

// ---------------------------------------------------------------- Linear ----

export function linearTickets(env: Env): TicketProvider {
  return {
    name: "linear",
    live: true,
    async create(_target, title, body) {
      const res = await callExternal("https://api.linear.app/graphql", {
        what: "linear issue",
        retry: false,
        method: "POST",
        headers: { authorization: env.LINEAR_TOKEN ?? "", "content-type": "application/json" },
        body: JSON.stringify({
          query: `mutation Create($input: IssueCreateInput!) {
                    issueCreate(input: $input) {
                      success
                      issue { identifier url }
                    }
                  }`,
          variables: { input: { teamId: env.LINEAR_TEAM_ID, title, description: body } },
        }),
      });
      await failOn(res, "linear issue");

      // Linear answers 200 with an errors array, so status alone is not enough.
      const json = (await res.json()) as any;
      if (json.errors?.length) {
        throw new Error(`linear issue: ${json.errors[0]?.message ?? "rejected"}`);
      }
      const issue = json.data?.issueCreate?.issue;
      if (!issue) throw new Error("linear issue: no issue returned");
      return { externalId: issue.identifier, url: issue.url };
    },
  };
}

// ----------------------------------------------- Azure DevOps work items ----

export function azureDevOpsWorkItems(env: Env): TicketProvider {
  const org = env.AZDO_ORG ?? "";
  const project = env.AZDO_PROJECT ?? "";
  return {
    name: "azuredevops",
    live: true,
    async create(_target, title, body) {
      const res = await callExternal(
        `https://dev.azure.com/${org}/${encodeURIComponent(project)}/_apis/wit/workitems/$Bug?api-version=7.1`,
        {
          what: "azuredevops work item",
          retry: false,
          method: "POST",
          headers: {
            authorization: `Basic ${btoa(`:${env.AZDO_TOKEN ?? ""}`)}`,
            // Work item creation is a JSON Patch document, not a plain body.
            "content-type": "application/json-patch+json",
          },
          body: JSON.stringify([
            { op: "add", path: "/fields/System.Title", value: title.slice(0, 255) },
            { op: "add", path: "/fields/System.Description", value: escapeHtml(body) },
          ]),
        },
      );
      await failOn(res, "azuredevops work item");
      const item = (await res.json()) as { id: number; _links?: { html?: { href?: string } } };
      return {
        externalId: String(item.id),
        url:
          item._links?.html?.href ??
          `https://dev.azure.com/${org}/${encodeURIComponent(project)}/_workitems/edit/${item.id}`,
      };
    },
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");
}

// ------------------------------------------------------------- simulated ----

/** Deterministic stand-in so the demo can be filed with nothing configured. */
export function simulatedTickets(): TicketProvider {
  return {
    name: "simulated",
    live: false,
    async create(target, title) {
      const number = 1000 + (Math.abs(hashCode(title)) % 9000);
      return {
        externalId: String(number),
        url: `https://github.com/${target.repo}/issues/${number}`,
      };
    },
  };
}

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}
