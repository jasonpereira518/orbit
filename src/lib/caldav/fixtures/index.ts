/**
 * SYNTHETIC fixtures for the CalDAV client.
 *
 * Every XML body in this file is hand-written from the wire examples in RFC 4791 (CalDAV),
 * RFC 6578 (WebDAV Collection Synchronization), and RFC 5545 (iCalendar) — NONE of it is a
 * recorded response from a real iCloud account. Task 1 (the spike that would have recorded
 * real, redacted traffic) needs Jason's Apple credentials and has not been run yet.
 *
 * Task 11 replaces these with redacted real Apple responses if Apple's shapes differ from
 * what the RFCs describe. Where the RFCs leave a choice open — namespace prefix, whether
 * `getctag` appears, element ordering — these fixtures deliberately vary it from one file to
 * the next (`D:`, lowercase `d:`, an unprefixed default namespace, and an arbitrary `z:`) so
 * that `client.ts`'s parser is exercised against the variation rather than tuned to one shape.
 *
 * Do not point real Apple traffic at anything that imports this file.
 */

/** PROPFIND response for `current-user-principal`, Depth: 0, against the well-known entry
 *  point. RFC 4791 §5.1 / RFC 3744 §4.2. Uses the `D:` prefix convention. */
export const PRINCIPAL_PROPFIND_RESPONSE = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/</D:href>
    <D:propstat>
      <D:prop>
        <D:current-user-principal>
          <D:href>/1234567/principal/</D:href>
        </D:current-user-principal>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;

/** PROPFIND response for `calendar-home-set`, Depth: 0, against the principal URL from
 *  above. RFC 4791 §6.2.1. Uses an unprefixed default namespace, unlike the fixture above. */
export const CALENDAR_HOME_PROPFIND_RESPONSE = `<?xml version="1.0" encoding="utf-8"?>
<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <response>
    <href>/1234567/principal/</href>
    <propstat>
      <prop>
        <C:calendar-home-set>
          <href>/1234567/calendars/</href>
        </C:calendar-home-set>
      </prop>
      <status>HTTP/1.1 200 OK</status>
    </propstat>
  </response>
</multistatus>`;

/**
 * PROPFIND response for the calendar home, Depth: 1, listing the home collection itself plus
 * two calendars: an ordinary read-write calendar that advertises WebDAV-Sync support (a
 * non-empty `sync-token`, RFC 6578 §3.5), and a subscribed calendar that does not.
 *
 * Apple marks a subscribed / shared-read-only calendar's resourcetype with a
 * `{http://calendarserver.org/ns/}subscribed` element — not an RFC 4791 element, but a
 * CalendarServer extension, which is the best documented signal available without Task 1's
 * real traffic. Task 11 must confirm this is what Apple actually sends; see the concern in
 * task-5-report.md.
 *
 * Uses the `d:` prefix (lowercase), unlike either fixture above.
 */
export const CALENDAR_LIST_PROPFIND_RESPONSE = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:x1="http://apple.com/ns/ical/">
  <d:response>
    <d:href>/1234567/calendars/</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype><d:collection/></d:resourcetype>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/1234567/calendars/home/</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
        <d:displayname>Home</d:displayname>
        <d:sync-token>https://caldav.icloud.com/1234567/calendars/home/sync/1</d:sync-token>
        <cs:getctag>3145</cs:getctag>
        <x1:calendar-color>#FF2D55FF</x1:calendar-color>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/1234567/calendars/birthdays-shared-9F2/</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype><d:collection/><c:calendar/><cs:subscribed/></d:resourcetype>
        <d:displayname>Ada's Birthdays</d:displayname>
        <cs:getctag>7</cs:getctag>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;

/**
 * `sync-collection` REPORT response, RFC 6578 §3.5's own worked example shape: one changed
 * resource carrying `calendar-data`, one removed resource reported as a top-level 404 (no
 * `propstat` wrapper — RFC 6578 §3.6 allows either shape; client.ts checks both), and a new
 * `sync-token` at the multistatus root for the next incremental run.
 */
export const SYNC_COLLECTION_RESPONSE = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:response>
    <D:href>/1234567/calendars/home/3B9F2.ics</D:href>
    <D:propstat>
      <D:prop>
        <D:getetag>"1000-abc"</D:getetag>
        <C:calendar-data>BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Orbit Test Fixture//EN
BEGIN:VEVENT
UID:3b9f2@example.com
DTSTAMP:20260301T120000Z
DTSTART:20260315T170000Z
DTEND:20260315T180000Z
SUMMARY:Coffee with Ada
END:VEVENT
END:VCALENDAR
</C:calendar-data>
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

/** Depth: 0 PROPFIND requesting only `getctag`, for the non-sync fallback's change check.
 *  RFC 4791 does not define `getctag` — it is a long-standing CalendarServer extension every
 *  real CalDAV client (including Apple's own) relies on for exactly this purpose. */
export const CTAG_PROPFIND_RESPONSE = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:cs="http://calendarserver.org/ns/">
  <D:response>
    <D:href>/1234567/calendars/no-sync/</D:href>
    <D:propstat>
      <D:prop>
        <cs:getctag>99</cs:getctag>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;

/**
 * `calendar-query` REPORT response for the time-range fallback, RFC 4791 §7.8's worked
 * example shape. Uses an arbitrary `z:` prefix for the DAV namespace to prove the parser
 * does not depend on any particular prefix spelling, not even a conventional one.
 */
export const CALENDAR_QUERY_RESPONSE = `<?xml version="1.0" encoding="utf-8"?>
<z:multistatus xmlns:z="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <z:response>
    <z:href>/1234567/calendars/no-sync/AAA1.ics</z:href>
    <z:propstat>
      <z:prop>
        <z:getetag>"1-aaa"</z:getetag>
        <C:calendar-data>BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Orbit Test Fixture//EN
BEGIN:VEVENT
UID:aaa1@example.com
DTSTAMP:20260301T120000Z
DTSTART:20260320T090000Z
DTEND:20260320T093000Z
SUMMARY:Stand-up
END:VEVENT
END:VCALENDAR
</C:calendar-data>
      </z:prop>
      <z:status>HTTP/1.1 200 OK</z:status>
    </z:propstat>
  </z:response>
</z:multistatus>`;
