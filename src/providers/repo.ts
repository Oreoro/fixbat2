import type { Commit, Env } from "../types";

export interface Issue {
  externalId: string;
  url: string;
}

export interface RepoSource {
  readonly name: string;
  /** Most recent commits touching a path, newest first. */
  recentCommitsTouching(repo: string, path: string, limit: number): Promise<Commit[]>;
  /** Only ever called from a button handler — never from the pipeline. */
  createIssue(repo: string, title: string, body: string): Promise<Issue>;
}

/** Map a runtime path like /app/src/checkout/pricing.ts to a repo-relative one. */
export function toRepoPath(runtimePath: string): string {
  return runtimePath.replace(/^.*?\/app\//, "").replace(/^\/+/, "");
}

export function githubRepo(env: Env): RepoSource {
  return {
    name: "github",
    async recentCommitsTouching(repo, path, limit) {
      const url = new URL(`https://api.github.com/repos/${repo}/commits`);
      url.searchParams.set("path", path);
      url.searchParams.set("per_page", String(limit));

      const res = await fetch(url, {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${env.GITHUB_TOKEN}`,
          "user-agent": "fixbat-2",
        },
      });

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

    async createIssue(repo, title, body) {
      const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${env.GITHUB_TOKEN}`,
          "content-type": "application/json",
          "user-agent": "fixbat-2",
        },
        body: JSON.stringify({ title, body }),
      });

      if (!res.ok) {
        throw new Error(`github issue ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }

      const issue = (await res.json()) as { number: number; html_url: string };
      return { externalId: String(issue.number), url: issue.html_url };
    },
  };
}

/**
 * Deterministic stand-in so the demo shows a realistic blame window with no
 * token. Commits are derived from the path, so the same file always yields the
 * same history across runs.
 */
export function simulatedRepo(env: Env): RepoSource {
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

    async createIssue(repo, title) {
      const number = 1000 + (Math.abs(hashCode(title)) % 9000);
      return {
        externalId: String(number),
        url: `https://github.com/${repo}/issues/${number}`,
      };
    },
  };
}

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
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
