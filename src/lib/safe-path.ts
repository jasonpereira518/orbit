/**
 * Is a client-supplied string safe to treat as an app-relative path?
 *
 * Zero dependencies on purpose. Every caller of this predicate is a trust boundary, and a
 * boundary check that drags a module graph behind it ends up copy-pasted instead of
 * imported — which is exactly how the two copies this replaces came to drift apart.
 *
 * The naive check is `startsWith("/")` plus `!startsWith("//")`, and it is wrong. The
 * WHATWG URL parser normalises before it parses an authority, so `new URL(value, origin)`
 * resolves all of these to the host `evil.example`:
 *
 *   - `/\evil.example`      a backslash is folded to a forward slash, so this IS `//`
 *   - `/\/evil.example`     same fold, one slash already present
 *   - `/<TAB>/evil.example` tab, newline and CR are STRIPPED from the whole input before
 *   - `/<LF>/evil.example`  parsing, so the remaining characters collapse into `//`
 *
 * Hence two checks rather than one: the first two characters can never both be
 * slash-or-backslash, and no whitespace or C0 control character may appear ANYWHERE, not
 * just at the front.
 *
 * A bare `/` is deliberately allowed — it is the app root, a legitimate destination and a
 * legitimate place to be standing when you file feedback.
 *
 * This is a PREDICATE, not a sanitiser, because its two callers owe their users different
 * things. `sanitizePath` in `feedback-submission.ts` returns null so the admin console can
 * say "no route recorded"; `safeReturnTo` in the connector OAuth helper substitutes a real
 * destination because a redirect has to go somewhere. Sharing the part that drifted, and
 * not the part that legitimately differs, is the whole point.
 */
export function isAppRelativePath(value: string): boolean {
  // The optional group is what admits a bare "/" while still rejecting "//" and "/\".
  if (!/^\/([^/\\].*)?$/.test(value)) return false;

  // Matching control characters IS the check here, hence the literal range: C0 controls,
  // space, and DEL. A real `location.pathname` is percent-encoded and contains none.
  if (/[\x00-\x20\x7f]/.test(value)) return false;

  return true;
}
