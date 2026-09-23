/**
 * The Apple (iCloud) calendar connector's mapping and cursor rules.
 *
 * Pure tier: the connector issues no database statement, so every one of these runs against a
 * stubbed CalDAV `fetch` and no database at all — real `Response` objects, not a plain object
 * literal, because these go through `guardedFetchText` (see `smoke-caldav-client.ts`'s own
 * header comment on why that matters). Mirrors `smoke-outlook-calendar-map.ts`: the properties
 * that matter here are UID identity (never a provider-local id), recurrence expansion (Apple,
 * unlike Google/Graph, sends only the RRULE master and expects the client to expand it),
 * owner-supplied self detection (Apple has no per-attendee "self" flag either), a CalDAV
 * tombstone read from `fetchChanges`, and the cursor-adoption rule shared with every connector.
 *
 * NO fixture or stub response in this file may use status 429 or >=500 — see
 * `smoke-caldav-client.ts`'s header comment for why an exhausted retryable-status ladder is the
 * one path that can reach a real database even from a "pure" script.
 */
import {
  CalendarSyncTokenExpiredError,
  advanceCursor,
  fetchCalendarPage,
  toNetworkEvents,
} from "../src/lib/connectors/apple-calendar";
import { parseIcsEvents } from "../src/lib/calendar-import";
import type { CalDavCredentials } from "../src/lib/caldav/client";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** A stub `fetch` that answers a queued list of responses in order and records each call's
 *  request BODY (or, for a request with none, the URL) — enough to assert on the sync-token a
 *  REPORT actually sent, same as `smoke-caldav-client.ts`'s richer `Call` shape but flattened to
 *  a single string per call, which is all these checks need. */
