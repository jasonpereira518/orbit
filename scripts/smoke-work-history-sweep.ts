/**
 * The hourly work-history sweep: who it checks, in what order, how often, and how it stops.
 *
 * PGlite plus a fake researcher and a fake AI gate — no key, no network. Pins the rules that
 * decide what the sweep spends from a person's own AI key:
 *   - closest people first, never-checked before re-checks;
 *   - a per-account daily budget, and a per-run cap so one big network cannot starve others;
 *   - accounts that switched it off, or have no AI, are not searched;
 *   - claims it could not start are handed back rather than lost;
 *   - the next check lands on the closeness tier's interval, jittered ±20%, so a batch
 *     checked together spreads out.
 *
 * Run: npx tsx scripts/smoke-work-history-sweep.ts
 */
import "./smoke/_env";

import { and, eq, inArray, like } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, rateLimitBuckets, userSettings } from "../src/db/schema";
import { consumeBucket, RATE_LIMITS } from "../src/lib/rate-limit";
import { utcDayKey } from "../src/lib/timeline-cost";
import { ensureUserSettings } from "../src/lib/user-settings";
import {
  nextWorkHistoryDue,
  WORK_HISTORY_INTERVAL_DAYS,
  workHistoryIntervalDays,
  type WorkHistoryResearcher,
} from "../src/lib/work-history-research";
import {
  BACKGROUND_DAILY_LIMIT,
  runWorkHistorySweep,
  SWEEP_CLAIM_PER_USER,
} from "../src/lib/work-history-sweep";

const HEAVY = "smoke-whs-heavy";
const LIGHT = "smoke-whs-light";
const OFF = "smoke-whs-off";
const NO_AI = "smoke-whs-noai";
const USERS = [HEAVY, LIGHT, OFF, NO_AI];
const DAY = 86_400_000;

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function reset() {
  const db = await getDb();
  await db.delete(contacts).where(inArray(contacts.userId, USERS));
  await db.delete(rateLimitBuckets).where(like(rateLimitBuckets.bucket, "%smoke-whs-%"));
  for (const u of USERS) await ensureUserSettings(u);
  await db.update(userSettings).set({ workHistoryAutoEnabled: 1 }).where(inArray(userSettings.userId, USERS));
  await db.update(userSettings).set({ workHistoryAutoEnabled: 0 }).where(eq(userSettings.userId, OFF));
}

async function addContact(userId: string, name: string, closeness: number | null, extra: Partial<typeof contacts.$inferInsert> = {}) {
  const db = await getDb();
  const [row] = await db
    .insert(contacts)
    .values({
      userId,
      fullName: name,
      linkedinUrl: `https://www.linkedin.com/in/${name.toLowerCase().replace(/\s+/g, "-")}`,
      closeness,
      ...extra,
    })
    .returning();
  return row!.id;
}

/** A researcher that finds nobody, and records who it was asked about. */
function recorder() {
  const asked: Array<{ name: string }> = [];
  const researcher: WorkHistoryResearcher = async (_userId, subject) => {
    asked.push({ name: subject.fullName });
    return { confident: false, headline: null, sources: [], experiences: [] };
  };
  return { researcher, asked };
}

const aiFor = async (userId: string) => userId !== NO_AI;

