/**
 * FNV-1a 64-bit, hex. Sync and dependency-free so the browser and Node compute the same key.
 * BigInt() calls rather than 0x…n literals: the tsconfig target (ES2017) rejects the latter.
 */
export function fnv1a64(text: string): string {
  let h = BigInt("0xcbf29ce484222325");
  const prime = BigInt("0x100000001b3");
  const mask = BigInt("0xffffffffffffffff");
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, "0");
}
