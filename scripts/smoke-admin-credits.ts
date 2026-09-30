/**
 * The Money section's pricing-v2 figures, on PGlite:
 *
 *  - Live MRR counts Max as well as Pro, at the value the webhook stored (founding discount
 *    included) — so it agrees with the ledger for every price, not only the legacy $5.
 *  - Comps are priced at their own plan's list price; a comped Lifetime is counted, not priced.
 *  - Pack liability is what buyers paid for the unused share; the part held by accounts no
 *    longer on Pro or Max is reported as frozen. Pack sales reconcile against pack grants.
 *  - Allowance use and included-AI cost come from the grants and Orbit-key usage only.
 *  - Paying Pro/Max split into founding and standard.
 *  - The included-AI switch writes the setting and an audit row, and the gate sees it at once.
 *
 * Global sums over a shared database, so every figure is checked as a DELTA from a reading
 * taken before this smoke seeds anything.
 *
 * Run: npx tsx scripts/smoke-admin-credits.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail === undefined ? "" : `\n       ${JSON.stringify(detail)}`}`);
  }
}

const P = "smoke-ac-";
const PRO = `${P}pro`;
const MAX_FOUNDING = `${P}max-founding`;
const COMP_MAX = `${P}comp-max`;
const COMP_LIFE = `${P}comp-life`;
const LAPSED = `${P}lapsed`;
const ADMIN = `${P}admin`;

run(async () => {
  const { eq, inArray, like } = await import("drizzle-orm");
  const { getDb } = await import("../src/db");
  const schema = await import("../src/db/schema");
  const { currentMrrCents } = await import("../src/lib/billing-events");
  const { compedForegoneCents } = await import("../src/lib/money-metrics");
  const { loadCreditsMoney, planDistribution, managedAiCostMicros } = await import("../src/lib/credits/admin-credits");
  const { getManagedAiSwitchState, setManagedAiPaused } = await import("../src/lib/managed-ai-switch");
  const { managedAiPaused } = await import("../src/lib/ai-access");

  const db = await getDb();
  const users = [PRO, MAX_FOUNDING, COMP_MAX, COMP_LIFE, LAPSED];
  const [siteBefore] = await db.select().from(schema.siteSettings).where(eq(schema.siteSettings.id, 1));
  const reset = async () => {
    await db.delete(schema.creditGrants).where(inArray(schema.creditGrants.userId, users));
    await db.delete(schema.usageEvents).where(inArray(schema.usageEvents.userId, users));
    await db.delete(schema.billingEvents).where(like(schema.billingEvents.eventId, `${P}%`));
    await db.delete(schema.adminAuditLog).where(eq(schema.adminAuditLog.adminUserId, ADMIN));
    await db.delete(schema.userSettings).where(inArray(schema.userSettings.userId, users));
  };
  await reset();

  const now = new Date();
  const periodEnd = new Date(now.getTime() + 20 * 86_400_000);
  const empty = new Set<string>();
  const mrr0 = await currentMrrCents(now);
  const comps0 = await compedForegoneCents();
  const money0 = await loadCreditsMoney(empty, 30, now);
  const cost0 = await managedAiCostMicros(30, now);

  await db.insert(schema.userSettings).values([
    { userId: PRO, subscriptionPlan: "orbit", subscriptionStatus: "active", subscriptionPeriodEnd: periodEnd, subscriptionMonthlyCents: 899 },
    {
      userId: MAX_FOUNDING, subscriptionPlan: "max", subscriptionStatus: "active", subscriptionPeriodEnd: periodEnd,
      subscriptionMonthlyCents: 1599, foundingWindowEndsAt: new Date(now.getTime() + 60 * 86_400_000),
    },
    { userId: COMP_MAX, compedPlan: "max" },
    { userId: COMP_LIFE, compedPlan: "lifetime" },
    { userId: LAPSED },
  ]);

  console.log("Recurring revenue");
  check("live MRR adds Pro at $8.99 and founding Max at $15.99", (await currentMrrCents(now)) - mrr0 === 899 + 1599,
    (await currentMrrCents(now)) - mrr0);
  const comps = await compedForegoneCents();
  check("a comped Max is priced at Max's list price; a comped Lifetime is counted, not priced",
    comps.comped - comps0.comped === 2 && comps.foregoneMonthlyCents - comps0.foregoneMonthlyCents === 1999, comps);

  console.log("\nPacks, allowance and included AI");
  const pack = (userId: string, key: string, remainingCredits: number, status: "active" | "revoked" = "active") => ({
    userId, kind: "pack" as const, grantKey: `${P}${key}`, microsGranted: 250 * 10_000,
    microsRemaining: remainingCredits * 10_000, amountCents: 500, stripeRef: `cs_${key}`, status,
  });
  await db.insert(schema.creditGrants).values([
    pack(PRO, "pack-half", 125),
    pack(LAPSED, "pack-frozen", 250),
    pack(PRO, "pack-refunded", 0, "revoked"),
    {
      userId: PRO, kind: "allowance", grantKey: `${P}allowance`, plan: "orbit", microsGranted: 200 * 10_000,
      microsRemaining: 150 * 10_000, periodStart: new Date(now.getTime() - 10 * 86_400_000), periodEnd,
    },
  ]);
  const booked = (id: string) => ({
    source: "stripe" as const, eventId: `${P}${id}`, kind: "credit_pack" as const, userId: PRO, amountCents: 500,
    mrrDeltaCents: 0, effectiveAt: new Date(now.getTime() - 86_400_000),
  });
  await db.insert(schema.billingEvents).values([booked("a"), booked("b"), booked("c")]);
  const usage = (keyOwner: "orbit" | "user", micros: number) => ({
    userId: PRO, operation: "capture.parse", provider: "gemini" as const, model: "gemini-flash", kind: "completion" as const,
    estimatedCostMicros: micros, keyOwner,
  });
  await db.insert(schema.usageEvents).values([usage("orbit", 300_000), usage("orbit", 200_000), usage("user", 9_000_000)]);

  const money = await loadCreditsMoney(new Set([PRO, MAX_FOUNDING]), 30, now);
  check("three packs sold in the window, $15 of one-time cash",
    money.packs.soldInWindow - money0.packs.soldInWindow === 3 && money.packs.cashInWindowCents - money0.packs.cashInWindowCents === 1500, money.packs);
  check("liability: half a live pack ($2.50) plus a whole frozen one ($5); the refunded pack owes nothing",
    money.liability.cents - money0.liability.cents === 750 && money.liability.unusedCredits - money0.liability.unusedCredits === 375, money.liability);
  check("…and the $5 held by an account no longer on Pro or Max is frozen",
    money.liability.frozenCents - (await loadCreditsMoney(new Set([PRO, MAX_FOUNDING, LAPSED]), 30, now)).liability.frozenCents === 500);
  check("allowance: 50 of 200 credits used this cycle",
    money.allowance.grantedCredits - money0.allowance.grantedCredits === 200 && money.allowance.usedCredits - money0.allowance.usedCredits === 50, money.allowance);
  check("included-AI cost counts Orbit's keys only ($0.50), never the user's own",
    money.managedAi.costMicros - money0.managedAi.costMicros === 500_000 && (await managedAiCostMicros(30, now)) - cost0 === 500_000);
  check("the top spender list names the account", money.managedAi.topSpenders.some((r) => r.userId === PRO && r.micros === 500_000));
  check("three packs booked, three granted: reconciled",
    money.reconciliation.packsBooked - money0.reconciliation.packsBooked === 3 && money.reconciliation.packGrants - money0.reconciliation.packGrants === 3);
  await db.insert(schema.billingEvents).values(booked("d"));
  const drift = await loadCreditsMoney(empty, 30, now);
  check("a pack booked with no grant shows as a mismatch", drift.reconciliation.packsBooked - drift.reconciliation.packGrants ===
    money0.reconciliation.packsBooked - money0.reconciliation.packGrants + 1 && !drift.reconciliation.ok);

  console.log("\nPlan distribution");
  const dist = await planDistribution([
    { userId: PRO, plan: "orbit", planSource: "subscription" },
    { userId: MAX_FOUNDING, plan: "max", planSource: "subscription" },
    { userId: COMP_MAX, plan: "max", planSource: "comp" },
    { userId: COMP_LIFE, plan: "lifetime", planSource: "comp" },
    { userId: LAPSED, plan: "free", planSource: "none" },
  ], now);
  check("Pro standard; Max one founding and one comp (never founding); Lifetime; Free",
    dist.orbit.standard === 1 && dist.orbit.founding === 0 && dist.max.founding === 1 && dist.max.standard === 1 &&
      dist.lifetime.standard === 1 && dist.free === 1, dist);

  console.log("\nThe included-AI switch");
  const on = await setManagedAiPaused(ADMIN, false, "legal text is live");
  check("turning it on is stored and explicit", !on.paused && on.explicit, on);
  check("…and this instance's gate sees it at once", (await managedAiPaused()) === false);
  const off = await setManagedAiPaused(ADMIN, true);
  check("pausing is stored", off.paused && (await getManagedAiSwitchState()).paused && (await managedAiPaused()) === true);
  const audit = await db.select().from(schema.adminAuditLog).where(eq(schema.adminAuditLog.adminUserId, ADMIN));
  check("both flips are audited, with the reason", audit.length === 2 &&
    audit.some((a) => a.action === "site.managed_ai.resume" && a.reason === "legal text is live") &&
    audit.some((a) => a.action === "site.managed_ai.pause"), audit.map((a) => [a.action, a.reason]));

  // Leave the switch as this smoke found it.
  await db.update(schema.siteSettings).set({ managedAiPaused: siteBefore?.managedAiPaused ?? null }).where(eq(schema.siteSettings.id, 1));
  const { forgetManagedAiPause } = await import("../src/lib/ai-access");
  forgetManagedAiPause();

  await reset();
  if (failures > 0) throw new Error(`${failures} admin-credits check(s) failed`);
  console.log("\nAll admin-credits checks passed.");
});
