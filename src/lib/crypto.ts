import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync } from "crypto";
import {
  DEV_ENCRYPTION_FALLBACK,
  KEY_PURPOSES,
  deriveKey,
  encryptionSecret,
  encryptionSecrets,
} from "@/lib/secrets";

const ALGO = "aes-256-gcm";

/**
 * Encryption at rest for credentials Orbit must read back (provider keys, OAuth tokens,
 * webhook secrets, interest-list tokens).
 *
 * TWO FORMATS, BOTH READABLE FOREVER (audit L-06):
 *
 *   legacy  `<iv hex>:<tag hex>:<data hex>` — key = scrypt(secret, "orbit-salt"). No key id,
 *           so a reader has to try each secret it knows.
 *   v2      `v2:<kid>:<iv hex>:<tag hex>:<data hex>` — key = HKDF(secret, "aes-256-gcm:v2"),
 *           `kid` = 8 hex characters identifying the secret, and the "v2:<kid>" prefix is
 *           bound into the GCM tag as associated data so it cannot be swapped.
 *
 * `encrypt` always writes v2 under the current `ENCRYPTION_SECRET`. `decrypt` reads either
 * format under the current secret or `ENCRYPTION_SECRET_PREVIOUS`. `decryptWithStatus` also
 * says whether the stored value is stale (legacy, or v2 under the previous secret), which is
 * what `src/lib/crypto-rewrap.ts` uses to re-encrypt lazily on read.
 */

/**
 * scrypt is deliberately slow (~40ms of synchronous CPU), so the legacy key is cached per
 * secret. v2 keys come from HKDF, which is cheap, and are cached in `src/lib/secrets.ts`.
 */
const legacyKeys = new Map<string, Buffer>();

function legacyKey(secret: string): Buffer {
  const cacheKey = createHmac("sha256", "orbit:legacy-cache").update(secret).digest("hex");
  let key = legacyKeys.get(cacheKey);
  if (!key) {
    key = scryptSync(secret, "orbit-salt", 32);
    legacyKeys.set(cacheKey, key);
  }
  return key;
}

/** The 8-hex id of a secret, written into every v2 ciphertext. Not secret itself. */
export function keyIdFor(secret: string): string {
  return deriveKey(secret, KEY_PURPOSES.keyId).toString("hex").slice(0, 8);
}

function currentSecret(): string {
  return encryptionSecret(DEV_ENCRYPTION_FALLBACK);
}

export function encrypt(plaintext: string): string {
  const secret = currentSecret();
  const kid = keyIdFor(secret);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, deriveKey(secret, KEY_PURPOSES.aesV2), iv);
  cipher.setAAD(Buffer.from(`v2:${kid}`, "utf8"));
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v2:${kid}:${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

/** The pre-v2 format, kept so tests can produce real legacy ciphertext. Never call it in app code. */
export function encryptLegacyForTest(plaintext: string, secret: string = currentSecret()): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, legacyKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

function openGcm(key: Buffer, ivHex: string, tagHex: string, dataHex: string, aad?: string): string {
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivHex, "hex"));
  if (aad) decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString("utf8");
}

export type DecryptResult = {
  plaintext: string;
  /** True when the value should be re-encrypted: legacy format, or made with the previous secret. */
  stale: boolean;
};

export function decryptWithStatus(payload: string): DecryptResult {
  const secrets = encryptionSecrets(DEV_ENCRYPTION_FALLBACK);
  const parts = payload.split(":");

  if (parts[0] === "v2") {
    const [, kid, ivHex, tagHex, dataHex, extra] = parts;
    if (!kid || !ivHex || !tagHex || !dataHex || extra !== undefined) {
      throw new Error("Invalid encrypted payload");
    }
    // The id picks the secret; a (vanishingly unlikely) id collision just falls through to
    // trying the others, since the GCM tag is what actually decides.
    const ordered = [...secrets].sort((a, b) => Number(keyIdFor(b) === kid) - Number(keyIdFor(a) === kid));
    for (const secret of ordered) {
      try {
        const plaintext = openGcm(deriveKey(secret, KEY_PURPOSES.aesV2), ivHex, tagHex, dataHex, `v2:${kid}`);
        return { plaintext, stale: secret !== secrets[0] };
      } catch {
        // try the next secret
      }
    }
    throw new Error("Unable to decrypt payload with any configured secret");
  }

  const [ivHex, tagHex, dataHex, extra] = parts;
  if (!ivHex || !tagHex || !dataHex || extra !== undefined) throw new Error("Invalid encrypted payload");
  for (const secret of secrets) {
    try {
      return { plaintext: openGcm(legacyKey(secret), ivHex, tagHex, dataHex), stale: true };
    } catch {
      // try the next secret
    }
  }
  throw new Error("Unable to decrypt payload with any configured secret");
}

export function decrypt(payload: string): string {
  return decryptWithStatus(payload).plaintext;
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

/** True when `payload` is v2 under the current secret (nothing to re-encrypt). */
export function isCurrentCiphertext(payload: string): boolean {
  const [version, kid] = payload.split(":");
  return version === "v2" && kid === keyIdFor(currentSecret());
}
