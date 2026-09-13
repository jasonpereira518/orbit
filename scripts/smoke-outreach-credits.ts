/**
 * Research credits (spec §7.6). Every movement is one SQL statement, so these checks drive the
 * real statements against PGlite: grants by plan, reservation splits across buckets, charging
 * exactly once, releasing the unused remainder, lazy rollover, and replayed idempotency keys.
 *
 * Run: npx tsx scripts/smoke-outreach-credits.ts
 */
import "./smoke/_env";

import { and, eq } from "drizzle-orm";
import { run } from "./smoke/_env";
import { getDb } from "../src/db";
import * as schema from "../src/db/schema";
import {
  addMonthsUtc,
  chargeAttempt,
  ensureCreditAccount,
  getCreditBalance,
  listCreditLedger,
  releaseHold,
  reserveCredits,
} from "../src/lib/outreach/credits/ledger";
import { ensureUserSettings } from "../src/lib/user-settings";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const PRO = "smoke-credits-pro";
const LIFE = "smoke-credits-lifetime";
const BOTH = "smoke-credits-both";
const FREE = "smoke-credits-free";

async function setup() {
  const db = await getDb();
  for (const id of [PRO, LIFE, BOTH, FREE]) await ensureUserSettings(id);
  await db.update(schema.userSettings).set({ compedPlan: "orbit" }).where(eq(schema.userSettings.userId, PRO));
  await db.update(schema.userSettings).set({ compedPlan: "lifetime" }).where(eq(schema.userSettings.userId, LIFE));
  await db
    .update(schema.userSettings)
    .set({ lifetimePurchasedAt: new Date(), subscriptionPlan: "orbit", subscriptionStatus: "active" })
    .where(eq(schema.userSettings.userId, BOTH));
}

async function attemptFor(userId: string, holdId: string) {
  const db = await getDb();
  const [campaign] = await db.insert(schema.outreachCampaigns).values({ userId, name: "c", generation: 2 }).returning();
  const [prospect] = await db
    .insert(schema.outreachProspects)
    .values({ userId, campaignId: campaign.id, externalId: `manual:${Math.random()}`, fullName: "P" })
    .returning();
  const [attempt] = await db
    .insert(schema.outreachResearchAttempts)
    .values({ userId, campaignId: campaign.id, prospectId: prospect.id, fundingSource: "orbit", creditState: "held", holdId })
    .returning();
  return attempt.id;
}

