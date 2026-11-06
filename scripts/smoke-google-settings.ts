/**
 * The Google page's v192 pieces: Meetings reads its own switch (not a paused connection), the
 * calendar list parses Google's answer, each switch writes only its own lane, and the panel
 * counts come from Google's own rows.
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, gmailConnections, interactions } from "../src/db/schema";
import { googleAccountStatus, type GoogleConnectionInput } from "../src/lib/integration-status";
import { listGoogleCalendars } from "../src/lib/connectors/google-calendar";
import { checker } from "./smoke/check";

const t = checker();
const USER = "demo-user";
const SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/contacts.readonly",
].join(" ");

run(async () => {
  // --- Status: the Meetings switch, not connection health ----------------------------------
  const base: GoogleConnectionInput = {
    configured: true,
    connected: true,
    emailAddress: "me@example.com",
    status: "active",
    syncError: null,
    canImportContacts: true,
    hasCalendarScope: true,
    canRead: false,
    canSend: false,
  };
  const plan = { canUseRecruiters: false, recruitersOn: "Pro" } as Parameters<typeof googleAccountStatus>[1];
  t.check("meetings on by default", googleAccountStatus(base, plan).capabilities.meetings?.state === "on");
  t.check(
    "meetings off when its switch is off, on a healthy connection",
    googleAccountStatus({ ...base, syncPaused: true }, plan).capabilities.meetings?.state === "off",
  );
  t.check(
    "contacts unaffected by the meetings switch",
    googleAccountStatus({ ...base, syncPaused: true }, plan).capabilities.contacts?.state !== "off",
  );

  // --- Calendar list parsing ---------------------------------------------------------------
  const fake = (async () =>
    new Response(
      JSON.stringify({
        items: [
          { id: "me@gmail.com", summary: "Me", primary: true, backgroundColor: "#4285F4" },
          { id: "team@group.calendar.google.com", summary: "Team", summaryOverride: "Work", backgroundColor: "#34A853" },
          { id: "gone", summary: "Gone", deleted: true },
        ],
      }),
      { status: 200 },
    )) as unknown as typeof fetch;
  const list = await listGoogleCalendars({ accessToken: "x", fetchImpl: fake });
  t.check("deleted calendars are left out", list.length === 2, JSON.stringify(list));
  t.check("the primary calendar is keyed 'primary', as the sync keys it", list[0].id === "primary" && list[0].primary);
  t.check("a renamed calendar shows its own name", list[1].summary === "Work");
  t.check("Google's color is kept", list[1].color === "#34A853");

  // --- Switches and counts, as the demo user ----------------------------------------------
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  delete process.env.CLERK_SECRET_KEY;
  (process.env as Record<string, string>).NODE_ENV = "development";
  process.env.ORBIT_DEMO_DATA = "off";
  const { setCalendarSync, setGoogleContactsSync } = await import("../src/actions/gmail");
  const { getGooglePanel } = await import("../src/actions/google-settings");

  const db = await getDb();
  const cleanup = async () => {
    await db.delete(interactions).where(eq(interactions.userId, USER));
    await db.delete(contacts).where(eq(contacts.userId, USER));
    await db.delete(gmailConnections).where(eq(gmailConnections.userId, USER));
  };
  await cleanup();
  await db.insert(gmailConnections).values({
    userId: USER,
    emailAddress: "me@example.com",
    accessTokenEncrypted: "enc",
    scopes: SCOPES,
    status: "active",
  });
  const flags = async () => {
    const row = await db.query.gmailConnections.findFirst({ where: eq(gmailConnections.userId, USER) });
    return { calendar: row?.calendarSyncEnabled, contacts: row?.contactsSyncEnabled, syncStatus: row?.syncStatus };
  };

  t.check("both lanes start on", JSON.stringify(await flags()) === JSON.stringify({ calendar: 1, contacts: 1, syncStatus: null }));
  const off = await setCalendarSync(false);
  t.check("meetings off saves", off.ok);
  const afterMeetingsOff = await flags();
  t.check("meetings off turns only the calendar lane off", afterMeetingsOff.calendar === 0 && afterMeetingsOff.contacts === 1);
  t.check("meetings off no longer pauses the connection", afterMeetingsOff.syncStatus !== "paused");
  await setGoogleContactsSync(false);
  const bothOff = await flags();
  t.check("contacts off turns only the contacts lane off", bothOff.contacts === 0 && bothOff.calendar === 0);
  await setCalendarSync(true);
  t.check("meetings back on leaves contacts off", (await flags()).calendar === 1 && (await flags()).contacts === 0);

  const [person] = await db.insert(contacts).values({ userId: USER, fullName: "Ana Fox", source: "google_contacts" }).returning();
  await db.insert(contacts).values({ userId: USER, fullName: "Pat Kim", source: "capture" });
  await db.insert(interactions).values([
    { userId: USER, contactId: person.id, source: "google_calendar" },
    { userId: USER, contactId: person.id, source: "google_calendar" },
    { userId: USER, contactId: person.id, source: "gmail_activity" },
  ]);
  const panel = await getGooglePanel();
  t.check("contacts from Google only", panel.contactsFromGoogle === 1, String(panel.contactsFromGoogle));
  t.check("meetings logged from the calendar", panel.meetingsLogged === 2, String(panel.meetingsLogged));
  t.check("emails logged from Gmail activity", panel.emailsLogged === 1, String(panel.emailsLogged));

  await cleanup();
  t.done("google settings smoke tests");
});
