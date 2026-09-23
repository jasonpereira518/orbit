/**
 * The CalDAV transport layer for an iCloud connection: principal/calendar-home discovery,
 * calendar listing, and change fetching. Transport and parsing only — no database statement
 * of any kind, so this is testable against fixtures with no database at all (same shape as
 * `src/lib/connectors/google-calendar.ts` / `microsoft-calendar.ts`). Task 6 wraps this in a
 * connector shaped like those two; Task 8 calls `discoverPrincipal` from the connect action.
 *
 * ## Why this is dangerous code
 *
 * Every request here carries the user's iCloud app-specific password as an `Authorization:
 * Basic` header — Apple's CalDAV endpoint has no OAuth. A request that follows a redirect
 * off Apple's own host hands that password to whoever controls the redirect target. That is
 * the one property this module exists to guarantee, more than correctness of any single
 * PROPFIND body.
 *
 * ## Going through `guardedFetchText`, and why the request still needs its own wrapper
 *
 * `src/lib/events/guarded-fetch.ts` already re-runs an SSRF guard (`assertDeliverable`) on
 * *every* redirect hop and keeps `redirect: "manual"` throughout, which is exactly the
 * "re-checked at every hop, not just the entry point" property this task needs. Two things
 * it does NOT do, by its own doc comment:
 *
 *   1. It only ever sends `GET`, with no body. CalDAV speaks `PROPFIND` and `REPORT` with an
 *      XML request body — there is no way to ask `guardedFetchText` for that.
 *   2. Its `headers` option is documented as being replayed on every redirect hop, "for
 *      conditional-GET validators... NEVER credentials" — exactly the leak this module must
 *      not create.
 *
 * `deps.fetch` is the extension point `guardedFetchText` already exposes for substituting the
 * transport ("`deps` exists so the smoke tests can inject a fetch and stay in the `pure`
 * tier" — its own comment). `davRequest` below uses it for both problems at once: the
 * function passed as `deps.fetch` is invoked by `guardedFetchText` on EVERY hop (the initial
 * request and each redirect it decides to follow), with that hop's own URL, so it can:
 *
 *   - Re-validate the hop's hostname against `caldav.icloud.com` / `*.icloud.com` before
 *     doing anything else — this is what stops a redirect from ever reaching a non-Apple
 *     host, layered on top of `assertDeliverable`'s generic (internal-address-only) check.
 *   - Attach `Authorization` itself, here, never through `GuardedFetchOptions.headers` — so
 *     the password is only ever attached after THIS hop's host has passed the pin, not
 *     merged in once and blindly replayed by `guardedFetchText`'s own redirect loop.
 *   - Send the actual CalDAV method and XML body `guardedFetchText` has no concept of, while
 *     still handing back a real `Response` for `guardedFetchText`'s own status/redirect/
 *     content-type/body-cap handling to interpret exactly as it would for any other fetch
 *     through this module.
 *
 * This was a deliberate choice over editing `guarded-fetch.ts` itself to add `method`/`body`
 * options: that module is shared by every event-page and ICS-feed fetch in the app, and
 * every actual protection it enforces (per-hop `assertDeliverable`, `redirect: "manual"`,
 * the streamed body cap, the content-type allowlist) still runs unchanged here — nothing
 * about what makes it safe depends on the method being `GET`. If a second non-GET consumer
 * ever shows up, promoting this pattern into `GuardedFetchOptions` directly would be the
 * next move; see task-5-report.md for the full reasoning.
 *
 * One consequence worth knowing: `guardedFetchText`'s retry loop cannot distinguish "the
 * `deps.fetch` we gave it refused to send this" from "the network is down" — both are a
 * thrown error from the same call, and it retries either one twice (with backoff) before
 * giving up. A refused host is therefore never contacted (the throw happens before any real
 * fetch), but the error that surfaces after a refused redirect is a generic "could not be
 * reached" a few hundred milliseconds later, not an immediate, specific one. Safety holds
 * either way; only the error's latency and specificity are affected.
 *
 * ## Parsing
 *
 * `fast-xml-parser` with `removeNSPrefix: true`, so `D:response`, `d:response`, and an
 * unprefixed `response` under a default `xmlns="DAV:"` all read as the same `response` key.
 * Apple's real responses are not guaranteed to match any one fixture's prefix choice — see
 * `src/lib/caldav/fixtures/index.ts` for how that variation is exercised on purpose.
 *
 * ## The `syncToken` cursor's value grammar — a contract Tasks 6 and 7 depend on
 *
 * `fetchChanges` returns `nextSyncToken` as one of three shapes, and whoever persists it
 * into `CalendarSyncCursor.syncToken` (Task 7) must round-trip it byte-for-byte as the
 * `cursor` on the next call:
 *
 *   - `null` — no successful fetch has completed yet, or the collection offered neither a
 *     sync-token nor a ctag. Treat this the same as no stored cursor at all next time.
 *   - An opaque, UNPREFIXED string — a real WebDAV-Sync `sync-token` from a
 *     `sync-collection` REPORT (RFC 6578). Sent back verbatim as `<D:sync-token>` next time.
 *   - `ctag:<value>` — a CalendarServer `getctag`, from the non-sync fallback path, prefixed
 *     so a later call can tell on sight (`ctagFromCursor` below) that this calendar has
 *     already been probed and does not support `sync-collection` — and skip straight to the
 *     fallback, rather than spending one doomed credentialed REPORT reconfirming that on
 *     every single call. A real sync-token happening to start with the literal characters
 *     `ctag:` is not a case RFC 6578 rules out, but it is astronomically unlikely for an
 *     opaque server-issued token, and the cost of a false positive is one wasted PROPFIND,
 *     not a security issue.
 *
 * The fallback path's short-circuit (skip the time-range query entirely when nothing could
 * have changed) also depends on `cursor.windowStart` / `cursor.windowEnd` — already fields
 * on `CalendarSyncCursor` — being the window `fetchChanges` was called with on the run that
 * produced the stored `syncToken`. This function does NOT write those fields itself; its own
 * return shape has no room for them. Task 7 must persist `windowStart`/`windowEnd` from the
 * SAME `window` argument it passed into the call that produced the `nextSyncToken` it is
 * storing, every time. Without that, an unchanged ctag cannot be told apart from a rolling
 * window simply not having reached a future event yet, and the two look identical from a
 * ctag alone — see the fix log in task-5-report.md for the failure this caused.
 */
