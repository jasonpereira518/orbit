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
 * `userId:encrypt(verifier):encodeURIComponent(safeReturnPath(returnTo))`, the same shape
 * `src/actions/gmail.ts` builds its OAuth state in. There the middle field is a bare
 * `crypto.randomUUID()`, so a plain `split(":")` is enough; here it is an *encrypted*
 * verifier — the actual PKCE secret, worth protecting at rest even inside an httpOnly
 * cookie — and `encrypt()`'s own output is `iv:tag:data`, so `decodeState` below has to
 * peel the first and last fields off rather than split naively.
 */
export function encodeState(input: {
  userId: string;
  verifier: string;
  returnTo?: string | null;
}): string {
  const safeReturn = safeReturnPath(input.returnTo ?? null) ?? "";
  return `${input.userId}:${encrypt(input.verifier)}:${encodeURIComponent(safeReturn)}`;
}

/**
 * Null on anything malformed, tampered with, or encrypted under a different key — never
 * throws. A stale or forged cookie must send the person back to the AI page with a
 * friendly reason, not a 500.
 */
export function decodeState(raw: string): OpenRouterOAuthState | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const parts = raw.split(":");
  // userId + encrypt()'s 3 colon-joined fields (iv, tag, data) + the encoded return path.
  if (parts.length !== 5) return null;
  const userId = parts[0];
  const encodedReturnTo = parts[4];
  const encryptedVerifier = `${parts[1]}:${parts[2]}:${parts[3]}`;
  if (!userId) return null;

  let verifier: string;
  try {
    verifier = decrypt(encryptedVerifier);
  } catch {
    return null;
  }
  if (!verifier) return null;

  let decodedReturnTo: string;
  try {
    decodedReturnTo = decodeURIComponent(encodedReturnTo);
  } catch {
    return null;
  }

  return { userId, verifier, returnTo: safeReturnPath(decodedReturnTo) };
}
