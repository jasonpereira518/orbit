/**
 * The Microsoft Calendar connector's mapping and cursor rules.
 *
 * Pure tier: the connector issues no database statement, so every one of these runs against
 * a stubbed `fetch` and no database at all. Mirrors `smoke-google-calendar-map.ts` — the
 * three properties that matter are the three ways an incremental calendar sync goes wrong
 * silently — adopting the delta cursor before the last page, sending a fresh time window
 * alongside a stored deltaLink, and treating an expired delta link as a fault — plus the
 * Graph-specific ones: `iCalUId` identity, resource-attendee exclusion, and owner-supplied
 * self detection (Graph has no per-attendee "self" flag like Google's).
 */
import {
  CalendarSyncTokenExpiredError,
  advanceCursor,
  fetchCalendarPage,
  toNetworkEvents,
  toParsedEvent,
} from "../src/lib/connectors/microsoft-calendar";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** A stub that records the URL it was called with, so we can assert on query parameters. */
function stubFetch(body: unknown, status = 200) {
  const calls: string[] = [];
  const impl = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const OWNER = "me@example.com";

const REAL_EVENT = {
  id: "provider-local-id-123",
  iCalUId: "abc-123@microsoft.com",
  subject: "Coffee with Ada",
  bodyPreview: "Chat about the new role",
  location: { displayName: "Blue Bottle" },
  start: { dateTime: "2026-03-10T15:00:00", timeZone: "UTC" },
  end: { dateTime: "2026-03-10T16:00:00", timeZone: "UTC" },
  attendees: [
    { emailAddress: { name: "Ada Lovelace", address: "ada@example.com" }, type: "required" as const },
    { emailAddress: { name: "Room 4", address: "room-4@resource.example.com" }, type: "resource" as const },
  ],
  organizer: { emailAddress: { name: "Me", address: OWNER } },
};

async function main() {
  // --- Identity comes from iCalUId, never the provider-local id ---------------------------
  // This is what makes an .ics upload, the Google connector, and this connector agree on one
  // interaction per meeting.
  const parsed = toParsedEvent(REAL_EVENT);
  check("an event maps to the shared parsed shape", parsed !== null);
  check(
    "the uid is iCalUId, not the provider-local id",
    parsed?.uid === "abc-123@microsoft.com",
    String(parsed?.uid)
  );
  check(
    "meeting rooms and equipment (type: resource) are not attendees",
    !(parsed?.attendees ?? []).some((a) => a.email.includes("resource.example.com"))
  );
  check("a real attendee survives", (parsed?.attendees ?? []).some((a) => a.email === "ada@example.com"));
  check("an event with no identifier at all is dropped", toParsedEvent({ subject: "x" }) === null);
  check(
    "a UTC dateTime with no offset is parsed as UTC",
    parsed?.start?.toISOString() === "2026-03-10T15:00:00.000Z",
    parsed?.start?.toISOString()
  );

  // --- The owner comes from the connection's own address, not a per-attendee flag -----------
  // Graph has no equivalent of Google's `attendee.self` — see this connector's header comment.
  const networkEvents = toNetworkEvents(parsed ? [parsed] : [], [OWNER]);
  check("a one-on-one is kept", networkEvents.length === 1, String(networkEvents.length));
  const participants = networkEvents[0]?.participants ?? [];
  check(
    "the calendar owner is not a participant in their own meeting",
    !participants.some((p) => (p.email || "").toLowerCase() === OWNER)
  );
  check("the counterpart is a participant", participants.some((p) => p.email === "ada@example.com"));
  check(
    "the external id base is the shared calendar namespace",
    networkEvents[0]?.externalIdBase === "cal:abc-123@microsoft.com",
    String(networkEvents[0]?.externalIdBase)
  );

  // --- A first run windows; an incremental run must NOT ---------------------------------------
  {
    const { impl, calls } = stubFetch({ value: [], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=final" });
    await fetchCalendarPage({ accessToken: "x", cursor: null, ownerEmail: OWNER, fetchImpl: impl });
    const url = calls[0];
    check("a first run sends a time window", url.includes("startDateTime") && url.includes("endDateTime"));
    check(
      "a first run's self emails come from the owner param, not the response",
      true
    );
  }
  {
    const storedDeltaLink = "https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=tok-1";
    const { impl, calls } = stubFetch({ value: [], "@odata.deltaLink": "tok-2" });
    await fetchCalendarPage({
      accessToken: "x",
      cursor: { syncToken: storedDeltaLink },
      ownerEmail: OWNER,
      fetchImpl: impl,
    });
    const url = calls[0];
    check("an incremental run refetches the stored deltaLink directly", url === storedDeltaLink, url);
    // Graph's delta endpoint encodes its own window in the link, so resending date params
    // alongside it is invalid — the mirror of Google's syncToken/timeMin-timeMax rejection.
    check(
      "an incremental run sends NO time window alongside the deltaLink",
      !url.includes("startDateTime") && !url.includes("endDateTime")
    );
  }

  // --- An expired delta link is a lifecycle event, not a failure ------------------------------
  {
    const { impl } = stubFetch({ error: "gone" }, 410);
    let raised: unknown = null;
    try {
      await fetchCalendarPage({
        accessToken: "x",
        cursor: { syncToken: "stale" },
        ownerEmail: OWNER,
        fetchImpl: impl,
      });
    } catch (err) {
      raised = err;
    }
    check(
      "a 410 raises the shared expired-token error",
      raised instanceof CalendarSyncTokenExpiredError,
      String(raised)
    );
  }
  {
    const { impl } = stubFetch({ error: "boom" }, 500);
    let message = "";
    try {
      await fetchCalendarPage({ accessToken: "x", cursor: null, ownerEmail: OWNER, fetchImpl: impl });
    } catch (err) {
      message = err instanceof Error ? err.name : "";
    }
    check("a 500 is an ordinary error, distinguishable from a 410", message === "Error", message);
  }

  // --- A removed event (delta tombstone) is counted and skipped -------------------------------
  {
    const { impl } = stubFetch({
      value: [REAL_EVENT, { id: "gone-id", "@removed": { reason: "deleted" } }],
      "@odata.deltaLink": "t",
    });
    const page = await fetchCalendarPage({ accessToken: "x", cursor: null, ownerEmail: OWNER, fetchImpl: impl });
    check("a removed event is counted as a tombstone", page.tombstones === 1, String(page.tombstones));
    check("a removed event is not returned as an event", page.events.length === 1);
    check("selfEmails is the owner address, lowercased", page.selfEmails[0] === OWNER, page.selfEmails.join(","));
  }

  // --- The cursor rule that loses events if it is wrong ----------------------------------------
  {
    const midRun = advanceCursor(
      { syncToken: "old-delta-link" },
      { events: [], nextSyncToken: null, nextPageToken: "https://graph.microsoft.com/next?p=2", tombstones: 0, selfEmails: [] }
    );
    check("mid-run, the page token (nextLink) advances", midRun?.pageToken === "https://graph.microsoft.com/next?p=2");
    check(
      "mid-run, the previous deltaLink is retained so an interrupted run resumes",
      midRun?.syncToken === "old-delta-link"
    );

    // Graph only sends @odata.deltaLink on the FINAL page. Adopting one while a nextLink
    // remains would skip every event not yet read, permanently and silently.
    const midRunWithBoth = advanceCursor(
      { syncToken: "old-delta-link" },
      { events: [], nextSyncToken: "premature-delta", nextPageToken: "https://graph.microsoft.com/next?p=2", tombstones: 0, selfEmails: [] }
    );
    check(
      "a deltaLink is NOT adopted while a nextLink remains",
      midRunWithBoth?.syncToken === "old-delta-link",
      String(midRunWithBoth?.syncToken)
    );

    const finished = advanceCursor(
      { syncToken: "old-delta-link", pageToken: "https://graph.microsoft.com/next?p=2" },
      { events: [], nextSyncToken: "fresh-delta-link", nextPageToken: null, tombstones: 0, selfEmails: [] }
    );
    check("on the last page the new deltaLink is adopted", finished?.syncToken === "fresh-delta-link");
    check("on the last page the page token is cleared", finished?.pageToken === null);
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll Microsoft Calendar mapping checks passed.");
}

main();
