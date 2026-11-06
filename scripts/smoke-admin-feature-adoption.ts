/**
 * The Growth page's "Accounts that have used each feature" bars (`featureAdoption` in
 * src/lib/admin-trends.ts).
 *
 * Every feature's count is its own correlated subquery over a table named in a constant
 * list, so a renamed or dropped table fails the whole Growth page at render time — and a
 * coming-soon feature slipping back in would chart the operator's own testing as adoption.
 * This runs the real query against the smoke PGlite and pins both.
 *
 * Run: npx tsx scripts/smoke-admin-feature-adoption.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { calendarSources, calendarSubscriptions } from "../src/db/schema";
import { featureAdoption } from "../src/lib/admin-trends";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const USER = "smoke-feature-adoption-user";

async function cleanup() {
  const db = await getDb();
  await db.delete(calendarSubscriptions).where(eq(calendarSubscriptions.userId, USER));
  await db.delete(calendarSources).where(eq(calendarSources.userId, USER));
}

run(async () => {
  await cleanup();
  const db = await getDb();

  const before = await featureAdoption();
  const labels = before.map((r) => r.label);
  check("every feature table exists and the query runs", before.length > 0);
  check("each feature appears once", new Set(labels).size === labels.length, labels.join(", "));
  const CHARTED = ["Capture", "Chat", "Meetings", "Reminders", "Imports", "Goals", "Calendar", "Extension"];
  check(
    "charts exactly the core features",
    labels.length === CHARTED.length && CHARTED.every((l) => labels.includes(l)),
    labels.join(", ")
  );
  for (const left of ["Outreach", "Events", "Leads", "Phone scan", "Outlook", "iCloud", "Gmail", "API & MCP", "Recruiters"]) {
    check(`leaves out ${left}`, !labels.includes(left));
  }
  check(
    "most-used first",
    before.every((r, i) => i === 0 || before[i - 1]!.count >= r.count),
    before.map((r) => `${r.label}=${r.count}`).join(", ")
  );

  // One account using BOTH calendar paths counts once.
  const calendar = (rows: typeof before) => rows.find((r) => r.key === "calendar")!.count;
  await db.insert(calendarSubscriptions).values({ userId: USER, icsUrl: "https://example.test/cal.ics" });
  await db.insert(calendarSources).values({
    userId: USER,
    provider: "apple",
    connectionId: randomUUID(),
    calendarId: "/calendars/home/",
  });
  const after = await featureAdoption();
  check("an account on both calendar paths counts once", calendar(after) === calendar(before) + 1,
    `${calendar(before)} → ${calendar(after)}`);

  // Completion, not attempt: a queued capture, a failed import and an abandoned meeting are
  // not adoption. Counted as deltas because the suite shares one database.
  const count = (rows: typeof before, key: string) => rows.find((r) => r.key === key)!.count;
  const base = await featureAdoption();
  const U = "smoke-adoption-completion-user";
  await db.execute(sql`DELETE FROM capture_jobs WHERE user_id = ${U}`);
  await db.execute(sql`DELETE FROM imports WHERE user_id = ${U}`);
  await db.execute(sql`DELETE FROM meeting_sessions WHERE user_id = ${U}`);
  await db.execute(sql`INSERT INTO capture_jobs (user_id, source_kind, status) VALUES (${U}, 'text', 'queued')`);
  await db.execute(sql`INSERT INTO imports (user_id, import_type, status) VALUES (${U}, 'csv', 'failed')`);
  const queued = await featureAdoption();
  check("a queued capture is not adoption", count(queued, "capture") === count(base, "capture"));
  check("a failed import is not adoption", count(queued, "imports") === count(base, "imports"));
  await db.execute(sql`INSERT INTO capture_jobs (user_id, source_kind, status) VALUES (${U}, 'text', 'saved')`);
  await db.execute(sql`INSERT INTO imports (user_id, import_type, status) VALUES (${U}, 'csv', 'completed')`);
  const done = await featureAdoption();
  check("a saved capture is adoption", count(done, "capture") === count(base, "capture") + 1);
  check("a completed import is adoption", count(done, "imports") === count(base, "imports") + 1);

  // The extension counts when it DID something, not when the popup probed the session.
  await db.execute(sql`INSERT INTO extension_usage (user_id, request_count) VALUES (${U}, 5) ON CONFLICT (user_id) DO NOTHING`);
  const probed = await featureAdoption();
  check("a session probe is not extension adoption", count(probed, "extension") === count(base, "extension"));
  await db.execute(sql`INSERT INTO reminders (user_id, title, created_by) VALUES (${U}, 'x', 'extension')`);
  const acted = await featureAdoption();
  check("a follow-up saved through the extension is", count(acted, "extension") === count(base, "extension") + 1);

  // An account the operator marked as a tester never counts, whatever it did.
  const T = "smoke-adoption-tester-user";
  await db.execute(sql`DELETE FROM user_settings WHERE user_id = ${T}`);
  await db.execute(sql`DELETE FROM capture_jobs WHERE user_id = ${T}`);
  await db.execute(sql`INSERT INTO user_settings (user_id, account_kind) VALUES (${T}, 'tester')`);
  await db.execute(sql`INSERT INTO capture_jobs (user_id, source_kind, status) VALUES (${T}, 'text', 'saved')`);
  const withTester = await featureAdoption();
  check("a tester account's capture is excluded", count(withTester, "capture") === count(done, "capture"));
  await db.execute(sql`DELETE FROM capture_jobs WHERE user_id IN (${U}, ${T})`);
  await db.execute(sql`DELETE FROM imports WHERE user_id = ${U}`);
  await db.execute(sql`DELETE FROM reminders WHERE user_id = ${U}`);
  await db.execute(sql`DELETE FROM extension_usage WHERE user_id = ${U}`);
  await db.execute(sql`DELETE FROM user_settings WHERE user_id = ${T}`);

  await cleanup();
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll feature-adoption checks passed.");
});
