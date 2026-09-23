import "./smoke/_env";
/**
 * `calendar_sources` and `apple_connections`.
 *
 * The migration is the risky half: every existing Google and Outlook connection must come out
 * with exactly ONE source row carrying the cursor it already had. A missed cursor means a full
 * resync for that user; a doubled row means the same calendar synced twice.
 *
 * Disconnect/reconnect is the other risky half: `calendar_sources` has no FK to any connection
 * table, and its unique index is keyed on (connection_id, calendar_id) — a fresh connection id
 * from a reconnect dedupes against nothing unless the disconnect path cleaned up the source row
 * itself. See `deleteCalendarSourcesForProvider`.
 */
import { getDb, reconcileSchema } from "../src/db";
import { appleConnections, calendarSources, gmailConnections, outlookConnections } from "../src/db/schema";
import { and, eq } from "drizzle-orm";
import { deleteCalendarSourcesForProvider, seedCalendarSources } from "../src/lib/calendar-sources";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const USER = `smoke-cal-src-${Date.now()}`;
const APPLE_USER = `${USER}-apple`;

/**
 * Every row this script writes, for both test identities. Without this, the armed Gmail and
 * Outlook connections this script inserts (`nextSyncAt: new Date()`, fake ciphertext that
 * `decrypt()` cannot parse) outlive the script and get claimed by whichever `smoke-sync-*`
 * script runs next against the same shared PGlite database — `getValidAccessToken` then
 * throws "Invalid encrypted payload" for a user that script never created. Called both up
 * front (defensive, in case a previous run was killed mid-test) and in a `finally`.
 */
async function cleanup() {
  const db = await getDb();
  for (const userId of [USER, APPLE_USER]) {
    await db.delete(calendarSources).where(eq(calendarSources.userId, userId));
    await db.delete(gmailConnections).where(eq(gmailConnections.userId, userId));
    await db.delete(outlookConnections).where(eq(outlookConnections.userId, userId));
    await db.delete(appleConnections).where(eq(appleConnections.userId, userId));
  }
}

async function main() {
  await reconcileSchema();
  const db = await getDb();
  await cleanup();

  try {
    // A Google connection that already synced, with a cursor on the connection row.
    await db.insert(gmailConnections).values({
      userId: USER,
      emailAddress: "someone@example.com",
      accessTokenEncrypted: "x",
      scopes: "https://www.googleapis.com/auth/calendar.readonly",
      syncCursor: { calendar: { syncToken: "tok-123", pageToken: null } },
      nextSyncAt: new Date(),
    });
    // An Outlook connection alongside it, so one seed call has to insert both — the multi-row
    // `values(rows)` path, not just the single-row one.
    await db.insert(outlookConnections).values({
      userId: USER,
      emailAddress: "someone@outlook.com",
      accessTokenEncrypted: "x",
      scopes: "Calendars.Read",
      syncCursor: { calendar: { syncToken: "outlook-tok-456", pageToken: null } },
      nextSyncAt: new Date(),
    });

    await seedCalendarSources(USER);
    const seeded = await db.select().from(calendarSources).where(eq(calendarSources.userId, USER));
    check("one source per existing connection", seeded.length === 2, `got ${seeded.length}`);

    const google = seeded.find((s) => s.provider === "google");
    const outlook = seeded.find((s) => s.provider === "microsoft");
    // "primary" and "default" are load-bearing: the Google connector requests
    // `calendars/primary/events`, so a seeder that wrote the connection id, or any other
    // placeholder, here would break sync while still passing every idempotency check below.
    check("google source is provider google", google?.provider === "google");
    check("google source's calendarId is primary", google?.calendarId === "primary", `got ${google?.calendarId}`);
    check("the google connection's cursor moved onto it", google?.syncCursor?.syncToken === "tok-123");
    check("it is enabled", google?.enabled === 1);
    check("outlook source is provider microsoft", outlook?.provider === "microsoft");
    check("outlook source's calendarId is default", outlook?.calendarId === "default", `got ${outlook?.calendarId}`);
    check("the outlook connection's cursor moved onto it", outlook?.syncCursor?.syncToken === "outlook-tok-456");
    check("it is enabled", outlook?.enabled === 1);

    // Running twice must not double it — the scheduler calls this on every pass.
    await seedCalendarSources(USER);
    const again = await db.select().from(calendarSources).where(eq(calendarSources.userId, USER));
    check("seeding is idempotent", again.length === 2, `got ${again.length}`);

    // An Apple connection stores a password, not tokens.
    await db.insert(appleConnections).values({
      userId: APPLE_USER,
      emailAddress: "someone@icloud.com",
      appPasswordEncrypted: "iv:tag:data",
      principalUrl: "https://caldav.icloud.com/123/principal/",
      calendarHomeUrl: "https://caldav.icloud.com/123/calendars/",
    });
    const apple = await db.query.appleConnections.findFirst({
      where: eq(appleConnections.userId, APPLE_USER),
    });
    check("apple connection stores its home url", Boolean(apple?.calendarHomeUrl));
    check("apple connection defaults to active", apple?.status === "active");

    // --- Disconnect must not orphan the source row, or a reconnect doubles the calendar ---
    //
    // `disconnectGmail`/`disconnectOutlook` delete the connection row and, right alongside it,
    // call `deleteCalendarSourcesForProvider`. Without that second delete, the orphaned source
    // row (still `enabled = 1`, still carrying its old cursor) has nothing to dedupe a
    // reconnect's fresh connection uuid against, and `seedCalendarSources` inserts a second
    // `primary` row every cycle.
    await db.delete(gmailConnections).where(eq(gmailConnections.userId, USER));
    await deleteCalendarSourcesForProvider(USER, "google");
    const afterDisconnect = await db
      .select()
      .from(calendarSources)
      .where(and(eq(calendarSources.userId, USER), eq(calendarSources.provider, "google")));
    check("disconnect leaves no orphaned google source", afterDisconnect.length === 0, `got ${afterDisconnect.length}`);
    const outlookStillThere = await db
      .select()
      .from(calendarSources)
      .where(and(eq(calendarSources.userId, USER), eq(calendarSources.provider, "microsoft")));
    check(
      "disconnecting google leaves the outlook source alone",
      outlookStillThere.length === 1,
      `got ${outlookStillThere.length}`
    );

    // Reconnect: a brand new connection row, a brand new connection id. Only the disconnect's
    // cleanup above stands between this and a doubled `primary` row.
    await db.insert(gmailConnections).values({
      userId: USER,
      emailAddress: "someone@example.com",
      accessTokenEncrypted: "y",
      scopes: "https://www.googleapis.com/auth/calendar.readonly",
      nextSyncAt: new Date(),
    });
    await seedCalendarSources(USER);
    const afterReconnect = await db
      .select()
      .from(calendarSources)
      .where(and(eq(calendarSources.userId, USER), eq(calendarSources.provider, "google")));
    check(
      "reconnect produces exactly one primary row, not two",
      afterReconnect.length === 1,
      `got ${afterReconnect.length}`
    );
  } finally {
    await cleanup();
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll calendar source checks passed.");
  process.exit(0);
}

main();
