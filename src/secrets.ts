import type { Env } from "./types";

/**
 * Integration credentials entered through the UI.
 *
 * A one-click deployment has no terminal, so a client needs somewhere to put an
 * API key. Values are encrypted with AES-GCM before storage.
 *
 * Be clear about what that buys: the key lives in the same database as the
 * ciphertext, so this protects against database exports, dashboard browsing and
 * log leakage — not against someone who already has full read access to your
 * D1. A Worker secret set with `wrangler secret put` is stronger and always
 * takes precedence over anything stored here.
 */

/** Every credential the app understands, and what it unlocks. */
export const MANAGED_SECRETS = [
  {
    name: "ANTHROPIC_API_KEY",
    label: "Anthropic API key",
    help: "Real incident briefs instead of canned ones. sk-ant-… from console.anthropic.com.",
    unlocks: "briefs",
  },
  {
    name: "SLACK_BOT_TOKEN",
    label: "Slack bot token",
    help: "Posts briefs to each service's channel. xoxb-… with the chat:write scope.",
    unlocks: "slack",
  },
  {
    name: "SLACK_SIGNING_SECRET",
    label: "Slack signing secret",
    help: "Verifies button clicks. Without it the buttons return 503.",
    unlocks: "slack",
  },
  {
    name: "GITHUB_TOKEN",
    label: "GitHub token",
    help: "Reads commit history and files issues. Needs contents:read and issues:write.",
    unlocks: "repo",
  },
  {
    name: "INGEST_TOKEN",
    label: "Ingest token",
    help: "Bearer credential your applications use to POST errors to /ingest. Not your admin token.",
    unlocks: "logs",
  },
  {
    name: "ELASTICSEARCH_URL",
    label: "Elasticsearch URL",
    help: "Your cluster, reachable from Cloudflare's network.",
    unlocks: "logs",
  },
  {
    name: "ELASTICSEARCH_API_KEY",
    label: "Elasticsearch API key",
    help: "API key for the cluster above.",
    unlocks: "logs",
  },
] as const;

export type ManagedSecretName = (typeof MANAGED_SECRETS)[number]["name"];

const NAMES = new Set<string>(MANAGED_SECRETS.map((s) => s.name));

export interface StoredSecret {
  name: string;
  hint: string;
  updated_by: string | null;
  updated_at: string;
}

/* ------------------------------------------------------------ encryption */

async function keyMaterial(db: D1Database): Promise<string> {
  const row = await db
    .prepare(`SELECT key_material FROM deployment WHERE id = 1`)
    .first<{ key_material: string | null }>();

  if (row?.key_material) return row.key_material;

  // Generated once, on first use.
  const material = toBase64(crypto.getRandomValues(new Uint8Array(32)));
  await db
    .prepare(`UPDATE deployment SET key_material = ?1 WHERE id = 1 AND key_material IS NULL`)
    .bind(material)
    .run();

  const after = await db
    .prepare(`SELECT key_material FROM deployment WHERE id = 1`)
    .first<{ key_material: string | null }>();
  return after?.key_material ?? material;
}

async function aesKey(db: D1Database): Promise<CryptoKey> {
  const material = await keyMaterial(db);
  const base = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(material),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode("fixbat.integration-secrets.v1"),
      info: new Uint8Array(),
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(s: string): ArrayBuffer {
  const bin = atob(s);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/* --------------------------------------------------------------- storage */

/** A recognisable tail so an operator can confirm which value is stored. */
function hintFor(value: string): string {
  const tail = value.slice(-4);
  return value.length <= 8 ? "••••" : `••••${tail}`;
}

export async function putSecret(
  env: Env,
  name: string,
  value: string,
  updatedBy: string,
): Promise<{ error?: string }> {
  if (!NAMES.has(name)) return { error: "Unknown credential." };
  const trimmed = value.trim();
  if (!trimmed) return { error: "A value is required." };

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await aesKey(env.DB),
    new TextEncoder().encode(trimmed),
  );

  await env.DB.prepare(
    `INSERT INTO integration_secrets (name, ciphertext, iv, hint, updated_by, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT (name) DO UPDATE SET
       ciphertext = excluded.ciphertext, iv = excluded.iv, hint = excluded.hint,
       updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  )
    .bind(
      name,
      toBase64(new Uint8Array(ciphertext)),
      toBase64(iv),
      hintFor(trimmed),
      updatedBy,
      new Date().toISOString(),
    )
    .run();

  return {};
}

export async function deleteSecret(env: Env, name: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM integration_secrets WHERE name = ?1`).bind(name).run();
}

export async function listSecrets(env: Env): Promise<StoredSecret[]> {
  const { results } = await env.DB.prepare(
    `SELECT name, hint, updated_by, updated_at FROM integration_secrets ORDER BY name`,
  ).all<StoredSecret>();
  return results ?? [];
}

/**
 * Decrypts everything stored and returns it as an Env overlay. A Worker secret
 * of the same name always wins, so a client can start in the UI and later move
 * a credential to `wrangler secret put` without changing anything else.
 */
export async function resolveEnv(env: Env): Promise<Env> {
  const { results } = await env.DB.prepare(
    `SELECT name, ciphertext, iv FROM integration_secrets`,
  ).all<{ name: string; ciphertext: string; iv: string }>();

  if (!results?.length) return env;

  const key = await aesKey(env.DB);
  const overlay: Record<string, string> = {};

  for (const row of results) {
    // Never let one unreadable row take down the whole request.
    try {
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: fromBase64(row.iv) },
        key,
        fromBase64(row.ciphertext),
      );
      overlay[row.name] = new TextDecoder().decode(plain);
    } catch {
      console.error(`could not decrypt ${row.name} — was key_material replaced?`);
    }
  }

  // Worker secrets take precedence: spread the overlay first.
  return { ...env, ...overlay, ...stripUndefined(env) } as Env;
}

function stripUndefined(env: Env): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && v !== null && v !== "") out[k] = v;
  }
  return out;
}
