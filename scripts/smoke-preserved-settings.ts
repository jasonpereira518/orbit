/**
 * Launch Phase 1 adds three user_settings columns that are account state, not content:
 * the recorded Terms acceptance (terms_accepted_at, terms_version) and the LinkedIn
 * timeline switch (timeline_backfill_enabled — an operator kill switch since schema v108,
 * on by default with no user-facing control). A Settings data wipe (purgeUserData with
 * keepSettings left at its default) must keep them; deleting the account must not.
 *
 * Run: npx tsx scripts/smoke-preserved-settings.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { userSettings } from "../src/db/schema";
import { purgeUserData } from "../src/lib/user-data";

const USER = "smoke-preserved-settings-user";
const FRESH = "smoke-preserved-settings-fresh";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function settingsFor(userId: string) {
  const db = await getDb();
  return db.query.userSettings.findFirst({ where: eq(userSettings.userId, userId) });
}

run(async () => {
  const db = await getDb();
  await db.delete(userSettings).where(inArray(userSettings.userId, [USER, FRESH]));

  await db.insert(userSettings).values({ userId: FRESH });
  const fresh = await settingsFor(FRESH);
  check("a fresh row defaults the timeline backfill on", fresh?.timelineBackfillEnabled === 1, JSON.stringify(fresh?.timelineBackfillEnabled));
  check("a fresh row has accepted nothing", fresh?.termsAcceptedAt === null && fresh?.termsVersion === null);

  const acceptedAt = new Date("2026-09-15T12:00:00.000Z");
  await db.insert(userSettings).values({
    userId: USER,
    termsAcceptedAt: acceptedAt,
    termsVersion: "2026-09-15",
    timelineBackfillEnabled: 1,
  });

  await purgeUserData(USER);
  const wiped = await settingsFor(USER);
  check("a Settings data wipe keeps the recorded terms acceptance", wiped?.termsAcceptedAt?.toISOString() === acceptedAt.toISOString(), String(wiped?.termsAcceptedAt));
  check("…and the terms version", wiped?.termsVersion === "2026-09-15", String(wiped?.termsVersion));
  check("…and the timeline opt-in", wiped?.timelineBackfillEnabled === 1, String(wiped?.timelineBackfillEnabled));

  await purgeUserData(USER, { keepSettings: false });
  check("deleting the account removes the row and everything on it", (await settingsFor(USER)) === undefined);

  await db.delete(userSettings).where(inArray(userSettings.userId, [USER, FRESH]));
  if (failures > 0) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll preserved-settings checks passed.");
});