function stubFetch(steps: Array<Response | (() => Response)>) {
  const calls: string[] = [];
  const impl = (async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(typeof init?.body === "string" ? init.body : url);
    const i = calls.length - 1;
    const step = steps[Math.min(i, steps.length - 1)];
    if (!step) throw new Error(`stubFetch: no step queued for call ${i} (${url})`);
    return typeof step === "function" ? step() : step;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function xml(body: string, status = 207): Response {
  return new Response(body, { status, headers: { "content-type": "application/xml; charset=utf-8" } });
}

/** A definitive 4xx with no `valid-sync-token` precondition body — same shape as
 *  `smoke-caldav-client.ts`'s `forbidden()`. */
function forbidden(): Response {
  return new Response("", { status: 403, headers: { "content-type": "text/plain" } });
}

const CREDS: CalDavCredentials = { username: "jason@icloud.com", password: "app-specific-secret-do-not-log" };
const CALENDAR_URL = "https://caldav.icloud.com/1234567/calendars/home/";
const OWNER = "me@icloud.com";

const SINGLE_EVENT_ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Orbit Test Fixture//EN
BEGIN:VEVENT
UID:abc-123
DTSTAMP:20260301T120000Z
DTSTART:20260310T150000Z
DTEND:20260310T160000Z
SUMMARY:Coffee with Ada
ORGANIZER;CN=Me:mailto:me@icloud.com
ATTENDEE;CN=Ada Lovelace:mailto:ada@example.com
END:VEVENT
END:VCALENDAR
`;

/** A weekly master with no per-provider expansion (unlike Google/Graph, Apple never expands a
 *  recurrence server-side) — `fetchCalendarPage` must run it through `expandEvent` itself. */
const RECURRING_EVENT_ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Orbit Test Fixture//EN
BEGIN:VEVENT
UID:recurring-1
DTSTAMP:20260301T120000Z
DTSTART:20260310T150000Z
DTEND:20260310T160000Z
SUMMARY:Coffee with Ada
ORGANIZER;CN=Me:mailto:me@icloud.com
ATTENDEE;CN=Ada Lovelace:mailto:ada@example.com
RRULE:FREQ=WEEKLY;COUNT=4
END:VEVENT
END:VCALENDAR
`;

/** One changed (recurring) resource plus one removed resource reported as a bare top-level 404
 *  — the same two shapes RFC 6578 §3.6 allows, exercised together in one response, same as
 *  `SYNC_COLLECTION_RESPONSE` in `src/lib/caldav/fixtures/index.ts`. */
const SYNC_RESPONSE_WITH_RECURRENCE = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:response>
    <D:href>/1234567/calendars/home/recurring-1.ics</D:href>
    <D:propstat>
      <D:prop>
        <D:getetag>"1-rec"</D:getetag>
        <C:calendar-data>${RECURRING_EVENT_ICS}</C:calendar-data>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/1234567/calendars/home/gone-event.ics</D:href>
    <D:status>HTTP/1.1 404 Not Found</D:status>
  </D:response>
  <D:sync-token>https://caldav.icloud.com/1234567/calendars/home/sync/2</D:sync-token>
</D:multistatus>`;

const EMPTY_SYNC_RESPONSE = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:sync-token>https://caldav.icloud.com/1234567/calendars/home/sync/100</D:sync-token>
</D:multistatus>`;

/** `now` pinned so the 90-day-back/60-day-forward expansion window deterministically covers all
 *  four COUNT=4 weekly occurrences starting 2026-03-10. */
const NOW = new Date("2026-03-01T00:00:00Z");

async function main() {
  // --- Identity comes from the VEVENT UID, never a provider-local id ------------------------
  const [first] = parseIcsEvents(SINGLE_EVENT_ICS);
  check("uid comes from the VEVENT UID", first?.uid === "abc-123", String(first?.uid));

  const single = first!;
  check(
    "the external id base is unchanged for a single event",
    toNetworkEvents([single], [OWNER])[0]?.externalIdBase === "cal:abc-123",
    String(toNetworkEvents([single], [OWNER])[0]?.externalIdBase)
  );

  // --- A recurring master expands, and a CalDAV tombstone is counted, not returned -----------
  const { impl: pageImpl } = stubFetch([xml(SYNC_RESPONSE_WITH_RECURRENCE)]);
  const page = await fetchCalendarPage({
    creds: CREDS,
    calendarUrl: CALENDAR_URL,
    cursor: null,
    ownerEmail: OWNER,
    now: NOW,
    fetchImpl: pageImpl,
  });
  check("a recurring master expands", page.events.length === 4, `got ${page.events.length}`);
  check("a deleted href counts as a tombstone", page.tombstones === 1, String(page.tombstones));
  check("selfEmails is the owner address, lowercased", page.selfEmails[0] === OWNER, page.selfEmails.join(","));

  // --- Apple, like Graph, has no per-attendee "self" flag — the owner is excluded by address --
  const participants = toNetworkEvents(page.events, [OWNER]).flatMap((e) => e.participants);
  check(
    "the owner is excluded from counterparts",
    !participants.some((p) => (p.email || "").toLowerCase() === OWNER)
  );
  check("a real counterpart survives", participants.some((p) => p.email === "ada@example.com"));

  // --- An incremental run sends the stored sync token, and CalDAV has no time-range window ----
  {
    const { impl, calls } = stubFetch([xml(EMPTY_SYNC_RESPONSE)]);
    await fetchCalendarPage({
      creds: CREDS,
      calendarUrl: CALENDAR_URL,
      cursor: { syncToken: "tok-abc" },
      ownerEmail: OWNER,
      now: NOW,
      fetchImpl: impl,
    });
    check(
      "an incremental run sends the stored sync token and no window",
      (calls[0]?.includes("tok-abc") ?? false) && !(calls[0]?.includes("time-range") ?? true)
    );
  }

  // --- A rejection the client's own resync handling could not recover from is a resync signal,
  //     not a fault to retry — the CalDAV equivalent of Google's 410 / Graph's 410 -------------
  {
    // A fresh ctag cursor skips straight to the fallback PROPFIND (no sync-collection probe at
    // all — see client.ts's cursor grammar), so a single 403 there is what this exercises.
    const ctagCursor = `ctag:${Date.now()}:99`;
    const { impl } = stubFetch([forbidden()]);
    let err: unknown = null;
    try {
      await fetchCalendarPage({
        creds: CREDS,
        calendarUrl: CALENDAR_URL,
        cursor: { syncToken: ctagCursor },
        ownerEmail: OWNER,
        now: NOW,
        fetchImpl: impl,
      });
    } catch (e) {
      err = e;
    }
    check("an expired token is its own error", err instanceof CalendarSyncTokenExpiredError, String(err));
  }

  // --- The cursor rule shared by every connector: never adopt a token while pages remain ------
  check(
    "the cursor is never adopted while pages remain",
    advanceCursor(null, { ...page, nextPageToken: "more" }).syncToken === undefined
  );

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll Apple Calendar mapping checks passed.");
}

main();
