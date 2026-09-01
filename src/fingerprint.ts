import type { LogEvent, StackFrame } from "./types";

const DEPENDENCY = /[/\\]node_modules[/\\]/;
const FRAME = /^\s*at\s+(?:async\s+)?(.+?)\s+\((.+?):(\d+):(\d+)\)\s*$/;

/**
 * First stack frame belonging to the application rather than a dependency.
 * This is what makes two occurrences of "the same bug" hash alike.
 */
export function firstAppFrame(stackTrace: string): StackFrame | null {
  for (const line of stackTrace.split("\n")) {
    const m = FRAME.exec(line);
    if (!m) continue;
    const [, fn, file, lineNo] = m;
    if (DEPENDENCY.test(file)) continue;
    return { fn: fn.trim(), file, line: Number(lineNo) };
  }
  return null;
}

/**
 * Stable across line-number drift: keep the file and function, drop the line,
 * so an edit above the fault does not mint a new incident.
 */
export async function fingerprint(event: LogEvent): Promise<string> {
  const frame = firstAppFrame(event.stackTrace);
  const parts = [
    event.service,
    event.environment,
    event.exceptionType,
    frame ? `${frame.file}:${frame.fn}` : normalizeMessage(event.message),
  ];
  return sha256(parts.join(" "));
}

/** Strip volatile bits so messages carrying ids or values still group together. */
function normalizeMessage(message: string): string {
  return message
    .replace(/0x[0-9a-f]+/gi, "<hex>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/\d+/g, "<n>")
    .slice(0, 200);
}

async function sha256(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
