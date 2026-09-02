import * as db from "../db/queries";
import { run, type Deps } from "../pipeline";
import { MANAGED_SECRETS, putSecret } from "../secrets";
import { summarise, verifyAll } from "../providers/verify";
import { resolveEnv } from "../secrets";

/**
 * Configuring FixBat from Slack.
 *
 * Slack is where the output is read, so it is a reasonable place to control
 * what gets read. Everything here is restricted to people who administer the
 * workspace: Slack is the authority on that, so it is asked rather than kept
 * as a second list that would drift.
 *
 * Slack gives a slash command three seconds. Anything slower — running the
 * pipeline, probing every provider — is acknowledged immediately and finished
 * against `response_url`.
 */

export interface CommandRequest {
  command: string;
  text: string;
  userId: string;
  userName: string;
  channelId: string;
  responseUrl: string;
  triggerId: string;
}

export function parseCommand(body: URLSearchParams): CommandRequest {
  return {
    command: body.get("command") ?? "",
    text: (body.get("text") ?? "").trim(),
    userId: body.get("user_id") ?? "",
    userName: body.get("user_name") ?? "someone",
    channelId: body.get("channel_id") ?? "",
    responseUrl: body.get("response_url") ?? "",
    triggerId: body.get("trigger_id") ?? "",
  };
}

/** Only the person who typed it sees an ephemeral reply. */
const ephemeral = (text: string) => ({ response_type: "ephemeral", text });

const HELP = [
  "*FixBat*",
  "`/fixbat status` — what is connected, and today's volume and spend",
  "`/fixbat services` — the services being diagnosed",
  "`/fixbat watch <service> <repo> <#channel|id> [team]` — start diagnosing a service",
  "`/fixbat unwatch <service>` — stop diagnosing it",
  "`/fixbat source <auto|sentry|datadog|elasticsearch|http|fixture>` — where errors are read from",
  "`/fixbat connect` — set a credential",
  "`/fixbat verify` — check every credential actually works",
  "`/fixbat limit <n>` — daily brief cap",
  "`/fixbat pause [reason]` / `/fixbat resume`",
  "`/fixbat run` — process waiting errors now",
].join("\n");

