/**
 * Pure PKCE + state-cookie logic for the OpenRouter connect flow (spec §3, "The connect
 * flow"). No DB, no `next/server`, no SDK — kept importable by
 * `scripts/smoke-openrouter-oauth.ts`, which pins the S256 derivation against RFC 7636's
 * own test vector. A subtly wrong challenge fails only at the exchange, in a browser,
 * against a live service, with no local signal at all — this file is what gives that
 * signal locally instead.
 */
import { createHash, randomBytes } from "node:crypto";
import { encrypt, decrypt } from "@/lib/crypto";
import { safeReturnPath } from "@/lib/safe-return-path";

/** Matches the cookie state pattern in `src/actions/gmail.ts` (`orbit_gmail_oauth_state`). */
export const OPENROUTER_STATE_COOKIE = "orbit_openrouter_oauth";

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * A cryptographically random PKCE verifier. 32 random bytes base64url-encode to 43
 * characters — RFC 7636 §4.1's minimum length, with none of its padding or `+`/`/`.
 */
export function createVerifier(): string {
  return base64url(randomBytes(32));
}

/** The S256 challenge for a verifier — RFC 7636 §4.2. */
export function challengeFor(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

export type OpenRouterOAuthState = {
  userId: string;
  verifier: string;
  /** Already run through `safeReturnPath`; null for anything off-site or malformed. */
  returnTo: string | null;
};

/**
 * `encrypt(JSON.stringify({ userId, verifier, returnTo }))` — the whole payload under one
 * AEAD, not just the verifier. An earlier version encrypted only the verifier and left
 * `userId` and `returnTo` as cleartext fields alongside it; that meant
 * `decoded.userId === sessionUserId` in the callback route was only as strong as "nobody
 * can write a cookie on this origin", because GCM never covered the id — an attacker who
 * can write a cookie here (Orbit also serves a separate `WAITLIST_HOST`, so sibling-
 * subdomain cookie-tossing is not purely theoretical) could swap in a victim's id and the
 * verifier would still decrypt cleanly. Encrypting the whole object makes any tampering —
 * to the id, the return path, or the verifier — fail the same way: `decrypt()` throws, and
 * `decodeState` reports it as `null`, same as gmail.ts's own state check treats a mismatch.
 */
export function encodeState(input: {
  userId: string;
  verifier: string;
  returnTo?: string | null;
}): string {
  const safeReturn = safeReturnPath(input.returnTo ?? null) ?? "";
  return encrypt(JSON.stringify({ userId: input.userId, verifier: input.verifier, returnTo: safeReturn }));
}

/**
 * Null on anything malformed, tampered with, or encrypted under a different key — never
 * throws, and never returns a partial result. A stale, forged, or truncated cookie must
 * send the person back to the AI page with a friendly reason, not a 500 and not a decode
 * that trusts half of a tampered payload.
 */
export function decodeState(raw: string): OpenRouterOAuthState | null {
  if (typeof raw !== "string" || raw.length === 0) return null;

  let json: string;
  try {
    json = decrypt(raw);
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const { userId, verifier, returnTo } = parsed as Record<string, unknown>;
  if (typeof userId !== "string" || !userId) return null;
  if (typeof verifier !== "string" || !verifier) return null;

  return {
    userId,
    verifier,
    returnTo: safeReturnPath(typeof returnTo === "string" ? returnTo : null),
  };
}
