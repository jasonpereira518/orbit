import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";

const ALGO = "aes-256-gcm";

/**
 * scrypt is deliberately slow (~40ms of synchronous CPU), and this ran on every encrypt and
 * decrypt — several per AI call, one per OAuth token use — blocking every other request on
 * the instance meanwhile. The derived key is cached per secret value, so a rotated secret
 * (or a test that swaps it) still derives afresh.
 */
let cachedKey: { secret: string; key: Buffer } | null = null;

function getKey() {
  let secret = process.env.ENCRYPTION_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "ENCRYPTION_SECRET must be set in production — refusing to encrypt/decrypt with a default key."
      );
    }
    secret = "orbit-dev-secret-change-me-in-prod";
  }
  if (cachedKey?.secret !== secret) {
    cachedKey = { secret, key: scryptSync(secret, "orbit-salt", 32) };
  }
  return cachedKey.key;
}

export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decrypt(payload: string): string {
  const [ivHex, tagHex, dataHex] = payload.split(":");
  if (!ivHex || !tagHex || !dataHex) throw new Error("Invalid encrypted payload");
  const decipher = createDecipheriv(ALGO, getKey(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataHex, "hex")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

/** Decrypt a stored secret, returning null for missing or undecryptable values. */
export function decryptOrNull(encrypted?: string | null): string | null {
  if (!encrypted) return null;
  try {
    return decrypt(encrypted);
  } catch {
    return null;
  }
}