export async function handleCommand(
  deps: Deps,
  req: CommandRequest,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<unknown> {
  const [verb = "", ...rest] = req.text.split(/\s+/);
  const args = rest.filter(Boolean);

  if (!verb || verb === "help") return ephemeral(HELP);

  // Read-only and harmless inside a workspace, and the refusal below promises
  // it is open — so it must actually be open.
  if (verb === "status") return ephemeral(await status(deps));

  /**
   * Everything below changes what the product does or spends, so it is gated.
   * Checked per command rather than cached: someone's admin rights can be
   * removed, and the next command should respect that.
   */
  if (!(await deps.slack.isWorkspaceAdmin(req.userId))) {
    return ephemeral(
      "Only workspace admins can configure FixBat. `/fixbat status` and `/fixbat help` are open to everyone.",
    );
  }

  switch (verb) {
    case "services":
      return ephemeral(await listServices(deps));

    case "watch":
      return ephemeral(await watch(deps, args, req));

    case "unwatch":
      return ephemeral(await unwatch(deps, args, req));

    case "source":
      return ephemeral(await setSource(deps, args, req));

    case "limit":
      return ephemeral(await setLimit(deps, args, req));

    case "pause":
      return ephemeral(await pause(deps, args.join(" "), req));

    case "resume":
      return ephemeral(await resume(deps, req));

    case "connect":
      await deps.slack.openView(req.triggerId, credentialModal(args[0]));
      return { response_type: "ephemeral", text: "" };

    case "verify":
      // Ten providers, each a network round trip — far past three seconds.
      waitUntil(finishLater(deps, req, async () => verifyText(deps, req)));
      return ephemeral("Checking every connection…");

    case "run":
      waitUntil(finishLater(deps, req, async () => runText(deps, req)));
      return ephemeral("Running the pipeline…");

    default:
      return ephemeral(`Unknown command \`${verb}\`.\n\n${HELP}`);
  }
}

/** Acknowledge now, answer on response_url when the work is actually done. */
async function finishLater(
  deps: Deps,
  req: CommandRequest,
  work: () => Promise<string>,
): Promise<void> {
  try {
    await deps.slack.respond(req.responseUrl, ephemeral(await work()));
  } catch (error) {
    await deps.slack
      .respond(req.responseUrl, ephemeral(`That failed: ${String(error).slice(0, 200)}`))
      .catch(() => {});
  }
}

async function status(deps: Deps): Promise<string> {
  const [settings, m, services] = await Promise.all([
    db.getSettings(deps.env.DB),
    db.metrics(deps.env.DB),
    db.listServices(deps.env.DB),
  ]);
  const today = await db.briefsToday(deps.env.DB);
  const providers = [
    `logs \`${deps.logs.name}\``,
    `code \`${deps.repo.name}\``,
    `tickets \`${deps.tickets.name}\``,
    `briefs \`${deps.diagnoser.name}\``,
    `slack \`${deps.slack.live ? "live" : "simulated"}\``,
  ].join("  ·  ");

  return [
    settings.kill_switch
      ? `:warning: *Paused* — ${settings.kill_switch_reason || "no reason given"}`
      : ":white_check_mark: *Running*",
    providers,
    `${services.length} service(s) · ${m.total} incidents · ${today}/${settings.daily_brief_limit} briefs today · $${m.spendUsd.toFixed(2)} total`,
    m.causeConfirmed + m.causeWrong > 0
      ? `Precision: ${m.causeConfirmed}/${m.causeConfirmed + m.causeWrong} confirmed on resolved incidents`
      : "_No incidents resolved yet, so there is no precision figure._",
  ].join("\n");
}

async function listServices(deps: Deps): Promise<string> {
  const services = await db.listServices(deps.env.DB);
  if (!services.length) {
    return "No services yet. `/fixbat watch <service> <repo> <#channel>` to add one.";
  }
  return [
    "*Services being diagnosed*",
    ...services.map(
      (s) =>
        `• \`${s.name}\` → ${s.repo} → ${s.slack_channel}${s.team ? ` _(${s.team})_` : ""}${
          s.enabled ? "" : " — *disabled*"
        }`,
    ),
  ].join("\n");
}

async function watch(deps: Deps, args: string[], req: CommandRequest): Promise<string> {
  const [name, repo, channel, ...team] = args;
  if (!name || !repo || !channel) {
    return "Usage: `/fixbat watch <service> <owner/repo> <#channel|channel-id> [team]`";
  }
  await db.upsertService(deps.env.DB, {
    name,
    repo,
    // An id is the only way to reach a private channel or a DM.
    slack_channel: /^[CDG][A-Z0-9]{6,}$/.test(channel)
      ? channel
      : channel.startsWith("#")
        ? channel
        : `#${channel}`,
    team: team.join(" "),
  });
  await db.logEvent(deps.env.DB, null, "service_registered", name, `slack:${req.userName}`);
  return `Now diagnosing \`${name}\` against ${repo}, posting to ${channel}.`;
}

async function unwatch(deps: Deps, args: string[], req: CommandRequest): Promise<string> {
  const name = args[0];
  if (!name) return "Usage: `/fixbat unwatch <service>`";
  const existing = await db.getService(deps.env.DB, name);
  if (!existing) return `No service called \`${name}\`.`;
  // Disabled rather than deleted: its incidents stay readable.
  await db.upsertService(deps.env.DB, { ...existing, enabled: false });
  await db.logEvent(deps.env.DB, null, "service_disabled", name, `slack:${req.userName}`);
  return `Stopped diagnosing \`${name}\`. Its past incidents are untouched.`;
}

const SOURCES = ["auto", "sentry", "datadog", "elasticsearch", "http", "fixture"];

async function setSource(deps: Deps, args: string[], req: CommandRequest): Promise<string> {
  const choice = (args[0] ?? "").toLowerCase();
  if (!SOURCES.includes(choice)) {
    return `Where should errors be read from? One of: ${SOURCES.map((s) => `\`${s}\``).join(", ")}`;
  }
  await db.updateSettings(deps.env.DB, { log_source: choice });
  await db.logEvent(deps.env.DB, null, "log_source_set", choice, `slack:${req.userName}`);
  return choice === "auto"
    ? "Reading from whichever source is configured, most specific first."
    : `Reading errors from \`${choice}\`.`;
}

