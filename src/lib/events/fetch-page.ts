/**
 * Fetching the public page of an event the user pasted a link to.
 *
 * The guarded request itself — the SSRF fence, the hand-followed redirect chain, the capped
 * body read — lives in `guarded-fetch.ts`, because an ICS feed URL is the same hazard in a
 * different content type. What stays here is everything specific to an EVENT page: which
 * candidate URLs to try, and how to tell a login wall from the event.
 *
 * ## Details only
 *
 * `EventPageDetails` carries no guest list, and nothing in this path looks for one. What a
 * public page publishes about people — the host line-up, and the handful of guests a host has
 * chosen to feature — is published deliberately, and that is the boundary: no cookies, no
 * session, no "who's going" endpoint, no pagination. A full guest list comes from a
 * host-scoped provider API (`src/lib/events/connectors/`) or from the user pasting one.
 *
 * That is a product constraint rather than a missing feature. Every platform's terms draw the
 * line at their "publicly supported interfaces", and for an event you merely attended the
 * guest list is not one of them.
 *
 * `deps` exists so the smoke test can inject a fetch and stay in the `pure` tier.
 */
import { canonicalizeEventUrl } from "@/lib/events/canonical-url";
import {
  EventPageError,
  guardedFetchText,
  type FetchPageDeps,
} from "@/lib/events/guarded-fetch";
import { parseEventPage, type EventPageDetails } from "@/lib/events/parse-page";

// Re-exported rather than moved out of sight: these are this module's published surface, and
// `smoke-event-url-guard.ts` and the actions import them from here.
export {
  ALLOWED_CONTENT_TYPES,
  EventPageError,
  MAX_HTML_BYTES,
  MAX_REDIRECT_HOPS,
  type FetchPageDeps,
} from "@/lib/events/guarded-fetch";

const SIGN_IN_PATH = /\/(log-?in|sign-?in|sign-?up|auth|authenticate)(\/|$)/i;

/**
 * Did we land on a login wall rather than the event?
 *
 * Worth detecting because the failure is silent otherwise: a login page parses perfectly
 * well, and "Log In — Eventbrite" would be stored as the event's title.
 *
 * Two independent signals, and the title one is deliberately narrow. `/^register/` would
 * have been the obvious pattern and is exactly wrong — "Register for the AI Summit" is a
 * real event title. So the title branch fires only on an unambiguous log-in/sign-in phrase
 * AND a page carrying neither structured event data nor a date, which no real event page
 * manages at once.
 */
function looksLikeSignIn(details: EventPageDetails): boolean {
  try {
    if (SIGN_IN_PATH.test(new URL(details.sourceUrl).pathname)) return true;
  } catch {
    // An unparseable sourceUrl cannot be judged; fall through to the content signal.
  }
  const bare = details.warnings.includes("no-jsonld-event") && !details.startsAt;
  return bare && /(^|\W)(log ?in|sign ?in)(\W|$)/i.test(details.title ?? "");
}

/**
 * Fetch and parse the public page for a pasted event link.
 *
 * The link is canonicalised first (see `canonical-url.ts`), which yields ORDERED candidates
 * rather than one URL: a rewritten public-page guess, then the user's own link. Each is
 * tried in turn, so a rewrite rule that has gone stale costs one wasted request instead of
 * failing the paste.
 *
 * Throws `EventPageError` for anything the user can act on, so callers can show the reason
 * rather than a generic failure.
 */
export async function fetchEventPage(
  rawUrl: string,
  deps: FetchPageDeps = { fetch }
): Promise<EventPageDetails> {
  const outcome = canonicalizeEventUrl(rawUrl);
  if (outcome.kind === "invalid") throw new EventPageError("blocked", outcome.message);
  if (outcome.kind === "private") throw new EventPageError("private_page", outcome.message);

  let lastError: EventPageError | null = null;
  for (const candidate of outcome.candidates) {
    let details: EventPageDetails;
    try {
      const page = await guardedFetchText(candidate, { deps });
      details = parseEventPage(page.text, page.url);
    } catch (error) {
      // Keep the first refusal: it came from the candidate we thought most likely, and a
      // later candidate's error is usually the same story told about a worse URL.
      lastError ??= error as EventPageError;
      continue;
    }
    if (looksLikeSignIn(details)) {
      lastError ??= new EventPageError(
        "sign_in_required",
        "That link opens a sign-in page. Paste the event's public page instead."
      );
      continue;
    }
    return details;
  }
  throw lastError ?? new EventPageError("unreachable", "That page could not be reached.");
}
