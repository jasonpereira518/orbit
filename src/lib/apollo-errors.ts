import { UserFacingError } from "@/lib/errors";

/**
 * The error for a failed Apollo people search. The failures a person can act on — a plan
 * without people search, a key Apollo rejects, rate limiting — become Orbit's own words;
 * retrying fixes none of them, so "try again" would be wrong. Everything else stays an
 * ordinary Error carrying the status and a slice of the body for the logs, which
 * `friendlyError` never shows.
 *
 * Kept free of database imports so the smoke suite can exercise it without one.
 */
export function apolloSearchError(status: number, body: string): Error {
  if (status === 403 && /\bplan\b/i.test(body)) {
    return new UserFacingError("Your Apollo plan doesn’t include people search — upgrade it in Apollo to search from Orbit");
  }
  if (status === 401 || status === 403) {
    return new UserFacingError("Apollo didn’t accept your key — check it in Settings");
  }
  if (status === 429) {
    return new UserFacingError("Apollo is limiting searches right now — try again in a minute");
  }
  return new Error(`Apollo search failed (${status}): ${body.slice(0, 200)}`);
}
