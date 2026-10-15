/**
 * `calendar_events`: the Google mapping, the windowed mirror, and the `upcoming_meetings` tool.
 *
 * Runs against a throwaway PGlite database. Run: npx tsx scripts/smoke-calendar-events.ts
 */
import "./smoke/_env";

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import {
  calendarEvents,
  calendarSources,
  contactBriefs,
  contactIdentities,
  contacts,
  appleConnections,
  gmailConnections,
  interactions,
  outlookConnections,
  rateLimitBuckets,
  reminders,
  userSettings,
} from "../src/db/schema";
import { conferenceOf, storedEventsOf, toStoredEvent } from "../src/lib/connectors/google-calendar";
import {
  listUpcomingEvents,
  pruneStaleCalendarEvents,
  refreshCalendarWindow,
} from "../src/lib/calendar-events";
import { refreshUserCalendarWindows } from "../src/lib/calendar-window";
import { setSourceEnabled } from "../src/lib/calendar-sources";
import { GOOGLE_SCOPES } from "../src/lib/google-scopes";
import { getMeetingContext, nextKnownMeeting } from "../src/lib/meeting-context";
import { ORBIT_TOOLS } from "../src/lib/tools/definitions";
import { runTool, toolsFor, type OrbitTool } from "../src/lib/tools/registry";
import { ensureUserSettings } from "../src/lib/user-settings";

const USER = "smoke-calendar-events-user";
const OTHER = "smoke-calendar-events-other";
const OWNER = "me@example.com";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const NOW = new Date();
const at = (hoursFromNow: number) => new Date(NOW.getTime() + hoursFromNow * 3_600_000).toISOString();

const ONE_ON_ONE = {
  id: "series1_20261012T150000Z",
  iCalUID: "series1@google.com",
  recurringEventId: "series1",
  summary: "Ada / me weekly",
  start: { dateTime: at(26) },
  end: { dateTime: at(26.5) },
  hangoutLink: "https://meet.google.com/abc-defg-hij",
  attendees: [
    { email: OWNER, self: true, responseStatus: "accepted" },
    // Ada's SECOND address — known only to contact_identities.
    { email: "Ada@Work.example", displayName: "Ada Lovelace" },
    { email: "room@resource.calendar.google.com", resource: true },
  ],
  organizer: { email: OWNER, self: true },
};

const WEBINAR = {
  id: "webinar1",
  summary: "Scaling Postgres — live webinar",
  start: { dateTime: at(50) },
  end: { dateTime: at(51) },
  description: "Join here: https://us02web.zoom.us/j/123456789?pwd=abc and bring questions",
  guestsCanSeeOtherGuests: false,
  attendees: [
    { email: OWNER, self: true },
    { email: "stranger1@example.com", displayName: "Stranger One" },
    { email: "stranger2@example.com", displayName: "Stranger Two" },
  ],
};

const TRIP = {
  id: "allday1",
  summary: "Trip to Lisbon",
  start: { date: NOW.toISOString().slice(0, 10) },
  end: { date: new Date(NOW.getTime() + 2 * 86_400_000).toISOString().slice(0, 10) },
};

