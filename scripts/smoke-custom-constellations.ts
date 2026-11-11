/**
 * Custom constellations: the plan cap, merge repointing and purge coverage.
 * Run: npx tsx scripts/smoke-custom-constellations.ts
 */
import "./smoke/_env";

import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import { contacts, customConstellationMembers, customConstellations } from "../src/db/schema";
import { mergeContacts, unmergeContacts } from "../src/lib/contact-merge";
import { getConstellationLimitForPlan } from "../src/lib/plans/plan-config";
import { purgeUserData } from "../src/lib/user-data";
import { run } from "./smoke/_env";

const USER = "smoke-custom-constellations-user";

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

run(async () => {
  const db = await getDb();

  check(
    "cap: free=3, orbit=Infinity",
    getConstellationLimitForPlan("free") === 3 &&
      getConstellationLimitForPlan("orbit") === Infinity &&
      getConstellationLimitForPlan("max") === Infinity &&
      getConstellationLimitForPlan("lifetime") === Infinity
  );

  const [a, b] = await db
    .insert(contacts)
    .values([
      { userId: USER, fullName: "Ada Constellation" },
      { userId: USER, fullName: "Ada C. Constellation" },
    ])
    .returning();
  const [cons] = await db
    .insert(customConstellations)
    .values({ userId: USER, name: "Founders", prompt: "people who founded companies" })
    .returning();
  await db.insert(customConstellationMembers).values([
    { userId: USER, constellationId: cons.id, contactId: a.id, source: "ai", reason: "founder" },
    { userId: USER, constellationId: cons.id, contactId: b.id, source: "manual" },
  ]);

  const distinctIds = async () =>
    rowsOf<{ contact_id: string }>(
      await db.execute(
        sql`SELECT DISTINCT contact_id FROM custom_constellation_members WHERE constellation_id = ${cons.id}::uuid`
      )
    )
      .map((r) => r.contact_id)
      .sort();

  const { mergeId } = await mergeContacts(USER, a.id, b.id, { deferInvalidation: true });
  const merged = await distinctIds();
  check("merge repoints members", merged.length === 1 && merged[0] === a.id, JSON.stringify(merged));

  await unmergeContacts(USER, mergeId);
  const restored = await distinctIds();
  check(
    "undo restores both members",
    restored.length === 2 && restored.includes(a.id) && restored.includes(b.id),
    JSON.stringify(restored)
  );

  await purgeUserData(USER, { only: ["contacts"] });
  const left = rowsOf<{ n: number }>(
    await db.execute(sql`
      SELECT (SELECT count(*) FROM custom_constellations WHERE user_id = ${USER})::int
           + (SELECT count(*) FROM custom_constellation_members WHERE user_id = ${USER})::int AS n
    `)
  )[0].n;
  check("purge removes both tables", left === 0, `${left} rows left`);

  await purgeUserData(USER, { keepSettings: false }).catch(() => {});
  console.log("\nAll custom-constellation checks passed.");
});
