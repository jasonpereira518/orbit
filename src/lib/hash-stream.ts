import { hashUnit } from "@/lib/hash";

/**
 * `hashUnit(id, salt)` for many salts of one id, hashing the string once instead of per call.
 *
 * Exact, not an approximation: the hash is linear in its seed, so for a string of length L
 * it equals `salt·2654435761·31^L + hash(id)` mod 2^32, and only the first term depends on the
 * salt. That identity needs the seed to be exact in a double before `hashUnit`'s first `>>> 0`
 * (salt·2654435761·31 < 2^53), so larger salts, and the empty string (which `hashUnit` never
 * reduces mod 2^32), fall back to `hashUnit` itself. `scripts/smoke-hash-stream.ts` pins it.
 *
 * Its own module rather than beside `hashUnit` in hash.ts, which half the app imports for colours:
 * only the constellation layout needs this, and nothing else should ship it.
 */
export function hashUnitStream(id: string): (salt: number) => number {
  if (id.length === 0) return (salt) => hashUnit(id, salt);
  let base = 0;
  let pow = 1;
  for (let i = 0; i < id.length; i++) {
    base = (Math.imul(base, 31) + id.charCodeAt(i)) >>> 0;
    pow = Math.imul(pow, 31) >>> 0;
  }
  return (salt) => {
    if (!Number.isInteger(salt) || salt < 0 || salt > HASH_STREAM_MAX_SALT) return hashUnit(id, salt);
    const seed = Math.imul(salt, 2654435761) >>> 0;
    const h = ((Math.imul(seed, pow) >>> 0) + base) >>> 0;
    return (h % 10000) / 10000;
  };
}

/** Largest salt for which `salt * 2654435761 * 31` is exact in a double (see above). */
export const HASH_STREAM_MAX_SALT = 100_000;
