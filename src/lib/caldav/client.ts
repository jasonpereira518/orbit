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
 */
import { XMLParser } from "fast-xml-parser";
import { guardedFetchText } from "@/lib/events/guarded-fetch";
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
 * `GuardedFetchOptions`. Returns the raw XML body; throws `CalDavAuthError` on a 401 and lets
 * every other `guardedFetchText` failure (network, wrong content type, too many redirects,
 * body too large) propagate as its own `EventPageError`.
 */
async function davRequest(
  creds: CalDavCredentials,
  url: string,
  method: "PROPFIND" | "REPORT",
  depth: "0" | "1",
  body: string,
  fetchImpl: typeof fetch
): Promise<string> {
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
    const res = await fetchImpl(target, {
      redirect: init?.redirect,
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
      wrongTypeMessage: "iCloud returned something that was not XML.",
      deps: { fetch: authedFetch },
    });
    return result.text;
  } catch (err) {
    // `guardedFetchText` throws a generic `EventPageError` for every non-2xx status; 401 is
    // the one status this module must surface distinctly. `lastStatus` is read from the
    // actual `Response`, not parsed out of an error message, so it holds regardless of how
    // `guardedFetchText` happens to word its own error.
    if (lastStatus === 401) {
      throw new CalDavAuthError();
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

  const principalXml = await davRequest(
    creds,
    DISCOVERY_URL,
    "PROPFIND",
    "0",
    PROPFIND_CURRENT_USER_PRINCIPAL_BODY,
    fetchImpl
  );
  const principalHref = firstPropHref(principalXml, "current-user-principal");
  if (!principalHref) {
    throw new Error("iCloud did not return a current-user-principal");
  }
  const principalUrl = new URL(principalHref, DISCOVERY_URL).href;
  // The href came from the server's own response — re-validate it before using it as the
  // target of the next request, same as any other discovery URL Apple hands back.
  assertAppleHost(principalUrl);

  const homeXml = await davRequest(
    creds,
    principalUrl,
    "PROPFIND",
    "0",
    PROPFIND_CALENDAR_HOME_SET_BODY,
    fetchImpl
  );
  const homeHref = firstPropHref(homeXml, "calendar-home-set");
  if (!homeHref) {
    throw new Error("iCloud did not return a calendar-home-set");
  }
  const calendarHomeUrl = new URL(homeHref, principalUrl).href;
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
  const xml = await davRequest(creds, calendarHomeUrl, "PROPFIND", "1", PROPFIND_CALENDAR_LIST_BODY, fetchImpl);
  const ms = parseMultistatus(xml);

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
    calendars.push({
      url: new URL(href, calendarHomeUrl).href,
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

export async function fetchChanges(
  creds: CalDavCredentials,
  calendarUrl: string,
  cursor: CalendarSyncCursor | null,
  window: { from: Date; to: Date },
  deps?: { fetchImpl?: typeof fetch }
): Promise<{ icsDocuments: string[]; nextSyncToken: string | null; tombstones: number }> {
  const fetchImpl = deps?.fetchImpl ?? fetch;

  // Try WebDAV-Sync first. There is no separate "does this calendar support sync" flag on
  // this call — `CalDavCalendar.supportsSync` (from `listCalendars`) is a snapshot from
  // whenever that calendar was last listed, and could be stale; asking the server directly,
  // every time, is what stays correct if Apple ever adds or drops support for a calendar.
  // A calendar that does not support it answers with a non-2xx status (RFC 6578: an invalid
  // or unrecognised sync-token is a 403 with a `valid-sync-token` precondition; an
  // unsupported REPORT is a plain 4xx too) — `davRequest` throws either way, and that is the
  // signal to fall back, not a fault to surface.
  try {
    const xml = await davRequest(
      creds,
      calendarUrl,
      "REPORT",
      "1",
      syncCollectionBody(cursor?.syncToken ?? null),
      fetchImpl
    );
    return parseSyncCollectionResponse(xml);
  } catch (err) {
    // A revoked password is a revoked password regardless of which request surfaced it —
    // never swallowed into "must just be an unsupported report".
    if (err instanceof CalDavAuthError) throw err;
  }

  // Fallback: ctag change-detection plus a bounded time-range query. `calendar-query` has no
  // incremental mode of its own (RFC 4791), so `getctag` (a CalendarServer extension, not in
  // any of the three RFCs, but the only cheap "did anything change" signal available) is the
  // only way to skip the query entirely when nothing has.
  const ctagXml = await davRequest(creds, calendarUrl, "PROPFIND", "0", PROPFIND_CTAG_BODY, fetchImpl);
  const newCtag = firstPropText(ctagXml, "getctag");
  if (newCtag !== null && cursor?.syncToken && newCtag === cursor.syncToken) {
    return { icsDocuments: [], nextSyncToken: newCtag, tombstones: 0 };
  }

  const queryXml = await davRequest(
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
    icsDocuments: allCalendarData(queryXml),
    nextSyncToken: newCtag,
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