function cadence() {
  console.log("\nCadence");
  const now = new Date("2026-09-29T12:00:00Z");
  const base = { lastInteractionAt: now, statedCloseness: 3, priorityLevel: 0 };
  check("inner orbit: 30 days", workHistoryIntervalDays({ ...base, closenessTier: "inner" }) === 30);
  check("mid orbit: 60 days", workHistoryIntervalDays({ ...base, closenessTier: "mid" }) === 60);
  check("outer orbit: 120 days", workHistoryIntervalDays({ ...base, closenessTier: "outer" }) === 120);
  check(
    "never talked to, never rated: 180 days",
    workHistoryIntervalDays({ closenessTier: null, lastInteractionAt: null, statedCloseness: null, priorityLevel: 0 }) === 180
  );
  check(
    "a priority contact gets the inner cadence whatever its tier",
    workHistoryIntervalDays({ ...base, closenessTier: "outer", priorityLevel: 2 }) === 30
  );

  const mid = { ...base, closenessTier: "mid" as const };
  const low = nextWorkHistoryDue(mid, "saved", now, { random: () => 0 }).getTime() - now.getTime();
  const high = nextWorkHistoryDue(mid, "saved", now, { random: () => 1 }).getTime() - now.getTime();
  check("jitter floor is -20%", Math.abs(low - 0.8 * 60 * DAY) < 1000, String(low / DAY));
  check("jitter ceiling is +20%", Math.abs(high - 1.2 * 60 * DAY) < 1000, String(high / DAY));
  const spread = new Set(
    Array.from({ length: 50 }, () => Math.round((nextWorkHistoryDue(mid, "saved", now).getTime() - now.getTime()) / DAY))
  );
  check("…and a batch checked together lands on many different days", spread.size >= 10, String(spread.size));
  check(
    "a failed check retries in about a day",
    Math.abs(nextWorkHistoryDue(mid, "error", now, { random: () => 0.5 }).getTime() - now.getTime() - DAY) < 1000
  );
  const limited = nextWorkHistoryDue(mid, "rate_limited", now, { random: () => 0 });
  check("an exhausted budget waits for the next UTC day", limited.toISOString() === "2026-09-30T00:00:00.000Z", limited.toISOString());
  check(
    "fresh counts from the search that made it fresh",
    nextWorkHistoryDue(mid, "fresh", now, { from: new Date(now.getTime() - 10 * DAY), random: () => 0.5 }).getTime() ===
      now.getTime() + 50 * DAY
  );
  check("the tier table is what the sweep header promises", WORK_HISTORY_INTERVAL_DAYS.inner === 30 && WORK_HISTORY_INTERVAL_DAYS.cold === 180);
}

