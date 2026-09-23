import "./smoke/_env";
/**
 * `calendar_sources` and `apple_connections`.
 *
 * The migration is the risky half: every existing Google and Outlook connection must come out
 * with exactly ONE source row carrying the cursor it already had. A missed cursor means a full
 * resync for that user; a doubled row means the same calendar synced twice.
 */
import { getDb, reconcileSchema } from "../src/db";
import { appleConnections, calendarSources, gmailConnections } from "../src/db/schema";
import { eq } from "drizzle-orm";
import { seedCalendarSources } from "../src/lib/calendar-sources";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const USER = `smoke-cal-src-${Date.now()}`;

async function main() {
  await reconcileSchema();
  const db = await getDb();

  // A Google connection that already synced, with a cursor on the connection row.
  await db.insert(gmailConnections).values({
    userId: USER,
    emailAddress: "someone@example.com",
    accessTokenEncrypted: "x",
    scopes: "https://www.googleapis.com/auth/calendar.readonly",
    syncCursor: { calendar: { syncToken: "tok-123", pageToken: null } },
    nextSyncAt: new Date(),
  });

  await seedCalendarSources(USER);
  const seeded = await db.select().from(calendarSources).where(eq(calendarSources.userId, USER));
  check("one source per existing connection", seeded.length === 1, `got ${seeded.length}`);
  check("the connection's cursor moved onto it", seeded[0]?.syncCursor?.syncToken === "tok-123");
  check("it is enabled", seeded[0]?.enabled === 1);

  // Running twice must not double it — the scheduler calls this on every pass.
  await seedCalendarSources(USER);
  const again = await db.select().from(calendarSources).where(eq(calendarSources.userId, USER));
  check("seeding is idempotent", again.length === 1, `got ${again.length}`);

  // An Apple connection stores a password, not tokens.
  await db.insert(appleConnections).values({
    userId: `${USER}-apple`,
    emailAddress: "someone@icloud.com",
    appPasswordEncrypted: "iv:tag:data",
    principalUrl: "https://caldav.icloud.com/123/principal/",
    calendarHomeUrl: "https://caldav.icloud.com/123/calendars/",
  });
  const apple = await db.query.appleConnections.findFirst({
    where: eq(appleConnections.userId, `${USER}-apple`),
  });
  check("apple connection stores its home url", Boolean(apple?.calendarHomeUrl));
  check("apple connection defaults to active", apple?.status === "active");

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll calendar source checks passed.");
  process.exit(0);
}

main();
