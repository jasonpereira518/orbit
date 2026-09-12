/**
 * Fetching the public page of an event the user pasted a link to.
 *
 * ## This is the most dangerous code in the events feature
 *
 * Every other fetch in Orbit goes to a host we chose — Apollo, Google, Stripe. This one goes
 * wherever a user points it, which makes it a server-side request forgery primitive unless it
 * is fenced. The fence is `assertDeliverable` from `@/lib/net-guard`, and the rules it enforces
 * (https only, no credentials in the URL, no internal hostname, DNS resolved and every
 * resulting address checked) are documented there.
 *
 * ## Why this cannot just reuse the webhook sender
 *
 * `src/lib/webhooks/dispatch.ts` sets `redirect: "manual"` and stops at the first hop. That is
 * right for a webhook — the user registered an exact endpoint and a redirect is suspicious.
 * It is wrong here: `lu.ma` short links and Eventbrite tracking URLs redirect as a matter of
 * course, so refusing to follow them would reject most real event links.
 *
 * So this follows redirects itself, and the guard runs again on EVERY hop. That distinction is
 * the whole point: `fetch`'s own redirect following would take the first hop's clearance as
 * permission to reach the second, which is precisely how a public URL becomes a request to
 * 169.254.169.254. `redirect: "manual"` stays set; the loop below is what advances.
 *
 * ## Details only
 *
 * `EventPageDetails` has no attendee field, and this module never looks for one. Guest lists
 * come from a host-scoped provider API or from the user pasting them — see
 * `src/lib/events/connectors/`. That is a product constraint, not an oversight: no platform
 * exposes the guest list of an event you merely attended.
 *
 * `deps` exists so the smoke test can inject a fetch and stay in the `pure` tier.
 */
import { ERROR_SOURCES, recordErrorEvent } from "@/lib/error-events";
import { assertDeliverable } from "@/lib/net-guard";
import { canonicalizeEventUrl } from "@/lib/events/canonical-url";
import { parseEventPage, type EventPageDetails } from "@/lib/events/parse-page";

/** One page is plenty for `<head>` metadata; anything larger is a document we do not want. */
export const MAX_HTML_BYTES = 512_000;

/**
 * Ticket links are longer chains than event links: a mail-tracking redirector, then a short
 * link, then the canonical page. Two hops covered the latter two and rejected real links
 * whose first hop was the tracker, so the budget is four.
 *
 * Raising it costs nothing in safety — `assertDeliverable` runs before EVERY hop, so hop
 * four is checked exactly as hop one is. What the bound still buys is termination: unbounded
 * following is a redirect loop waiting to happen.
 */
export const MAX_REDIRECT_HOPS = 4;

export const ALLOWED_CONTENT_TYPES = ["text/html", "application/xhtml+xml"] as const;

const TIMEOUT_MS = 8_000;
const MAX_ATTEMPTS = 3;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Same ladder as `apolloFetch` in `src/lib/apollo.ts`, deliberately. */
function jitteredBackoffMs(attempt: number) {
  return 300 * 2 ** attempt + Math.floor(Math.random() * 250);
}

export class EventPageError extends Error {
  code:
    | "blocked"
    | "not_html"
    | "too_many_redirects"
    | "unreachable"
    | "http_error"
    /** An order or wallet page. It exists, but no public event page is derivable from it. */
    | "private_page"
    /** The link resolved to a login wall, whose title is not this event's title. */
    | "sign_in_required";
  constructor(code: EventPageError["code"], message: string) {
    super(message);
    this.name = "EventPageError";
    this.code = code;
  }
}

export type FetchPageDeps = { fetch: typeof fetch };

/**
 * Read at most `MAX_HTML_BYTES` of the body, then stop.
 *
 * Streamed rather than `await res.text()` because `Content-Length` is optional and can lie:
 * trusting it means a hostile server can hand us an unbounded body and exhaust the function's
 * memory. Reading through the reader and cancelling is the only cap that actually holds.
 */
async function readCapped(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      out += decoder.decode(value, { stream: true });
      if (total >= MAX_HTML_BYTES) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return out;
}

function isHtml(contentType: string | null): boolean {
  if (!contentType) return false;
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  return (ALLOWED_CONTENT_TYPES as readonly string[]).includes(type);
}

/**
 * One guarded request, with the retry ladder. Redirects are returned, not followed — the
 * caller advances them so the guard runs on the next URL.
 */
async function attemptOnce(
  url: string,
  deps: FetchPageDeps
): Promise<{ kind: "redirect"; location: string } | { kind: "ok"; html: string }> {
  let last: Response | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // Immediately before the request, every time — including on a retry, because DNS can
    // change between attempts and a cached clearance is exactly the rebinding hole.
    await assertDeliverable(url);

    let res: Response;
    try {
      res = await deps.fetch(url, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          // Identify honestly. A site that would rather not be read this way can say so.
          "user-agent": "OrbitBot/1.0 (+https://orbit.app; event page preview)",
          accept: "text/html,application/xhtml+xml",
        },
      });
    } catch {
      if (attempt === MAX_ATTEMPTS - 1) {
        throw new EventPageError("unreachable", "That page could not be reached.");
      }
      await sleep(jitteredBackoffMs(attempt));
      continue;
    }
    last = res;

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new EventPageError("http_error", "The page redirected to nowhere.");
      return { kind: "redirect", location: new URL(location, url).href };
    }

    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable) {
      if (!res.ok) {
        throw new EventPageError("http_error", `That page returned ${res.status}.`);
      }
      if (!isHtml(res.headers.get("content-type"))) {
        // Checked before a single byte of body is read: a non-HTML response is the channel
        // an attacker would use to read something back out of our network position.
        await res.body?.cancel().catch(() => {});
        throw new EventPageError("not_html", "That link is not a web page.");
      }
      return { kind: "ok", html: await readCapped(res) };
    }

    if (attempt === MAX_ATTEMPTS - 1) {
      // Only once retries were actually spent — matching `apolloFetch`'s rule, so the error
      // table records exhaustion rather than every transient blip.
      await recordErrorEvent({
        source: ERROR_SOURCES.eventPageFetch,
        kind: "retry_exhausted",
        message: `Event page returned ${res.status} after ${MAX_ATTEMPTS} attempts`,
        context: { status: res.status, attempts: MAX_ATTEMPTS },
      });
      throw new EventPageError("http_error", `That page returned ${res.status}.`);
    }

    const retryAfter = Number(res.headers.get("retry-after"));
    const waitMs =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 8_000)
        : jitteredBackoffMs(attempt);
    await sleep(waitMs);
  }
  throw new EventPageError("http_error", `That page returned ${last?.status ?? "no response"}.`);
}

/** Follow one candidate's redirect chain to a parsed page. */
async function followAndParse(
  start: string,
  deps: FetchPageDeps
): Promise<EventPageDetails> {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    let result: Awaited<ReturnType<typeof attemptOnce>>;
    try {
      result = await attemptOnce(url, deps);
    } catch (error) {
      if (error instanceof EventPageError) throw error;
      // assertDeliverable's refusals land here. Its messages are already user-facing.
      throw new EventPageError("blocked", (error as Error).message);
    }
    if (result.kind === "ok") return parseEventPage(result.html, url);
    url = result.location;
  }
  throw new EventPageError("too_many_redirects", "That link redirected too many times.");
}

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
      details = await followAndParse(candidate, deps);
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
