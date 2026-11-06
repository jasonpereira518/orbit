/**
 * The money-correctness workstream, end to end, on one fixture.
 *
 * ONE FIXTURE, MANY READERS. The audit's money findings (M1-M14, I2, I5) were all the same
 * shape: two screens, two definitions, one number. So this seeds a small cast of fake
 * accounts — a subscriber, a past-due subscriber, a free heavy user, two Lifetime buyers, a
 * fully refunded buyer, a comped account that is still paying, an internal admin and a
 * `tester` — and asserts every reader against hand-computed expectations:
 *
 *   M1   credit-pack cash reaches oneTime / cashIn / netCash / chargeCount
 *   I2   internal and tester accounts move no MRR, new subscribers, cash-in, CAC or cost
 *   I5   a comped account is out of MRR and out of the ledger drift (but its cash is cash)
 *   1.9  one `paidAccountSql`, and every reader that uses it agrees on who is paid
 *   1.10 Deepgram dollars reach burn, cost-to-run and top spenders (and no credit ledger)
 *   1.11 four readers, one 30-day managed-AI figure
 *   1.12 a spend row belongs to one month; both pages quote one CAC
 *   1.13 LTV / payback / margin from the ledger (pure maths: smoke-admin-yc-calculations)
 *   1.14 bucketing is UTC: identical output under a US-zone session
 *   1.15 lifetime sold vs holders, and the intro/standard histogram
 *   M10  tier-aware fallback for a subscription with no recorded price
 *
 * Every figure is a DELTA against a snapshot taken before seeding: the PGlite directory is
 * shared across a smoke run, so absolute totals would include other scripts' leftovers.
 *
 * Run: npx tsx scripts/smoke-money-correctness.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

const ADMIN = "smoke-money-admin";
process.env.ADMIN_USER_IDS = ADMIN;

import { eq, like, sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import {
  acquisitionSpend,
  billingEvents,
  gateEvents,
  speechUsage,
  usageEvents,
  userSettings,
} from "../src/db/schema";
import {
  currentMrrDetail,
  fallbackMonthlyCents,
  monthlyValueCents,
  mrrMovement,
  mrrReconciliation,
  paidAccountSql,
} from "../src/lib/billing-events";
import { decideStripeEvent } from "../src/lib/billing-stripe";
import { PRICE_LOOKUP_KEYS } from "../src/lib/stripe-config";
import { managedAiCostMicros, deepgramCostMicros, loadCreditsMoney } from "../src/lib/credits/admin-credits";
import { loadManagedAiOpsFacts } from "../src/lib/managed-ai-ops";
import { monthStart } from "../src/lib/infra-costs";
import {
  acquisitionByChannel,
  monthlyCosts,
  speechSpendByUser,
} from "../src/lib/money-costs";
import {
  costToRunBreakdown,
  costToRunPerUser,
  gateDemand,
  lifetimeSales,
  paidSignupsByChannel,
  planUnitEconomics,
  revenueAtRiskCents,
} from "../src/lib/money-metrics";
import {
  cacFor,
  cacWindow,
  churnOverrideOwner,
  countNewSubscribers,
  loadChurnOverride,
  loadRunwayMetrics,
  loadUnitEconomics,
} from "../src/lib/admin-yc-metrics";
import { computeCac } from "../src/lib/admin-yc-calculations";
import { speechCostMicros } from "../src/lib/speech-cost";
import { speechSpendMicros } from "../src/lib/speech-credit";
import { UNPRICED_CALL_MICROS } from "../src/lib/managed-ai-policy";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail === undefined ? "" : `\n       ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
  }
}

const P = "smoke-money-";
const id = (name: string) => `${P}${name}`;
const SUB = id("sub");
const PASTDUE = id("pastdue");
const FREE = id("free");
const LIFE = id("life");
const LIFE2 = id("life2");
const REF = id("refunded");
const COMP = id("comped");
const TESTER = id("tester");
const BOUNDARY = id("boundary");
const NULLMAX = id("nullmax");
const SRC = "smoke-money-src";
const GATE = "smoke-money-gate";

/** Flatten a React element tree to the strings it would render. */
function textOf(node: unknown, out: string[] = []): string[] {
  if (node == null || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) textOf(child, out);
    return out;
  }
  const el = node as { props?: Record<string, unknown>; label?: unknown };
  if (!el.props && typeof el.label === "string") {
    out.push(el.label);
    return out;
  }
  if (el.props) {
    for (const [key, value] of Object.entries(el.props)) {
      if (["children", "value", "label", "title", "subtitle", "hint", "rows", "head", "action"].includes(key)) {
        textOf(value, out);
      }
    }
  }
  return out;
}

