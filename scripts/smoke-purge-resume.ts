/**
 * A purge interrupted mid-way finishes on the next nightly tick (launch Phase 2, audit B3).
 * The interruption is real, not simulated: the `goals` step's table is renamed away, so its
 * DELETE throws exactly as a dropped connection would.
 *
 * Run: npx tsx scripts/smoke-purge-resume.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { eq, sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import * as schema from "../src/db/schema";
import { PURGE_MAX_ATTEMPTS, planPurgeSteps } from "../src/lib/data-categories";
import { PurgeIncompleteError, purgeUserData, resumeStrandedPurges } from "../src/lib/user-data";

const USER = "smoke-purge-resume-user";
const MIN = 60_000;

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function seed() {
  const db = await getDb();
  await db.insert(schema.userSettings).values({ userId: USER }).onConflictDoNothing();
  await db.insert(schema.contacts).values({ userId: USER, fullName: "Ada Lovelace" });
  await db.insert(schema.chatThreads).values({ userId: USER, title: "thread" });
}

async function count(table: "contacts" | "chat_threads") {
  const db = await getDb();
  const res = await db.execute(sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE user_id = ${USER}`);
  return rowsOf<{ n: number }>(res)[0]?.n ?? 0;
}

async function runFor(runId: string) {
  const db = await getDb();
  const [row] = await db.select().from(schema.dataPurgeRuns).where(eq(schema.dataPurgeRuns.id, runId));
  return row;
}

async function breakGoals() {
  await (await getDb()).execute(sql`ALTER TABLE user_goals RENAME TO user_goals_parked`);
}
async function fixGoals() {
  await (await getDb()).execute(sql`ALTER TABLE IF EXISTS user_goals_parked RENAME TO user_goals`);
}

async function interruptedPurge(): Promise<PurgeIncompleteError> {
  await breakGoals();
  try {
    await purgeUserData(USER, { keepSettings: false });
  } catch (err) {
    if (err instanceof PurgeIncompleteError) return err;
    throw err;
  }
  throw new Error("expected the purge to stop at the goals step");
}

async function main() {
  console.log("The plan");
  const full = planPurgeSteps(["contacts", "preferences", "insights", "notes", "reminders"], false);
  check("a partial plan follows category order and ends with preferences", full.join(",") === "insights,notes,reminders,contacts,preferences", full.join(","));
  const all = planPurgeSteps(["tags", "preferences", "goals"], true);
  check("a full purge anonymises billing before resetting settings", all.slice(-2).join(",") === "billing,preferences", all.join(","));

  try {
    console.log("\nAn interrupted purge");
    await seed();
    const stopped = await interruptedPurge();
    check("the error names the completed steps", stopped.completed.join(",") === "insights,notes,reminders,imports,connections,events", stopped.completed.join(","));
    check("...and what is still pending, starting at goals", stopped.pending[0] === "goals");
    check("rows after the failed step are still there", (await count("contacts")) === 1);
    const stranded = await runFor(stopped.runId);
    check("the run is recorded as running with its progress", stranded?.status === "running" && stranded.completedSteps.length === 6);
    check("...and the error that stopped it", Boolean(stranded?.lastError));

    await fixGoals();
    const tooSoon = await resumeStrandedPurges({ now: new Date() });
    check("a run touched in the last ten minutes is left alone", tooSoon.found === 0);
    const resumed = await resumeStrandedPurges({ now: new Date(Date.now() + 11 * MIN) });
    check("the nightly resume finishes it", resumed.finished === 1, JSON.stringify(resumed));
    check("the rest of the data is gone", (await count("contacts")) === 0 && (await count("chat_threads")) === 0);
    const finished = await runFor(stopped.runId);
    check("the run is done, on its second attempt", finished?.status === "done" && finished.attempts === 2 && finished.finishedAt !== null);

    console.log("\nA run that keeps failing gives up");
    await seed();
    const again = await interruptedPurge();
    let clock = Date.now();
    let gaveUp = 0;
    for (let i = 0; i < PURGE_MAX_ATTEMPTS; i += 1) {
      clock += 11 * MIN;
      gaveUp += (await resumeStrandedPurges({ now: new Date(clock) })).gaveUp;
    }
    check("it is marked failed after the maximum attempts", (await runFor(again.runId))?.status === "failed" && gaveUp === 1);
    await fixGoals();

    console.log("\nHousekeeping");
    const pruned = await resumeStrandedPurges({ now: new Date(Date.now() + 31 * 86_400_000) });
    check("finished runs older than 30 days are pruned", pruned.pruned >= 1, JSON.stringify(pruned));
  } finally {
    await fixGoals();
    await purgeUserData(USER, { keepSettings: false }).catch(() => {});
    const db = await getDb();
    await db.delete(schema.dataPurgeRuns).where(eq(schema.dataPurgeRuns.targetUserId, USER));
  }
  console.log("\nAll purge-resume checks passed.");
}

run(main);
