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
import { eq } from "drizzle-orm";
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
  for (const released of ["Capture", "Chat", "Meetings", "Reminders", "Imports", "Calendar", "iCloud", "API & MCP", "Extension"]) {
    check(`lists ${released}`, labels.includes(released));
  }
  for (const unreleased of ["Outreach", "Events", "Leads"]) {
    check(`leaves out coming-soon ${unreleased}`, !labels.includes(unreleased));
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

  await cleanup();
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll feature-adoption checks passed.");
});
