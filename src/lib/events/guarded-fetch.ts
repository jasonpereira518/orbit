/**
 * One guarded GET of a URL the user chose, with the redirect chain followed by hand.
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
 * ## Why it lives apart from `fetch-page.ts`
 *
 * It was `fetch-page.ts`, and an ICS feed URL is the same hazard wearing a different content
 * type: a link the user pasted, fetched by a background job, with no human looking at the
 * result. `src/lib/calendar-sync.ts` `fetchIcs` shows what the second copy looks like when it
 * is written separately — a plain `fetch` with `redirect: "follow"` and no body cap — so the
 * guarded loop is a shared module rather than a pattern to re-type.
 *
 * `deps` exists so the smoke tests can inject a fetch and stay in the `pure` tier.
 */
import { ERROR_SOURCES, recordErrorEvent } from "@/lib/error-events";
import { assertDeliverable } from "@/lib/net-guard";

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

/** Identify honestly. A site that would rather not be read this way can say so. */
export const USER_AGENT = "OrbitBot/1.0 (+https://orbit.app; event page preview)";

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

export type GuardedFetchOptions = {
  /** Sent as `Accept`, and the content types the response may carry. */
  accept?: string;
  contentTypes?: readonly string[];
  maxBytes?: number;
  deps?: FetchPageDeps;
  /** Which `ERROR_SOURCES` entry an exhausted retry ladder is recorded under. */
  errorSource?: string;
  /** The message for a response whose content type is not allowed. */
  wrongTypeMessage?: string;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Same ladder as `apolloFetch` in `src/lib/apollo.ts`, deliberately. */
function jitteredBackoffMs(attempt: number) {
  return 300 * 2 ** attempt + Math.floor(Math.random() * 250);
}

/**
 * Read at most `maxBytes` of the body, then stop.
 *
 * Streamed rather than `await res.text()` because `Content-Length` is optional and can lie:
 * trusting it means a hostile server can hand us an unbounded body and exhaust the function's
 * memory. Reading through the reader and cancelling is the only cap that actually holds.
 */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
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
      if (total >= maxBytes) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return out;
}

function typeAllowed(contentType: string | null, allowed: readonly string[]): boolean {
  if (!contentType) return false;
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  return allowed.includes(type);
}

/**
 * One guarded request, with the retry ladder. Redirects are returned, not followed — the
 * caller advances them so the guard runs on the next URL.
 */
async function attemptOnce(
  url: string,
  options: Required<Pick<GuardedFetchOptions, "accept" | "contentTypes" | "maxBytes" | "wrongTypeMessage">> & {
    deps: FetchPageDeps;
    errorSource: string;
  }
): Promise<{ kind: "redirect"; location: string } | { kind: "ok"; text: string }> {
  let last: Response | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // Immediately before the request, every time — including on a retry, because DNS can
    // change between attempts and a cached clearance is exactly the rebinding hole.
    await assertDeliverable(url);

    let res: Response;
    try {
      res = await options.deps.fetch(url, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          "user-agent": USER_AGENT,
          accept: options.accept,
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
      if (!typeAllowed(res.headers.get("content-type"), options.contentTypes)) {
        // Checked before a single byte of body is read: an unexpected response type is the
        // channel an attacker would use to read something back out of our network position.
        await res.body?.cancel().catch(() => {});
        throw new EventPageError("not_html", options.wrongTypeMessage);
      }
      return { kind: "ok", text: await readCapped(res, options.maxBytes) };
    }

    if (attempt === MAX_ATTEMPTS - 1) {
      // Only once retries were actually spent — matching `apolloFetch`'s rule, so the error
      // table records exhaustion rather than every transient blip.
      await recordErrorEvent({
        source: options.errorSource,
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

/**
 * Follow one URL's redirect chain and return the body, with the URL it finally came from.
 *
 * The final URL matters to every caller: the page parser resolves relative links against it,
 * and it is the one that gets stored.
 */
export async function guardedFetchText(
  start: string,
  options: GuardedFetchOptions = {}
): Promise<{ url: string; text: string }> {
  const resolved = {
    accept: options.accept ?? "text/html,application/xhtml+xml",
    contentTypes: options.contentTypes ?? ALLOWED_CONTENT_TYPES,
    maxBytes: options.maxBytes ?? MAX_HTML_BYTES,
    wrongTypeMessage: options.wrongTypeMessage ?? "That link is not a web page.",
    deps: options.deps ?? { fetch },
    errorSource: options.errorSource ?? ERROR_SOURCES.eventPageFetch,
  };

  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    let result: Awaited<ReturnType<typeof attemptOnce>>;
    try {
      result = await attemptOnce(url, resolved);
    } catch (error) {
      if (error instanceof EventPageError) throw error;
      // assertDeliverable's refusals land here. Its messages are already user-facing.
      throw new EventPageError("blocked", (error as Error).message);
    }
    if (result.kind === "ok") return { url, text: result.text };
    url = result.location;
  }
  throw new EventPageError("too_many_redirects", "That link redirected too many times.");
}
