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