async function main() {
  await setup();
  const db = await getDb();
  const now = new Date("2026-09-13T12:00:00Z");

  console.log("Grants by plan...");
  const pro = await getCreditBalance(PRO, now);
  check("Pro gets 250 a month", pro.monthlyAllowance === 250 && pro.total === 250, JSON.stringify(pro));
  const life = await getCreditBalance(LIFE, now);
  check("Lifetime gets 100 once", life.lifetimeAvailable === 100 && life.monthlyAvailable === 0);
  await ensureCreditAccount(LIFE, now);
  check("the Lifetime grant is not repeated", (await getCreditBalance(LIFE, now)).lifetimeAvailable === 100);
  const both = await getCreditBalance(BOTH, now);
  check("Lifetime plus a live subscription has both buckets", both.monthlyAvailable === 250 && both.lifetimeAvailable === 100);
  check("Free gets nothing", (await getCreditBalance(FREE, now)).total === 0);
  check("the free user cannot reserve", (await reserveCredits(FREE, { want: 5, idempotencyKey: "f1" }, now)) === null);

  console.log("Reserve, charge, release...");
  const hold = await reserveCredits(PRO, { want: 25, idempotencyKey: "run-a" }, now);
  check("a reservation takes what was asked", hold?.amount === 25);
  check("reserved credits are no longer available", (await getCreditBalance(PRO, now)).total === 225);
  const replay = await reserveCredits(PRO, { want: 25, idempotencyKey: "run-a" }, now);
  check("replaying the key returns the same hold, not a second one", replay?.holdId === hold?.holdId);
  check("…and does not double-reserve", (await getCreditBalance(PRO, now)).total === 225);

  const a1 = await attemptFor(PRO, hold!.holdId);
  const a2 = await attemptFor(PRO, hold!.holdId);
  check("a held attempt charges", await chargeAttempt(PRO, a1, now));
  check("the same attempt never charges twice", !(await chargeAttempt(PRO, a1, now)));
  check("a second attempt charges", await chargeAttempt(PRO, a2, now));
  const released = await releaseHold(PRO, hold!.holdId, now);
  check("release returns the unused remainder", released === 23, String(released));
  check("releasing twice is a no-op", (await releaseHold(PRO, hold!.holdId, now)) === 0);
  const afterRun = await getCreditBalance(PRO, now);
  check("net effect is exactly the two charges", afterRun.total === 248 && afterRun.held === 0, JSON.stringify(afterRun));
  const kinds = (await listCreditLedger(PRO)).map((r) => r.entryType).sort().join(",");
  check("the ledger records grant, reserve, two charges, release", kinds === "charge,charge,grant,release,reserve", kinds);

  console.log("Split reservations...");
  await db.update(schema.researchCreditAccounts).set({ monthlyUsed: 247 }).where(eq(schema.researchCreditAccounts.userId, BOTH));
  const split = await reserveCredits(BOTH, { want: 5, idempotencyKey: "split" }, now);
  const [splitHold] = await db.select().from(schema.researchCreditHolds).where(eq(schema.researchCreditHolds.id, split!.holdId));
  check("monthly is spent first, lifetime covers the rest", splitHold.amountMonthly === 3 && splitHold.amountLifetime === 2, JSON.stringify(splitHold));
  for (let i = 0; i < 4; i++) await chargeAttempt(BOTH, await attemptFor(BOTH, split!.holdId), now);
  const [splitAfter] = await db.select().from(schema.researchCreditHolds).where(eq(schema.researchCreditHolds.id, split!.holdId));
  check("charges drain monthly before lifetime", splitAfter.usedMonthly === 3 && splitAfter.usedLifetime === 1);
  await releaseHold(BOTH, split!.holdId, now);
  const bothAfter = await getCreditBalance(BOTH, now);
  check("lifetime lost exactly one", bothAfter.lifetimeAvailable === 99 && bothAfter.monthlyAvailable === 0, JSON.stringify(bothAfter));

  console.log("Minimums and exhaustion...");
  const big = await reserveCredits(PRO, { want: 1000, idempotencyKey: "big" }, now);
  check("a large ask takes what is left", big?.amount === 248);
  check("nothing left means no hold", (await reserveCredits(PRO, { want: 5, idempotencyKey: "none" }, now)) === null);
  await releaseHold(PRO, big!.holdId, now);
  check("an ask above the minimum is refused when short",
    (await reserveCredits(PRO, { want: 300, min: 300, idempotencyKey: "min" }, now)) === null);

  console.log("Rollover...");
  const inFlight = await reserveCredits(PRO, { want: 10, idempotencyKey: "straddle" }, now);
  const later = new Date("2026-11-20T12:00:00Z");
  const rolled = await ensureCreditAccount(PRO, later);
  check("the period advances by whole months from its anchor",
    rolled.periodStart.toISOString() === addMonthsUtc(now, 2).toISOString(), rolled.periodStart.toISOString());
  check("used resets on rollover", rolled.monthlyUsed === 0);
  check("an in-flight hold carries over", rolled.monthlyHeld === 10);
  await releaseHold(PRO, inFlight!.holdId, later);
  check("after release the new period is whole", (await getCreditBalance(PRO, later)).monthlyAvailable === 250);

  const ledgerRows = await db
    .select()
    .from(schema.researchCreditLedger)
    .where(and(eq(schema.researchCreditLedger.userId, PRO), eq(schema.researchCreditLedger.entryType, "grant")));
  check("each period's grant is recorded once", ledgerRows.length === 2, String(ledgerRows.length));

  console.log("All outreach credit checks passed.");
}

run(main);
