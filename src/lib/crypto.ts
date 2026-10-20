import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "crypto";

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

/**
 * Timing-safe string comparison. `timingSafeEqual` throws on unequal lengths, so the lengths
 * are compared first (a wrong-length value is simply unequal). Compares the UTF-8 bytes.
 */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Lowercase hex SHA-256 of a UTF-8 string. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Signed, domain-separated tokens: `${base64url(payload)}.${base64url(HMAC)}`. The HMAC key is
 * HMAC-SHA256(ENCRYPTION_SECRET, label), so a token minted under one label never verifies under
 * another. `devSecret` is the dev-only stand-in when ENCRYPTION_SECRET is unset; it is refused
 * outright in production, because a known key would let anyone sign a token.
 * The format is frozen: changing it invalidates every token already sent in an email.
 */
function tokenKey(label: string, devSecret: string): Buffer {
  const secret = process.env.ENCRYPTION_SECRET;
  if (!secret && process.env.NODE_ENV === "production") {
    throw new Error("ENCRYPTION_SECRET must be set in production");
  }
  return createHmac("sha256", secret || devSecret).update(label).digest();
}

export function signToken(label: string, payload: string, devSecret = "orbit-dev-token"): string {
  const id = Buffer.from(payload, "utf8").toString("base64url");
  const mac = createHmac("sha256", tokenKey(label, devSecret)).update(id).digest("base64url");
  return `${id}.${mac}`;
}

/** The payload a token was signed for, or null when this app did not sign it (or it is empty). */
export function verifyToken(
  label: string,
  token: string | null | undefined,
  devSecret = "orbit-dev-token"
): string | null {
  if (!token || token.length > 400) return null;
  const [id, mac, extra] = token.split(".");
  if (!id || !mac || extra !== undefined) return null;
  const expected = createHmac("sha256", tokenKey(label, devSecret)).update(id).digest("base64url");
  if (!safeEqual(mac, expected)) return null;
  return Buffer.from(id, "base64url").toString("utf8") || null;
}