import { XMLParser } from "fast-xml-parser";
import { guardedFetchText } from "@/lib/events/guarded-fetch";
import { ERROR_SOURCES } from "@/lib/error-events";
import type { CalendarSyncCursor } from "@/db/schema";

export type CalDavCredentials = { username: string; password: string };

export type CalDavCalendar = {
  url: string;
  displayName: string;
  color: string | null;
  readOnly: boolean;
  ctag: string | null;
  supportsSync: boolean;
};

/** The app-specific password was rejected (HTTP 401). A revoked password, not a transient
 *  fault — Task 6 treats this as a non-retryable reauth signal rather than burning retries. */
export class CalDavAuthError extends Error {
  constructor(message = "The iCloud app-specific password was rejected.") {
    super(message);
    this.name = "CalDavAuthError";
  }
}

/**
 * Internal: a request was rejected with a definitive 4xx — not 401 (its own error, handled
 * separately), and not 429 (which `guardedFetchText` already classifies as transient and
 * retries, same as a 5xx). Only this range means "the server looked at this exact request
 * and refused it", which is `fetchChanges`' signal to fall back to the non-sync path rather
 * than a fault to surface. Not exported: nothing outside this file is meant to catch it —
 * everything else should see either `CalDavAuthError` or a plain propagated failure.
 */
class CalDavRejectedError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "CalDavRejectedError";
    this.status = status;
  }
}

/** Apple's well-known CalDAV entry point. Discovery starts here and nowhere else. */
const DISCOVERY_URL = "https://caldav.icloud.com/";

const XML_CONTENT_TYPES = ["application/xml", "text/xml", "text/calendar"] as const;

/**
 * A calendar-query response can bundle the full ICS body of every event in a multi-month
 * window into one XML document. `guardedFetchText`'s default (`MAX_HTML_BYTES`, 512 KB) is
 * sized for a `<head>` tag, not this — 8 MB is generous headroom for a busy calendar's
 * worth of events while still being a bound, not an absence of one.
 */
const MAX_CALDAV_BYTES = 8_000_000;

