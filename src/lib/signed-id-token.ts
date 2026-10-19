import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { KEY_PURPOSES, subKey, verificationKeys } from "@/lib/secrets";

/**
 * `base64url(id).HMAC(key, base64url(id))`, the shape of the one-click unsubscribe tokens in
 * Orbit's emails (Radar digest, credit notices).
 *
 * The signing key is `HMAC(K, label)`, with K the HKDF "unsubscribe" sub-key of
 * `ENCRYPTION_SECRET` (audit L-06). Tokens already sitting in people's inboxes were signed with
 * K = the raw secret; those still verify, and come back marked `legacy`, so a caller can apply
 * whatever extra binding it requires only to new tokens. Tokens signed under
 * `ENCRYPTION_SECRET_PREVIOUS` verify too, so rotating the secret breaks no link.
 */
export type SignedIdTokenSpec = {
  /** Domain separation between token kinds; part of every signature, so never edit one. */
  label: string;
  /** The development-only key the module used before this helper existed. */
  devFallback: string;
};

function labelKey(base: Buffer | string, label: string): Buffer {
  return createHmac("sha256", base).update(label).digest();
}

export function signIdToken(spec: SignedIdTokenSpec, id: string): string {
  const encoded = Buffer.from(id, "utf8").toString("base64url");
  const key = labelKey(subKey(KEY_PURPOSES.unsubscribe, spec.devFallback), spec.label);
  return `${encoded}.${createHmac("sha256", key).update(encoded).digest("base64url")}`;
}

/** The pre-HKDF signature, for tests that need a token as old emails carry it. */
export function signIdTokenLegacyForTest(spec: SignedIdTokenSpec, id: string, secret: string): string {
  const encoded = Buffer.from(id, "utf8").toString("base64url");
  return `${encoded}.${createHmac("sha256", labelKey(secret, spec.label)).update(encoded).digest("base64url")}`;
}

export type VerifiedIdToken = { id: string; legacy: boolean; previous: boolean };

export function verifyIdToken(spec: SignedIdTokenSpec, token: string | null | undefined): VerifiedIdToken | null {
  if (!token || token.length > 400) return null;
  const [encoded, mac, extra] = token.split(".");
  if (!encoded || !mac || extra !== undefined) return null;
  const given = Buffer.from(mac);
  for (const candidate of verificationKeys(KEY_PURPOSES.unsubscribe, spec.devFallback)) {
    const expected = Buffer.from(
      createHmac("sha256", labelKey(candidate.key, spec.label)).update(encoded).digest("base64url")
    );
    if (given.length === expected.length && timingSafeEqual(given, expected)) {
      const id = Buffer.from(encoded, "base64url").toString("utf8");
      return id ? { id, legacy: candidate.legacy, previous: candidate.previous } : null;
    }
  }
  return null;
}

/** What is stored to bind a token to its account: a plain digest (the token is already a MAC). */
export function hashIdToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
