import type { Env } from "./types";
import {
  CI_IDENTITY,
  countUsers,
  createUser,
  findUserById,
  identify,
  timingSafeEqual,
  touchUser,
  type Identity,
} from "./users";

/**
 * Admin access.
 *
 * Two ways in, both resolving to a named identity:
 *   • `Authorization: Bearer <token>` — a person's token, or the ADMIN_TOKEN
 *     secret, which is attributed to CI rather than a person
 *   • a session cookie for the browser
 *
 * The cookie carries the identity plus an HMAC over a server-side secret, never
 * a token — so it cannot be replayed as a bearer credential against the API.
 */

const COOKIE = "fixbat_session";
const TTL_SECONDS = 12 * 60 * 60;

/** Signing key for session cookies. Distinct from any user's token. */
async function signingKey(env: Env): Promise<string> {
  const row = await env.DB.prepare(`SELECT token_hash FROM deployment WHERE id = 1`).first<{
    token_hash: string | null;
  }>();
  return `${env.ADMIN_TOKEN ?? ""}|${row?.token_hash ?? ""}`;
}

async function sign(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function mintSession(env: Env, identity: Identity): Promise<string> {
  const expiry = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const payload = `v2.${identity.id}.${expiry}`;
  return `${payload}.${await sign(await signingKey(env), payload)}`;
}

async function readSession(env: Env, value: string): Promise<Identity | null> {
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== "v2") return null;
  const [, id, rawExpiry, mac] = parts;

  const expiry = Number(rawExpiry);
  if (!Number.isFinite(expiry) || expiry * 1000 < Date.now()) return null;

  const expected = await sign(await signingKey(env), `v2.${id}.${expiry}`);
  if (!timingSafeEqual(expected, mac)) return null;

  if (id === CI_IDENTITY.id) return env.ADMIN_TOKEN ? CI_IDENTITY : null;

  const user = await findUserById(env.DB, id);
  return user ? { id: user.id, name: user.name, role: user.role } : null;
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export function sessionCookie(value: string, secure: boolean): string {
  // Strict rather than Lax: every admin action is a same-site form post, so
  // Strict costs nothing and removes the cross-site request class outright.
  const attrs = [
    `${COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${TTL_SECONDS}`,
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

export function clearCookie(secure: boolean): string {
  const attrs = [`${COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=0"];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

export type AdminCheck = "ok" | "unclaimed" | "denied";

export interface AuthResult {
  state: AdminCheck;
  identity: Identity | null;
}

/**
 * `unclaimed` is distinct from `denied`: a deployment with no administrator yet
 * has to send people to the claim page, not a dead end.
 */
export async function authenticate(env: Env, req: Request): Promise<AuthResult> {
  const auth = req.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  if (bearer) {
    const identity = await identify(env, bearer);
    if (identity) {
      if (identity.role !== "ci") await touchUser(env.DB, identity.id);
      return { state: "ok", identity };
    }
  }

  const cookie = readCookie(req.headers.get("cookie") ?? undefined, COOKIE);
  if (cookie) {
    const identity = await readSession(env, cookie);
    if (identity) return { state: "ok", identity };
  }

  // Nobody administers this deployment yet, and no CI secret is configured.
  if (!env.ADMIN_TOKEN && (await countUsers(env.DB)) === 0) {
    return { state: "unclaimed", identity: null };
  }

  return { state: "denied", identity: null };
}

export async function checkAdmin(env: Env, req: Request): Promise<AdminCheck> {
  return (await authenticate(env, req)).state;
}

/** The name to attribute an action to, falling back to the caller's address. */
export async function actorFor(env: Env, req: Request): Promise<string> {
  const { identity } = await authenticate(env, req);
  return identity ? identity.name : clientId(req);
}

/**
 * Incident briefs carry production stack traces, internal file paths and repo
 * names, so the app is private by default. PUBLIC_READ=true opts a deployment
 * into anonymous read access; writes always require a session.
 */
export function publicReadEnabled(env: Env): boolean {
  return String(env.PUBLIC_READ ?? "").toLowerCase() === "true";
}

/* ------------------------------------------------------------ throttling */

const MAX_FAILURES = 5;
const LOCKOUT_MINUTES = 15;

/**
 * A token is a single secret on a public URL, so sign-in has to be throttled or
 * it can simply be guessed at speed. Counted per client, cleared on success.
 */
export function clientId(req: Request): string {
  return (
    req.headers.get("cf-connecting-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

export interface Throttle {
  locked: boolean;
  remaining: number;
  retryAfterMinutes: number;
}

export async function checkThrottle(db: D1Database, id: string): Promise<Throttle> {
  const row = await db
    .prepare(`SELECT failures, last_failed FROM auth_attempts WHERE client_id = ?1`)
    .bind(id)
    .first<{ failures: number; last_failed: string }>();

  if (!row) return { locked: false, remaining: MAX_FAILURES, retryAfterMinutes: 0 };

  const elapsedMinutes = (Date.now() - Date.parse(row.last_failed)) / 60000;
  if (elapsedMinutes >= LOCKOUT_MINUTES) {
    await db.prepare(`DELETE FROM auth_attempts WHERE client_id = ?1`).bind(id).run();
    return { locked: false, remaining: MAX_FAILURES, retryAfterMinutes: 0 };
  }

  return {
    locked: row.failures >= MAX_FAILURES,
    remaining: Math.max(0, MAX_FAILURES - row.failures),
    retryAfterMinutes: Math.ceil(LOCKOUT_MINUTES - elapsedMinutes),
  };
}

export async function recordFailure(db: D1Database, id: string): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO auth_attempts (client_id, failures, first_failed, last_failed)
       VALUES (?1, 1, ?2, ?2)
       ON CONFLICT (client_id) DO UPDATE SET
         failures = failures + 1, last_failed = excluded.last_failed`,
    )
    .bind(id, now)
    .run();
}

export async function clearFailures(db: D1Database, id: string): Promise<void> {
  await db.prepare(`DELETE FROM auth_attempts WHERE client_id = ?1`).bind(id).run();
}

/* ----------------------------------------------------------------- claim */

/**
 * First run. A deploy button cannot set a secret, so the first person to open
 * an unclaimed deployment becomes its owner.
 */
export async function claimDeployment(
  env: Env,
  ownerName: string,
): Promise<{ token: string; name: string } | { error: string }> {
  if (await countUsers(env.DB)) return { error: "This deployment has already been claimed." };

  const created = await createUser(env.DB, ownerName.trim() || "owner", "owner", null);
  if ("error" in created) return created;

  // Marks the deployment claimed and gives session signing a stable secret.
  const result = await env.DB.prepare(
    `UPDATE deployment SET token_hash = ?1, claimed_at = ?2, claimed_by = ?3
      WHERE id = 1 AND token_hash IS NULL`,
  )
    .bind(created.user.token_hash, new Date().toISOString(), created.user.name)
    .run();

  // The WHERE guard makes the claim atomic: a concurrent second claim changes
  // no rows, so its user is removed again and it is told the deployment is taken.
  if (result.meta.changes === 0) {
    await env.DB.prepare(`DELETE FROM users WHERE id = ?1`).bind(created.user.id).run();
    return { error: "This deployment has already been claimed." };
  }

  return { token: created.token, name: created.user.name };
}
