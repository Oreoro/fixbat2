/**
 * Every outbound call the product makes goes through here.
 *
 * With real client credentials the failure modes stop being hypothetical: a
 * provider that hangs, a rate limit, a 503 during someone else's incident. A
 * bare fetch() has no deadline, so one unresponsive host would hold a pipeline
 * run open until the platform killed it, and the events in that window would
 * be retried from the same cursor for ever.
 */

/** Long enough for a slow API, short enough that a run cannot be held hostage. */
export const EXTERNAL_TIMEOUT_MS = 10_000;

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 250;
/** Never wait longer than this between attempts, whatever Retry-After says. */
const MAX_BACKOFF_MS = 4_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Transient by definition: worth retrying, unlike a 401 or a 404. */
function isTransient(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Providers publish their own backpressure; honouring it is the difference
 * between backing off and being banned.
 */
function retryAfterMs(res: Response): number | null {
  const header = res.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.min(seconds * 1000, MAX_BACKOFF_MS);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.min(Math.max(0, at - Date.now()), MAX_BACKOFF_MS) : null;
}

export interface CallOptions extends RequestInit {
  /** Names the provider in any error, so a failure says which one. */
  what: string;
  /** Retries are for reads; a POST that may have succeeded is not retried. */
  retry?: boolean;
}

export async function callExternal(url: string | URL, options: CallOptions): Promise<Response> {
  const { what, retry = true, ...init } = options;
  const attempts = retry ? MAX_ATTEMPTS : 1;
  let lastStatus = 0;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(EXTERNAL_TIMEOUT_MS) });
    } catch (error) {
      const timedOut = (error as Error)?.name === "TimeoutError";
      if (attempt === attempts) {
        throw new Error(
          timedOut
            ? `${what} did not respond within ${EXTERNAL_TIMEOUT_MS / 1000}s`
            : `${what} unreachable: ${String(error).slice(0, 160)}`,
        );
      }
      await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
      continue;
    }

    if (!isTransient(res.status) || attempt === attempts) return res;

    lastStatus = res.status;
    await sleep(retryAfterMs(res) ?? BASE_BACKOFF_MS * 2 ** (attempt - 1));
  }

  // Unreachable: the loop either returns or throws. Kept for exhaustiveness.
  throw new Error(`${what} failed after ${attempts} attempts (last status ${lastStatus})`);
}

/** Throws with the provider's own words, which are more useful than ours. */
export async function expectOk(res: Response, what: string): Promise<Response> {
  if (res.ok) return res;
  const detail = (await res.text().catch(() => "")).slice(0, 200);
  throw new Error(`${what} ${res.status}: ${detail}`);
}
