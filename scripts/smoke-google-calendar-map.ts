/**
 * The Google Calendar connector's mapping and cursor rules.
 *
 * Pure tier: the connector issues no database statement, so every one of these runs against
 * a stubbed `fetch` and no database at all. The three properties that matter are the three
 * ways an incremental calendar sync goes wrong silently — adopting `nextSyncToken` before the
 * last page, sending `syncToken` alongside a time window, and treating an expired token as a
 * fault. None of them would surface in manual testing until events had already been lost.
 */
import {
  CalendarSyncTokenExpiredError,
  advanceCursor,
  fetchCalendarPage,
  selfEmailsFrom,
  toNetworkEvents,
  toParsedEvent,
} from "../src/lib/connectors/google-calendar";

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
  iCalUID: "abc-123@google.com",
  status: "confirmed",
  summary: "Coffee with Ada",
  description: "Chat about the new role",
  location: "Blue Bottle",
  start: { dateTime: "2026-03-10T15:00:00Z" },
  end: { dateTime: "2026-03-10T16:00:00Z" },
  attendees: [
    { email: OWNER, displayName: "Me", self: true },
    { email: "ada@example.com", displayName: "Ada Lovelace" },
    { email: "room-4@resource.calendar.google.com", displayName: "Room 4", resource: true },
  ],
  organizer: { email: OWNER, displayName: "Me", self: true },
};

async function main() {
  // --- Identity comes from iCalUID, never the provider-local id ---------------------------
  // This is what makes an .ics upload and this connector agree on one interaction per meeting.
  const parsed = toParsedEvent(REAL_EVENT);
  check("an event maps to the shared parsed shape", parsed !== null);
  check(
    "the uid is iCalUID, not the provider-local id",
    parsed?.uid === "abc-123@google.com",
    String(parsed?.uid)
  );
  check(
    "meeting rooms and equipment are not attendees",
    !(parsed?.attendees ?? []).some((a) => a.email.includes("resource.calendar.google.com"))
  );
  check("a real attendee survives", (parsed?.attendees ?? []).some((a) => a.email === "ada@example.com"));
  check("an event with no identifier at all is dropped", toParsedEvent({ summary: "x" }) === null);

  // --- The owner is identified by Google, not by the user typing their address --------------
  const selves = selfEmailsFrom(REAL_EVENT);
  check("the calendar owner is detected from self:true", selves.includes(OWNER), selves.join(","));

  // --- Classification is reused, and the owner is excluded from participants ------------------
  const networkEvents = toNetworkEvents(parsed ? [parsed] : [], selves);
  check("a one-on-one is kept", networkEvents.length === 1, String(networkEvents.length));
  const participants = networkEvents[0]?.participants ?? [];
  check(
    "the calendar owner is not a participant in their own meeting",
    !participants.some((p) => (p.email || "").toLowerCase() === OWNER)
  );
  check("the counterpart is a participant", participants.some((p) => p.email === "ada@example.com"));
  check(
    "the external id base is the shared calendar namespace",
    networkEvents[0]?.externalIdBase === "cal:abc-123@google.com",
    String(networkEvents[0]?.externalIdBase)
  );
  check(
    "the event is timestamped from its start, not from now",
    networkEvents[0]?.timestamp.toISOString() === "2026-03-10T15:00:00.000Z",
    networkEvents[0]?.timestamp.toISOString()
  );

  // --- A first run windows; an incremental run must NOT ---------------------------------------
  {
    const { impl, calls } = stubFetch({ items: [], nextSyncToken: "tok-final" });
    await fetchCalendarPage({ accessToken: "x", cursor: null, fetchImpl: impl });
    const url = calls[0];
    check("a first run sends a time window", url.includes("timeMin") && url.includes("timeMax"));
    check("a first run sends no syncToken", !url.includes("syncToken"));
    check("deleted events are requested, or deletions can never be seen", url.includes("showDeleted=true"));
  }
  {
    const { impl, calls } = stubFetch({ items: [], nextSyncToken: "tok-2" });
    await fetchCalendarPage({
      accessToken: "x",
      cursor: { syncToken: "tok-1" },
      fetchImpl: impl,
    });
    const url = calls[0];
    check("an incremental run sends the syncToken", url.includes("syncToken=tok-1"));
    // Google rejects the combination with a 400, so this is a correctness rule, not a nicety.
    check(
      "an incremental run sends NO time window alongside the syncToken",
      !url.includes("timeMin") && !url.includes("timeMax")
    );
  }

  // --- An expired syncToken is a lifecycle event, not a failure ---------------------------------
  {
    const { impl } = stubFetch({ error: "gone" }, 410);
    let raised: unknown = null;
    try {
      await fetchCalendarPage({ accessToken: "x", cursor: { syncToken: "stale" }, fetchImpl: impl });
    } catch (err) {
      raised = err;
    }
    check(
      "a 410 raises the distinct expired-token error",
      raised instanceof CalendarSyncTokenExpiredError,
      String(raised)
    );
  }
  {
    const { impl } = stubFetch({ error: "boom" }, 500);
    let message = "";
    try {
      await fetchCalendarPage({ accessToken: "x", cursor: null, fetchImpl: impl });
    } catch (err) {
      message = err instanceof Error ? err.name : "";
    }
    check("a 500 is an ordinary error, distinguishable from a 410", message === "Error", message);
  }

  // --- Cancelled events are counted and skipped --------------------------------------------------
  {
    const { impl } = stubFetch({
      items: [REAL_EVENT, { ...REAL_EVENT, iCalUID: "gone@google.com", status: "cancelled" }],
      nextSyncToken: "t",
    });
    const page = await fetchCalendarPage({ accessToken: "x", cursor: null, fetchImpl: impl });
    check("a cancelled event is counted as a tombstone", page.tombstones === 1, String(page.tombstones));
    check("a cancelled event is not returned as an event", page.events.length === 1);
  }

  // --- The cursor rule that loses events if it is wrong --------------------------------------------
  {
    const midRun = advanceCursor(
      { syncToken: "old-token" },
      { events: [], nextSyncToken: null, nextPageToken: "page-2", tombstones: 0, selfEmails: [] }
    );
    check("mid-run, the page token advances", midRun?.pageToken === "page-2");
    check(
      "mid-run, the previous syncToken is retained so an interrupted run resumes",
      midRun?.syncToken === "old-token"
    );

    // Google only sends nextSyncToken on the FINAL page. Adopting one while pages remain
    // would skip every event not yet read, permanently and silently.
    const midRunWithBoth = advanceCursor(
      { syncToken: "old-token" },
      { events: [], nextSyncToken: "premature", nextPageToken: "page-2", tombstones: 0, selfEmails: [] }
    );
    check(
      "a syncToken is NOT adopted while more pages remain",
      midRunWithBoth?.syncToken === "old-token",
      String(midRunWithBoth?.syncToken)
    );

    const finished = advanceCursor(
      { syncToken: "old-token", pageToken: "page-2" },
      { events: [], nextSyncToken: "fresh", nextPageToken: null, tombstones: 0, selfEmails: [] }
    );
    check("on the last page the new syncToken is adopted", finished?.syncToken === "fresh");
    check("on the last page the page token is cleared", finished?.pageToken === null);
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll Google Calendar mapping checks passed.");
}

main();
