import type { Env } from "./types";

/**
 * Named administrators.
 *
 * Each person gets their own token, so the audit trail records a name rather
 * than an IP and access can be revoked for one person without rotating the
 * secret for everyone. Only the SHA-256 of a token is ever stored.
 *
 * The `ADMIN_TOKEN` secret remains valid for CI and scripted use and is
 * attributed to a reserved identity rather than a person.
 */

export interface User {
  id: string;
  name: string;
  token_hash: string;
  role: "owner" | "admin";
  disabled: number;
  created_by: string | null;
  created_at: string;
  last_seen_at: string | null;
}

/** The identity behind a request, whether a person or the CI secret. */
export interface Identity {
  id: string;
  name: string;
  role: "owner" | "admin" | "ci";
}

export const CI_IDENTITY: Identity = { id: "ci", name: "ADMIN_TOKEN", role: "ci" };

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function newToken(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function listUsers(db: D1Database): Promise<User[]> {
  const { results } = await db
    .prepare(`SELECT * FROM users ORDER BY role = 'owner' DESC, created_at`)
    .all<User>();
  return results ?? [];
}

export async function countUsers(db: D1Database): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM users`).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function findUserById(db: D1Database, id: string): Promise<User | null> {
  return db
    .prepare(`SELECT * FROM users WHERE id = ?1 AND disabled = 0`)
    .bind(id)
    .first<User>();
}

/** Look a person up by the token they presented. */
export async function findUserByToken(db: D1Database, token: string): Promise<User | null> {
  return db
    .prepare(`SELECT * FROM users WHERE token_hash = ?1 AND disabled = 0`)
    .bind(await sha256Hex(token))
    .first<User>();
}

export interface CreatedUser {
  user: User;
  token: string;
}

export async function createUser(
  db: D1Database,
  name: string,
  role: "owner" | "admin",
  createdBy: string | null,
): Promise<CreatedUser | { error: string }> {
  const trimmed = name.trim();
  if (!trimmed) return { error: "A name is required." };
  if (trimmed.length > 64) return { error: "That name is too long." };

  const existing = await db
    .prepare(`SELECT 1 FROM users WHERE name = ?1`)
    .bind(trimmed)
    .first();
  if (existing) return { error: `Someone is already called “${trimmed}”.` };

  const token = newToken();
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO users (id, name, token_hash, role, disabled, created_by, created_at)
       VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6)`,
    )
    .bind(id, trimmed, await sha256Hex(token), role, createdBy, new Date().toISOString())
    .run();

  const user = await db.prepare(`SELECT * FROM users WHERE id = ?1`).bind(id).first<User>();
  return { user: user!, token };
}

/**
 * Disabling rather than deleting keeps the audit trail readable — a past action
 * still resolves to a name.
 */
export async function setUserDisabled(
  db: D1Database,
  id: string,
  disabled: boolean,
): Promise<{ error?: string }> {
  const user = await db.prepare(`SELECT * FROM users WHERE id = ?1`).bind(id).first<User>();
  if (!user) return { error: "No such person." };

  if (user.role === "owner" && disabled) {
    const others = await db
      .prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND disabled = 0 AND id != ?1`)
      .bind(id)
      .first<{ n: number }>();
    // Locking every owner out would leave the deployment unadministerable.
    if ((others?.n ?? 0) === 0) return { error: "That is the last active owner." };
  }

  await db
    .prepare(`UPDATE users SET disabled = ?2 WHERE id = ?1`)
    .bind(id, disabled ? 1 : 0)
    .run();
  return {};
}

export async function touchUser(db: D1Database, id: string): Promise<void> {
  await db
    .prepare(`UPDATE users SET last_seen_at = ?2 WHERE id = ?1`)
    .bind(id, new Date().toISOString())
    .run();
}

/** Resolves a supplied token to whoever holds it, CI secret included. */
export async function identify(env: Env, token: string): Promise<Identity | null> {
  if (env.ADMIN_TOKEN && timingSafeEqual(env.ADMIN_TOKEN, token)) return CI_IDENTITY;
  const user = await findUserByToken(env.DB, token);
  return user ? { id: user.id, name: user.name, role: user.role } : null;
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
