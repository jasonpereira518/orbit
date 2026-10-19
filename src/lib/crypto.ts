import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";

const ALGO = "aes-256-gcm";

/**
 * scrypt is deliberately slow (~40ms of synchronous CPU), and this ran on every encrypt and
 * decrypt — several per AI call, one per OAuth token use — blocking every other request on
 * the instance meanwhile. Derived keys are cached per secret value, so a rotated secret (or a
 * test that swaps it) still derives afresh.
 */
const derivedKeys = new Map<string, Buffer>();

function deriveKey(secret: string): Buffer {
  let key = derivedKeys.get(secret);
  if (!key) {
    if (derivedKeys.size > 8) derivedKeys.clear();
    key = scryptSync(secret, "orbit-salt", 32);
    derivedKeys.set(secret, key);
  }
  return key;
}

function currentSecret(): string {
  const secret = process.env.ENCRYPTION_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "ENCRYPTION_SECRET must be set in production — refusing to encrypt/decrypt with a default key."
    );
  }
  return "orbit-dev-secret-change-me-in-prod";
}

/**
 * Secrets that used to be current, comma-separated in `ENCRYPTION_PREVIOUS_SECRETS`. Decrypt
 * falls back to them, so rotating `ENCRYPTION_SECRET` is: put the old value here, set the new
 * one, deploy, run `scripts/reencrypt-secrets.ts --apply`, then remove the old value. Nothing
 * is ever encrypted with one of these. See docs/RUNBOOK.md -> Rotate ENCRYPTION_SECRET.
 */
function previousSecrets(): string[] {
  return (process.env.ENCRYPTION_PREVIOUS_SECRETS ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function getKey() {
  return deriveKey(currentSecret());
}

export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

function decryptWith(key: Buffer, ivHex: string, tagHex: string, dataHex: string): string {
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString("utf8");
}

/**
 * Decrypt with the current secret, then each previous one. `usedPrevious` is true when only an
 * old secret opened it, i.e. the value should be re-encrypted (`reencryptAll`).
 */
export function decryptDetailed(payload: string): { plaintext: string; usedPrevious: boolean } {
  const [ivHex, tagHex, dataHex] = payload.split(":");
  if (!ivHex || !tagHex || !dataHex) throw new Error("Invalid encrypted payload");
  try {
    return { plaintext: decryptWith(getKey(), ivHex, tagHex, dataHex), usedPrevious: false };
  } catch (err) {
    const current = currentSecret();
    for (const old of previousSecrets()) {
      if (old === current) continue;
      try {
        return { plaintext: decryptWith(deriveKey(old), ivHex, tagHex, dataHex), usedPrevious: true };
      } catch {
        // wrong key: try the next
      }
    }
    throw err;
  }
}

export function decrypt(payload: string): string {
  return decryptDetailed(payload).plaintext;
}

/**
 * Decrypt a stored secret, returning null for missing or undecryptable values.
 *
 * A null for a value that IS present means no configured secret opens it — a mistyped or
 * rotated `ENCRYPTION_SECRET` — and every saved key then reads as "not set". That used to be
 * invisible; it now leaves a throttled `crypto.decrypt_failed` error event, which the ops
 * sweep's error burst alert will surface if it happens at scale.
 */
export function decryptOrNull(encrypted?: string | null): string | null {
  if (!encrypted) return null;
  try {
    return decrypt(encrypted);
  } catch {
    void reportDecryptFailure();
    return null;
  }
}

async function reportDecryptFailure(): Promise<void> {
  try {
    const { shouldRecordThrottled } = await import("./throttle-latch");
    if (!shouldRecordThrottled("crypto.decrypt_failed")) return;
    const { ERROR_SOURCES, recordErrorEvent } = await import("./error-events");
    await recordErrorEvent({ source: ERROR_SOURCES.cryptoDecryptFailed, kind: "decrypt" });
  } catch {
    // Reporting must never turn a null into a throw.
  }
}
