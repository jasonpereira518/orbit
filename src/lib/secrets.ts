import { createHash, hkdfSync } from "node:crypto";

/**
 * The app's one long-lived secret, `ENCRYPTION_SECRET`, and the keys derived from it
 * (audit L-06).
 *
 * Before this module every purpose used the raw secret directly: AES key material (through
 * scrypt), the rate-limit IP salt, the log tag, three HMAC signers. Each now gets its own
 * HKDF sub-key, named by an `info` string, so a value computed for one purpose can never be
 * replayed as another, and a leak of one derived key says nothing about the rest.
 *
 * ROTATION. `ENCRYPTION_SECRET_PREVIOUS` holds the secret being retired. Every reader accepts
 * both (ciphertext in `src/lib/crypto.ts`, signed tokens through `verificationKeys`), and
 * stored ciphertext is re-encrypted under the current secret the next time it is read. Set
 * it only while rotating; remove it once nothing older is left.
 *
 * LEGACY. Anything already issued under the old derivation (unsubscribe links in sent mail,
 * stored token hashes, hashed rate-limit keys) must keep verifying, so `verificationKeys`
 * returns the raw secret as a second candidate, marked `legacy`. New values are always
 * produced with the HKDF key.
 *
 * DEV FALLBACKS. Each caller keeps the fallback string it always had, so a value issued in
 * development keeps verifying there. No fallback is ever used in production or on Vercel
 * (preview included): those throw instead, because a known key lets anyone sign a token.
 */

export const DEV_ENCRYPTION_FALLBACK = "orbit-dev-secret-change-me-in-prod";

/** Fixed, public, and part of every derived key: changing it invalidates them all. */
const HKDF_SALT = "orbit:hkdf:v1";

/** The HKDF `info` labels in use. One per purpose; never reuse one for something new. */
export const KEY_PURPOSES = {
  aesV2: "aes-256-gcm:v2",
  keyId: "key-id",
  rateLimitSalt: "rate-limit-salt",
  logTag: "log-tag",
  unsubscribe: "unsubscribe",
  oauthState: "oauth-state",
} as const;

export type KeyPurpose = (typeof KEY_PURPOSES)[keyof typeof KEY_PURPOSES];

/** True on any deployed environment, where a hard-coded key is never acceptable. */
function isDeployed(): boolean {
  return process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL);
}

/**
 * The current secret, or the caller's dev fallback off Vercel. Throws in production and on
 * any Vercel deployment when it is unset.
 */
export function encryptionSecret(devFallback: string = DEV_ENCRYPTION_FALLBACK): string {
  const secret = process.env.ENCRYPTION_SECRET;
  if (secret) return secret;
  if (isDeployed()) {
    throw new Error(
      "ENCRYPTION_SECRET must be set on every deployment — refusing to fall back to a development key."
    );
  }
  return devFallback;
}

/** The secret being rotated out, when one is set and differs from the current one. */
export function previousEncryptionSecret(): string | null {
  const previous = process.env.ENCRYPTION_SECRET_PREVIOUS;
  if (!previous || previous === process.env.ENCRYPTION_SECRET) return null;
  return previous;
}

/** Current first, then the previous one if rotating. */
export function encryptionSecrets(devFallback: string = DEV_ENCRYPTION_FALLBACK): string[] {
  const previous = previousEncryptionSecret();
  return previous ? [encryptionSecret(devFallback), previous] : [encryptionSecret(devFallback)];
}

const derived = new Map<string, Buffer>();

/**
 * HKDF-SHA256 of `secret` for one purpose. Cached per (secret, purpose); the cache key is a
 * digest so the secret itself is never kept as a map key.
 */
export function deriveKey(secret: string, purpose: KeyPurpose | string): Buffer {
  const cacheKey = createHash("sha256").update(`${purpose}\u0000${secret}`).digest("hex");
  let key = derived.get(cacheKey);
  if (!key) {
    key = Buffer.from(hkdfSync("sha256", secret, HKDF_SALT, purpose, 32));
    derived.set(cacheKey, key);
  }
  return key;
}

/** The current HKDF sub-key for a purpose: what every NEW value is made with. */
export function subKey(purpose: KeyPurpose, devFallback: string = DEV_ENCRYPTION_FALLBACK): Buffer {
  return deriveKey(encryptionSecret(devFallback), purpose);
}

export type VerificationKey = {
  key: Buffer | string;
  /** The pre-HKDF derivation (the raw secret), accepted only so issued values keep working. */
  legacy: boolean;
  /** Made from `ENCRYPTION_SECRET_PREVIOUS`. */
  previous: boolean;
};

/**
 * Every key a signed value may have been made with, newest first: the HKDF sub-key of the
 * current secret, the current raw secret (legacy), then the same two for the previous secret.
 */
export function verificationKeys(
  purpose: KeyPurpose,
  devFallback: string = DEV_ENCRYPTION_FALLBACK
): VerificationKey[] {
  const out: VerificationKey[] = [];
  encryptionSecrets(devFallback).forEach((secret, i) => {
    out.push({ key: deriveKey(secret, purpose), legacy: false, previous: i > 0 });
    out.push({ key: secret, legacy: true, previous: i > 0 });
  });
  return out;
}