/**
 * `guardedFetchText`'s own doc comment pairs its default timeout with its default byte cap —
 * "a multi-megabyte document needs longer, and 8s would abort it mid-download every time on
 * a cold connection" — and then leaves the pairing to the caller when the cap is raised.
 * `MAX_CALDAV_BYTES` is over 15x the 512 KB default; even a slow connection (a rough
 * 200 KB/s floor) needs ~40s to pull the full cap, so 8s aborted nearly every response near
 * that size before it could finish, retried, and aborted again. 45s covers that with room to
 * spare, while three exhausted attempts (~135s worst case, plus backoff) still fit inside the
 * sync run's own multi-minute budget rather than consuming most of it on one calendar.
 */
const CALDAV_TIMEOUT_MS = 45_000;

const xmlParser = new XMLParser({
  removeNSPrefix: true,
  // Keep every value a string. fast-xml-parser's default number/boolean coercion would turn
  // a numeric-looking ctag or sync-token into a `number`, silently breaking every `===`
  // comparison and string method this file relies on.
  parseTagValue: false,
  trimValues: true,
});

type XmlNode = Record<string, unknown>;

function isAppleHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "caldav.icloud.com" || host.endsWith(".icloud.com");
}

function assertAppleHost(rawUrl: string): void {
  let hostname: string;
  try {
    hostname = new URL(rawUrl).hostname;
  } catch {
    throw new Error("Malformed CalDAV URL");
  }
  if (!isAppleHost(hostname)) {
    throw new Error("Refusing to send a CalDAV request outside icloud.com");
  }
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** CalDAV's `time-range` wants the basic UTC form from RFC 5545 (`20260301T000000Z`), not
 *  full ISO 8601 with dashes and colons. */
function toCalDavUtc(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** fast-xml-parser represents a leaf with only text as a plain string; a leaf that also has
 *  attributes (not expected in any response this file reads, but real-Apple-tolerant
 *  regardless) comes back as `{ "#text": "..." }`. Anything else has no text of its own. */
function textOf(value: unknown): string | null {
  if (typeof value === "string") return value.length > 0 ? value : null;
  if (typeof value === "number") return String(value);
  if (value && typeof value === "object" && "#text" in (value as XmlNode)) {
    const inner = (value as XmlNode)["#text"];
    return typeof inner === "string" ? inner : typeof inner === "number" ? String(inner) : null;
  }
  return null;
}

function hasChild(node: unknown, name: string): boolean {
  return typeof node === "object" && node !== null && name in (node as XmlNode);
}

function parseMultistatus(xml: string): XmlNode {
  const doc = xmlParser.parse(xml) as XmlNode;
  const ms = doc.multistatus;
  return typeof ms === "object" && ms !== null ? (ms as XmlNode) : {};
}

// ---------------------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------------------

const PROPFIND_CURRENT_USER_PRINCIPAL_BODY = `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:current-user-principal/>
  </D:prop>
</D:propfind>`;

const PROPFIND_CALENDAR_HOME_SET_BODY = `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <C:calendar-home-set/>
  </D:prop>
</D:propfind>`;

const PROPFIND_CALENDAR_LIST_BODY = `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/" xmlns:A="http://apple.com/ns/ical/">
  <D:prop>
    <D:resourcetype/>
    <D:displayname/>
    <D:sync-token/>
    <CS:getctag/>
    <A:calendar-color/>
  </D:prop>
</D:propfind>`;

const PROPFIND_CTAG_BODY = `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:" xmlns:CS="http://calendarserver.org/ns/">
  <D:prop>
    <CS:getctag/>
  </D:prop>
</D:propfind>`;

function syncCollectionBody(syncToken: string | null): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<D:sync-collection xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:sync-token>${syncToken ? escapeXml(syncToken) : ""}</D:sync-token>
  <D:sync-level>1</D:sync-level>
  <D:prop>
    <D:getetag/>
    <C:calendar-data/>
  </D:prop>
</D:sync-collection>`;
}

function calendarQueryBody(fromUtc: string, toUtc: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:getetag/>
    <C:calendar-data/>
  </D:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="VEVENT">
        <C:time-range start="${fromUtc}" end="${toUtc}"/>
      </C:comp-filter>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>`;
}

// ---------------------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------------------

/**
 * One PROPFIND or REPORT, with the Apple-only host pin and the Basic auth header attached at
 * the transport layer — see the module doc comment for why both live here rather than in
 * `GuardedFetchOptions`. Returns the raw XML body AND the URL it actually came from — not
 * necessarily `url` above, since Apple is free to redirect a request to a shard host
 * (`p42-caldav.icloud.com` and the like) and a relative href in the response must resolve
 * against where the response actually came from, not where the request was first aimed.
 * Throws `CalDavAuthError` on a 401 and lets every other `guardedFetchText` failure (network,
 * wrong content type, too many redirects, body too large) propagate as its own
 * `EventPageError`.
 */
async function davRequest(
  creds: CalDavCredentials,
  url: string,
  method: "PROPFIND" | "REPORT",
  depth: "0" | "1",
  body: string,
  fetchImpl: typeof fetch
): Promise<{ text: string; url: string }> {
  // Fails fast, with no network access at all, for a bad ENTRY url. A url discovered mid
  // redirect chain is re-checked inside `authedFetch` below, which is what `guardedFetchText`
  // actually invokes per hop.
  assertAppleHost(url);

  const basic = Buffer.from(`${creds.username}:${creds.password}`, "utf8").toString("base64");
  let lastStatus = 0;

  const authedFetch = (async (input: string | URL, init?: RequestInit) => {
    const target = typeof input === "string" ? input : input.toString();
    // Re-checked here, not just at the top of `davRequest`: this function is what
    // `guardedFetchText` calls for EVERY hop, including a redirect target it read out of
    // Apple's own response a moment ago. That is the credential-leak path this guards.
    assertAppleHost(target);
    // `guardedFetchText` always calls us with `redirect: "manual"` today — that is what
    // makes ITS OWN redirect loop (and the host pin just above) the thing deciding whether a
    // redirect is ever followed, rather than `fetch` itself. Verified here, not trusted:
    // `RequestInit.redirect` defaults to `"follow"`, so if `guarded-fetch.ts` ever stopped
    // setting it explicitly, the real `fetch` below would silently start following redirects
    // itself, off-host, with `Authorization` already attached and no guard in that loop at
    // all. A loud failure the day that changes beats a silent security regression.
    if (init?.redirect !== "manual") {
      throw new Error(`Expected guardedFetchText to request redirect: "manual", got ${String(init?.redirect)}`);
    }
    const res = await fetchImpl(target, {
      // Hardcoded, not `init.redirect` — belt and suspenders with the check just above.
      redirect: "manual",
      signal: init?.signal,
      method,
      headers: {
        ...(init?.headers as Record<string, string> | undefined),
        Authorization: `Basic ${basic}`,
        Depth: depth,
        "Content-Type": "application/xml; charset=utf-8",
      },
      body,
    });
    lastStatus = res.status;
    return res;
  }) as unknown as typeof fetch;

  try {
    const result = await guardedFetchText(url, {
      accept: "application/xml, text/xml",
      contentTypes: XML_CONTENT_TYPES,
      maxBytes: MAX_CALDAV_BYTES,
      timeoutMs: CALDAV_TIMEOUT_MS,
      // "truncate" (the default) would hand back a clean-looking partial XML tree instead of
      // an error — fast-xml-parser does not notice a document cut mid-element. A caller here
      // (`fetchChanges`) advances a cursor off what it's given; a silently partial response
      // would advance PAST events it never actually saw, permanently. See
      // `guarded-fetch.ts`'s own doc comment on `onOverflow` for this exact hazard.
      onOverflow: "error",
      wrongTypeMessage: "iCloud returned something that was not XML.",
      errorSource: ERROR_SOURCES.caldavSync,
      deps: { fetch: authedFetch },
    });
    return { text: result.text, url: result.url };
  } catch (err) {
    // `guardedFetchText` throws a generic `EventPageError` for every non-2xx status; 401 is
    // the one status this module must surface distinctly. `lastStatus` is read from the
    // actual `Response`, not parsed out of an error message, so it holds regardless of how
    // `guardedFetchText` happens to word its own error.
    if (lastStatus === 401) {
      throw new CalDavAuthError();
    }
    // A definitive 4xx (not 401, not 429 — see `CalDavRejectedError`'s own comment) is the
    // one status range `fetchChanges` is entitled to read as "unsupported, fall back to the
    // non-sync path". Everything else — a network failure, an exhausted 429/5xx retry ladder,
    // too many redirects, the wrong content type, a body over `MAX_CALDAV_BYTES` — propagates
    // as-is: those are real faults, and folding them into "fall back" is exactly what
    // permanently downgrades a sync-capable calendar over one bad moment.
    if (lastStatus >= 400 && lastStatus < 500 && lastStatus !== 401 && lastStatus !== 429) {
      throw new CalDavRejectedError(lastStatus, err instanceof Error ? err.message : String(err));
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------

export async function discoverPrincipal(
  creds: CalDavCredentials,
  deps?: { fetchImpl?: typeof fetch }
): Promise<{ principalUrl: string; calendarHomeUrl: string }> {
  const fetchImpl = deps?.fetchImpl ?? fetch;

  const principal = await davRequest(
    creds,
    DISCOVERY_URL,
    "PROPFIND",
    "0",
    PROPFIND_CURRENT_USER_PRINCIPAL_BODY,
    fetchImpl
  );
  const principalHref = firstPropHref(principal.text, "current-user-principal");
  if (!principalHref) {
    throw new Error("iCloud did not return a current-user-principal");
  }
  // Resolved against `principal.url` — the URL the response actually came FROM, which is not
  // necessarily `DISCOVERY_URL` if Apple redirected the request to a shard host — not the
  // request's starting URL, so a relative href lands on the right origin either way.
  const principalUrl = new URL(principalHref, principal.url).href;
  // The href came from the server's own response — re-validate it before using it as the
  // target of the next request, same as any other discovery URL Apple hands back.
  assertAppleHost(principalUrl);

  const home = await davRequest(creds, principalUrl, "PROPFIND", "0", PROPFIND_CALENDAR_HOME_SET_BODY, fetchImpl);
  const homeHref = firstPropHref(home.text, "calendar-home-set");
  if (!homeHref) {
    throw new Error("iCloud did not return a calendar-home-set");
  }
  const calendarHomeUrl = new URL(homeHref, home.url).href;
  assertAppleHost(calendarHomeUrl);

  return { principalUrl, calendarHomeUrl };
}

function firstPropHref(xml: string, propName: string): string | null {
  const ms = parseMultistatus(xml);
  for (const response of toArray(ms.response as XmlNode | XmlNode[] | undefined)) {
    for (const propstat of toArray(response.propstat as XmlNode | XmlNode[] | undefined)) {
      const prop = propstat.prop as XmlNode | undefined;
      const node = prop?.[propName] as XmlNode | undefined;
      const href = textOf(node?.href);
      if (href) return href;
    }
  }
  return null;
}

export async function listCalendars(
  creds: CalDavCredentials,
  calendarHomeUrl: string,
  deps?: { fetchImpl?: typeof fetch }
): Promise<CalDavCalendar[]> {
  const fetchImpl = deps?.fetchImpl ?? fetch;
  const listing = await davRequest(creds, calendarHomeUrl, "PROPFIND", "1", PROPFIND_CALENDAR_LIST_BODY, fetchImpl);
  const ms = parseMultistatus(listing.text);

  const calendars: CalDavCalendar[] = [];
  for (const response of toArray(ms.response as XmlNode | XmlNode[] | undefined)) {
    const href = textOf(response.href);
    if (!href) continue;

    let isCalendar = false;
    // Apple marks a subscribed / shared-read-only calendar with a CalendarServer
    // `{http://calendarserver.org/ns/}subscribed` resourcetype element — not part of RFC
    // 4791, and unverified against a real account (Task 1 has not run; see task-5-report.md).
    let isSubscribed = false;
    let displayName: string | null = null;
    let color: string | null = null;
    let ctag: string | null = null;
    let supportsSync = false;

    for (const propstat of toArray(response.propstat as XmlNode | XmlNode[] | undefined)) {
      const status = textOf(propstat.status) ?? "";
      if (!status.includes("200")) continue; // a property this server could not supply
      const prop = (propstat.prop as XmlNode | undefined) ?? {};
      const resourcetype = prop.resourcetype;
      if (hasChild(resourcetype, "calendar")) isCalendar = true;
      if (hasChild(resourcetype, "subscribed")) isSubscribed = true;
      const name = textOf(prop.displayname);
      if (name) displayName = name;
      const colorValue = textOf(prop["calendar-color"]);
      if (colorValue) color = colorValue;
      const ctagValue = textOf(prop.getctag);
      if (ctagValue) ctag = ctagValue;
      // An empty `<sync-token/>` (the property exists but carries no value) means the same
      // as it being absent: no token to resume from, no WebDAV-Sync support to rely on.
      if (textOf(prop["sync-token"])) supportsSync = true;
    }

    if (!isCalendar) continue; // the calendar-home collection itself, or a non-calendar child
    // Resolved against `listing.url` (where the PROPFIND response actually came from), not
    // `calendarHomeUrl` (where it was first aimed) — same reasoning as `discoverPrincipal`.
    const url = new URL(href, listing.url).href;
    // No credential rides on this — the transport pin in `davRequest` refuses it at request
    // time regardless. But a spoofed absolute href would otherwise become stored,
    // user-visible, permanently-broken state in `calendar_sources` the moment anything tries
    // to sync it, so it is refused here too, at the source, rather than left for a later
    // caller to discover the hard way.
    assertAppleHost(url);
    calendars.push({
      url,
      displayName: displayName ?? "Calendar",
      color,
      readOnly: isSubscribed,
      ctag,
      supportsSync,
    });
  }
  return calendars;
}

function calendarDataOf(propstats: XmlNode[]): string | null {
  for (const propstat of propstats) {
    const status = textOf(propstat.status) ?? "";
    if (!status.includes("200")) continue;
    const prop = (propstat.prop as XmlNode | undefined) ?? {};
    const data = textOf(prop["calendar-data"]);
    if (data) return data;
  }
  return null;
}

function parseSyncCollectionResponse(xml: string): {
  icsDocuments: string[];
  nextSyncToken: string | null;
  tombstones: number;
} {
  const ms = parseMultistatus(xml);
  const icsDocuments: string[] = [];
  let tombstones = 0;

  for (const response of toArray(ms.response as XmlNode | XmlNode[] | undefined)) {
    // RFC 6578 §3.6 allows a removed resource to be reported either as a bare top-level
    // `status` with no `propstat` at all, or as a `propstat` whose own status is 404 — real
    // servers use both shapes, so both are read here.
    const topStatus = textOf(response.status);
    if (topStatus?.includes("404")) {
      tombstones++;
      continue;
    }

    const propstats = toArray(response.propstat as XmlNode | XmlNode[] | undefined);
    const removed = propstats.some((p) => (textOf(p.status) ?? "").includes("404"));
    const data = calendarDataOf(propstats);
    if (data) {
      icsDocuments.push(data);
    } else if (removed) {
      tombstones++;
    }
  }

  return { icsDocuments, nextSyncToken: textOf(ms["sync-token"]), tombstones };
}

/** Prefix marking a fallback-path (ctag) cursor value — see the module doc comment's cursor
 *  grammar section for the full contract. */
const CTAG_CURSOR_PREFIX = "ctag:";

function ctagCursor(ctag: string): string {
  return `${CTAG_CURSOR_PREFIX}${ctag}`;
}

/** Unwraps a stored cursor value to its bare ctag, or returns `null` if `value` is not one —
 *  either there is no stored cursor, or it holds a real (unprefixed) WebDAV-Sync token. */
function ctagFromCursor(value: string | null | undefined): string | null {
  if (!value || !value.startsWith(CTAG_CURSOR_PREFIX)) return null;
  return value.slice(CTAG_CURSOR_PREFIX.length);
}

/** Whether the window this run was asked to cover is fully inside the window the stored
 *  cursor was last computed for — the only condition under which an unchanged ctag actually
 *  proves nothing relevant changed. A rolling window (today's is 90 days back / 60 forward,
 *  same shape as the Google and Microsoft connectors) moves every run, so without this an
 *  event that only just entered the window would be invisible until something unrelated
 *  edited the calendar and finally changed the ctag. */
function windowCoveredByCursor(cursor: CalendarSyncCursor | null, window: { from: Date; to: Date }): boolean {
  if (!cursor?.windowStart || !cursor?.windowEnd) return false;
  const storedStart = new Date(cursor.windowStart).getTime();
  const storedEnd = new Date(cursor.windowEnd).getTime();
  if (Number.isNaN(storedStart) || Number.isNaN(storedEnd)) return false;
  return storedStart <= window.from.getTime() && storedEnd >= window.to.getTime();
}

export async function fetchChanges(
  creds: CalDavCredentials,
  calendarUrl: string,
  cursor: CalendarSyncCursor | null,
  window: { from: Date; to: Date },
  deps?: { fetchImpl?: typeof fetch }
): Promise<{ icsDocuments: string[]; nextSyncToken: string | null; tombstones: number }> {
  const fetchImpl = deps?.fetchImpl ?? fetch;

  // A `ctag:`-prefixed cursor means a PRIOR call already learned, from the server itself,
  // that this calendar does not support `sync-collection` — see the cursor grammar in the
  // module doc comment. Skip straight to the fallback rather than spending one guaranteed-
  // rejected credentialed REPORT reconfirming that on every single call.
  const knownCtag = ctagFromCursor(cursor?.syncToken);
  const probeSync = knownCtag === null;

  if (probeSync) {
    // Try WebDAV-Sync first. `CalDavCalendar.supportsSync` (from `listCalendars`) is a
    // snapshot from whenever that calendar was last listed and could be stale; asking the
    // server directly is what stays correct if Apple ever adds sync support to a calendar
    // that lacked it, and the `ctag:` prefix above is what stops this from happening on
    // every call once a calendar's answer is already known.
    try {
      const synced = await davRequest(
        creds,
        calendarUrl,
        "REPORT",
        "1",
        syncCollectionBody(cursor?.syncToken ?? null),
        fetchImpl
      );
      return parseSyncCollectionResponse(synced.text);
    } catch (err) {
      // A revoked password is a revoked password regardless of which request surfaced it —
      // never swallowed into "must just be an unsupported report". Likewise anything that
      // isn't a definitive rejection (a network failure, an exhausted 429/5xx retry ladder,
      // too many redirects, an oversized body): those are real faults, and treating them as
      // "unsupported, fall back" is exactly what would permanently downgrade a sync-capable
      // calendar over one bad moment. Only `CalDavRejectedError` — the server looked at this
      // exact request and said no — means fall back.
      if (!(err instanceof CalDavRejectedError)) throw err;
    }
  }

  // Fallback: ctag change-detection plus a bounded time-range query. `calendar-query` has no
  // incremental mode of its own (RFC 4791), so `getctag` (a CalendarServer extension, not in
  // any of the three RFCs, but the only cheap "did anything change" signal available) is the
  // only way to skip the query when nothing relevant has.
  const ctagResult = await davRequest(creds, calendarUrl, "PROPFIND", "0", PROPFIND_CTAG_BODY, fetchImpl);
  const newCtag = firstPropText(ctagResult.text, "getctag");
  if (newCtag !== null && knownCtag !== null && newCtag === knownCtag && windowCoveredByCursor(cursor, window)) {
    return { icsDocuments: [], nextSyncToken: ctagCursor(newCtag), tombstones: 0 };
  }

  const queryResult = await davRequest(
    creds,
    calendarUrl,
    "REPORT",
    "1",
    calendarQueryBody(toCalDavUtc(window.from), toCalDavUtc(window.to)),
    fetchImpl
  );
  // A time-range query only ever returns what currently matches the window — it has no way
  // to report a deletion, unlike a sync-collection report's tombstones.
  return {
    icsDocuments: allCalendarData(queryResult.text),
    nextSyncToken: newCtag !== null ? ctagCursor(newCtag) : null,
    tombstones: 0,
  };
}

function allCalendarData(xml: string): string[] {
  const ms = parseMultistatus(xml);
  const docs: string[] = [];
  for (const response of toArray(ms.response as XmlNode | XmlNode[] | undefined)) {
    const data = calendarDataOf(toArray(response.propstat as XmlNode | XmlNode[] | undefined));
    if (data) docs.push(data);
  }
  return docs;
}

function firstPropText(xml: string, propName: string): string | null {
  const ms = parseMultistatus(xml);
  for (const response of toArray(ms.response as XmlNode | XmlNode[] | undefined)) {
    for (const propstat of toArray(response.propstat as XmlNode | XmlNode[] | undefined)) {
      const status = textOf(propstat.status) ?? "";
      if (!status.includes("200")) continue;
      const prop = (propstat.prop as XmlNode | undefined) ?? {};
      const text = textOf(prop[propName]);
      if (text) return text;
    }
  }
  return null;
}