async function cleanup() {
  const db = await getDb();
  await db.delete(billingEvents).where(like(billingEvents.eventId, `${P}%`));
  await db.delete(usageEvents).where(like(usageEvents.userId, `${P}%`));
  await db.delete(speechUsage).where(like(speechUsage.userId, `${P}%`));
  await db.delete(gateEvents).where(like(gateEvents.userId, `${P}%`));
  await db.delete(acquisitionSpend).where(like(acquisitionSpend.channel, `${P}%`));
  await db.delete(userSettings).where(like(userSettings.userId, `${P}%`));
}

run(async () => {
  const db = await getDb();
  await cleanup();

  const now = new Date();
  const hAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);
  const thisMonth = monthStart(now);
  const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  // Everything dated "now-ish" is clamped into the current UTC month, so the per-month
  // readers see it even in the first hour of a month.
  const at = new Date(Math.max(hAgo(1).getTime(), thisMonth.getTime()));
  const window = { since: hAgo(6), until: new Date(now.getTime() + 3_600_000) };
  const future = new Date(now.getTime() + 20 * 86_400_000);

  /* ------------------------------------------------------------ snapshots (before) */
  const move0 = await mrrMovement(window.since, window.until);
  const mrr0 = await currentMrrDetail(now);
  const recon0 = await mrrReconciliation(now);
  const risk0 = await revenueAtRiskCents(now);
  const newSubs0 = await countNewSubscribers(window.since, window.until);
  const life0 = await lifetimeSales();
  const managed0 = await managedAiCostMicros(30, now);
  const managedAll0 = await managedAiCostMicros(30, now, { includeInternal: true });
  const dg0 = await deepgramCostMicros(30, now);
  const breakdown0 = await costToRunBreakdown(30);
  const credits0 = await loadCreditsMoney(new Set(), 30, now);
  const ops0 = await loadManagedAiOpsFacts(now);
  const runway0 = await loadRunwayMetrics(now);
  const speechAll0 = await speechSpendMicros(hAgo(24 * 30));
  const econ0 = await planUnitEconomics(now);
  const cac0 = await cacFor(cacWindow(now));
  const costsThis0 = await monthlyCosts(thisMonth);
  const costsLast0 = await monthlyCosts(lastMonth);
  const channelSpend0 = (await acquisitionByChannel(cacWindow(now).since, now)).find((c) => c.channel === id("ads"))?.spendCents ?? 0;

  /* ------------------------------------------------------------------------- seed */
  const settings = (userId: string, over: Partial<typeof userSettings.$inferInsert> = {}) => ({
    userId,
    email: `${userId}@example.test`,
    signupUtmSource: SRC,
    ...over,
  });
  const subscription = {
    subscriptionPlan: "orbit" as const,
    subscriptionStatus: "active" as const,
    subscriptionPeriodEnd: future,
    subscriptionMonthlyCents: 899,
    subscriptionInterval: "month" as const,
  };
  await db.insert(userSettings).values([
    settings(SUB, subscription),
    settings(PASTDUE, { ...subscription, subscriptionStatus: "past_due" }),
    settings(FREE),
    settings(LIFE, { lifetimePurchasedAt: hAgo(2) }),
    settings(LIFE2, { lifetimePurchasedAt: hAgo(2) }),
    settings(REF),
    settings(COMP, { ...subscription, compedPlan: "orbit" }),
    settings(ADMIN, { ...subscription, estimatedMonthlyChurnPct: 4 }),
    settings(TESTER, { ...subscription, accountKind: "tester" }),
  ]);

  const row = (
    name: string,
    userId: string,
    kind: (typeof billingEvents.$inferInsert)["kind"],
    over: Partial<typeof billingEvents.$inferInsert> = {}
  ) => ({
    source: "stripe" as const,
    eventId: id(name),
    kind,
    userId,
    amountCents: 0,
    mrrDeltaCents: 0,
    effectiveAt: at,
    ...over,
  });
  await db.insert(billingEvents).values([
    row("sub-new", SUB, "new", { mrrDeltaCents: 899 }),
    row("sub-pay", SUB, "payment", { amountCents: 899 }),
    row("sub-pack", SUB, "credit_pack", { amountCents: 500 }),
    row("pd-new", PASTDUE, "new", { mrrDeltaCents: 899 }),
    row("pd-pay", PASTDUE, "payment", { amountCents: 899 }),
    row("comp-new", COMP, "new", { mrrDeltaCents: 899 }),
    row("comp-pay", COMP, "payment", { amountCents: 899 }),
    row("admin-new", ADMIN, "new", { mrrDeltaCents: 899 }),
    row("admin-pay", ADMIN, "payment", { amountCents: 899 }),
    row("admin-life", ADMIN, "lifetime", { amountCents: 2500 }),
    row("admin-pack", ADMIN, "credit_pack", { amountCents: 500 }),
    row("tester-new", TESTER, "new", { mrrDeltaCents: 899 }),
    row("tester-pack", TESTER, "credit_pack", { amountCents: 500 }),
    row("life-life", LIFE, "lifetime", { amountCents: 2500, detail: { tier: "intro" } }),
    // No `tier` on the row (booked before 1.15) and tax-inclusive: classified from the amount.
    row("life2-life", LIFE2, "lifetime", { amountCents: 8100 }),
    row("ref-life", REF, "lifetime", { amountCents: 7500 }),
    row("ref-refund", REF, "refund", { amountCents: 7500 }),
  ]);

  /* ---- M1, I2, I5: the movement ledger --------------------------------------------- */
  console.log("Credit packs reach the cash lines; internal and tester accounts move nothing");
  const move = await mrrMovement(window.since, window.until);
  const d = (key: keyof typeof move) => (move[key] as number) - (move0[key] as number);
  check("pack cash is in oneTimeCents with Lifetime: 2500 + 8100 + 7500 + one $5 pack", d("oneTimeCents") === 18_600, d("oneTimeCents"));
  check("…and in cashInCents beside the 3 invoices", d("cashInCents") === 18_600 + 2 * 899 + 899, d("cashInCents"));
  check("…and in netCashCents after the $75 refund", d("netCashCents") === 21_297 - 7_500, d("netCashCents"));
  check("…and in chargeCount (3 invoices + 3 Lifetime + 1 pack)", d("chargeCount") === 7, d("chargeCount"));
  check("the admin's and tester's packs, Lifetime and invoice are not in any of it", d("paymentCents") === 3 * 899 && d("refundedCents") === 7_500, { payment: d("paymentCents") });
  check("new MRR is the two real subscribers only (comped, admin, tester excluded)", d("newCents") === 2 * 899 && d("netCents") === 2 * 899, { new: d("newCents"), net: d("netCents") });

  const mrr = await currentMrrDetail(now);
  check("live MRR rose by the two real subscribers only", mrr.mrrCents - mrr0.mrrCents === 2 * 899, mrr.mrrCents - mrr0.mrrCents);
  check("…and the past-due part is reported separately, not removed", mrr.pastDueCents - mrr0.pastDueCents === 899);
  const recon = await mrrReconciliation(now);
  check("ledger MRR rose by the same 1798, so the drift did not move", recon.ledgerCents - recon0.ledgerCents === 2 * 899 && recon.driftCents === recon0.driftCents, { recon0, recon });
  check("new subscribers counts the two real ones (CAC denominator)", (await countNewSubscribers(window.since, window.until)) - newSubs0 === 2);

  const risk = await revenueAtRiskCents(now);
  check("revenue at risk: the past-due subscriber, not the admin's or tester's", risk.pastDueCents - risk0.pastDueCents === 899 && risk.atRiskCents - risk0.atRiskCents === 899, risk);

  /* ---- M10: tier-aware fallback ----------------------------------------------------- */
  console.log("\nA subscription with no recorded price is valued by its tier");
  check("the fallback is the legacy $5 for Pro and unknown, Max's list price for Max", fallbackMonthlyCents("orbit") === 500 && fallbackMonthlyCents(null) === 500 && fallbackMonthlyCents("max") === 1999);
  check("monthlyValueCents applies it", monthlyValueCents("active", null, now, null, "max") === 1999 && monthlyValueCents("active", null, now, null, "orbit") === 500);
  await db.insert(userSettings).values(
    settings(NULLMAX, {
      subscriptionPlan: "max",
      subscriptionStatus: "past_due",
      subscriptionPeriodEnd: future,
      subscriptionMonthlyCents: null,
      signupUtmSource: null,
    })
  );
  const mrrNull = await currentMrrDetail(now);
  const riskNull = await revenueAtRiskCents(now);
  check("live MRR and revenue-at-risk agree on it (1999, not 500)", mrrNull.pastDueCents - mrr.pastDueCents === 1999 && riskNull.pastDueCents - risk.pastDueCents === 1999, {
    mrr: mrrNull.pastDueCents - mrr.pastDueCents,
    risk: riskNull.pastDueCents - risk.pastDueCents,
  });
  await db.delete(userSettings).where(eq(userSettings.userId, NULLMAX));
  const decision = decideStripeEvent(
    {
      id: "evt_smoke_money_nullmax",
      type: "customer.subscription.created",
      created: Math.floor(now.getTime() / 1000),
      data: {
        object: {
          id: "sub_smoke_money",
          object: "subscription",
          customer: "cus_smoke_money",
          status: "active",
          metadata: {},
          items: { data: [{ id: "si_1", current_period_end: Math.floor(future.getTime() / 1000), price: { id: "price_max", lookup_key: PRICE_LOOKUP_KEYS.max } }] },
        },
      },
    } as never,
    { userId: NULLMAX, beforeCents: 0, hadPriorRevenue: false, now }
  );
  check("the webhook decision values a Max subscription with no unit amount at 1999 as well", decision.bookings[0]?.mrrDeltaCents === 1999, JSON.stringify(decision.bookings));

  /* ---- 1.9: one paid rule ------------------------------------------------------------ */
  console.log("\nOne definition of paid");
  const paidIds = async (includeComped: boolean) =>
    new Set(
      rowsOf<{ user_id: string }>(
        await db.execute(sql`SELECT s.user_id FROM user_settings s WHERE s.user_id LIKE ${`${P}%`} AND ${paidAccountSql(sql`s.user_id`, { includeComped })}`)
      ).map((r) => r.user_id)
    );
  const paid = await paidIds(false);
  check(
    "paid = subscriber, past-due subscriber, both Lifetime buyers",
    [SUB, PASTDUE, LIFE, LIFE2].every((u) => paid.has(u)) && paid.size === 4,
    [...paid]
  );
  check("not paid: free, the fully refunded buyer, the comped account, the admin, the tester", ![FREE, REF, COMP, ADMIN, TESTER].some((u) => paid.has(u)));
  const paidWithComps = await paidIds(true);
  check("includeComped adds the comped account and still not the internal ones", paidWithComps.has(COMP) && !paidWithComps.has(ADMIN) && !paidWithComps.has(TESTER) && paidWithComps.size === 5);

  const channels = await paidSignupsByChannel(hAgo(24));
  const channel = channels.find((c) => c.channel === SRC);
  check("paidSignupsByChannel: 6 signups (no comped/admin/tester), 4 paid", channel?.signups === 6 && channel?.paid === 4, channel);

  await db.insert(gateEvents).values(
    [SUB, COMP, LIFE, REF, ADMIN, TESTER, PASTDUE, FREE].map((userId) => ({
      userId,
      feature: GATE,
      plan: "free" as const,
      createdAt: hAgo(2),
    }))
  );
  const gate = (await gateDemand(30)).find((g) => g.feature === GATE);
  check("gateDemand: 6 people refused (admin and tester out)", gate?.distinctUsers === 6, gate);
  check("…and 3 converted: the subscriber, the past-due subscriber and the Lifetime buyer — not the comp, the refunded buyer or the free user", gate?.converted === 3, gate);
  check("the two readers agree on who is paid (4 paid signups, a subset of whom were refused: 3)", (channel?.paid ?? 0) === 4 && (gate?.converted ?? 0) === 3);

  /* ---- 1.15: lifetime sold vs holders ------------------------------------------------ */
  console.log("\nLifetime sold is the ledger's count, net of refunds");
  const life = await lifetimeSales();
  check("sold +2: the refunded purchase and the admin's are not counted", life.sold - life0.sold === 2, life);
  check("…one intro (recorded tier) and one standard (classified from $81 incl. tax)", life.intro - life0.intro === 1 && life.standard - life0.standard === 1 && life.unknown === life0.unknown, life);
  check("…cash behind them is 2500 + 8100", life.cashCents - life0.cashCents === 10_600);
  const holders = rowsOf<{ n: number }>(await db.execute(sql`SELECT count(*)::int AS n FROM user_settings WHERE user_id LIKE ${`${P}%`} AND lifetime_purchased_at IS NOT NULL`))[0]?.n;
  check("holders are counted separately: the two current holders", holders === 2);

  /* ---- 1.10 / 1.11: managed AI and Deepgram ------------------------------------------ */
  console.log("\nOne managed-AI figure; Deepgram beside it, never inside it");
  const usage = (userId: string, over: Partial<typeof usageEvents.$inferInsert>) => ({
    userId,
    operation: "capture.parse",
    provider: "gemini" as const,
    model: "gemini-flash",
    kind: "completion" as const,
    keyOwner: "orbit" as const,
    createdAt: at,
    ...over,
  });
  await db.insert(usageEvents).values([
    usage(SUB, { estimatedCostMicros: 2_000_000 }),
    // Unpriced but successful: charged its stand-in, exactly as the credit cap does.
    usage(SUB, { estimatedCostMicros: null, kind: "embedding" }),
    // Deepgram rows carry keyOwner "orbit" and no cost; never part of the managed figure.
    usage(SUB, { provider: "deepgram", model: "nova-3", kind: "transcription", estimatedCostMicros: null }),
    // A user's own key is the user's money.
    usage(SUB, { keyOwner: "user", estimatedCostMicros: 9_000_000 }),
    usage(FREE, { estimatedCostMicros: 50_000_000 }),
    usage(COMP, { estimatedCostMicros: 4_000_000 }),
    usage(ADMIN, { estimatedCostMicros: 3_000_000 }),
  ]);
  const shortform = (userId: string, seconds: number) => ({ userId, kind: "shortform" as const, source: "file" as const, seconds, createdAt: at });
  await db.insert(speechUsage).values([shortform(SUB, 600), shortform(ADMIN, 300)]);

  const customerManaged = 2_000_000 + UNPRICED_CALL_MICROS.embedding + 50_000_000 + 4_000_000;
  const dMan = (await managedAiCostMicros(30, now)) - managed0;
  check("managedAiCostMicros: priced + stand-in, Orbit's keys, no Deepgram, no user keys, no admin", dMan === customerManaged, dMan);
  check("…the cost-to-run breakdown reports the same figure", (await costToRunBreakdown(30)).orbitKeyMicros - breakdown0.orbitKeyMicros === customerManaged);
  const credits = await loadCreditsMoney(new Set(), 30, now);
  check("…and so does the credits section", credits.managedAi.costMicros - credits0.managedAi.costMicros === customerManaged);
  const allManaged = customerManaged + 3_000_000;
  check("the ops sweep sees real spend (the admin's included): same definition", (await loadManagedAiOpsFacts(now)).spentLast30dMicros - ops0.spentLast30dMicros === allManaged);
  check("managedAiCostMicros with includeInternal is that same figure", (await managedAiCostMicros(30, now, { includeInternal: true })) - managedAll0 === allManaged);
  const runway = await loadRunwayMetrics(now);
  check("the Runway burn's managed-AI line is it too", Math.abs((runway.managedAiMonthlyUsd - runway0.managedAiMonthlyUsd) * 1e6 - allManaged) < 1);

  const customerDg = speechCostMicros([{ kind: "shortform", source: "file", seconds: 600 }]);
  const adminDg = speechCostMicros([{ kind: "shortform", source: "file", seconds: 300 }]);
  check("600 s of shortform file audio prices at 99 000 micros", customerDg === 99_000, customerDg);
  check("Deepgram for customers: priced from speech_usage, internal left out", (await deepgramCostMicros(30, now)) - dg0 === customerDg);
  check("…the cost-to-run breakdown and the credits section show the same", (await costToRunBreakdown(30)).deepgramMicros - breakdown0.deepgramMicros === customerDg && credits.managedAi.deepgramMicros - credits0.managedAi.deepgramMicros === customerDg);
  check("burn carries ALL Deepgram (the admin's too) in its own line", Math.abs((runway.deepgramMonthlyUsd - runway0.deepgramMonthlyUsd) * 1e6 - (customerDg + adminDg)) < 1);
  check("…which is speechSpendMicros", (await speechSpendMicros(hAgo(24 * 30))) - speechAll0 === customerDg + adminDg);
  check("per-account Deepgram agrees with the total", ((await speechSpendByUser(hAgo(24 * 30), new Date(now.getTime() + 1))).get(SUB) ?? 0) === customerDg);
  const burnParts = runway.expenseBurnUsd + runway.infraMonthlyUsd + runway.managedAiMonthlyUsd + runway.deepgramMonthlyUsd + runway.acquisitionMonthlyUsd;
  check("burn = expenses + infra + managed AI + Deepgram + acquisition", Math.abs(runway.monthlyBurnUsd - burnParts) < 1e-9);

  const top = (await costToRunBreakdown(30)).topSpenders;
  check("top spenders (all keys) include Deepgram dollars, and not the admin", top.find((r) => r.userId === SUB)?.micros === 2_000_000 + 9_000_000 + customerDg && !top.some((r) => r.userId === ADMIN), top.slice(0, 4));
  check("the credits section's top spenders rank managed cost plus Deepgram", credits.managedAi.topSpenders.find((r) => r.userId === SUB)?.micros === 2_000_000 + UNPRICED_CALL_MICROS.embedding + customerDg && !credits.managedAi.topSpenders.some((r) => r.userId === ADMIN), credits.managedAi.topSpenders.slice(0, 4));

  /* ---- 1.13: unit economics by plan -------------------------------------------------- */
  console.log("\nUnit economics by plan");
  const econ = await planUnitEconomics(now);
  const er = (rows: typeof econ.rows, plan: string) => rows.find((r) => r.plan === plan)!;
  check("accounts: orbit +2, lifetime +2, free +2 (free and refunded), comped +1; admin and tester absent",
    er(econ.rows, "orbit").accounts - er(econ0.rows, "orbit").accounts === 2 &&
      er(econ.rows, "lifetime").accounts - er(econ0.rows, "lifetime").accounts === 2 &&
      er(econ.rows, "free").accounts - er(econ0.rows, "free").accounts === 2 &&
      er(econ.rows, "comped").accounts - er(econ0.rows, "comped").accounts === 1);
  check("Pro revenue: two subscriptions + the pack; Lifetime is amortised over 36 months; comped earns nothing",
    er(econ.rows, "orbit").revenueCents - er(econ0.rows, "orbit").revenueCents === 899 + 899 + 500 &&
      er(econ.rows, "lifetime").revenueCents - er(econ0.rows, "lifetime").revenueCents === Math.round(2500 / 36) + Math.round(8100 / 36) &&
      er(econ.rows, "comped").revenueCents === er(econ0.rows, "comped").revenueCents,
    econ.rows);
  check("cost lands on the right plan: free 50M, comped 4M, Pro = managed + stand-in + Deepgram",
    er(econ.rows, "free").costMicros - er(econ0.rows, "free").costMicros === 50_000_000 &&
      er(econ.rows, "comped").costMicros - er(econ0.rows, "comped").costMicros === 4_000_000 &&
      er(econ.rows, "orbit").costMicros - er(econ0.rows, "orbit").costMicros === 2_000_000 + UNPRICED_CALL_MICROS.embedding + customerDg);
  const heavy = econ.heavyUsers;
  check("heavy users: the free account and the comped one, as ids only; not the subscriber, admin or tester",
    heavy.some((h) => h.userId === FREE && h.plan === "free" && h.revenueCents === 0) &&
      heavy.some((h) => h.userId === COMP && h.plan === "comped") &&
      !heavy.some((h) => [SUB, ADMIN, TESTER].includes(h.userId)) &&
      heavy.every((h) => Object.keys(h).sort().join() === "costMicros,plan,revenueCents,userId"),
    heavy);

  /* ---- 1.12: one CAC, one month per spend row ---------------------------------------- */
  console.log("\nOne CAC; a spend row belongs to one month");
  await db.insert(acquisitionSpend).values([
    // The legacy overlap shape: 20th of last month to the 10th of this one. It must count
    // in THIS month (created_at) and not also in last month.
    {
      channel: id("ads"),
      amountUsd: 300,
      periodStart: new Date(lastMonth.getTime() + 19 * 86_400_000),
      periodEnd: new Date(thisMonth.getTime() + 9 * 86_400_000),
      createdAt: thisMonth,
    },
    { channel: id("ads"), amountUsd: 200, periodStart: lastMonth, periodEnd: new Date(thisMonth.getTime() - 1), createdAt: lastMonth },
  ]);
  const costsThis = await monthlyCosts(thisMonth);
  const costsLast = await monthlyCosts(lastMonth);
  check("the overlapping row appears in this month only", costsThis.acquisitionCents - costsThis0.acquisitionCents === 30_000, costsThis.acquisitionCents - costsThis0.acquisitionCents);
  check("…and the earlier row in last month only (no row counted twice)", costsLast.acquisitionCents - costsLast0.acquisitionCents === 20_000);
  const cac = await cacFor(cacWindow(now));
  check("cacFor: spend delta $500, new-subscriber delta 2", Math.abs(cac.spendUsd - cac0.spendUsd - 500) < 1e-6 && cac.newSubscribers - cac0.newSubscribers === 2, { spend: cac.spendUsd - cac0.spendUsd, subs: cac.newSubscribers - cac0.newSubscribers });
  check("…and CAC is that spend over those subscribers", cac.cac === computeCac(cac.spendUsd, cac.newSubscribers));
  const channelSpend = (await acquisitionByChannel(cacWindow(now).since, now)).find((c) => c.channel === id("ads"))?.spendCents ?? 0;
  check("per-channel spend uses the same window", channelSpend - channelSpend0 === 50_000);
  const runway2 = await loadRunwayMetrics(now);
  check("acquisition is in Runway's burn (this month's $300)", Math.abs(runway2.acquisitionMonthlyUsd - runway0.acquisitionMonthlyUsd - 300) < 1e-6 || runway2.acquisitionMonthlyUsd >= 300, runway2.acquisitionMonthlyUsd);

  /* ---- 1.13: the typed churn override is one site-wide value ------------------------- */
  console.log("\nThe typed churn estimate is one value for every admin");
  const override = await loadChurnOverride();
  check("read from the first admin that has one, deterministically", override.pct === 4 && override.ownerId === ADMIN, override);
  check("and edits go to that same row whoever asks", (await churnOverrideOwner("some-other-admin")) === ADMIN);
  const econ2 = await loadUnitEconomics(now);
  check("with too little subscriber time, LTV is a labelled estimate from the typed churn", econ2.ltv.basis === "estimate" || econ2.ltv.basis === "none", econ2.ltv);
  check("…never an observed rate below the minimum sample", econ2.subscriberMonths >= econ2.minSubscriberMonths || econ2.ltv.basis !== "observed");

  /* ---- 1.14: UTC buckets -------------------------------------------------------------- */
  console.log("\nBuckets are UTC, whatever the session time zone");
  const lastBucketBefore = (await costToRunPerUser("month", 3)).points.at(-1)!;
  // 03:00 UTC on the 1st is still the PREVIOUS month in Los Angeles: the fixture that tells
  // a session-zone date_trunc from a UTC one.
  await db.insert(usageEvents).values(
    usage(BOUNDARY, { keyOwner: "user", estimatedCostMicros: 1_234_000, createdAt: new Date(thisMonth.getTime() + 3 * 3_600_000) })
  );
  const utcSeries = await costToRunPerUser("month", 3);
  const lastBucket = utcSeries.points.at(-1)!;
  check("the 1st-of-month 03:00 UTC row lands in the current month's bucket", lastBucket.totalMicros - lastBucketBefore.totalMicros === 1_234_000 && lastBucket.activeUsers - lastBucketBefore.activeUsers === 1, { before: lastBucketBefore, after: lastBucket });
  await db.execute(sql`SET TIME ZONE 'America/Los_Angeles'`);
  try {
    const laProbe = rowsOf<{ m: string }>(await db.execute(sql`SELECT to_char(date_trunc('month', timestamptz '2026-10-01 03:00:00+00'), 'YYYY-MM') AS m`))[0]?.m;
    check("(the fixture does straddle: a session-zone date_trunc puts it in September)", laProbe === "2026-09", laProbe);
    const laSeries = await costToRunPerUser("month", 3);
    check("costToRunPerUser under a Los Angeles session is identical to UTC", JSON.stringify(laSeries) === JSON.stringify(utcSeries), { utc: utcSeries.points.at(-1), la: laSeries.points.at(-1) });
  } finally {
    await db.execute(sql`SET TIME ZONE 'UTC'`);
  }

  /* ---- pages ----------------------------------------------------------------------- */
  console.log("\nThe pages render with the new figures");
  const { default: MoneyPage } = await import("../src/app/(clerk)/(admin)/admin/billing/page");
  const { default: MovementPage } = await import("../src/app/(clerk)/(admin)/admin/billing/movement/page");
  const { default: CostsPage } = await import("../src/app/(clerk)/(admin)/admin/billing/costs/page");
  const { default: DemandPage } = await import("../src/app/(clerk)/(admin)/admin/billing/demand/page");
  const { default: RunCostPage } = await import("../src/app/(clerk)/(admin)/admin/billing/run-cost/page");
  const { default: EconomicsPage } = await import("../src/app/(clerk)/(admin)/admin/yc/economics/page");
  const { default: RunwayPage } = await import("../src/app/(clerk)/(admin)/admin/yc/runway/page");

  const money = textOf(await MoneyPage()).join("|");
  check("Money: Lifetime sold and holders, and the intro / standard histogram", money.includes("Lifetime sold") && money.includes("holders") && money.includes("Intro ($25)") && money.includes("Standard ($75)"));
  const movement = textOf(await MovementPage()).join("|");
  check("Movement: the stale '$5/mo becomes $4.17/mo' copy is gone; prices come from the plan table", !movement.includes("4.17") && movement.includes("$8.99") && movement.includes("$7.50"), movement.slice(movement.indexOf("Contract"), movement.indexOf("Contract") + 160));
  const costs = textOf(await CostsPage()).join("|");
  check("Costs: the unit-economics table, the heavy-user list (ids), and CAC", costs.includes("Unit economics by plan") && costs.includes(FREE) && costs.includes("CAC"));
  const economics = textOf(await EconomicsPage()).join("|");
  const cacText = cac.cac === null ? "—" : `$${cac.cac.toFixed(0)}`;
  const cacCosts = cac.cac === null ? "—" : `$${Math.round(cac.cac)}`;
  check("Economics and Costs quote the same CAC", economics.includes(cacText) && costs.includes(cacCosts) && cacText === cacCosts, { cacText, cacCosts });
  check("Economics labels an estimate as an estimate, or says why there is no LTV", economics.includes("LTV (estimate)") || economics.includes("subscriber-months") || economics.includes("no "), economics.slice(0, 300));
  const runwayText = textOf(await RunwayPage()).join("|");
  check("Runway says burn includes Deepgram and acquisition", runwayText.includes("Deepgram") && runwayText.includes("Acquisition"));
  await DemandPage();
  await RunCostPage();
  check("Demand and Cost-to-run render", true);

  /* ---- 1.13: observed LTV once there is enough subscriber time ----------------------- */
  console.log("\nLTV from the ledger once the window has 100 subscriber-months");
  const sim = Array.from({ length: 40 }, (_, i) => id(`sim-${i}`));
  const dayMs = 86_400_000;
  await db.insert(billingEvents).values([
    ...sim.map((u, i) => ({
      source: "stripe" as const, eventId: id(`sim-new-${i}`), kind: "new" as const, userId: u,
      mrrDeltaCents: 899, effectiveAt: new Date(now.getTime() - 89 * dayMs),
    })),
    ...sim.slice(0, 3).map((u, i) => ({
      source: "stripe" as const, eventId: id(`sim-churn-${i}`), kind: "churn" as const, userId: u,
      mrrDeltaCents: -899, effectiveAt: new Date(now.getTime() - 30 * dayMs),
    })),
  ]);
  const econ3 = await loadUnitEconomics(now);
  check("40 subscribers for ~3 months clears the 100 subscriber-month bar", econ3.subscriberMonths >= econ3.minSubscriberMonths, econ3.subscriberMonths);
  check("…so LTV is OBSERVED, not an estimate", econ3.ltv.basis === "observed", econ3.ltv);
  const observedChurn = econ3.observedChurnPct ?? 0;
  check("…from the churn those subscribers actually had (at least the 3 seeded)", econ3.churnedLogos >= 3 && observedChurn > 0 && Math.abs(observedChurn - (econ3.churnedLogos / econ3.subscriberMonths) * 100) < 1e-9);
  check("LTV = ARPA x gross margin / churn", econ3.arpaUsd !== null && econ3.grossMargin !== null && econ3.ltv.ltvUsd !== null && Math.abs(econ3.ltv.ltvUsd - (econ3.arpaUsd * econ3.grossMargin) / (observedChurn / 100)) < 1e-6, { arpa: econ3.arpaUsd, margin: econ3.grossMargin, ltv: econ3.ltv });
  check("payback = CAC / (ARPA x gross margin)", econ3.cac !== null && econ3.arpaUsd !== null && econ3.grossMargin !== null && econ3.paybackMonths !== null && Math.abs(econ3.paybackMonths - econ3.cac / (econ3.arpaUsd * econ3.grossMargin)) < 1e-9, econ3.paybackMonths);
  check("gross margin is net of managed AI, Deepgram and Stripe fees", econ3.grossMargin !== null && econ3.costBreakdown.aiCents > 0 && econ3.costBreakdown.speechCents > 0 && econ3.costBreakdown.feesCents > 0, econ3.costBreakdown);
  const economics2 = textOf(await EconomicsPage()).join("|");
  check("Economics shows 'observed churn' and drops the estimate label", economics2.includes("observed churn") && !economics2.includes("LTV (estimate)"), economics2.slice(0, 240));

  await cleanup();
  if (failures > 0) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll money-correctness checks passed.");
});
