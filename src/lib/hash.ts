/**
 * Deterministic string hashes for visual assignment (colors, jitter).
 * Same input always yields the same value, so renders stay stable
 * between server and client and across reloads.
 */

/** Stable hue in [0, 360) for a string. */
export function hashHue(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (h * 31 + input.charCodeAt(i)) >>> 0;
  }
  return h % 360;
}

/** Stable value in [0, 1) for a string, `salt` picking an independent stream. */
export function hashUnit(id: string, salt = 0) {
  let h = salt * 2654435761;
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) >>> 0;
  }
  return (h % 10000) / 10000;
}

/**
 * `hashUnit(id, salt)` for many salts of one id, hashing the string once instead of per call.
 *
 * Exact, not an approximation: the hash is linear in its seed, so for a string of length L
 * it equals `salt·2654435761·31^L + hash(id)` mod 2^32, and only the first term depends on the
 * salt. That identity needs the seed to be exact in a double before `hashUnit`'s first `>>> 0`
 * (salt·2654435761·31 < 2^53), so larger salts, and the empty string (which `hashUnit` never
 * reduces mod 2^32), fall back to `hashUnit` itself. `scripts/smoke-hash-stream.ts` pins it.
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
