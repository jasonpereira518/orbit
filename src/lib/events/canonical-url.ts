/**
 * Turning whatever the user pasted into the URL of the event's *public* page.
 *
 * People do not paste the event page. They paste the link they have, which is whatever their
 * ticket landed on: an Eventbrite `/x/` checkout URL, a Luma link carrying the guest token
 * from their invite, a Meetup `/attendees` subpath, a share URL wearing five `utm_` params.
 * `fetchEventPage` used to take all of those literally, and a login-walled one would come
 * back parsed as an event titled "Log In".
 *
 * ## Rules are hints, not assertions
 *
 * Every rewrite here is a guess about a platform's URL scheme, and platforms change theirs
 * without telling us. So `canonicalizeEventUrl` never returns a single answer — it returns
 * ORDERED CANDIDATES, rewrite first and the user's original last. `fetch-page.ts` walks them
 * until one yields a real event page.
 *
 * That shape is the whole safety argument. A rule that is wrong, or that goes stale in
 * eighteen months, costs one extra request; it cannot turn a working link into a broken one.
 * It is what lets this file carry host-specific knowledge at all without the knowledge
 * becoming load-bearing.
 *
 * ## Stripping is not cosmetic
 *
 * A Luma invite URL carries `?tk=<token>` — the recipient's own guest token. Before this,
 * that string was written into `events.url` and rendered back as a clickable link on the
 * event page. Dropping it is a leak fix, not tidying.
 *
 * Params are removed by explicit DENYLIST, never by pattern, and `IDENTIFYING_PARAMS` wins
 * over the denylist regardless. A canonicaliser that guesses wrong about which param names
 * an event has strips the event's identity and turns a good link into a 404 — the exact
 * failure the candidate list exists to prevent, so it must not be introduced here.
 *
 * Pure: no network, no database. Tested in the `pure` tier by
 * `scripts/smoke-event-canonical-url.ts`.
 */

/** Known-tracking params. Explicit, because anything pattern-matched risks an event id. */
const TRACKING_PARAMS = new Set([
  "aff",
  "ref",
  "referrer",
  "fbclid",
  "gclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "igshid",
  "si",
  "trk",
  "trkcampaign",
  "_gl",
  "gi",
  "share_source",
]);

/** Only `utm_*`. Kept separate so the prefix rule cannot quietly grow. */
const TRACKING_PREFIXES = ["utm_"];

/**
 * Params naming WHICH event. These survive everything above — a collision between this set
 * and the denylist resolves here, because losing an event id is unrecoverable while keeping
 * a tracking param is merely untidy.
 */
const IDENTIFYING_PARAMS = new Set(["eid", "e", "id", "event", "event_id", "eventid"]);

/**
 * Per-host personal tokens. Not tracking — these identify the RECIPIENT, which is why they
 * must never reach the database. Keyed by the matcher below, not by exact hostname.
 */
const HOST_TOKEN_PARAMS: Array<{ host: string; params: string[] }> = [
  // Luma has moved to luma.com and redirects lu.ma to it, so both are live in the wild: old
  // links and confirmation emails still say lu.ma, anything copied today says luma.com.
  // Listing only the short domain would have left the token on every link copied today.
  { host: "lu.ma", params: ["tk", "pk"] },
  { host: "luma.com", params: ["tk", "pk"] },
  { host: "partiful.com", params: ["t"] },
];

/** `host` itself, or any subdomain of it. Never a bare substring — "notlu.ma" is not lu.ma. */
function hostMatches(hostname: string, base: string): boolean {
  return hostname === base || hostname.endsWith(`.${base}`);
}

/** Eventbrite runs a dozen ccTLDs (.co.uk, .ca, .com.au); match the label, not the suffix. */
function isEventbrite(hostname: string): boolean {
  return /(^|\.)eventbrite\.[a-z]{2,}(\.[a-z]{2,})?$/.test(hostname);
}

function isTicketmaster(hostname: string): boolean {
  return /(^|\.)ticketmaster\.[a-z]{2,}(\.[a-z]{2,})?$/.test(hostname);
}

export type CanonicalOutcome =
  /** `candidates` is ordered: try each in turn until one yields an event page. */
  | { kind: "ok"; candidates: string[]; rewritten: boolean }
  /** A page that exists but is the user's own order/wallet — no public page is derivable. */
  | { kind: "private"; message: string }
  | { kind: "invalid"; message: string };

/**
 * Order and wallet URLs, which carry an ORDER id rather than an event id.
 *
 * This is the one honest dead end. No rewrite can recover the event from an order number, so
 * saying so beats fetching a login page and storing its title. Deliberately host-scoped: a
 * generic "/orders" rule would misfire on some host that uses the word innocently.
 */
