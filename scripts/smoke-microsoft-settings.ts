/**
 * The Microsoft page's v194 pieces: Meetings reads its own switch, the calendar list parses
 * Graph's answer, a non-default calendar is read through its own calendarView, each switch
 * writes only its own lane, and the panel counts come from Outlook's own rows.
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { cloudNoteSources, contacts, interactions, outlookConnections } from "../src/db/schema";
import { microsoftAccountStatus, type MicrosoftConnectionInput } from "../src/lib/integration-status";
import { fetchCalendarPage, listMicrosoftCalendars } from "../src/lib/connectors/microsoft-calendar";
import { checker } from "./smoke/check";

const t = checker();
const USER = "demo-user";

run(async () => {
  // --- Status: the Meetings switch, not connection health ----------------------------------
  const base: MicrosoftConnectionInput = {
    configured: true,
    connected: true,
    emailAddress: "me@example.com",
    status: "active",
    syncError: null,
    hasContactsScope: true,
    hasCalendarScope: true,
    hasMailScope: false,
  };
  const plan = { canUseRecruiters: false, recruitersOn: "Pro" } as Parameters<typeof microsoftAccountStatus>[1];
  t.check("meetings on by default", microsoftAccountStatus(base, plan).capabilities.meetings?.state === "on");
  t.check(
    "meetings off when its switch is off",
    microsoftAccountStatus({ ...base, syncPaused: true }, plan).capabilities.meetings?.state === "off",
  );
  t.check("no send capability unless the caller reads it", microsoftAccountStatus(base, plan).capabilities.send === undefined);
  t.check(
    "send reads Mail.Send",
    microsoftAccountStatus({ ...base, canSend: false }, plan).capabilities.send?.state === "not_allowed",
  );

  // --- Calendar list parsing ---------------------------------------------------------------
  const listed = await listMicrosoftCalendars({
    accessToken: "x",
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({
          value: [
            { id: "AAMkDefault", name: "Calendar", isDefaultCalendar: true, hexColor: "" },
            { id: "AAMkWork", name: " Work ", isDefaultCalendar: false, hexColor: "#7FBA00" },
            { name: "No id" },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch,
  });
  t.check("entries without an id are left out", listed.length === 2, JSON.stringify(listed));
  t.check("the default calendar is keyed 'default', as the sync keys it", listed[0].id === "default" && listed[0].primary);
  t.check("an unset colour is null", listed[0].color === null);
  t.check("names are trimmed and colours kept", listed[1].summary === "Work" && listed[1].color === "#7FBA00");

  // --- Which URL each calendar is read from -----------------------------------------------
  const urls: string[] = [];
  const capture = (async (url: string) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ value: [] }), { status: 200 });
  }) as unknown as typeof fetch;
  await fetchCalendarPage({ accessToken: "x", cursor: null, ownerEmail: "me@example.com", fetchImpl: capture });
  await fetchCalendarPage({ accessToken: "x", cursor: null, ownerEmail: "me@example.com", calendarId: "AAMk/Work", fetchImpl: capture });
  t.check("the default calendar uses delta", urls[0].includes("/me/calendarView/delta?"), urls[0]);
  t.check(
    "another calendar uses its own calendarView, id encoded",
    urls[1].includes("/me/calendars/AAMk%2FWork/calendarView?") && !urls[1].includes("delta"),
    urls[1],
  );

  // --- Switches and counts, as the demo user ----------------------------------------------
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  delete process.env.CLERK_SECRET_KEY;
  (process.env as Record<string, string>).NODE_ENV = "development";
  process.env.ORBIT_DEMO_DATA = "off";
  const { setCalendarSync, setOutlookContactsSync } = await import("../src/actions/outlook");
  const { getMicrosoftPanel } = await import("../src/actions/microsoft-settings");

  const db = await getDb();
  const cleanup = async () => {
    await db.delete(interactions).where(eq(interactions.userId, USER));
    await db.delete(contacts).where(eq(contacts.userId, USER));
    await db.delete(cloudNoteSources).where(eq(cloudNoteSources.userId, USER));
    await db.delete(outlookConnections).where(eq(outlookConnections.userId, USER));
  };
  await cleanup();
  await db.insert(outlookConnections).values({
    userId: USER,
    emailAddress: "me@example.com",
    accessTokenEncrypted: "enc",
    scopes: "openid Calendars.Read Contacts.Read Files.Read",
    status: "active",
  });
  const flags = async () => {
    const row = await db.query.outlookConnections.findFirst({ where: eq(outlookConnections.userId, USER) });
    return { calendar: row?.calendarSyncEnabled, contacts: row?.contactsSyncEnabled, syncStatus: row?.syncStatus };
  };

  t.check("both lanes start on", (await flags()).calendar === 1 && (await flags()).contacts === 1);
  t.check("meetings off saves", (await setCalendarSync(false)).ok);
  const afterOff = await flags();
  t.check("meetings off turns only the calendar lane off", afterOff.calendar === 0 && afterOff.contacts === 1);
  t.check("meetings off no longer pauses the connection", afterOff.syncStatus !== "paused");
  await setOutlookContactsSync(false);
  t.check("contacts off turns only the contacts lane off", (await flags()).contacts === 0 && (await flags()).calendar === 0);
  await setCalendarSync(true);
  t.check("meetings back on leaves contacts off", (await flags()).calendar === 1 && (await flags()).contacts === 0);

  const [person] = await db
    .insert(contacts)
    .values([
      { userId: USER, fullName: "Ana Fox", source: "microsoft_contacts" },
      { userId: USER, fullName: "Bo Lee", source: "outlook_contacts" },
      { userId: USER, fullName: "Pat Kim", source: "capture" },
    ])
    .returning();
  await db.insert(interactions).values([
    { userId: USER, contactId: person.id, source: "microsoft_calendar" },
    { userId: USER, contactId: person.id, source: "google_calendar" },
  ]);
  let panel = await getMicrosoftPanel();
  t.check("contacts from both Outlook sources", panel.contactsFromOutlook === 2, String(panel.contactsFromOutlook));
  t.check("meetings logged from Outlook only", panel.meetingsLogged === 1, String(panel.meetingsLogged));
  t.check("no OneDrive watch yet", panel.oneDrive === null);
  await db.insert(cloudNoteSources).values({ userId: USER, provider: "microsoft" });
  panel = await getMicrosoftPanel();
  t.check("a watched OneDrive shows up", panel.oneDrive !== null && panel.oneDrive.notesFound === 0, JSON.stringify(panel.oneDrive));

  // --- Sync now's claim: the cron's lease rule, plus a two-minute cooldown --------------------
  const { claimConnectionNow } = await import("../src/lib/provider-connections");
  const setRun = (set: Partial<typeof outlookConnections.$inferInsert>) =>
    db.update(outlookConnections).set(set).where(eq(outlookConnections.userId, USER));
  const longAgo = new Date(Date.now() - 60 * 60_000);
  await setRun({ syncStatus: "idle", syncStartedAt: null, lastSyncedAt: longAgo });
  const claimed = await claimConnectionNow("microsoft", USER);
  t.check("an idle connection is claimed", claimed?.userId === USER);
  t.check("a claimed connection is marked syncing", (await flags()).syncStatus === "syncing");
  t.check("it can't be claimed twice while the cron or a click holds it", (await claimConnectionNow("microsoft", USER)) === null);
  await setRun({ syncStatus: "idle", syncStartedAt: null, lastSyncedAt: new Date(Date.now() - 30_000) });
  t.check("not again within two minutes of a finished run", (await claimConnectionNow("microsoft", USER)) === null);
  await setRun({ syncStatus: "syncing", syncStartedAt: longAgo, lastSyncedAt: longAgo });
  t.check("an abandoned lease can be taken over", (await claimConnectionNow("microsoft", USER)) !== null);

  await cleanup();
  t.done("microsoft settings smoke tests");
});
