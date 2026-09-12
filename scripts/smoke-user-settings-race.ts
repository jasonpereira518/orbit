/**
 * Asserts that creating a user's settings row is safe under concurrent requests.
 *
 * `ensureUserSettings` is called on every authenticated request. On a brand-new user two
 * requests that overlap — the page render, the notifications pulse, an avatar backfill —
 * each saw "no row", each inserted, and the second died with `duplicate key value violates
 * unique constraint "user_settings_user_id_key"` as an unhandled rejection. React's
 * per-request `cache()` cannot help across requests. The insert must tolerate the race.
 *
 * Runs against a throwaway PGlite database. Run: npx tsx scripts/smoke-user-settings-race.ts
 */
import "./smoke/_env";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { userSettings } from "../src/db/schema";
import { ensureUserSettings } from "../src/lib/user-settings";

const USER = "smoke-user-settings-race-user";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

async function main() {
  const db = await getDb();
  await db.delete(userSettings).where(eq(userSettings.userId, USER));

  const results = await Promise.allSettled(
    Array.from({ length: 6 }, () => ensureUserSettings(USER))
  );
  const rejected = results.filter((r) => r.status === "rejected");
  check("six overlapping ensures all resolve", rejected.length === 0,
    rejected.map((r) => String((r as PromiseRejectedResult).reason).slice(0, 120)).join(" | "));
  const rows = await db.query.userSettings.findMany({ where: eq(userSettings.userId, USER) });
  check("exactly one row exists afterwards", rows.length === 1, `rows=${rows.length}`);
  check("every caller got the row back",
    results.every((r) => r.status === "fulfilled" && r.value?.userId === USER));

  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll user-settings race checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
