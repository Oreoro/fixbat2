import type { Commit, Env } from "../types";
import { callExternal, expectOk } from "./http";

/** A window of real source around the failing line. */
export interface SourceExcerpt {
  path: string;
  /** 1-based line number of the first line in `lines`. */
  startLine: number;
  lines: string[];
}

export interface RepoSource {
  readonly name: string;
  /** Most recent commits touching a path, newest first. */
  recentCommitsTouching(repo: string, path: string, limit: number): Promise<Commit[]>;
  /** Source around a line, so the brief can reason about code and not just commit subjects. */
  readSource(repo: string, path: string, line: number, radius: number): Promise<SourceExcerpt | null>;
  /** What one commit changed in one file. Null when unavailable. */
  commitDiff(repo: string, sha: string, path: string): Promise<string | null>;
  /**
   * A browsable link to a line of source. Both the Slack message and the
   * incident page used to build this as a github.com URL regardless of host,
   * so every GitLab and Azure DevOps client got a dead link on the one element
   * that tells them where to look.
   */
  fileUrl(repo: string, path: string, line: number | null): string;
}

/** Map a runtime path like /app/src/checkout/pricing.ts to a repo-relative one. */
export function toRepoPath(runtimePath: string): string {
  return runtimePath.replace(/^.*?\/app\//, "").replace(/^\/+/, "");
}

/** Trim a fetched file to a window around `line`, 1-based and clamped. */
function window(content: string, path: string, line: number, radius: number): SourceExcerpt {
  const all = content.split("\n");
  const start = Math.max(1, line - radius);
  const end = Math.min(all.length, line + radius);
  return { path, startLine: start, lines: all.slice(start - 1, end) };
}

async function textOr(res: Response, what: string): Promise<string> {
  if (!res.ok) throw new Error(`${what} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.text();
}

// ---------------------------------------------------------------- GitHub ----

export function githubRepo(env: Env): RepoSource {
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${env.GITHUB_TOKEN}`,
    "user-agent": "fixbat",
  };

  return {
    name: "github",

    fileUrl(repo, path, line) {
      return `https://github.com/${repo}/blob/HEAD/${path}${line ? `#L${line}` : ""}`;
    },

    async recentCommitsTouching(repo, path, limit) {
      const url = new URL(`https://api.github.com/repos/${repo}/commits`);
      url.searchParams.set("path", path);
      url.searchParams.set("per_page", String(limit));

      const res = await callExternal(url, { what: "github", headers });
      if (!res.ok) {
        throw new Error(`github ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }

      const commits = (await res.json()) as any[];
      return commits.map((c) => ({
        sha: c.sha,
        shortSha: c.sha.slice(0, 7),
        author: c.commit?.author?.name ?? c.author?.login ?? "unknown",
        message: (c.commit?.message ?? "").split("\n")[0],
        committedAt: c.commit?.author?.date ?? "",
        url: c.html_url,
      }));
    },

    async readSource(repo, path, line, radius) {
      const res = await callExternal(`https://api.github.com/repos/${repo}/contents/${encodeURI(path)}`, {
        what: "github contents",
        headers: { ...headers, accept: "application/vnd.github.raw" },
      });
      // A file that has since moved or been deleted is not an error worth
      // failing the brief over.
      if (res.status === 404) return null;
      return window(await textOr(res, "github contents"), path, line, radius);
    },

    async commitDiff(repo, sha, path) {
      const res = await callExternal(`https://api.github.com/repos/${repo}/commits/${sha}`, {
        what: "github commit",
        headers,
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { files?: Array<{ filename: string; patch?: string }> };
      return body.files?.find((f) => f.filename === path)?.patch ?? null;
    },
  };
}

// ---------------------------------------------------------------- GitLab ----

/** `repo` is a project path like `group/subgroup/project`. */
export function gitlabRepo(env: Env): RepoSource {
  const host = (env.GITLAB_URL || "https://gitlab.com").replace(/\/+$/, "");
  const headers = { "private-token": env.GITLAB_TOKEN ?? "" };
  const id = (repo: string) => encodeURIComponent(repo);

  return {
    name: "gitlab",

    fileUrl(repo, path, line) {
      return `${host}/${repo}/-/blob/HEAD/${path}${line ? `#L${line}` : ""}`;
    },

    async recentCommitsTouching(repo, path, limit) {
      const url = new URL(`${host}/api/v4/projects/${id(repo)}/repository/commits`);
      url.searchParams.set("path", path);
      url.searchParams.set("per_page", String(limit));

      const res = await callExternal(url, { what: "gitlab", headers });
      if (!res.ok) {
        throw new Error(`gitlab ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }

      const commits = (await res.json()) as any[];
      return commits.map((c) => ({
        sha: c.id,
        shortSha: String(c.short_id ?? c.id).slice(0, 7),
        author: c.author_name ?? "unknown",
        message: (c.title ?? c.message ?? "").split("\n")[0],
        committedAt: c.committed_date ?? c.created_at ?? "",
        url: c.web_url ?? `${host}/${repo}/-/commit/${c.id}`,
      }));
    },

    async readSource(repo, path, line, radius) {
      const res = await callExternal(
        `${host}/api/v4/projects/${id(repo)}/repository/files/${encodeURIComponent(path)}/raw?ref=HEAD`,
        { what: "gitlab file", headers },
      );
      if (res.status === 404) return null;
      return window(await textOr(res, "gitlab file"), path, line, radius);
    },

    async commitDiff(repo, sha, path) {
      const res = await callExternal(
        `${host}/api/v4/projects/${id(repo)}/repository/commits/${sha}/diff`,
        { what: "gitlab diff", headers },
      );
      if (!res.ok) return null;
      const diffs = (await res.json()) as Array<{ new_path: string; diff: string }>;
      return diffs.find((d) => d.new_path === path)?.diff ?? null;
    },
  };
}

// --------------------------------------------------------- Azure DevOps ----

/** `repo` is the Azure DevOps repository name within AZDO_ORG / AZDO_PROJECT. */
export function azureDevOpsRepo(env: Env): RepoSource {
  const org = env.AZDO_ORG ?? "";
  const project = env.AZDO_PROJECT ?? "";
  const base = `https://dev.azure.com/${org}/${encodeURIComponent(project)}/_apis/git/repositories`;
  // Azure DevOps takes a PAT as basic auth with an empty username.
  const headers = { authorization: `Basic ${btoa(`:${env.AZDO_TOKEN ?? ""}`)}` };

  return {
    name: "azuredevops",

    fileUrl(repo, path, line) {
      const url = new URL(
        `https://dev.azure.com/${org}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repo)}`,
      );
      url.searchParams.set("path", `/${path}`);
      if (line) url.searchParams.set("line", String(line));
      return url.toString();
    },

    async recentCommitsTouching(repo, path, limit) {
      const url = new URL(`${base}/${encodeURIComponent(repo)}/commits`);
      url.searchParams.set("searchCriteria.itemPath", `/${path}`);
      url.searchParams.set("searchCriteria.$top", String(limit));
      url.searchParams.set("api-version", "7.1");

      const res = await callExternal(url, { what: "azuredevops", headers });
      if (!res.ok) {
        throw new Error(`azuredevops ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }

      const body = (await res.json()) as { value?: any[] };
      return (body.value ?? []).map((c) => ({
        sha: c.commitId,
        shortSha: String(c.commitId).slice(0, 7),
        author: c.author?.name ?? "unknown",
        message: (c.comment ?? "").split("\n")[0],
        committedAt: c.author?.date ?? "",
        url: c.remoteUrl ?? "",
      }));
    },

    async readSource(repo, path, line, radius) {
      const url = new URL(`${base}/${encodeURIComponent(repo)}/items`);
      url.searchParams.set("path", `/${path}`);
      url.searchParams.set("api-version", "7.1");
      url.searchParams.set("$format", "text");

      const res = await callExternal(url, { what: "azuredevops item", headers });
      if (res.status === 404) return null;
      return window(await textOr(res, "azuredevops item"), path, line, radius);
    },

    // Azure DevOps exposes changes per commit but not a unified patch in one
    // call; the commit list already carries the subject, which is what the
    // brief uses. Returning null keeps the evidence honest rather than partial.
    async commitDiff() {
      return null;
    },
  };
}

// ------------------------------------------------------------- simulated ----

/**
 * Deterministic stand-in so the demo shows a realistic blame window and a
 * plausible code excerpt with no token. Everything is derived from the path, so
 * the same file always yields the same history across runs.
 */
export function simulatedRepo(_env: Env): RepoSource {
  const authors = ["Priya Raman", "Tomas Lindqvist", "Dana Whitfield", "Marcus Oyelaran"];
  const subjects: Record<string, string[]> = {
    "src/checkout/pricing.ts": [
      "Apply stacked promotions before tax calculation",
      "Extract promotion eligibility into helper",
    ],
    "src/checkout/payment.ts": ["Raise Stripe client timeout to 15s"],
    "src/checkout/promotions.ts": ["Add expiry window to coupon validation"],
    "src/payments/settlement.ts": [
      "Increase settlement batch size from 50 to 500",
      "Parallelise settlement batches",
    ],
    "src/payments/customer.ts": ["Make taxId optional for non-EU customers"],
    "src/payments/idempotency.ts": ["Move idempotency keys to Redis"],
    "src/inventory/variants.ts": ["Support nested variant groups"],
    "src/inventory/suppliers.ts": ["Switch supplier feed to the v3 endpoint"],
  };

  return {
    name: "simulated",

    // The demo's repos are fabricated, so this link is illustrative either way.
    fileUrl(repo, path, line) {
      return `https://github.com/${repo}/blob/HEAD/${path}${line ? `#L${line}` : ""}`;
    },

    async recentCommitsTouching(repo, path, limit) {
      const messages = subjects[path] ?? [`Refactor ${path.split("/").pop()}`];
      const seed = [...path].reduce((a, c) => a + c.charCodeAt(0), 0);
      const now = Date.now();

      return messages.slice(0, limit).map((message, i) => {
        const sha = hex(seed + i * 7919);
        return {
          sha,
          shortSha: sha.slice(0, 7),
          author: authors[(seed + i) % authors.length],
          message,
          committedAt: new Date(now - (i * 19 + 3) * 3_600_000).toISOString(),
          url: `https://github.com/${repo}/commit/${sha}`,
        };
      });
    },

    // No token means no repository to read. Saying so is better than inventing
    // source that does not exist and letting the model cite it as real.
    async readSource() {
      return null;
    },

    async commitDiff() {
      return null;
    },
  };
}

function hex(seed: number): string {
  let out = "";
  let x = seed >>> 0;
  while (out.length < 40) {
    x = (x * 1_664_525 + 1_013_904_223) >>> 0;
    out += x.toString(16).padStart(8, "0");
  }
  return out.slice(0, 40);
}