async function sweep() {
  console.log("\nSweep");
  await reset();
  const db = await getDb();

  // HEAVY has more due contacts than one run's cap; closeness decides who goes first.
  const heavyIds = {
    close: await addContact(HEAVY, "Close Friend", 95, { closenessTier: "inner" }),
    mid: await addContact(HEAVY, "Mid Friend", 50, { closenessTier: "mid" }),
    far: await addContact(HEAVY, "Far Acquaintance", 5, { closenessTier: "outer" }),
    unscored: await addContact(HEAVY, "Unscored Import", null),
    another: await addContact(HEAVY, "Another Import", null),
  };
  // Already checked and not due: never claimed.
  const notDue = await addContact(HEAVY, "Checked Recently", 99, {
    closenessTier: "inner",
    workHistoryDueAt: new Date(Date.now() + 10 * DAY),
  });
  // No LinkedIn URL: nothing to anchor a search on.
  await db.insert(contacts).values({ userId: HEAVY, fullName: "No Url", closeness: 99 });
  const lightId = await addContact(LIGHT, "Only Contact", 10, { closenessTier: "outer" });
  const offId = await addContact(OFF, "Switched Off", 90, { closenessTier: "inner" });
  const noAiId = await addContact(NO_AI, "No Key", 90, { closenessTier: "inner" });

  const first = recorder();
  const stats = await runWorkHistorySweep({ researcher: first.researcher, canUseAi: aiFor });
  const names = first.asked.map((a) => a.name);
  check(
    `one run checks at most ${SWEEP_CLAIM_PER_USER} of a big network`,
    names.filter((n) => n !== "Only Contact").length === SWEEP_CLAIM_PER_USER,
    names.join(", ")
  );
  check(
    "closest first: the three most-close due contacts",
    ["Close Friend", "Mid Friend", "Far Acquaintance"].every((n) => names.includes(n)),
    names.join(", ")
  );
  check("a small network is not starved by a big one", names.includes("Only Contact"), names.join(", "));
  check("a contact not yet due is left alone", !names.includes("Checked Recently"));
  check("a contact without a LinkedIn URL is left alone", !names.includes("No Url"));
  check("an account that switched it off is not searched", !names.includes("Switched Off"));
  check("an account with no AI is not searched", !names.includes("No Key") && stats.noAiUsers === 1, String(stats.noAiUsers));

  const byId = async (id: string) => (await db.query.contacts.findFirst({ where: eq(contacts.id, id) }))!;
  const closeDue = (await byId(heavyIds.close)).workHistoryDueAt!;
  const farDue = (await byId(heavyIds.far)).workHistoryDueAt!;
  check(
    "a checked inner contact is next due in ~30 days (±20%)",
    closeDue.getTime() - Date.now() > 23 * DAY && closeDue.getTime() - Date.now() < 37 * DAY,
    closeDue.toISOString()
  );
  check(
    "a checked outer contact in ~120 days (±20%)",
    farDue.getTime() - Date.now() > 95 * DAY && farDue.getTime() - Date.now() < 145 * DAY,
    farDue.toISOString()
  );
  check("the not-due contact kept its date", (await byId(notDue)).workHistoryDueAt!.getTime() > Date.now() + 9 * DAY);
  check("the switched-off account's contact was not rescheduled", (await byId(offId)).workHistoryDueAt === null);
  const deferred = (await byId(noAiId)).workHistoryDueAt!;
  check(
    "the no-AI account is deferred about a week, not re-found every hour",
    deferred.getTime() - Date.now() > 5 * DAY && deferred.getTime() - Date.now() < 9 * DAY,
    String(deferred)
  );
  check("the light account's contact was rescheduled", (await byId(lightId)).workHistoryDueAt !== null);

  // Second run: the never-checked imports are what is left for HEAVY.
  const second = recorder();
  await runWorkHistorySweep({ researcher: second.researcher, canUseAi: aiFor });
  check(
    "the next run picks up where the last left off",
    ["Unscored Import", "Another Import"].every((n) => second.asked.some((a) => a.name === n)),
    second.asked.map((a) => a.name).join(", ")
  );

  // --- the daily budget --------------------------------------------------------------
  await reset();
  for (let i = 0; i < 4; i++) await addContact(HEAVY, `Budget ${i}`, 50 - i);
  const key = `${HEAVY}:${utcDayKey(new Date())}`;
  for (let i = 0; i < BACKGROUND_DAILY_LIMIT - 1; i++) {
    await consumeBucket("work-history-background", key, RATE_LIMITS.workHistoryBackground);
  }
  const budget = recorder();
  const budgetStats = await runWorkHistorySweep({ researcher: budget.researcher, canUseAi: aiFor });
  check(
    `the ${BACKGROUND_DAILY_LIMIT}-a-day background budget stops the account`,
    budget.asked.length === 1 && budgetStats.budgetSpent === 1,
    `${budget.asked.length} searched, ${budgetStats.budgetSpent} spent`
  );
  const waiting = await db
    .select({ due: contacts.workHistoryDueAt })
    .from(contacts)
    .where(and(eq(contacts.userId, HEAVY)));
  const tomorrow = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 1);
  // Four due, three claimed (the per-run cap), one searched: the other two claims were
  // turned away by the budget and wait for tomorrow; the fourth was never claimed.
  check(
    "…and the claims it turned away wait for tomorrow instead of being lost",
    waiting.filter((w) => w.due && w.due.getTime() >= tomorrow - 1000 && w.due.getTime() < tomorrow + 7 * 3_600_000).length === 2,
    JSON.stringify(waiting.map((w) => w.due?.toISOString()))
  );
  check("…and one never claimed is still simply due", waiting.filter((w) => w.due === null).length === 1);

  // --- the deadline --------------------------------------------------------------------
  await reset();
  const late = await addContact(LIGHT, "Deadline Person", 50);
  const lateRun = recorder();
  const lateStats = await runWorkHistorySweep({
    researcher: lateRun.researcher,
    canUseAi: aiFor,
    deadline: Date.now() - 1,
  });
  check("past the deadline nobody is started", lateRun.asked.length === 0 && lateStats.claimed === 1);
  const released = (await byId(late)).workHistoryDueAt;
  check(
    "…and the claim is handed back due now, not left leased",
    lateStats.released === 1 && released !== null && released.getTime() <= Date.now(),
    String(released)
  );

  await reset();
  await db.delete(contacts).where(inArray(contacts.userId, USERS));
}

async function main() {
  cadence();
  await sweep();
  console.log("\nsmoke-work-history-sweep: all checks passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