function privateReason(url: URL): string | null {
  const host = url.hostname;
  const path = url.pathname.toLowerCase();

  if (isEventbrite(host) && /^\/(orders?|mytickets|my-tickets)(\/|$)/.test(path)) {
    return "That is your Eventbrite order page, which only you can open. Paste the event's own page instead.";
  }
  if (isTicketmaster(host)) {
    if (host.startsWith("my.") || /^\/(my|orders?)(\/|$)/.test(path)) {
      return "That is your Ticketmaster order page, which only you can open. Paste the event's own page instead.";
    }
  }
  if (hostMatches(host, "axs.com") && (host.startsWith("my.") || /^\/(my|orders?)(\/|$)/.test(path))) {
    return "That is your AXS order page, which only you can open. Paste the event's own page instead.";
  }
  return null;
}

/** Remove tracking and personal tokens. Returns a new URL; the input is not mutated. */
function stripParams(url: URL): URL {
  const out = new URL(url.href);
  const tokens = HOST_TOKEN_PARAMS.filter((rule) => hostMatches(out.hostname, rule.host)).flatMap(
    (rule) => rule.params
  );

  for (const key of [...out.searchParams.keys()]) {
    const lower = key.toLowerCase();
    if (IDENTIFYING_PARAMS.has(lower)) continue;
    const drop =
      TRACKING_PARAMS.has(lower) ||
      TRACKING_PREFIXES.some((prefix) => lower.startsWith(prefix)) ||
      tokens.includes(lower);
    if (drop) out.searchParams.delete(key);
  }
  // A trailing "?" survives deleting the last param and makes two equal URLs compare unequal.
  if ([...out.searchParams.keys()].length === 0) out.search = "";
  return out;
}

/**
 * The host-specific rewrite, or null when we have nothing better to suggest than what we were
 * given. Returning null is the common and correct case: Partiful and Dice event links are
 * already public, and only need the stripping above.
 */
function rewrite(url: URL): URL | null {
  const host = url.hostname;
  const path = url.pathname;

  if (isEventbrite(host)) {
    // `/x/<slug>-tickets-<id>` is the ticket-selection view of `/e/<slug>-tickets-<id>`.
    const checkout = /^\/x\/(.+)$/.exec(path);
    if (checkout) {
      const next = new URL(url.href);
      next.pathname = `/e/${checkout[1]}`;
      return next;
    }
    // Manage and promo URLs carry the event in `eid` rather than in the path.
    const eid = url.searchParams.get("eid");
    if (eid && !path.startsWith("/e/")) {
      const next = new URL(url.href);
      next.pathname = `/e/${eid}`;
      next.searchParams.delete("eid");
      if ([...next.searchParams.keys()].length === 0) next.search = "";
      return next;
    }
    return null;
  }

  if (hostMatches(host, "meetup.com")) {
    // Sub-tabs of an event page: `/<group>/events/<id>/attendees` and friends.
    const tab = /^\/([^/]+)\/events\/([^/]+)\/(?:attendees|comments|photos|discussions)\/?$/.exec(
      path
    );
    if (tab) {
      const next = new URL(url.href);
      next.pathname = `/${tab[1]}/events/${tab[2]}/`;
      return next;
    }
    return null;
  }

  return null;
}

/**
 * Resolve a pasted link to the candidates worth fetching.
 *
 * A bare "lu.ma/abc" is accepted and read as https — people paste what they copied out of a
 * confirmation email, and refusing it over a missing scheme helps nobody. http is upgraded
 * for the same reason `assertDeliverable` refuses it outright: there is no reason to read an
 * event page in cleartext.
 */
export function canonicalizeEventUrl(raw: string): CanonicalOutcome {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: "invalid", message: "That does not look like a link." };

  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return { kind: "invalid", message: "That does not look like a link." };
  }

  if (url.protocol === "http:") url.protocol = "https:";
  if (url.protocol !== "https:") {
    return { kind: "invalid", message: "Event links must be http or https." };
  }

  const blocked = privateReason(url);
  if (blocked) return { kind: "private", message: blocked };

  const stripped = stripParams(url);
  const rewritten = rewrite(stripped);

  // Deduped, order preserved: the rewrite is worth a request only if it differs.
  const candidates = [rewritten?.href, stripped.href].filter(
    (href, index, all): href is string => Boolean(href) && all.indexOf(href) === index
  );

  return { kind: "ok", candidates, rewritten: Boolean(rewritten) };
}
