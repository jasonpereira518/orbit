/**
 * `calendar_events`: the Google mapping, the windowed mirror, and the `upcoming_meetings` tool.
 *
 * Runs against a throwaway PGlite database. Run: npx tsx scripts/smoke-calendar-events.ts
 */
import "./smoke/_env";

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, setAsideAbandonedCalendarEvents, type SchemaFailure } from "../src/db";
import { PGlite } from "@electric-sql/pglite";
import {
  calendarEvents,
  calendarSources,
  contactBriefs,
  contactIdentities,
  contacts,
  interactions,
  reminders,
  userSettings,
} from "../src/db/schema";
import { conferenceOf, toStoredEvent } from "../src/lib/connectors/google-calendar";
import { listUpcomingEvents, refreshCalendarWindow } from "../src/lib/calendar-events";
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
  // --- a stale calendar_events from #184 is set aside, ours never is --------------------------
  {
    const pg = new PGlite();
    const run = (q: string) => pg.query(q);
    const failed: SchemaFailure[] = [];
    const tables = async () =>
      (await pg.query<{ t: string }>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = current_schema()`)).rows.map((r) => r.t);
    await pg.exec(`CREATE TABLE calendar_events (id uuid, user_id text, provider text, external_id text, starts_at timestamptz)`);
    await setAsideAbandonedCalendarEvents(run, failed);
    const names = await tables();
    check("#184's calendar_events is renamed out of the way", names.includes("calendar_events_abandoned_v56") && !names.includes("calendar_events") && failed.length === 0, JSON.stringify({ names, failed }));
    await pg.exec(`CREATE TABLE calendar_events (id uuid, source_id uuid, provider_event_id text)`);
    await setAsideAbandonedCalendarEvents(run, failed);
    check("…and this table is left alone", (await tables()).includes("calendar_events") && failed.length === 0);
    await pg.close();
  }

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

  await refreshCalendarWindow(USER, source.id, { items: [ONE_ON_ONE, WEBINAR, TRIP], complete: true }, NOW);
  await refreshCalendarWindow(OTHER, otherSource.id, { items: [{ ...TRIP, id: "theirs" }], complete: true }, NOW);

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
  await refreshCalendarWindow(USER, source.id, { items: [{ ...ONE_ON_ONE, summary: "Ada 1:1 (moved)" }, TRIP], complete: true }, NOW);
  const after = await db.select().from(calendarEvents).where(eq(calendarEvents.userId, USER));
  check("an event missing from a complete read is deleted", !after.some((r) => r.providerEventId === "webinar1"));
  check(
    "an existing event is updated in place",
    after.find((r) => r.providerEventId === ONE_ON_ONE.id)?.title === "Ada 1:1 (moved)"
  );

  await refreshCalendarWindow(USER, source.id, { items: [], complete: false }, NOW);
  const kept = await db.select().from(calendarEvents).where(eq(calendarEvents.userId, USER));
  check("a partial read deletes nothing", kept.length === 2, String(kept.length));

  const theirs = await db.select().from(calendarEvents).where(eq(calendarEvents.userId, OTHER));
  check("another user's window is untouched", theirs.length === 1);

  // --- the tool ------------------------------------------------------------------------
  const tool = ORBIT_TOOLS.find((t) => t.name === "upcoming_meetings") as OrbitTool;
  check(
    "upcoming_meetings is chat-only",
    toolsFor(ORBIT_TOOLS, "chat", ["read"]).includes(tool) && !toolsFor(ORBIT_TOOLS, "mcp", ["read", "write"]).includes(tool)
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

  // --- the cascade ---------------------------------------------------------------------
  await db.delete(calendarSources).where(eq(calendarSources.id, source.id));
  const orphaned = await db.select().from(calendarEvents).where(eq(calendarEvents.userId, USER));
  check("deleting the source deletes its events", orphaned.length === 0);

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
