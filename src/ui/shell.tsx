import type { ReactNode } from "react";
import { renderToString } from "react-dom/server.browser";
import { Banner } from "@cloudflare/kumo/components/banner";
import { Grid } from "@cloudflare/kumo/components/grid";
import { Surface } from "@cloudflare/kumo/components/surface";
import { Text } from "@cloudflare/kumo/components/text";

/**
 * Kumo is a React library, so the pages are React and rendered to a string in
 * the Worker. Only the interactive islands are hydrated on the client — the
 * rest ships as plain HTML.
 */
export interface ShellProps {
  cssHref: string;
  jsHref?: string;
  title: string;
  active: "incidents" | "metrics" | "services" | "setup";
  halted?: string | null;
  mode?: string | null;
  /** Who is signed in, for the nav. Null when reading anonymously. */
  who?: string | null;
  children: ReactNode;
}

const NAV = [
  { href: "/", key: "incidents", label: "Incidents" },
  { href: "/metrics", key: "metrics", label: "Measurement" },
  { href: "/services", key: "services", label: "Services" },
  { href: "/setup", key: "setup", label: "Setup" },
] as const;

export function Shell({ title, active, halted, mode, who, cssHref, jsHref, children }: ShellProps) {
  return (
    <html lang="en" className="h-full">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>{title}</title>
        <link
          rel="icon"
          href={
            "data:image/svg+xml," +
            encodeURIComponent(
              '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
                '<rect width="32" height="32" rx="7" fill="#2f6fe4"/>' +
                '<text x="16" y="22" font-family="system-ui,sans-serif" font-size="15" ' +
                'font-weight="700" fill="#fff" text-anchor="middle">Fb</text></svg>',
            )
          }
        />
        <link rel="stylesheet" href={cssHref} />
        {/*
          Kumo's theme is driven entirely by data-mode; it has no
          prefers-color-scheme rules of its own, so without this a viewer on a
          dark OS gets the light theme. Runs before first paint, so no flash.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "document.documentElement.dataset.mode=matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light'",
          }}
        />
      </head>
      <body className="min-h-full bg-kumo-canvas antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50 focus:rounded-lg focus:bg-kumo-base focus:px-3 focus:py-2 focus:ring-2 focus:ring-kumo-brand"
        >
          Skip to content
        </a>

        <div className="mx-auto w-full max-w-[76rem] px-5 pt-5 pb-24">
          <nav
            aria-label="Sections"
            className="mb-6 flex flex-wrap items-center gap-1 border-b border-kumo-hairline pb-3"
          >
            <a href="/" className="mr-3 flex items-center gap-2 no-underline" aria-label="FixBat home">
              <span
                aria-hidden="true"
                className="flex h-5 w-5 items-center justify-center rounded-md bg-kumo-brand text-[11px] font-bold text-white"
              >
                Fb
              </span>
              <span className="text-sm font-semibold tracking-tight text-kumo-strong">FixBat</span>
            </a>
            {NAV.map((item) => (
              <a
                key={item.key}
                href={item.href}
                aria-current={active === item.key ? "page" : undefined}
                className={
                  active === item.key
                    ? "rounded-md bg-kumo-fill px-2.5 py-1 text-sm font-medium text-kumo-default no-underline"
                    : "rounded-md px-2.5 py-1 text-sm text-kumo-subtle no-underline hover:bg-kumo-tint hover:text-kumo-default"
                }
              >
                {item.label}
              </a>
            ))}
            <span className="flex-1" />
            {mode ? (
              <Text variant="mono-secondary">{mode}</Text>
            ) : null}
          </nav>

          {halted ? (
            <div className="mb-5">
              <Banner variant="alert">
                <strong>Paused</strong> — {halted}. No briefs are being generated.
              </Banner>
            </div>
          ) : null}

          <main id="main">{children}</main>
        </div>
        {jsHref ? <script type="module" src={jsHref} defer /> : null}
      </body>
    </html>
  );
}

/** Page header: title, supporting line, and a row of figures. */
export function PageHeader({
  title,
  sub,
  stats,
  crumbs,
}: {
  title: string;
  sub?: ReactNode;
  stats?: Array<{ label: string; value: ReactNode }>;
  crumbs?: ReactNode;
}) {
  return (
    <header className="mb-5 border-b border-kumo-hairline pb-4">
      {crumbs ? <div className="mb-2">{crumbs}</div> : null}
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div className="min-w-0">
          <h1 className="m-0">
            <Text variant="heading" size="lg">
              {title}
            </Text>
          </h1>
          {sub ? (
            <div className="mt-1 max-w-[62ch]">
              <Text variant="secondary" size="sm">
                {sub}
              </Text>
            </div>
          ) : null}
        </div>
        {stats?.length ? (
          <dl className="flex flex-wrap gap-6">
            {stats.map((s) => (
              <div key={s.label}>
                <dd className="text-xl font-semibold tabular-nums text-kumo-strong">{s.value}</dd>
                <dt>
                  <Text variant="secondary" size="xs">
                    {s.label}
                  </Text>
                </dt>
              </div>
            ))}
          </dl>
        ) : null}
      </div>
    </header>
  );
}

/** A titled Kumo Surface. Every block on the detail and metrics pages is one. */
export function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Surface className="mb-3 overflow-hidden rounded-xl border border-kumo-line bg-kumo-base">
      <div className="border-b border-kumo-hairline bg-kumo-elevated px-4 py-2.5">
        <h2 className="m-0">
          <Text variant="heading">{title}</Text>
        </h2>
      </div>
      {children}
    </Surface>
  );
}

export function PanelBody({ children }: { children: ReactNode }) {
  return <div className="p-4">{children}</div>;
}

/** Responsive column set built on Kumo's Grid. */
export function Columns({ children }: { children: ReactNode }) {
  return (
    <Grid variant="3up" gap="sm" className="items-start">
      {children}
    </Grid>
  );
}

export function KeyValue({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[9rem_minmax(0,1fr)] gap-x-4 gap-y-1.5 max-[540px]:grid-cols-1">
      {rows.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="pt-0.5">
            <Text variant="secondary" size="xs">
              {k}
            </Text>
          </dt>
          <dd className="min-w-0 break-words">
            <Text size="sm">{v}</Text>
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function renderPage(node: ReactNode): string {
  return `<!doctype html>${renderToString(node)}`;
}
