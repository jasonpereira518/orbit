/**
 * The /admin overview reuses its five whole-table aggregates for ten minutes; the account
 * list itself (user_settings) is always live, and loadAdminUserRows() stays live by default.
 *
 * Run: npx tsx scripts/smoke-admin-aggregates.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, userSettings } from "../src/db/schema";
import { ADMIN_AGGREGATES_TTL_MS, getAdminOverview, loadAdminUserRows, type AdminUserRow } from "../src/lib/admin-metrics";
import { startQueryCount, stopQueryCount } from "../src/lib/query-counter";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const USER = "smoke-admin-agg-user";
const LATE = "smoke-admin-agg-late";
const contactsOf = (rows: AdminUserRow[], id: string) => rows.find((r) => r.userId === id)?.counts.contacts;

run(async () => {
  const db = await getDb();
  await db.delete(contacts).where(inArray(contacts.userId, [USER, LATE]));
  await db.delete(userSettings).where(inArray(userSettings.userId, [USER, LATE]));
  await db.insert(userSettings).values({ userId: USER, email: `${USER}@example.test` });
  await db.insert(contacts).values([{ userId: USER, fullName: "One" }, { userId: USER, fullName: "Two" }]);

  const primed = await getAdminOverview(new Date(), { aggregatesMaxAgeMs: 0 });
  check("a fresh overview counts both contacts", contactsOf(primed.rows, USER) === 2);

  await db.insert(contacts).values({ userId: USER, fullName: "Three" });
  await db.insert(userSettings).values({ userId: LATE, email: `${LATE}@example.test` });

  startQueryCount();
  const memo = await getAdminOverview();
  const statements = stopQueryCount();
  check("the default overview reuses the aggregates inside the TTL", contactsOf(memo.rows, USER) === 2, String(contactsOf(memo.rows, USER)));
  check("and costs one statement (user_settings), not six", statements === 1, String(statements));
  check("an account created since is listed at once, with zero counts", contactsOf(memo.rows, LATE) === 0);
  check("the TTL is ten minutes", ADMIN_AGGREGATES_TTL_MS === 10 * 60 * 1000);

  check("loadAdminUserRows() stays live by default", contactsOf(await loadAdminUserRows(), USER) === 3);
  check("an overview asked for fresh numbers reads live",
    contactsOf((await getAdminOverview(new Date(), { aggregatesMaxAgeMs: 0 })).rows, USER) === 3);

  await db.delete(contacts).where(inArray(contacts.userId, [USER, LATE]));
  await db.delete(userSettings).where(inArray(userSettings.userId, [USER, LATE]));
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll admin-aggregate checks passed.");
});
