import type { Env } from "../types";

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
}

export function slackClient(env: Env): SlackClient {
  if (!env.SLACK_BOT_TOKEN) {
    return {
      live: false,
      async post(channel) {
        return { channel, ts: `sim-${Date.now()}.${Math.floor(Math.random() * 1e6)}` };
      },
      async update() {},
    };
  }

  const call = async (method: string, body: unknown) => {
    const res = await fetch(`https://slack.com/api/${method}`, {
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

  return {
    live: true,
    async post(channel, text, blocks) {
      const json = await call("chat.postMessage", { channel, text, blocks, unfurl_links: false });
      return { channel: json.channel, ts: json.ts };
    },
    async update(channel, ts, text, blocks) {
      await call("chat.update", { channel, ts, text, blocks });
    },
  };
}
