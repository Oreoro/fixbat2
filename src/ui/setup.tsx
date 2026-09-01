import { Badge } from "@cloudflare/kumo/components/badge";
import { Banner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { Empty } from "@cloudflare/kumo/components/empty";
import { Input } from "@cloudflare/kumo/components/input";
import { Table } from "@cloudflare/kumo/components/table";
import { Text } from "@cloudflare/kumo/components/text";

import type { EventRow } from "../db/queries";
import type { Identity, User } from "../users";

export interface SecretRow {
  name: string;
  label: string;
  help: string;
  unlocks: string;
  fromEnv: boolean;
  hint: string | null;
  updatedBy: string | null;
}
import type { ServiceRow, SettingsRow } from "../types";
import { KeyValue, PageHeader, Panel, PanelBody, Shell } from "./shell";

export interface ProviderState {
  logs: string;
  repo: string;
  diagnoser: string;
  slack: string;
}

/** Sign-in. The only thing standing between a stranger and the admin API. */
export function SignInPage({
  cssHref,
  jsHref,
  error,
  unconfigured,
}: {
  cssHref: string;
  jsHref?: string;
  error?: string;
  unconfigured: boolean;
}) {
  return (
    <Shell cssHref={cssHref} jsHref={jsHref} title="FixBat — sign in" active="setup">
      <div className="mx-auto max-w-md pt-10">
        <PageHeader
          title="Sign in"
          sub="Setup and administration need the ADMIN_TOKEN for this deployment."
        />

        {unconfigured ? (
          <div className="mb-4">
            <Banner variant="error">
              <strong>No ADMIN_TOKEN is set.</strong> Every admin endpoint on this deployment is
              open. Run <code>npm run setup</code>, or set the secret directly.
            </Banner>
          </div>
        ) : null}

        {error ? (
          <div className="mb-4">
            <Banner variant="error">{error}</Banner>
          </div>
        ) : null}

        <Panel title="Administrator token">
          <PanelBody>
            <form method="post" action="/setup/signin" className="flex flex-col gap-3">
              <Input
                type="password"
                name="token"
                label="Admin token"
                description="Shown once when the deployment was claimed. Exchanged for a session cookie — the token itself is never stored in the page."
                autoComplete="new-password"
                passwordManagerIgnore
                required
              />
              <div>
                <Button type="submit" variant="primary">
                  Sign in
                </Button>
              </div>
            </form>
          </PanelBody>
        </Panel>

        <div className="mt-3">
          <Text variant="secondary" size="xs">
            Lost it? Rotate with{" "}
            <code className="font-mono">npx wrangler secret put ADMIN_TOKEN</code> — this replaces
            the old one and signs everyone out.
          </Text>
        </div>
      </div>
    </Shell>
  );
}

/** Everything a new client needs, in order, without touching a terminal. */
export function SetupPage({
  cssHref,
  jsHref,
  services,
  settings,
  providers,
  incidentCount,
  notice,
  origin,
  demo,
  audit,
  users,
  secrets,
  failures,
  me,
  newToken,
  error,
}: {
  cssHref: string;
  jsHref?: string;
  services: ServiceRow[];
  settings: SettingsRow;
  providers: ProviderState;
  incidentCount: number;
  notice?: string;
  origin: string;
  demo: { services: number; incidents: number };
  audit: EventRow[];
  users: User[];
  secrets: SecretRow[];
  failures: EventRow[];
  me: Identity | null;
  newToken?: { token: string; name: string };
  error?: string;
}) {
  const simulated = Object.entries(providers).filter(([, v]) => v === "simulated" || v === "fixture");
  const done = {
    services: services.length > 0,
    ingested: incidentCount > 0,
    slack: providers.slack === "live",
  };

  return (
    <Shell
      cssHref={cssHref}
      jsHref={jsHref}
      title="FixBat — setup"
      active="setup"
      who={me?.name ?? null}
      halted={settings.kill_switch ? settings.kill_switch_reason || "paused" : null}
    >
      <PageHeader
        title="Setup"
        sub="FixBat works immediately with bundled sample data. Connect real services when you are ready — each one independently."
        stats={[
          { label: "services", value: services.length },
          { label: "incidents", value: incidentCount },
          { label: "simulated", value: simulated.length },
        ]}
      />

      {error ? (
        <div className="mb-4">
          <Banner variant="error">{error}</Banner>
        </div>
      ) : null}

      {failures.length ? (
        <div className="mb-4">
          <Banner variant="error">
            <strong>The pipeline is reporting errors.</strong> A wrong credential shows up here
            first — most recently: {failures[0].detail.slice(0, 160)}
          </Banner>
        </div>
      ) : null}

      {notice ? (
        <div className="mb-4">
          <Banner variant="default">{notice}</Banner>
        </div>
      ) : null}

      {newToken ? (
        <Panel title={`Token for ${newToken.name}`}>
          <PanelBody>
            <div className="rounded-lg border border-kumo-warning bg-kumo-warning/10 p-4">
              <code className="font-mono text-sm break-all select-all">{newToken.token}</code>
            </div>
            <div className="mt-3">
              <Text variant="secondary" size="sm">
                Shown once. Send it to {newToken.name} over a channel you trust — only its hash is
                stored, so it cannot be looked up again.
              </Text>
            </div>
          </PanelBody>
        </Panel>
      ) : null}

      <Panel title="Try it with sample data">
        <PanelBody>
          <div className="mb-4 max-w-[70ch]">
            <Text variant="secondary" size="sm">
              {demo.incidents
                ? `${demo.incidents} demo incidents are loaded across ${demo.services} sample services. Clearing them removes only what the demo created — anything you added yourself is untouched.`
                : "Loads three sample services and a set of realistic production errors, then runs the pipeline. Nothing external is contacted and no credentials are needed."}
            </Text>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {demo.incidents ? (
              <>
                <form method="post" action="/setup/demo/clear">
                  <Button type="submit" variant="secondary">
                    Clear demo data
                  </Button>
                </form>
                <a
                  href="/"
                  className="inline-flex items-center rounded-lg bg-kumo-brand px-4 py-2 text-sm font-semibold text-white no-underline hover:opacity-90"
                >
                  View incidents &rarr;
                </a>
              </>
            ) : (
              <form method="post" action="/setup/demo">
                <Button type="submit" variant="primary">
                  Load demo data
                </Button>
              </form>
            )}
            {demo.incidents ? <Badge variant="orange">demo data present</Badge> : null}
          </div>
        </PanelBody>
      </Panel>

      {/* ---------------------------------------------------- step 1 */}
      <Panel title={`1 · Register a service ${done.services ? "✓" : ""}`}>
        <PanelBody>
          <div className="mb-4 max-w-[70ch]">
            <Text variant="secondary" size="sm">
              FixBat only diagnoses services listed here — an unmapped service has no repository to
              correlate against. The name must match <code>service.name</code> as it appears in your
              logs.
            </Text>
          </div>

          <form method="post" action="/setup/services" className="grid gap-3 sm:grid-cols-2">
            <Input name="name" label="Service name" placeholder="checkout-service" required />
            <Input name="repo" label="GitHub repo" placeholder="acme/checkout" required />
            <Input name="slack_channel" label="Slack channel" placeholder="#incidents" required />
            <Input name="team" label="Owning team" placeholder="Checkout" />
            <div className="sm:col-span-2">
              <Button type="submit" variant="primary">
                Add service
              </Button>
            </div>
          </form>

          {services.length ? (
            <div className="mt-5 overflow-hidden rounded-lg border border-kumo-line">
              <Table>
                <Table.Header>
                  <Table.Row>
                    <Table.Head>Service</Table.Head>
                    <Table.Head>Repo</Table.Head>
                    <Table.Head>Channel</Table.Head>
                    <Table.Head>Team</Table.Head>
                    <Table.Head>State</Table.Head>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {services.map((s) => (
                    <Table.Row key={s.name}>
                      <Table.Cell className="font-mono text-xs">{s.name}</Table.Cell>
                      <Table.Cell className="font-mono text-xs">{s.repo}</Table.Cell>
                      <Table.Cell className="font-mono text-xs">{s.slack_channel}</Table.Cell>
                      <Table.Cell className="text-xs">{s.team || "—"}</Table.Cell>
                      <Table.Cell>
                        {s.enabled ? (
                          <Badge variant="green">enabled</Badge>
                        ) : (
                          <Badge variant="neutral">disabled</Badge>
                        )}
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
            </div>
          ) : null}
        </PanelBody>
      </Panel>

      {/* ---------------------------------------------------- step 2 */}
      <Panel title="2 · Connect your tools">
        <PanelBody>
          <div className="mb-4 max-w-[74ch]">
            <Text variant="secondary" size="sm">
              Anything left blank stays simulated — FixBat substitutes realistic stand-ins so the
              whole pipeline still runs. Values are encrypted before storage and only their last
              four characters are ever shown again.
            </Text>
          </div>

          <div className="mb-5 rounded-lg border border-kumo-line bg-kumo-recessed p-3">
            <Text variant="secondary" size="xs">
              The encryption key lives in this same database, so this protects against exports,
              dashboard browsing and log leakage — not against someone who already has full read
              access to your D1. For stronger separation run{" "}
              <code className="font-mono">npx wrangler secret put NAME</code>; a Worker secret
              always overrides anything stored here.
            </Text>
          </div>

          <div className="flex flex-col gap-4">
            {secrets.map((s) => (
              <div key={s.name} className="border-t border-kumo-hairline pt-4 first:border-0 first:pt-0">
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <Text size="sm">{s.label}</Text>
                  {s.fromEnv ? (
                    <Badge variant="purple">Worker secret</Badge>
                  ) : s.hint ? (
                    <Badge variant="green">saved</Badge>
                  ) : (
                    <Badge variant="neutral">simulated</Badge>
                  )}
                  <code className="font-mono text-xs text-kumo-subtle">{s.name}</code>
                </div>
                <div className="mb-2 max-w-[74ch]">
                  <Text variant="secondary" size="xs">{s.help}</Text>
                </div>

                {s.fromEnv ? (
                  <Text variant="secondary" size="xs">
                    Set as a Worker secret — it takes precedence and cannot be edited here.
                  </Text>
                ) : (
                  <div className="flex flex-wrap items-end gap-2">
                    <form method="post" action="/setup/secrets" className="flex flex-wrap items-end gap-2">
                      <input type="hidden" name="name" value={s.name} />
                      <div className="w-80">
                        {/*
                          A plain password Input rather than SensitiveInput: it
                          supports passwordManagerIgnore, without which every
                          field is autofilled and an empty one looks filled.
                        */}
                        <Input
                          type="password"
                          name="value"
                          size="sm"
                          autoComplete="new-password"
                          passwordManagerIgnore
                          placeholder={s.hint ? `replace ${s.hint}` : "paste value"}
                          aria-label={s.label}
                          required
                        />
                      </div>
                      <Button type="submit" variant="secondary">
                        {s.hint ? "Replace" : "Save"}
                      </Button>
                    </form>
                    {s.hint ? (
                      <div className="flex items-center gap-3 pb-1.5">
                        <Text variant="secondary" size="xs">
                          {s.hint}
                          {s.updatedBy ? ` · set by ${s.updatedBy}` : ""}
                        </Text>
                        <form method="post" action="/setup/secrets/delete">
                          <input type="hidden" name="name" value={s.name} />
                          <button type="submit" className="text-xs text-kumo-danger underline">
                            remove
                          </button>
                        </form>
                      </div>
                    ) : null}
                  </div>
                )}
              </div>
            ))}
          </div>

          {providers.slack === "live" ? null : (
            <div className="mt-5 border-t border-kumo-hairline pt-4">
              <Text variant="secondary" size="sm">
                For Slack buttons, set the app&rsquo;s <strong>Interactivity</strong> request URL to{" "}
                <code className="font-mono">{origin}/slack/actions</code>
              </Text>
            </div>
          )}
        </PanelBody>
      </Panel>

      {/* ---------------------------------------------------- step 3 */}
      <Panel title={`3 · Run it ${done.ingested ? "✓" : ""}`}>
        <PanelBody>
          <div className="mb-4 max-w-[70ch]">
            <Text variant="secondary" size="sm">
              The cron polls every 5 minutes. You can also run the pipeline now — it is safe to run
              repeatedly, because a checkpoint means nothing is processed twice.
            </Text>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <form method="post" action="/setup/ingest">
              <Button type="submit" variant="primary">
                Run pipeline now
              </Button>
            </form>
            <form method="post" action="/setup/kill">
              <input type="hidden" name="kill_switch" value={settings.kill_switch ? "0" : "1"} />
              <Button type="submit" variant="secondary">
                {settings.kill_switch ? "Resume pipeline" : "Pause pipeline"}
              </Button>
            </form>
          </div>
        </PanelBody>
      </Panel>

      {/* ---------------------------------------------------- state */}
      <Panel title="Deployment">
        <PanelBody>
          <KeyValue
            rows={[
              ["URL", <span className="font-mono text-xs">{origin}</span>],
              ["Admin API", <Badge variant="green">protected</Badge>],
              [
                "Pipeline",
                settings.kill_switch ? (
                  <Badge variant="red">paused</Badge>
                ) : (
                  <Badge variant="green">running</Badge>
                ),
              ],
              ["Daily brief limit", `${settings.daily_brief_limit}`],
              [
                "Sign out",
                <form method="post" action="/setup/signout">
                  <button type="submit" className="text-xs text-kumo-brand underline">
                    End this session
                  </button>
                </form>,
              ],
            ]}
          />
        </PanelBody>
      </Panel>

      <Panel title="People">
        <PanelBody>
          <div className="mb-4 max-w-[70ch]">
            <Text variant="secondary" size="sm">
              Each administrator gets their own token, so the audit trail records who did something
              and access can be revoked for one person without disrupting anyone else.
              {me ? ` You are signed in as ${me.name}.` : ""}
            </Text>
          </div>

          <form method="post" action="/setup/users" className="flex flex-wrap items-end gap-3">
            <div className="w-64">
              <Input name="name" label="Name" placeholder="Priya Raman" required />
            </div>
            <Button type="submit" variant="secondary">
              Add administrator
            </Button>
          </form>

          {users.length ? (
            <div className="mt-5 overflow-hidden rounded-lg border border-kumo-line">
              <Table>
                <Table.Header>
                  <Table.Row>
                    <Table.Head>Name</Table.Head>
                    <Table.Head>Role</Table.Head>
                    <Table.Head>Added by</Table.Head>
                    <Table.Head>Last seen</Table.Head>
                    <Table.Head>State</Table.Head>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {users.map((u) => (
                    <Table.Row key={u.id}>
                      <Table.Cell className="text-xs">
                        {u.name}
                        {me?.id === u.id ? (
                          <span className="ml-2 text-kumo-subtle">(you)</span>
                        ) : null}
                      </Table.Cell>
                      <Table.Cell>
                        <Badge variant={u.role === "owner" ? "purple" : "neutral"}>{u.role}</Badge>
                      </Table.Cell>
                      <Table.Cell className="text-xs text-kumo-subtle">{u.created_by ?? "—"}</Table.Cell>
                      <Table.Cell className="font-mono text-xs text-kumo-subtle">
                        {u.last_seen_at ? u.last_seen_at.replace("T", " ").slice(0, 16) : "never"}
                      </Table.Cell>
                      <Table.Cell>
                        <form method="post" action="/setup/users/toggle" className="flex items-center gap-2">
                          <input type="hidden" name="id" value={u.id} />
                          <input type="hidden" name="name" value={u.name} />
                          <input type="hidden" name="disabled" value={u.disabled ? "0" : "1"} />
                          {u.disabled ? <Badge variant="red">disabled</Badge> : <Badge variant="green">active</Badge>}
                          <button type="submit" className="text-xs text-kumo-brand underline">
                            {u.disabled ? "enable" : "disable"}
                          </button>
                        </form>
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
            </div>
          ) : null}
        </PanelBody>
      </Panel>

      {audit.length ? (
        <Panel title="Recent admin activity">
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.Head>Action</Table.Head>
                <Table.Head>Detail</Table.Head>
                <Table.Head>Actor</Table.Head>
                <Table.Head>When</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {audit.map((e) => (
                <Table.Row key={e.id}>
                  <Table.Cell className="font-mono text-xs">{e.kind}</Table.Cell>
                  <Table.Cell className="text-xs text-kumo-subtle">{e.detail || "—"}</Table.Cell>
                  <Table.Cell className="font-mono text-xs text-kumo-subtle">{e.actor ?? "—"}</Table.Cell>
                  <Table.Cell className="font-mono text-xs whitespace-nowrap text-kumo-subtle">
                    <time dateTime={e.created_at} title={e.created_at}>
                      {e.created_at.replace("T", " ").slice(0, 19)}
                    </time>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </Panel>
      ) : null}

      {!services.length ? (
        <Empty
          size="sm"
          title="No services yet"
          description="Add one above. Until then, errors are recorded as unmapped and not diagnosed."
        />
      ) : null}
    </Shell>
  );
}


/** Shown for 404s and unhandled errors, so a failure still looks like the app. */
export function ErrorPage({
  cssHref,
  title,
  detail,
}: {
  cssHref: string;
  title: string;
  detail?: string;
}) {
  return (
    <Shell cssHref={cssHref} title={`FixBat — ${title}`} active="incidents">
      <div className="mx-auto max-w-lg pt-16">
        <Empty
          title={title}
          description={detail}
          contents={
            <a
              href="/"
              className="inline-flex items-center rounded-lg bg-kumo-brand px-4 py-2 text-sm font-semibold text-white no-underline hover:opacity-90"
            >
              Back to incidents
            </a>
          }
        />
      </div>
    </Shell>
  );
}


/**
 * First run for a one-click install. Before the claim the deployment has no
 * admin token at all, so this page is deliberately urgent: whoever opens it
 * first becomes the administrator.
 */
export function ClaimPage({
  cssHref,
  origin,
  token,
  name,
}: {
  cssHref: string;
  origin: string;
  token?: string;
  name?: string;
}) {
  if (token) {
    return (
      <Shell cssHref={cssHref} title="FixBat — claimed" active="setup">
        <div className="mx-auto max-w-xl pt-10">
          <PageHeader
            title={name ? `Welcome, ${name}` : "Deployment claimed"}
            sub="This is the only time the token is shown. Save it now — it is stored only as a hash and cannot be recovered."
          />
          <Panel title="Your admin token">
            <PanelBody>
              <div className="rounded-lg border border-kumo-warning bg-kumo-warning/10 p-4">
                <code className="font-mono text-sm break-all select-all">{token}</code>
              </div>
              <div className="mt-4">
                <Text variant="secondary" size="sm">
                  Use it to sign in from another browser, or as{" "}
                  <code className="font-mono">Authorization: Bearer …</code> against the admin API.
                  You are already signed in here.
                </Text>
              </div>
              <div className="mt-4 flex gap-2">
                <a
                  href="/setup"
                  className="inline-flex items-center rounded-lg bg-kumo-brand px-4 py-2 text-sm font-semibold text-white no-underline hover:opacity-90"
                >
                  Continue to setup &rarr;
                </a>
              </div>
            </PanelBody>
          </Panel>
          <div className="mt-3">
            <Text variant="secondary" size="xs">
              Lost it later? Set <code className="font-mono">ADMIN_TOKEN</code> as a Worker secret —
              an explicit secret always overrides the claimed one.
            </Text>
          </div>
        </div>
      </Shell>
    );
  }

  return (
    <Shell cssHref={cssHref} title="FixBat — claim this deployment" active="setup">
      <div className="mx-auto max-w-xl pt-10">
        <PageHeader
          title="Claim this deployment"
          sub="FixBat is deployed and running, but nobody administers it yet."
        />

        <div className="mb-4">
          <Banner variant="alert">
            <strong>Anyone who opens this URL right now can claim it.</strong> Claim it before
            sharing the address.
          </Banner>
        </div>

        <Panel title="Become the administrator">
          <PanelBody>
            <div className="mb-4 max-w-[60ch]">
              <Text variant="secondary" size="sm">
                Claiming generates an admin token, shows it to you once, and stores only its hash.
                It can be done exactly once — after that the deployment is locked to whoever holds
                the token.
              </Text>
            </div>
            <form method="post" action="/setup/claim" className="flex flex-wrap items-end gap-3">
              <div className="w-64">
                <Input
                  name="name"
                  label="Your name"
                  description="Recorded against everything you do here."
                  placeholder="Priya Raman"
                  required
                />
              </div>
              <Button type="submit" variant="primary">
                Claim deployment
              </Button>
            </form>
            <div className="mt-4">
              <Text variant="secondary" size="xs">
                Deploying from CI instead? Set <code className="font-mono">ADMIN_TOKEN</code> as a
                Worker secret and this step is skipped entirely.
              </Text>
            </div>
          </PanelBody>
        </Panel>

        <div className="mt-3">
          <Text variant="secondary" size="xs">
            {origin}
          </Text>
        </div>
      </div>
    </Shell>
  );
}
