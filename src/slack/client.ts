import type { Env } from "../types";
import { callExternal } from "../providers/http";

export interface PostResult {
  channel: string;
  ts: string;
}

/**
 * Slack, or a no-op stand-in when no bot token is configured. The demo runs
 * either way; with a token the same blocks land in a real channel.
 */
export interface SlackClient {
  readonly live: boolean;
  post(channel: string, text: string, blocks: any[]): Promise<PostResult>;
  update(channel: string, ts: string, text: string, blocks: any[]): Promise<void>;
  /** True when the Slack user administers the workspace. Authorises config. */
  isWorkspaceAdmin(userId: string): Promise<boolean>;
  /** Opens a modal. `trigger_id` expires in about three seconds. */
  openView(triggerId: string, view: unknown): Promise<void>;
  /** Replies to a slash command after the initial 3s acknowledgement. */
  respond(responseUrl: string, body: unknown): Promise<void>;
}

export function slackClient(env: Env): SlackClient {
  if (!env.SLACK_BOT_TOKEN) {
    return {
      live: false,
      async post(channel) {
        return { channel, ts: `sim-${Date.now()}.${Math.floor(Math.random() * 1e6)}` };
      },
      async update() {},
      // Nobody administers a workspace that is not connected.
      async isWorkspaceAdmin() {
        return false;
      },
      async openView() {},
      async respond() {},
    };
  }

  const call = async (method: string, body: unknown): Promise<any> => {
    // Posting is not idempotent either — a retry after a message that landed
    // would post it twice. The timeout is the point here.
    const res = await callExternal(`https://slack.com/api/${method}`, {
      what: `slack ${method}`,
      retry: false,
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { ok: boolean; error?: string; [k: string]: any };
    if (!json.ok) throw new Error(`slack ${method}: ${json.error ?? "unknown error"}`);
    return json;
  };

  /** Slack's simpler read methods only accept a form-encoded body. */
  const callForm = async (method: string, params: Record<string, string>): Promise<any> => {
    const res = await callExternal(`https://slack.com/api/${method}`, {
      what: `slack ${method}`,
      retry: false,
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=utf-8",
        authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      },
      body: new URLSearchParams(params).toString(),
    });
    const json = (await res.json()) as { ok: boolean; error?: string; [k: string]: any };
    if (!json.ok) throw new Error(`slack ${method}: ${json.error ?? "unknown error"}`);
    return json;
  };

  return {
    live: true,
    async post(channel, text, blocks) {
      const json = await call("chat.postMessage", { channel, text, blocks, unfurl_links: false });
      return { channel: json.channel, ts: json.ts };
    },
    async update(channel, ts, text, blocks) {
      await call("chat.update", { channel, ts, text, blocks });
    },

    /**
     * Configuration is restricted to people who administer the workspace.
     * Slack is the authority here, so this asks it rather than keeping a
     * parallel list that would drift.
     */
    async isWorkspaceAdmin(userId) {
      try {
        // Form-encoded, not JSON. users.info silently ignores a JSON body and
        // answers `user_not_found`, which this method would read as "not an
        // admin" — failing closed for everyone, with no error to notice.
        const json = await callForm("users.info", { user: userId });
        const u = json.user ?? {};
        return Boolean(u.is_admin || u.is_owner || u.is_primary_owner);
      } catch {
        // A missing users:read scope must fail closed, never open.
        return false;
      }
    },

    async openView(triggerId, view) {
      await call("views.open", { trigger_id: triggerId, view });
    },

    async respond(responseUrl, body) {
      // response_url is pre-authorised; sending the bot token would be wrong.
      await callExternal(responseUrl, {
        what: "slack response_url",
        retry: false,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    },
  };
}
