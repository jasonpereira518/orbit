/**
 * Contract tests for the Microsoft Graph calendar and contacts sync connectors
 * (`src/lib/connectors/microsoft-calendar.ts`, `microsoft-contacts.ts`), against a mocked Graph.
 *
 * Payloads follow Graph's real shapes: a `calendarView/delta` page is `{ value, @odata.nextLink }`
 * until its last page, which carries `@odata.deltaLink` instead; deleted events arrive as
 * `{ id, @removed: { reason } }`; every `dateTime` is offset-less because the request asks for
 * `Prefer: outlook.timezone="UTC"`; contacts page with `@odata.nextLink`. The parsers read those
 * by hand, so the happy paths are pinned field by field — a mapping slip produces a meeting at
 * the wrong hour or a contact with no email, not an error.
 *
 * The failure half pins that a malformed answer is an ERROR, never a quietly empty page: an
 * empty page would advance the cursor (and on the last page adopt a delta link) past events
 * nobody read. HTML served with a 200, `value` that is not an array, and a 5xx all reject; a
 * 410 on the calendar is the typed "start over" signal; a 400 on a filtered contacts read is the
 * typed "drop the watermark" signal.
 *
 * What is NOT pinned here because it is wrong today lives in two bug scripts:
 * `smoke-bug-graph-nextlink-token-leak.ts` (the bearer token follows any `@odata.nextLink`
 * host) and `smoke-bug-graph-sync-resilience.ts` (no timeout on calendar pages; 429 not retried).
 *
 * Run: npx tsx scripts/smoke-contract-microsoft-sync.ts
 */
import {
  advanceCursor,
  CalendarSyncTokenExpiredError,
  fetchCalendarPage,
  fetchCalendarWindow,
  storedEventsOf,
} from "../src/lib/connectors/microsoft-calendar";
import {
  advanceContactsCursor,
  ContactsFilterRejectedError,
  fetchContactsPage,
} from "../src/lib/connectors/microsoft-contacts";
import { checker } from "./smoke/check";
import { makeContact } from "./smoke/factories";
import { json, mockFetch, notJson, route, status } from "./smoke/http-mock";

const t = checker();
const TOKEN = "EwB4A8l6.test-graph-token-not-real";
const OWNER = makeContact(0);
const GUEST = makeContact(1);
const GRAPH = "https://graph.microsoft.com/v1.0";
const NOW = new Date("2026-10-17T12:00:00Z");

function graphEvent(n: number, over: Record<string, unknown> = {}) {
  return {
    "@odata.type": "#microsoft.graph.event",
    "@odata.etag": `W/"DwAAABYAAAA${n}"`,
    id: `AAMkADU3-event-${n}`,
    iCalUId: `040000008200E00074C5B7101A82E0080000000010${n}`,
    subject: `Intro: ${OWNER.firstName} <> ${GUEST.firstName}`,
    bodyPreview: "Quick intro call about the platform role.",
    start: { dateTime: "2026-10-15T16:00:00.0000000", timeZone: "UTC" },
    end: { dateTime: "2026-10-15T16:30:00.0000000", timeZone: "UTC" },
    isAllDay: false,
    isCancelled: false,
    location: { displayName: "Microsoft Teams Meeting", locationType: "default" },
    attendees: [
      { type: "required", status: { response: "accepted", time: "2026-10-10T09:00:00Z" }, emailAddress: { name: GUEST.fullName, address: GUEST.email } },
      { type: "resource", status: { response: "none" }, emailAddress: { name: "Room 4.01", address: "room401@example.com" } },
    ],
    organizer: { emailAddress: { name: OWNER.fullName, address: OWNER.email } },
    responseStatus: { response: "organizer", time: "0001-01-01T00:00:00Z" },
    onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/19%3ameeting_test" },
    ...over,
  };
}

function graphContact(n: number) {
  const c = makeContact(n);
  return {
    "@odata.etag": `W/"EQAAABYAAAA${n}"`,
    id: `AAMkAGI2-contact-${n}`,
    displayName: c.fullName,
    givenName: c.firstName,
    surname: c.lastName,
    companyName: c.company,
    jobTitle: c.title,
    emailAddresses: [{ name: c.fullName, address: c.email }],
    businessPhones: [],
    mobilePhone: c.phone,
  };
}

