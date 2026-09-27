/**
 * `loadDueFollowUps` must return exactly the dashboard's due list: same people, same order,
 * same cap, same field values. The MCP `due_followups` and `get_network_overview` tools read
 * it instead of running the whole dashboard, so any drift here is an external contract
 * changing.
 *
 * The network is built to make ordering hard: dozens of contacts due at the identical
 * instant (so tier, priority and the id tiebreak all decide), others due at distinct times,
 * some in the future, some with no follow-up at all.
 *
 * Runs against a throwaway PGlite. Run: npx tsx scripts/smoke-due-follow-ups-parity.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { eq, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts } from "../src/db/schema";
import { getDashboardData } from "../src/lib/reminders";
import { loadDueFollowUps } from "../src/lib/due-follow-ups";
import { recalibrateCloseness } from "../src/lib/closeness-cohort";
import { ensureUserSettings } from "../src/lib/user-settings";
import { startQueryCount, stopQueryCount } from "../src/lib/query-counter";
import { scaleContactRows } from "./lib/scale-fixture";

const USER = "smoke-due-parity-user";
const N = 600;

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

type Row = {
  id: string;
  fullName: string;
  company: string | null;
  title: string | null;
  email: string | null;
  nextFollowUpAt: Date | null;
  lastInteractionAt: Date | null;
};
const view = (rows: Row[], tierOf: (id: string) => string | null) =>
  rows.map((c) => ({
    id: c.id,
    fullName: c.fullName,
    company: c.company ?? null,
    title: c.title ?? null,
    email: c.email ?? null,
    tier: tierOf(c.id),
    nextFollowUpAt: c.nextFollowUpAt ? new Date(c.nextFollowUpAt).toISOString() : null,
    lastInteractionAt: c.lastInteractionAt ? new Date(c.lastInteractionAt).toISOString() : null,
  }));

run(async () => {
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await ensureUserSettings(USER);

  const rows = scaleContactRows(USER, N, {});
  for (let start = 0; start < rows.length; start += 200) {
    await db.insert(contacts).values(rows.slice(start, start + 200));
  }
  // A shared instant for a block of contacts, varied priority, plus distinct overdue times,
  // future follow-ups and none at all.
  await db.execute(sql`
    WITH numbered AS (
      SELECT id, row_number() OVER (ORDER BY full_name, id) AS n FROM contacts WHERE user_id = ${USER}
    )
    UPDATE contacts c SET
      next_follow_up_at = CASE
        WHEN n % 10 = 0 THEN timestamptz '2026-01-01T09:00:00Z'
        WHEN n % 10 = 1 THEN now() - (n || ' hours')::interval
        WHEN n % 10 = 2 THEN now() + (n || ' hours')::interval
        ELSE NULL END,
      priority_level = (n % 4)::int,
      last_interaction_at = CASE WHEN n % 3 = 0 THEN now() - (n || ' days')::interval ELSE NULL END
    FROM numbered WHERE c.id = numbered.id
  `);
  await recalibrateCloseness(USER);

  startQueryCount();
  const dashboard = await getDashboardData(USER);
  const dashboardStatements = stopQueryCount();
  startQueryCount();
  const due = await loadDueFollowUps(USER);
  const statements = stopQueryCount();

  const expected = JSON.stringify(
    view(dashboard.dueFollowUps, (id) => dashboard.closenessById.get(id)?.tier ?? null)
  );
  const byId = new Map(due.map((c) => [c.id, c]));
  const actual = JSON.stringify(view(due, (id) => byId.get(id)?.closenessTier ?? null));
  check("same people, same order, same values as the dashboard", expected === actual,
    expected === actual ? `${due.length} rows` : `\n      dashboard: ${expected.slice(0, 300)}\n      loader:    ${actual.slice(0, 300)}`);
  check("the list is full (the fixture has more than the cap due)", due.length === 12, String(due.length));
  check("tied instants are present, so the tiebreaks were exercised",
    due.filter((c) => c.nextFollowUpAt?.toISOString() === "2026-01-01T09:00:00.000Z").length > 1);
  // The candidates, the stored cohort, and the twelve names — never the dashboard's fan-out.
  check("reads far fewer statements than the dashboard", statements < dashboardStatements / 2,
    `${statements} vs ${dashboardStatements}`);

  const empty = await loadDueFollowUps("smoke-due-parity-nobody");
  check("an account with nothing due gets an empty list", empty.length === 0);

  if (failures) throw new Error(`${failures} check(s) failed`);
  console.log("\nDue follow-ups parity checks passed.");
});
