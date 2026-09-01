import { ClipboardText } from "@cloudflare/kumo/components/clipboard-text";
import { Collapsible } from "@cloudflare/kumo/components/collapsible";
import { firstAppFrame } from "../fingerprint";

/**
 * Interactive islands.
 *
 * Most of the app is static HTML with no client JS. These components need a
 * browser to do anything, so each is server-rendered inside a marked container
 * and hydrated individually - the page never ships a whole-app hydration
 * bundle, and a page with no islands costs nothing.
 *
 * Server and client must produce the same tree, so props travel as JSON in a
 * data attribute and both sides build from the registry at the bottom.
 */

export interface CopyProps {
  text: string;
  label?: string;
}

/** The fingerprint is the one value worth copying - it identifies the incident. */
export function Copy({ text, label }: CopyProps) {
  return <ClipboardText size="sm" text={text} tooltip={{ text: label ?? "Copy" }} />;
}

export interface TraceProps {
  trace: string;
}

/**
 * Stack trace in a Kumo Collapsible. Dependency frames dim back and the frame
 * the fingerprint was built from is marked - that one frame is why two
 * occurrences group into a single incident.
 */
export function Trace({ trace }: TraceProps) {
  const origin = firstAppFrame(trace);
  const lines = trace.split("\n");
  let marked = false;

  const rendered = lines.map((line, n) => {
    const isFrame = /^\s*at\s/.test(line);
    const isDep = /[/\\]node_modules[/\\]/.test(line);
    let cls = "block whitespace-pre text-kumo-default";
    if (isFrame && isDep) cls = "block whitespace-pre text-kumo-subtle opacity-70";
    else if (isFrame && !marked && origin && line.includes(`${origin.file}:${origin.line}`)) {
      cls = "block whitespace-pre rounded bg-kumo-brand/15 px-1 font-semibold text-kumo-default";
      marked = true;
    }
    return (
      <span key={n} className={cls}>
        {line}
      </span>
    );
  });

  const frames = lines.filter((l) => /^\s*at\s/.test(l)).length;

  return (
    <Collapsible.Root defaultOpen>
      <Collapsible.DefaultTrigger>
        {frames} frame{frames === 1 ? "" : "s"}
      </Collapsible.DefaultTrigger>
      <Collapsible.DefaultPanel>
        <pre className="m-0 mt-2 overflow-x-auto rounded-lg border border-kumo-hairline bg-kumo-recessed p-3.5 font-mono text-xs leading-7">
          {rendered}
        </pre>
        <div className="mt-3 flex flex-wrap gap-4 text-xs text-kumo-subtle">
          <span>
            <span className="mr-1.5 inline-block h-2 w-2 rounded-sm bg-kumo-brand/40" />
            fingerprinted frame
          </span>
          <span>
            <span className="mr-1.5 inline-block h-2 w-2 rounded-sm bg-kumo-contrast" />
            application code
          </span>
          <span>
            <span className="mr-1.5 inline-block h-2 w-2 rounded-sm bg-kumo-fill" />
            dependency
          </span>
        </div>
      </Collapsible.DefaultPanel>
    </Collapsible.Root>
  );
}

/** Every island the client knows how to hydrate. */
export const ISLANDS = {
  copy: Copy,
  trace: Trace,
} as const;

export type IslandName = keyof typeof ISLANDS;

/** Server-side wrapper: renders the island and records how to rebuild it. */
export function Island<N extends IslandName>({
  name,
  props,
}: {
  name: N;
  props: React.ComponentProps<(typeof ISLANDS)[N]>;
}) {
  const Component = ISLANDS[name] as (p: unknown) => React.JSX.Element;
  return (
    <div data-island={name} data-props={JSON.stringify(props)}>
      <Component {...(props as object)} />
    </div>
  );
}