async function main() {
  console.log("calendarView/delta — a fresh run, page by page");
  {
    const next = `${GRAPH}/me/calendarView/delta?$skiptoken=page2-test`;
    const delta = `${GRAPH}/me/calendarView/delta?$deltatoken=dt-test`;
    const http = mockFetch([
      route("GET", /calendarView\/delta\?startDateTime=/, () =>
        json({
          "@odata.context": `${GRAPH}/$metadata#Collection(event)`,
          value: [graphEvent(1), { id: "AAMkADU3-gone", "@removed": { reason: "deleted" } }],
          "@odata.nextLink": next,
        })
      ),
      route("GET", next, () => json({ value: [graphEvent(2, { iCalUId: undefined })], "@odata.deltaLink": delta })),
    ]);
    try {
      const p1 = await fetchCalendarPage({ accessToken: TOKEN, cursor: null, ownerEmail: OWNER.email.toUpperCase(), now: NOW });
      const first = new URL(http.calls[0].url);
      t.check("the first request is windowed", Boolean(first.searchParams.get("startDateTime") && first.searchParams.get("endDateTime")));
      t.check("…asks for UTC, with the bearer", http.calls[0].headers.prefer === 'outlook.timezone="UTC"' && http.calls[0].headers.authorization === `Bearer ${TOKEN}`);
      t.check("one event, one tombstone", p1.events.length === 1 && p1.tombstones === 1);
      const e = p1.events[0];
      t.check("iCalUId is the identity", e.uid === "040000008200E00074C5B7101A82E00800000000101");
      t.check("an offset-less UTC dateTime is read as UTC", e.start?.toISOString() === "2026-10-15T16:00:00.000Z", e.start?.toISOString());
      t.check("rooms are not attendees", e.attendees.length === 1 && e.attendees[0].email === GUEST.email);
      t.check("the organizer is carried", e.organizer?.email === OWNER.email);
      t.check("self is the owner address, lower-cased", p1.selfEmails[0] === OWNER.email.toLowerCase());
      t.check("mid-run: nextLink, no delta yet", p1.nextPageToken === next && p1.nextSyncToken === null);
      const c1 = advanceCursor(null, p1);
      t.check("the cursor holds the page, not a delta", c1.pageToken === next && !c1.syncToken);

      const p2 = await fetchCalendarPage({ accessToken: TOKEN, cursor: c1, ownerEmail: OWNER.email, now: NOW });
      t.check("the nextLink is followed as-is (no window re-added)", http.calls[1].url === next);
      t.check("an event with no iCalUId falls back to its id", p2.events[0]?.uid === "AAMkADU3-event-2");
      const c2 = advanceCursor(c1, p2);
      t.check("the last page adopts the deltaLink and clears the page", c2.syncToken === delta && c2.pageToken === null);
    } finally {
      http.restore();
    }
  }

  console.log("calendarView/delta — failure answers are errors, never empty pages");
  const calCases: Array<[string, () => Response, (e: unknown) => boolean]> = [
    ["410 Gone → CalendarSyncTokenExpiredError (start over)", () => status(410, { error: { code: "SyncStateNotFound", message: "The sync state generation is not found." } }), (e) => e instanceof CalendarSyncTokenExpiredError],
    ["500 → an error naming the status", () => status(500, { error: { code: "InternalServerError" } }), (e) => e instanceof Error && /Microsoft Calendar 500/.test(e.message)],
    ["401 → an error naming the status", () => status(401, { error: { code: "InvalidAuthenticationToken" } }), (e) => e instanceof Error && /Microsoft Calendar 401/.test(e.message)],
    ["HTML 200 → rejects", () => notJson(), () => true],
    ["`value` is an object, not an array → rejects", () => json({ value: { id: "x" } }), () => true],
  ];
  for (const [label, reply, pred] of calCases) {
    const http = mockFetch([route("GET", /calendarView\/delta/, reply)]);
    try {
      await t.rejects(label, () => fetchCalendarPage({ accessToken: TOKEN, cursor: { syncToken: `${GRAPH}/me/calendarView/delta?$deltatoken=old` }, ownerEmail: OWNER.email }), pred);
    } finally {
      http.restore();
    }
  }
  {
    const http = mockFetch([route("GET", /calendarView\/delta/, () => json({ "@odata.deltaLink": `${GRAPH}/me/calendarView/delta?$deltatoken=x` }))]);
    try {
      const page = await fetchCalendarPage({ accessToken: TOKEN, cursor: null, ownerEmail: OWNER.email, now: NOW });
      t.check("a page with no `value` at all is an empty, final page", page.events.length === 0 && page.nextSyncToken !== null);
    } finally {
      http.restore();
    }
  }

  console.log("calendarView (the live window)");
  {
    const p2 = `${GRAPH}/me/calendarView?$skip=100`;
    const http = mockFetch([
      route("GET", /calendarView\?startDateTime=/, () => json({ value: [graphEvent(3), graphEvent(4, { isCancelled: true })], "@odata.nextLink": p2 })),
      route("GET", p2, () => json({ value: [graphEvent(5, { start: { dateTime: "not-a-date", timeZone: "UTC" } })] })),
    ]);
    try {
      const read = await fetchCalendarWindow({ accessToken: TOKEN, from: NOW, to: new Date(NOW.getTime() + 86_400_000), maxPages: 4 });
      t.check("both pages read, window complete", read.complete && read.items.length === 3);
      const stored = storedEventsOf(read.items, OWNER.email);
      t.check("cancelled and undatable events are not stored", stored.length === 1 && stored[0].providerEventId === "AAMkADU3-event-3");
      t.check("the Teams link is the conference", stored[0].conferenceKind !== null && /teams\.microsoft\.com/.test(stored[0].conferenceUrl ?? ""));
      t.check("organizer RSVP maps to accepted", stored[0].selfResponse === "accepted");
    } finally {
      http.restore();
    }
  }
  {
    const http = mockFetch([route("GET", /calendarView\?/, () => status(503, "<html>Service Unavailable</html>"))]);
    try {
      const read = await fetchCalendarWindow({ accessToken: TOKEN, from: NOW, to: NOW });
      t.check("a 503 on the window is incomplete (so the caller deletes nothing)", !read.complete && read.status === 503);
    } finally {
      http.restore();
    }
  }

  console.log("contacts — pages, watermark, failures");
  {
    const next = `${GRAPH}/me/contacts?$top=200&$skip=200`;
    const http = mockFetch([
      route("GET", /\/me\/contacts\?\$top=200&\$select=/, () =>
        json({
          "@odata.context": `${GRAPH}/$metadata#users('x')/contacts`,
          value: [graphContact(0), { id: "AAMkAGI2-nameless", emailAddresses: [{ address: "noname@example.com" }] }],
          "@odata.nextLink": next,
        })
      ),
      route("GET", next, () => json({ value: [graphContact(2)] })),
    ]);
    try {
      const p1 = await fetchContactsPage({ accessToken: TOKEN, cursor: null });
      t.check("$top and $select are literal, not %24-encoded", /\?\$top=200&\$select=displayName/.test(http.calls[0].url), http.calls[0].url);
      t.check("a fresh read carries no filter", !/\$filter=/.test(http.calls[0].url));
      t.check("one person, one nameless", p1.people.length === 1 && p1.nameless === 1);
      t.check("fields map from Graph's shape", p1.people[0].email === OWNER.email && p1.people[0].company === OWNER.company && p1.people[0].phone === OWNER.phone);
      const c1 = advanceContactsCursor(null, p1, NOW);
      t.check("mid-run: page kept, no watermark yet", c1.pageToken === next && !c1.syncToken && c1.readStartedAt === NOW.toISOString());
      const p2 = await fetchContactsPage({ accessToken: TOKEN, cursor: c1 });
      const c2 = advanceContactsCursor(c1, p2, new Date(NOW.getTime() + 60_000));
      t.check("the last page turns the START time (minus overlap) into the watermark", c2.syncToken === new Date(NOW.getTime() - 5 * 60_000).toISOString() && c2.pageToken === null);
    } finally {
      http.restore();
    }
  }
  {
    const http = mockFetch([route("GET", /\/me\/contacts\?/, () => json({ value: [] }))]);
    try {
      await fetchContactsPage({ accessToken: TOKEN, cursor: { syncToken: "2026-10-01T00:00:00.000Z" } });
      t.check("an incremental read filters on lastModifiedDateTime", /\$filter=lastModifiedDateTime%20ge%202026-10-01/.test(http.calls[0].url), http.calls[0].url);
    } finally {
      http.restore();
    }
  }
  const contactCases: Array<[string, () => Response, (e: unknown) => boolean, string | null]> = [
    ["400 on a filtered read → ContactsFilterRejectedError", () => status(400, { error: { code: "ErrorInvalidProperty" } }), (e) => e instanceof ContactsFilterRejectedError, "2026-10-01T00:00:00.000Z"],
    ["400 on an unfiltered read is a plain error", () => status(400, { error: { code: "BadRequest" } }), (e) => e instanceof Error && !(e instanceof ContactsFilterRejectedError), null],
    ["503 → an error naming the status", () => status(503, "<html>busy</html>"), (e) => e instanceof Error && /Microsoft Contacts 503/.test(e.message), null],
    ["HTML 200 → rejects", () => notJson(), () => true, null],
    ["`value` is an object, not an array → rejects", () => json({ value: { id: "x" } }), () => true, null],
  ];
  for (const [label, reply, pred, syncToken] of contactCases) {
    const http = mockFetch([route("GET", /\/me\/contacts\?/, reply)]);
    try {
      await t.rejects(label, () => fetchContactsPage({ accessToken: TOKEN, cursor: syncToken ? { syncToken } : null }), pred);
    } finally {
      http.restore();
    }
  }

  t.done("microsoft sync contract");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
