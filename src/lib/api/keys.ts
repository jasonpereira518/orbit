/**
 * Issuing and verifying the keys that let a third party act as a user.
 *
 * Pure crypto and formatting — no database, no `next/server` — so `tsx` scripts can exercise
 * every branch, and so the one function that runs on every single API request stays cheap.
 *
 * ## Format
 *
 *   orb_live_7f3a9c2b_<43 base64url characters>
 *   └──┬───┘ └───┬──┘ └─────────┬────────────┘
 *      │         │              └ 32 bytes of CSPRNG output: the actual secret
 *      │         └ public prefix, stored in clear so Settings can identify the key
 *      └ environment marker, so a test key can never be mistaken for a live one
 *
 * The prefix matters operationally: a user with three keys needs to tell which one a Zapier
 * integration is using before revoking the other two, and the only alternative is showing the
 * secret again — which the whole design exists to avoid.
 *
 * ## Why hashed, not encrypted
 *
 * `src/lib/crypto.ts` is reversible and is correct for the BYOK provider keys, because Orbit
 * has to present those to Gemini and OpenAI. A key Orbit *issues* is only ever compared, so
 * reversibility buys nothing and costs a lot: `ENCRYPTION_SECRET` lives in the same
 * environment as `DATABASE_URL`, so a single dump would yield working credentials for every
 * user. It is also non-deterministic — `encrypt()` uses a random IV — so the ciphertext could
 * not be indexed, and verification would become a full table scan on every request.
 *
 * Plain SHA-256 rather than a password KDF because the input is 256 bits of CSPRNG output.
 * There is no dictionary to slow down, so a KDF would add latency to every request and buy
 * nothing an attacker could have exploited.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export type ApiKeyScope = "read" | "write";
export type ApiKeyKind = "api" | "mcp_url";

const LIVE_PREFIX = "orb_live";
const MCP_PREFIX = "mcpk_live";

/** Shape check only — cheap enough to reject a malformed bearer before touching the database. */
const KEY_SHAPE = /^(orb_live|orb_test|mcpk_live)_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/;

export type GeneratedApiKey = {
  /** Shown to the user exactly once, at creation. Never stored. */
  token: string;
  /** Stored in clear, for display. */
  prefix: string;
  keyHash: string;
};

export function generateApiKey(kind: ApiKeyKind = "api"): GeneratedApiKey {
  const namespace = kind === "mcp_url" ? MCP_PREFIX : LIVE_PREFIX;
  const publicPart = randomBytes(4).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  const token = `${namespace}_${publicPart}_${secret}`;
  return {
    token,
    prefix: `${namespace}_${publicPart}`,
    keyHash: hashApiKey(token),
  };
}

export function hashApiKey(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Whether a string could possibly be one of our keys.
 *
 * Runs before the database lookup so a flood of malformed bearers costs no queries. It is a
 * shape test and nothing more — passing it says nothing about whether the key exists.
 */
export function looksLikeApiKey(token: string | null | undefined): boolean {
  return typeof token === "string" && KEY_SHAPE.test(token);
}

/**
 * Constant-time comparison of two hex digests.
 *
 * The lookup is by unique index, so this is belt-and-braces rather than the primary defence —
 * but a digest comparison that short-circuits is exactly the kind of thing that gets copied
 * into a context where it does matter.
 */
export function hashesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Reads the bearer token out of an Authorization header. */
export function bearerFrom(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/** Masked form for display: `orb_live_7f3a9c2b…`. Never reconstructs the secret. */
export function maskedKey(prefix: string): string {
  return `${prefix}…`;
}
