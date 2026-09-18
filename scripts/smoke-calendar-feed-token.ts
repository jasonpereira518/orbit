/**
 * The feed token is a bearer credential: the database holds only its SHA-256, the route
 * still resolves the token, the stored hash is not itself a credential, and Node's hash
 * equals the SQL that migrates existing rows. Run: npx tsx scripts/smoke-calendar-feed-token.ts
 */
import "./smoke/_env";

import { eq, sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import { userSettings } from "../src/db/schema";
import { clearCalendarFeedToken, findUserByFeedToken, hashCalendarFeedToken, mintCalendarFeedToken } from "../src/lib/calendar-feed";
import { ensureUserSettings } from "../src/lib/user-settings";
import { run } from "./smoke/_env";

const USER = "smoke-calendar-feed-token-user";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

run(async () => {
  const db = await getDb();
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await ensureUserSettings(USER);

  const token = await mintCalendarFeedToken(USER);
  const row = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, USER) });
  check("the row stores a 64-hex hash, not the token", /^[0-9a-f]{64}$/.test(row?.calendarFeedToken ?? "") && row?.calendarFeedToken !== token);
  check("it is the token's hash", row?.calendarFeedToken === hashCalendarFeedToken(token));
  check("the token resolves", (await findUserByFeedToken(token))?.userId === USER);
  check("with the .ics suffix too", (await findUserByFeedToken(`${token}.ics`))?.userId === USER);
  check("the stored hash is not a credential", (await findUserByFeedToken(row!.calendarFeedToken!)) === null);

  const res = await db.execute(sql`select encode(sha256(convert_to(${token}, 'UTF8')), 'hex') as h`);
  check("Node's hash equals the migration's SQL", rowsOf<{ h: string }>(res)[0]?.h === hashCalendarFeedToken(token));

  const second = await mintCalendarFeedToken(USER);
  check("regenerating revokes the old token", (await findUserByFeedToken(token)) === null);
  check("and the new one resolves", (await findUserByFeedToken(second))?.userId === USER);
  await clearCalendarFeedToken(USER);
  check("turning it off revokes it", (await findUserByFeedToken(second)) === null);
  // The smoke runner shares one PGlite across scripts.
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
});
