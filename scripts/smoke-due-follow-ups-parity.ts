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

import { eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { closenessCohorts, contacts, userSettings } from "../src/db/schema";
import { getDashboardData } from "../src/lib/reminders";
import { loadDueFollowUps } from "../src/lib/due-follow-ups";
import { recalibrateCloseness } from "../src/lib/closeness-cohort";
import { ensureUserSettings } from "../src/lib/user-settings";
import { startQueryCount, stopQueryCount } from "../src/lib/query-counter";
import { scaleContactRows } from "./lib/scale-fixture";
import { listContactsPage } from "../src/lib/contacts-page-query";
import { cadenceDueAt, isFollowUpDue } from "../src/lib/keep-in-touch";

const USER = "smoke-due-parity-user";
// A small second network for the cadence cases: in the 600-contact one, years-lapsed
// default cadences fill the twelve-row cap long before a contact lapsed yesterday could.
const CADENCE_USER = "smoke-due-parity-cadence-user";
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
  keepInTouchDays: number | null;
  keepInTouchIsDefault: boolean;
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
    keepInTouchDays: c.keepInTouchDays,
    keepInTouchIsDefault: c.keepInTouchIsDefault,
  }));

async function cleanup() {
  const db = await getDb();
  await db.delete(contacts).where(inArray(contacts.userId, [USER, CADENCE_USER]));
  await db.delete(closenessCohorts).where(eq(closenessCohorts.userId, CADENCE_USER));
  await db.delete(userSettings).where(eq(userSettings.userId, CADENCE_USER));
}