async function main() {
  // --- mapping (pure) ------------------------------------------------------------------
  const one = toStoredEvent(ONE_ON_ONE)!;
  check("keyed on the per-instance id, not the series' iCalUID", one.providerEventId === ONE_ON_ONE.id);
  check("the series id is kept", one.seriesId === "series1");
  check("Meet link from hangoutLink", one.conferenceKind === "meet" && one.conferenceUrl?.includes("meet.google.com") === true);
  check(
    "owner and rooms are not attendees; emails are lower-cased",
    one.attendees.length === 1 && one.attendees[0].email === "ada@work.example" && one.attendeeCount === 1,
    JSON.stringify(one.attendees)
  );
  check("own RSVP is kept", one.selfResponse === "accepted");

  const web = toStoredEvent(WEBINAR)!;
  check("a Zoom link pasted in the description is the call", web.conferenceKind === "zoom", String(web.conferenceUrl));
  check("a hidden guest list stores no names but keeps the count", web.attendees.length === 0 && web.attendeeCount === 2 && web.guestsHidden);
  check("an all-day event is flagged", toStoredEvent(TRIP)?.allDay === true);
  check("a cancelled event is not stored", toStoredEvent({ ...ONE_ON_ONE, status: "cancelled" }) === null);
  check("no link, no conference", conferenceOf({ summary: "Coffee", location: "Blue Bottle" }) === null);

  // --- the mirror ----------------------------------------------------------------------
  const db = await getDb();
  for (const u of [USER, OTHER]) {
    await db.delete(calendarSources).where(eq(calendarSources.userId, u));
    await db.delete(contacts).where(eq(contacts.userId, u));
    await ensureUserSettings(u);
  }
  await db.update(userSettings).set({ radarDigestTz: "America/New_York" }).where(eq(userSettings.userId, USER));

  const [ada] = await db
    .insert(contacts)
    .values({ userId: USER, fullName: "Ada Lovelace", email: "ada@home.example" })
    .returning();
  await db.insert(contactIdentities).values({ userId: USER, contactId: ada.id, kind: "email", value: "ada@work.example" });

  const [source] = await db
    .insert(calendarSources)
    .values({ userId: USER, provider: "google", connectionId: randomUUID(), calendarId: "primary" })
    .returning();
  const [otherSource] = await db
    .insert(calendarSources)
    .values({ userId: OTHER, provider: "google", connectionId: randomUUID(), calendarId: "primary" })
    .returning();

  await refreshCalendarWindow(USER, source.id, { events: storedEventsOf([ONE_ON_ONE, WEBINAR, TRIP]), complete: true }, NOW);
  await refreshCalendarWindow(OTHER, otherSource.id, { events: storedEventsOf([{ ...TRIP, id: "theirs" }]), complete: true }, NOW);

  const week = new Date(NOW.getTime() + 7 * 86_400_000);
  const rows = await listUpcomingEvents(USER, { from: NOW, to: week });
  check(
    "three events stored, soonest first",
    rows.length === 3 && rows[0].providerEventId === "allday1",
    rows.map((r) => r.providerEventId).join(",")
  );
  const stored1 = rows.find((r) => r.providerEventId === ONE_ON_ONE.id);
  check(
    "an attendee's secondary email resolves to the contact",
    stored1?.attendees[0]?.contactId === ada.id,
    JSON.stringify(stored1?.attendees)
  );

  const adas = await listUpcomingEvents(USER, { from: NOW, to: week, contactId: ada.id });
  check("contactId narrows to that person's events", adas.length === 1 && adas[0].providerEventId === ONE_ON_ONE.id);

  // Re-read with a changed title and the webinar gone.
  await refreshCalendarWindow(USER, source.id, { events: storedEventsOf([{ ...ONE_ON_ONE, summary: "Ada 1:1 (moved)" }, TRIP]), complete: true }, NOW);
  const after = await db.select().from(calendarEvents).where(eq(calendarEvents.userId, USER));
  check("an event missing from a complete read is deleted", !after.some((r) => r.providerEventId === "webinar1"));
  check(
    "an existing event is updated in place",
    after.find((r) => r.providerEventId === ONE_ON_ONE.id)?.title === "Ada 1:1 (moved)"
  );

  await refreshCalendarWindow(USER, source.id, { events: storedEventsOf([]), complete: false }, NOW);
  const kept = await db.select().from(calendarEvents).where(eq(calendarEvents.userId, USER));
  check("a partial read deletes nothing", kept.length === 2, String(kept.length));

  const theirs = await db.select().from(calendarEvents).where(eq(calendarEvents.userId, OTHER));
  check("another user's window is untouched", theirs.length === 1);

  // --- the tool ------------------------------------------------------------------------
  const tool = ORBIT_TOOLS.find((t) => t.name === "upcoming_meetings") as OrbitTool;
  check(
    "upcoming_meetings is on chat and MCP (MCP gets an allowlist: smoke-tool-registry)",
    toolsFor(ORBIT_TOOLS, "chat", ["read"]).includes(tool) && toolsFor(ORBIT_TOOLS, "mcp", ["read"]).includes(tool)
  );

  const result = (await runTool(tool, USER, { limit: 20 }, { surface: "chat" })) as Array<Record<string, unknown>>;
  check("the tool returns the user's events", Array.isArray(result) && result.length === 2, JSON.stringify(result));
  const meeting = result.find((r) => r.title === "Ada 1:1 (moved)");
  check("times are in the user's zone", meeting?.timeZone === "America/New_York" && typeof meeting?.start === "string");
  check(
    "attendees carry the contact id and no email",
    JSON.stringify(meeting?.attendees) === JSON.stringify([{ name: "Ada Lovelace", contactId: ada.id }]),
    JSON.stringify(meeting?.attendees)
  );
  const byTitle = (await runTool(tool, USER, { query: "lisbon", limit: 20 }, { surface: "chat" })) as unknown[];
  check("query matches title words", Array.isArray(byTitle) && byTitle.length === 1);
  const otherSees = (await runTool(tool, OTHER, { query: "ada", limit: 20 }, { surface: "chat" })) as unknown[];
  check("another user cannot see these events", Array.isArray(otherSees) && otherSees.length === 0);

  // --- meeting_context -------------------------------------------------------------------
  const ctxTool = ORBIT_TOOLS.find((t) => t.name === "meeting_context") as OrbitTool;
  const db2 = await getDb();
  await db2.insert(interactions).values([
    { userId: USER, contactId: ada.id, interactionType: "call", interactionDate: new Date(NOW.getTime() - 10 * 86_400_000), aiSummary: "Talked about the Series A" },
    // This meeting itself, as calendar sync logs it: not history yet.
    { userId: USER, contactId: ada.id, interactionType: "meeting", interactionDate: new Date(NOW.getTime() + 26 * 3_600_000), aiSummary: "Ada 1:1" },
  ]);
  await db2.insert(reminders).values({ userId: USER, contactId: ada.id, title: "Send Ada the deck", status: "pending" });
  await db2.insert(contactBriefs).values({ userId: USER, contactId: ada.id, standing: "Warm; mid fundraise", nextStep: "Send the deck" });

  const startNy = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ONE_ON_ONE.start.dateTime));
  type Ctx = { event: { title: string }; people: Array<{ standing: string | null; nextStep: string | null; recent: Array<{ summary: string | null }>; open: string[] }>; notInOrbit: string[] };
  const byTime = (await runTool(ctxTool, USER, { time: startNy }, { surface: "chat" })) as Ctx;
  check("meeting_context finds \"my 3pm\" by local time", byTime?.event?.title === "Ada 1:1 (moved)", JSON.stringify(byTime));
  const next = (await runTool(ctxTool, USER, {}, { surface: "chat" })) as Ctx;
  check("with no arguments it is the next meeting with someone known", next?.event?.title === "Ada 1:1 (moved)");
  const ada0 = next?.people?.[0];
  check("it carries the brief", ada0?.standing === "Warm; mid fundraise" && ada0.nextStep === "Send the deck");
  check(
    "recent history is the past only",
    ada0?.recent.length === 1 && ada0.recent[0].summary === "Talked about the Series A",
    JSON.stringify(ada0?.recent)
  );
  check(
    "open to-dos, without the meeting's own prep reminder",
    ada0?.open.includes("Send Ada the deck") === true && !ada0.open.some((o) => o.startsWith("Prep for")),
    JSON.stringify(ada0?.open)
  );
  const none = await runTool(ctxTool, USER, { query: "no such meeting" }, { surface: "chat" });
  check("no match is an error, not a guess", typeof (none as { error?: unknown })?.error === "string");
  const theirsCtx = await runTool(ctxTool, OTHER, { eventId: meeting?.eventId as string }, { surface: "chat" });
  check("another user cannot open this meeting by id", typeof (theirsCtx as { error?: unknown })?.error === "string");

  check(
    "the pulse's next meeting is the one with someone known, inside the horizon",
    (await nextKnownMeeting(USER, NOW, 30 * 3_600_000))?.title === "Ada 1:1 (moved)" &&
      (await nextKnownMeeting(USER, NOW, 3_600_000)) === null
  );

  // --- the cascade ---------------------------------------------------------------------
  await db.delete(calendarSources).where(eq(calendarSources.id, source.id));
  const orphaned = await db.select().from(calendarEvents).where(eq(calendarEvents.userId, USER));
  check("deleting the source deletes its events", orphaned.length === 0);

  // --- fresher, hidden, frozen, re-matched ---------------------------------------------------
  await db.delete(gmailConnections).where(eq(gmailConnections.userId, USER));
  await db.delete(rateLimitBuckets).where(eq(rateLimitBuckets.bucket, `calendarWindow:${USER}`));
  const [conn] = await db
    .insert(gmailConnections)
    .values({ userId: USER, emailAddress: OWNER, accessTokenEncrypted: "x", scopes: GOOGLE_SCOPES.calendar })
    .returning();
  const [live] = await db
    .insert(calendarSources)
    .values({ userId: USER, provider: "google", connectionId: conn.id, calendarId: "primary" })
    .returning();
  // Twelve minutes out, with someone not in Orbit yet.
  const BO_MEET = {
    id: "bo1",
    summary: "Intro with Bo",
    start: { dateTime: at(0.2) },
    end: { dateTime: at(0.7) },
    attendees: [{ email: OWNER, self: true }, { email: "bo@new.example", displayName: "Bo Chen" }],
  };
  let reads = 0;
  const pulseDeps = {
    getGoogleToken: async () => "token",
    fetchGoogleWindow: (async () => {
      reads++;
      return { items: [ONE_ON_ONE, BO_MEET], complete: true, status: 200 };
    }) as never,
  };
  const first = await refreshUserCalendarWindows(USER, NOW, pulseDeps);
  check("the pulse refresh reads the window", first.refreshed === 1 && reads === 1);
  const second = await refreshUserCalendarWindows(USER, new Date(NOW.getTime() + 60_000), pulseDeps);
  check("a second pulse inside ten minutes makes no read", second.refreshed === 0 && reads === 1);
  check(
    "no Google calendar access, no read",
    (await refreshUserCalendarWindows(OTHER, NOW, pulseDeps)).refreshed === 0 && reads === 1
  );
  check("a meeting only with a stranger is not a known one", (await nextKnownMeeting(USER, NOW, 3_600_000)) === null);

  const [bo] = await db.insert(contacts).values({ userId: USER, fullName: "Bo Chen", email: "bo@new.example" }).returning();
  const soon = await nextKnownMeeting(USER, NOW, 3_600_000);
  check("someone added since the sync counts as known, with no refresh", soon?.title === "Intro with Bo", JSON.stringify(soon));
  const boCtx = await getMeetingContext(USER, { eventId: soon?.eventId ?? "" }, NOW);
  check(
    "…and the prep context lists them as a person, not a stranger",
    boCtx?.people.some((p) => p.contactId === bo.id) === true && boCtx.notInOrbit.length === 0,
    JSON.stringify({ people: boCtx?.people.map((p) => p.name), notInOrbit: boCtx?.notInOrbit })
  );

  await db.insert(reminders).values([
    { userId: USER, title: "Prep for Intro with Bo", status: "pending", calendarEventKey: "bo1" },
    { userId: USER, title: "Already done prep", status: "done", calendarEventKey: ONE_ON_ONE.id },
  ]);
  await setSourceEnabled(USER, live.id, false);
  const hidden = await db.select().from(calendarEvents).where(eq(calendarEvents.sourceId, live.id));
  check("hiding a calendar drops its meetings", hidden.length === 0, String(hidden.length));
  const rs = await db.select().from(reminders).where(eq(reminders.userId, USER));
  check(
    "…dismisses their pending prep reminder and leaves a done one alone",
    rs.find((r) => r.title === "Prep for Intro with Bo")?.status === "dismissed" &&
      rs.find((r) => r.title === "Already done prep")?.status === "done",
    JSON.stringify(rs.map((r) => [r.title, r.status]))
  );

  // Frozen: OTHER's source stopped refreshing a day ago; USER's is fresh.
  await setSourceEnabled(USER, live.id, true);
  await refreshCalendarWindow(USER, live.id, { events: storedEventsOf([ONE_ON_ONE]), complete: true }, NOW);
  await db
    .update(calendarEvents)
    .set({ updatedAt: new Date(NOW.getTime() - 25 * 3_600_000) })
    .where(eq(calendarEvents.userId, OTHER));
  await pruneStaleCalendarEvents(NOW);
  check(
    "a calendar not refreshed in a day is pruned; a fresh one stays",
    (await db.select().from(calendarEvents).where(eq(calendarEvents.userId, OTHER))).length === 0 &&
      (await db.select().from(calendarEvents).where(eq(calendarEvents.userId, USER))).length === 1
  );

  // --- Outlook and iCloud fill the same table ---------------------------------------------------
  const MULTI = "smoke-calendar-events-multi";
  await db.delete(calendarSources).where(eq(calendarSources.userId, MULTI));
  await db.delete(outlookConnections).where(eq(outlookConnections.userId, MULTI));
  await db.delete(appleConnections).where(eq(appleConnections.userId, MULTI));
  await db.delete(contacts).where(eq(contacts.userId, MULTI));
  await db.delete(rateLimitBuckets).where(eq(rateLimitBuckets.bucket, `calendarWindow:${MULTI}`));
  const [grace] = await db.insert(contacts).values({ userId: MULTI, fullName: "Grace Hopper", email: "grace@navy.example" }).returning();
  const [outlook] = await db
    .insert(outlookConnections)
    .values({ userId: MULTI, emailAddress: "me@outlook.example", accessTokenEncrypted: "x", scopes: "Calendars.Read offline_access" })
    .returning();
  const [icloud] = await db
    .insert(appleConnections)
    .values({ userId: MULTI, emailAddress: "me@icloud.example", appPasswordEncrypted: "x" })
    .returning();
  const [outlookSource] = await db
    .insert(calendarSources)
    .values({ userId: MULTI, provider: "microsoft", connectionId: outlook.id, calendarId: "default" })
    .returning();
  const [icloudSource] = await db
    .insert(calendarSources)
    .values({ userId: MULTI, provider: "apple", connectionId: icloud.id, calendarId: "https://caldav.example/home/" })
    .returning();
  let appleAskedFor = "";
  const multi = await refreshUserCalendarWindows(MULTI, NOW, {
    getOutlookToken: async () => "token",
    fetchOutlookWindow: (async () => ({
      items: [
        {
          id: "graph-1",
          subject: "Sync with Grace",
          start: { dateTime: at(3).replace(/Z$/, ""), timeZone: "UTC" },
          end: { dateTime: at(3.5).replace(/Z$/, ""), timeZone: "UTC" },
          onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/x" },
          attendees: [
            { emailAddress: { name: "Grace Hopper", address: "grace@navy.example" }, type: "required" },
            { emailAddress: { name: "Me", address: "me@outlook.example" }, type: "required" },
          ],
        },
      ],
      complete: true,
      status: 200,
    })) as never,
    getAppleCredentials: async () => ({ username: "me@icloud.example", password: "x" }),
    fetchAppleWindow: (async (o: { calendarUrl: string }) => {
      appleAskedFor = o.calendarUrl;
      return [{ ...toStoredEvent(TRIP)!, providerEventId: "ics-trip" }];
    }) as never,
  });
  const mirrored = await db.select().from(calendarEvents).where(eq(calendarEvents.userId, MULTI));
  check("an Outlook and an iCloud calendar are both refreshed", multi.refreshed === 2 && mirrored.length === 2, JSON.stringify(multi));
  const graphRow = mirrored.find((r) => r.sourceId === outlookSource.id);
  check(
    "the Outlook meeting is stored with its call and its known guest",
    graphRow?.conferenceKind === "teams" && graphRow.attendees[0]?.contactId === grace.id && graphRow.attendees.length === 1,
    JSON.stringify(graphRow?.attendees)
  );
  check(
    "the iCloud read is per calendar",
    appleAskedFor === "https://caldav.example/home/" && mirrored.some((r) => r.sourceId === icloudSource.id)
  );

  if (failures) {
    console.error(`\nsmoke-calendar-events: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nsmoke-calendar-events: all checks passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
