/**
 * A same-origin path safe to redirect to after an OAuth round trip, or null.
 *
 * `startsWith("/")` is not enough: `//evil.example` and `/\evil.example` both start with a
 * slash and both resolve to another origin when handed to `new URL(path, origin)`, which is
 * exactly what the callback routes do. So a path must start with a single slash, contain no
 * backslash, and carry no control character (a newline in a Location header is its own bug).
 */
export function safeReturnPath(path: string | null | undefined): string | null {
  if (typeof path !== "string" || !path.startsWith("/")) return null;
  if (path.startsWith("//") || path.includes("\\")) return null;
  for (const ch of path) {
    if (ch.charCodeAt(0) <= 31 || ch.charCodeAt(0) === 127) return null;
  }
  return path;
}