run(async () => {
  const db = await getDb();
  await cleanup();
  await ensureUserSettings(USER);

  const rows = scaleContactRows(USER, N, {});
  for (let start = 0; start < rows.length; start += 200) {
    await db.insert(contacts).values(rows.slice(start, start + 200));
  }
  // A shared instant for a block of contacts (older than any lapsed default cadence here, so
  // the ties still fill the capped list), varied priority, plus distinct overdue times,
  // future follow-ups and none at all.
  await db.execute(sql`
    WITH numbered AS (
      SELECT id, row_number() OVER (ORDER BY full_name, id) AS n FROM contacts WHERE user_id = ${USER}
    )
    UPDATE contacts c SET
      next_follow_up_at = CASE
        WHEN n % 10 = 0 THEN timestamptz '2020-01-01T09:00:00Z'
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
    due.filter((c) => c.nextFollowUpAt?.toISOString() === "2020-01-01T09:00:00.000Z").length > 1);
  // The candidates, the stored cohort, and the twelve names — never the dashboard's fan-out.
  check("reads far fewer statements than the dashboard", statements < dashboardStatements / 2,
    `${statements} vs ${dashboardStatements}`);

  // The whole-network count, against the TypeScript rule over the stored rows (the tier is
  // the materialized column, as the SQL reads it).
  const stored = await db.query.contacts.findMany({ where: eq(contacts.userId, USER) });
  const countNow = new Date();
  const expectedDue = stored.filter((c) => isFollowUpDue(c, countNow)).length;
  check("stats.dueFollowUps counts every due contact, cadence-due included",
    dashboard.stats.dueFollowUps === expectedDue, `${dashboard.stats.dueFollowUps} vs ${expectedDue}`);
  check("the count includes cadence-due contacts",
    stored.some((c) => !c.nextFollowUpAt && isFollowUpDue(c, countNow)));

  /* ----------------------------------------- lapsed cadences come due (small network) */
  await ensureUserSettings(CADENCE_USER);
  const day = 86_400_000;
  const ago = (days: number) => new Date(Date.now() - days * day);
  const [innerLapsed, outerQuiet, booked, innerFresh, ownCadence] = await db.insert(contacts).values([
    { userId: CADENCE_USER, fullName: "Inner Lapsed", lastInteractionAt: ago(31), dateMet: ago(500) },
    { userId: CADENCE_USER, fullName: "Outer Quiet", lastInteractionAt: ago(400), dateMet: ago(500) },
    { userId: CADENCE_USER, fullName: "Booked Due", lastInteractionAt: ago(200), nextFollowUpAt: ago(2) },
    { userId: CADENCE_USER, fullName: "Inner Fresh", lastInteractionAt: ago(5) },
    { userId: CADENCE_USER, fullName: "Own Cadence", lastInteractionAt: ago(20), cadenceDays: 14 },
  ]).returning();
  await recalibrateCloseness(CADENCE_USER);
  // After the recalibration, which writes the column: the tier the effective cadence reads.
  const setTier = (id: string, tier: "inner" | "mid" | "outer") =>
    db.update(contacts).set({ closenessTier: tier }).where(eq(contacts.id, id));
  await setTier(innerLapsed.id, "inner");
  await setTier(outerQuiet.id, "outer");
  await setTier(booked.id, "inner");
  await setTier(innerFresh.id, "inner");
  await setTier(ownCadence.id, "outer");

  const small = await getDashboardData(CADENCE_USER);
  const smallLoader = await loadDueFollowUps(CADENCE_USER);
  check("inner contact with a lapsed default cadence is due on the dashboard",
    small.dueFollowUps.some((c) => c.id === innerLapsed.id && c.keepInTouchDays === 30 && c.keepInTouchIsDefault));
  check("and appears exactly once", small.dueFollowUps.filter((c) => c.id === innerLapsed.id).length === 1);
  check("outer contact with no cadence is not due", !small.dueFollowUps.some((c) => c.id === outerQuiet.id));
  check("a contact's own lapsed cadence is due, not a default",
    small.dueFollowUps.some((c) => c.id === ownCadence.id && c.keepInTouchDays === 14 && !c.keepInTouchIsDefault));
  check("a booked follow-up decides: no cadence label",
    small.dueFollowUps.some((c) => c.id === booked.id && c.keepInTouchDays === null && !c.keepInTouchIsDefault));
  check("an inner contact touched last week is not due", !small.dueFollowUps.some((c) => c.id === innerFresh.id));
  check("stats.dueFollowUps is exact (booked, inner lapsed, own cadence)", small.stats.dueFollowUps === 3,
    String(small.stats.dueFollowUps));
  check("loadDueFollowUps agrees", smallLoader.some((c) => c.id === innerLapsed.id));
  // External payloads (v1, MCP, webhook) read `dueAt`: a cadence-due row carries its lapse instant.
  const lapsedRow = smallLoader.find((c) => c.id === innerLapsed.id);
  const lapsedStored = await db.query.contacts.findFirst({ where: eq(contacts.id, innerLapsed.id) });
  const lapsedAt = lapsedStored && cadenceDueAt(lapsedStored);
  check("a cadence-due row's dueAt is its cadence due instant",
    Boolean(lapsedRow?.dueAt && lapsedAt) && lapsedRow!.dueAt!.getTime() === lapsedAt!.getTime(),
    `${lapsedRow?.dueAt?.toISOString()} vs ${lapsedAt?.toISOString()}`);
  check("a booked row's dueAt is its booked date",
    smallLoader.find((c) => c.id === booked.id)?.dueAt?.getTime() === booked.nextFollowUpAt?.getTime());
  const smallById = new Map(smallLoader.map((c) => [c.id, c]));
  check("loadDueFollowUps matches the dashboard on the small network",
    JSON.stringify(view(small.dueFollowUps, (id) => small.closenessById.get(id)?.tier ?? null)) ===
      JSON.stringify(view(smallLoader, (id) => smallById.get(id)?.closenessTier ?? null)));
  const page = await listContactsPage(CADENCE_USER, { followUp: "due" });
  check("followUp=due includes cadence-due", page.items.some((c) => c.id === innerLapsed.id));
  check("followUp=due excludes the quiet outer contact", !page.items.some((c) => c.id === outerQuiet.id));
  check("followUp=due is the dashboard's set",
    JSON.stringify(page.items.map((c) => c.id).sort()) === JSON.stringify(small.dueFollowUps.map((c) => c.id).sort()));
  const all = await listContactsPage(CADENCE_USER, {});
  check("the list carries the effective cadence",
    all.items.find((c) => c.id === innerLapsed.id)?.keepInTouchDays === 30 &&
      all.items.find((c) => c.id === ownCadence.id)?.keepInTouchDays === 14 &&
      all.items.find((c) => c.id === outerQuiet.id)?.keepInTouchDays === null);

  await cleanup();

  const empty = await loadDueFollowUps("smoke-due-parity-nobody");
  check("an account with nothing due gets an empty list", empty.length === 0);

  if (failures) throw new Error(`${failures} check(s) failed`);
  console.log("\nDue follow-ups parity checks passed.");
});
