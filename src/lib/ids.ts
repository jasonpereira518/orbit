/**
 * Route-param id validation.
 *
 * Every `[id]` segment in the app is a Postgres `uuid` column. Passing an
 * arbitrary string straight into `eq(table.id, param)` makes Postgres throw
 * `22P02 invalid input syntax for type uuid` — which surfaces as the generic
 * error boundary ("Orbit hit a snag", with a Try again button that re-runs the
 * same failing render) instead of the 404 the route already knows how to draw.
 * A well-formed-but-missing uuid 404s correctly today; only the malformed case
 * breaks, and it is reachable from a stale bookmark or a truncated shared link.
 *
 * Guard at the route boundary rather than inside the data accessors: an invalid
 * id reaching `getContact()` from internal code is a programming error worth
 * surfacing, and the pages already have `notFound()` paths that this makes
 * reachable.
 */

/** Accepts any RFC 4122 variant, including the v7 ids Postgres may hand back. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string | null | undefined): value is string {
  if (!value) return false;
  return UUID_RE.test(value);
}