async function setLimit(deps: Deps, args: string[], req: CommandRequest): Promise<string> {
  const n = Number(args[0]);
  if (!Number.isFinite(n) || n < 0) return "Usage: `/fixbat limit <number>`";
  await db.updateSettings(deps.env.DB, { daily_brief_limit: Math.trunc(n) });
  await db.logEvent(deps.env.DB, null, "limit_set", String(n), `slack:${req.userName}`);
  return `Daily cap set to ${Math.trunc(n)} briefs.`;
}

async function pause(deps: Deps, reason: string, req: CommandRequest): Promise<string> {
  await db.updateSettings(deps.env.DB, {
    kill_switch: true,
    kill_switch_reason: reason || `paused from Slack by ${req.userName}`,
  });
  await db.logEvent(deps.env.DB, null, "paused", reason, `slack:${req.userName}`);
  return ":octagonal_sign: Paused. Nothing will be diagnosed or posted until `/fixbat resume`.";
}

async function resume(deps: Deps, req: CommandRequest): Promise<string> {
  await db.updateSettings(deps.env.DB, { kill_switch: false, kill_switch_reason: "" });
  await db.logEvent(deps.env.DB, null, "resumed", "", `slack:${req.userName}`);
  return ":white_check_mark: Running again.";
}

async function verifyText(deps: Deps, req: CommandRequest): Promise<string> {
  const checks = await verifyAll(await resolveEnv(deps.env));
  await db.logEvent(deps.env.DB, null, "connections_verified", summarise(checks), `slack:${req.userName}`);
  const lines = checks
    .filter((c) => c.configured)
    .map((c) => `${c.ok ? ":white_check_mark:" : ":x:"} *${c.name}* — ${c.detail}`);
  return lines.length
    ? ["*Connections*", ...lines].join("\n")
    : "Nothing is configured yet — everything is simulated. `/fixbat connect` to change that.";
}

async function runText(deps: Deps, req: CommandRequest): Promise<string> {
  const summary = await run(deps);
  await db.logEvent(deps.env.DB, null, "manual_ingest", `${summary.briefed} briefed`, `slack:${req.userName}`);
  if (summary.halted) return `Paused — ${summary.halted}`;
  return `${summary.briefed} briefed · ${summary.deduped} already known · ${summary.unmapped} from unwatched services · ${summary.capped} held by the cap`;
}

/**
 * A credential form. The value is a Slack input, so it passes through Slack on
 * its way here — a Worker secret set with `wrangler secret put` remains
 * stronger and still overrides anything stored this way.
 */
export function credentialModal(preselect?: string) {
  const options = MANAGED_SECRETS.map((s) => ({
    text: { type: "plain_text", text: `${s.provider} — ${s.label}`.slice(0, 75) },
    value: s.name,
  }));
  const initial = options.find((o) => o.value === preselect?.toUpperCase());

  return {
    type: "modal",
    callback_id: "fixbat_credential",
    title: { type: "plain_text", text: "Connect a tool" },
    submit: { type: "plain_text", text: "Save" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: "name",
        label: { type: "plain_text", text: "Credential" },
        element: {
          type: "static_select",
          action_id: "value",
          options: options.slice(0, 100),
          ...(initial ? { initial_option: initial } : {}),
        },
      },
      {
        type: "input",
        block_id: "secret",
        label: { type: "plain_text", text: "Value" },
        element: { type: "plain_text_input", action_id: "value" },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "Stored encrypted. A Worker secret of the same name always wins over this.",
          },
        ],
      },
    ],
  };
}

/** Handles the modal's submit. Slack expects an empty 200 to close it. */
export async function handleViewSubmission(deps: Deps, payload: any): Promise<unknown> {
  if (payload?.view?.callback_id !== "fixbat_credential") return {};

  const userId = payload.user?.id ?? "";
  const userName = payload.user?.username ?? payload.user?.name ?? "someone";
  if (!(await deps.slack.isWorkspaceAdmin(userId))) {
    return { response_action: "errors", errors: { secret: "Only workspace admins can do this." } };
  }

  const values = payload.view.state?.values ?? {};
  const name = values.name?.value?.selected_option?.value ?? "";
  const value = values.secret?.value?.value ?? "";

  const result = await putSecret(deps.env, name, value, `slack:${userName}`);
  if (result.error) return { response_action: "errors", errors: { secret: result.error } };

  await db.logEvent(deps.env.DB, null, "secret_set", name, `slack:${userName}`);
  return {};
}
