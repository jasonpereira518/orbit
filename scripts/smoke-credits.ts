/**
 * The credit ledger's own rules, on PGlite:
 *
 *  - The allowance resets at each renewal and never rolls over; a comp resets monthly.
 *  - Pro → Max mid-cycle raises the cycle to Max's allowance, keeping what was used; a
 *    downgrade never lowers the cycle it happens in.
 *  - The 80% / 100% notices, and "now on pack credits".
 *  - Plain-language equivalents come from measured cost, and are hidden without enough data.
 *
 * (Holds, the hard stop, packs-after-allowance, own-key calls and freeze/restore are driven
 * through the real gate in smoke-ai-access; pack grants and refunds in smoke-pricing-v2-billing.)
 *
 * Run: npx tsx scripts/smoke-credits.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

const USER = "smoke-credits-user";
const DAY = 86_400_000;

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail === undefined ? "" : `\n       ${JSON.stringify(detail)}`}`);
  }
}

run(async () => {
  const { eq } = await import("drizzle-orm");
  const { getDb } = await import("../src/db");
  const { creditGrants, usageEvents } = await import("../src/db/schema");
  const ledger = await import("../src/lib/credits/ledger");
  const { evaluateAccountHealth, toAccountAlerts, isDismissible } = await import("../src/lib/account-alerts");
  const { equivalentsFor, measuredActionCosts, MIN_SAMPLES } = await import("../src/lib/credits/equivalents");

  const db = await getDb();
  const reset = async () => {
    await db.delete(creditGrants).where(eq(creditGrants.userId, USER));
    await db.delete(usageEvents).where(eq(usageEvents.userId, USER));
  };
  await reset();

  console.log("The allowance period");
  const now = new Date("2026-10-15T12:00:00Z");
  const sub = { subscriptionPeriodStart: new Date("2026-10-03T09:00:00Z"), subscriptionPeriodEnd: new Date("2026-11-03T09:00:00Z") };
  const p1 = ledger.creditPeriodFor(sub, now);
  check("a subscriber's allowance runs on their billing period", p1.start.getTime() === sub.subscriptionPeriodStart.getTime() && p1.end.getTime() === sub.subscriptionPeriodEnd.getTime());
  const comp = ledger.creditPeriodFor({ compedPlan: "orbit" }, now);
  check("a comp (no billing cycle) resets on the calendar month", comp.start.toISOString() === "2026-10-01T00:00:00.000Z" && comp.end.toISOString() === "2026-11-01T00:00:00.000Z");
  const noStart = ledger.creditPeriodFor({ subscriptionPeriodEnd: sub.subscriptionPeriodEnd }, now);
  check("a period end with no recorded start reads as the month before it", noStart.start.toISOString() === "2026-10-03T09:00:00.000Z");
  const annual = { subscriptionPeriodStart: new Date("2026-03-31T09:00:00Z"), subscriptionPeriodEnd: new Date("2027-03-31T09:00:00Z") };
  const slice = ledger.creditPeriodFor(annual, now);
  check("an ANNUAL plan still gets a monthly allowance, on its own anniversaries",
    slice.start.toISOString() === "2026-09-30T09:00:00.000Z" && slice.end.toISOString() === "2026-10-31T09:00:00.000Z",
    [slice.start.toISOString(), slice.end.toISOString()]);
  const feb = ledger.creditPeriodFor(annual, new Date("2027-02-15T00:00:00Z"));
  check("…clamped to short months the way Stripe bills (the 31st renews on Feb 28)",
    feb.start.toISOString() === "2027-01-31T09:00:00.000Z" && feb.end.toISOString() === "2027-02-28T09:00:00.000Z",
    [feb.start.toISOString(), feb.end.toISOString()]);
  const annualNoStart = ledger.creditPeriodFor({ subscriptionPeriodEnd: annual.subscriptionPeriodEnd }, now);
  check("…and without a recorded start it still slices by month, never a year-long allowance",
    annualNoStart.end.getTime() - annualNoStart.start.getTime() < 32 * DAY && annualNoStart.start <= now && now < annualNoStart.end);

  console.log("\nReset at renewal, no rollover");
  const cycle1 = { start: new Date(Date.now() - 20 * DAY), end: new Date(Date.now() + 10 * DAY) };
  await ledger.ensureAllowance(USER, "orbit", cycle1);
  await ledger.ensureAllowance(USER, "orbit", cycle1);
  let grants = await db.select().from(creditGrants).where(eq(creditGrants.userId, USER));
  check("one grant per cycle, however often it is ensured", grants.length === 1 && grants[0].microsGranted === 200 * 10_000, grants.length);
  await db.update(creditGrants).set({ microsRemaining: 150 * 10_000 }).where(eq(creditGrants.userId, USER));
  let bal = await ledger.getCreditBalance(USER, "orbit", { subscriptionPeriodStart: cycle1.start, subscriptionPeriodEnd: cycle1.end });
  check("the balance reads the cycle's remaining allowance", bal.allowance?.remaining === 150 * 10_000 && bal.spendable === 150 * 10_000, bal);

  // Renewal: the mirror moves to the next period.
  const cycle2 = { start: cycle1.end, end: new Date(cycle1.end.getTime() + 30 * DAY) };
  const renewedAt = new Date(cycle1.end.getTime() + DAY);
  bal = await ledger.getCreditBalance(USER, "orbit", { subscriptionPeriodStart: cycle2.start, subscriptionPeriodEnd: cycle2.end }, renewedAt);
  check("the new cycle starts from a full 200", bal.allowance?.granted === 200 * 10_000 && bal.allowance.remaining === 200 * 10_000, bal.allowance);
  check("…and last cycle's 150 unused credits do not roll over", bal.spendable === 200 * 10_000, bal.spendable);

  console.log("\nThe real billing period adopts the provisional grant");
  await reset();
  // Verify-on-return mirrored the plan before Stripe sent the period: calendar fallback.
  const provisional = ledger.creditPeriodFor({ subscriptionPeriodEnd: null }, new Date());
  await ledger.ensureAllowance(USER, "orbit", provisional);
  await db.update(creditGrants).set({ microsRemaining: 170 * 10_000 }).where(eq(creditGrants.userId, USER));
  const real = { start: new Date(Date.now() - DAY), end: new Date(Date.now() + 29 * DAY) };
  await ledger.ensureAllowance(USER, "max", real);
  grants = await db.select().from(creditGrants).where(eq(creditGrants.userId, USER));
  check("still one allowance grant — never a second, overlapping one", grants.length === 1, grants.length);
  check("…moved onto the real billing period", grants[0].periodStart?.getTime() === real.start.getTime() && grants[0].periodEnd?.getTime() === real.end.getTime());
  check("…raised to Max's 500, with the 30 already used still used",
    grants[0].microsGranted === 500 * 10_000 && grants[0].microsRemaining === 470 * 10_000, grants[0]);
  bal = await ledger.getCreditBalance(USER, "max", { subscriptionPeriodStart: real.start, subscriptionPeriodEnd: real.end });
  check("…and the balance resets on the real renewal date", bal.allowance?.periodEnd === real.end.toISOString() && bal.spendable === 470 * 10_000, bal);

  console.log("\nPro → Max mid-cycle");
  await reset();
  await ledger.ensureAllowance(USER, "orbit", cycle1);
  await db.update(creditGrants).set({ microsRemaining: 50 * 10_000 }).where(eq(creditGrants.userId, USER));
  await ledger.ensureAllowance(USER, "max", cycle1);
  grants = await db.select().from(creditGrants).where(eq(creditGrants.userId, USER));
  check("the cycle rises to Max's 500, keeping the 150 already used",
    grants.length === 1 && grants[0].microsGranted === 500 * 10_000 && grants[0].microsRemaining === 350 * 10_000 && grants[0].plan === "max", grants[0]);
  await ledger.ensureAllowance(USER, "orbit", cycle1);
  grants = await db.select().from(creditGrants).where(eq(creditGrants.userId, USER));
  check("a switch back to Pro never lowers the cycle it happens in", grants[0].microsGranted === 500 * 10_000 && grants[0].microsRemaining === 350 * 10_000);
  await ledger.ensureAllowance(USER, "lifetime", cycle1);
  check("Lifetime gets no allowance", (await db.select().from(creditGrants).where(eq(creditGrants.userId, USER))).length === 1);

  console.log("\nFree: 10 a month plus 25 to start");
  await reset();
  const month = ledger.creditPeriodFor(null);
  await ledger.ensureAllowance(USER, "free", month);
  await ledger.ensureAllowance(USER, "free", month);
  grants = await db.select().from(creditGrants).where(eq(creditGrants.userId, USER));
  const freeAllowance = grants.filter((g) => g.kind === "allowance");
  const starter = grants.filter((g) => g.kind === "starter");
  check("Free gets one 10-credit allowance on the calendar month",
    freeAllowance.length === 1 && freeAllowance[0].microsGranted === 10 * 10_000 && freeAllowance[0].plan === "free" &&
      freeAllowance[0].periodStart?.getTime() === month.start.getTime(), freeAllowance);
  check("…and exactly one 25-credit starter grant, with no period",
    starter.length === 1 && starter[0].microsGranted === 25 * 10_000 && starter[0].grantKey === `starter:${USER}` &&
      starter[0].periodStart === null && starter[0].periodEnd === null, starter);
  let fbal = await ledger.getCreditBalance(USER, "free", null);
  check("the balance shows 35 spendable, 25 of them starter",
    fbal.spendable === 35 * 10_000 && fbal.starterRemaining === 25 * 10_000 && fbal.allowance?.granted === 10 * 10_000, fbal);

  await ledger.settleCredits({ userId: USER, operation: "x", micros: 12 * 10_000 });
  grants = await db.select().from(creditGrants).where(eq(creditGrants.userId, USER));
  check("spending takes the monthly allowance first, then starter",
    grants.find((g) => g.kind === "allowance")?.microsRemaining === 0 &&
      grants.find((g) => g.kind === "starter")?.microsRemaining === 23 * 10_000, grants.map((g) => [g.kind, g.microsRemaining]));
  await db.insert(creditGrants).values({ userId: USER, kind: "adjustment", grantKey: `adj:smoke:${USER}`, microsGranted: 5 * 10_000, microsRemaining: 5 * 10_000 });
  await ledger.settleCredits({ userId: USER, operation: "x", micros: 24 * 10_000 });
  grants = await db.select().from(creditGrants).where(eq(creditGrants.userId, USER));
  check("…then adjustments once the starter is gone",
    grants.find((g) => g.kind === "starter")?.microsRemaining === 0 &&
      grants.find((g) => g.kind === "adjustment")?.microsRemaining === 4 * 10_000, grants.map((g) => [g.kind, g.microsRemaining]));

  const nextMonth = { start: month.end, end: new Date(Date.UTC(month.end.getUTCFullYear(), month.end.getUTCMonth() + 1, 1)) };
  const inNext = new Date(month.end.getTime() + DAY);
  await ledger.ensureAllowance(USER, "free", nextMonth, inNext);
  grants = await db.select().from(creditGrants).where(eq(creditGrants.userId, USER));
  check("next month brings a fresh 10 and never a second starter",
    grants.filter((g) => g.kind === "starter").length === 1 &&
      grants.some((g) => g.kind === "allowance" && g.periodStart?.getTime() === nextMonth.start.getTime() && g.microsRemaining === 10 * 10_000));

  console.log("\nPaid plans never get a starter; a downgrade keeps one");
  await reset();
  await ledger.ensureAllowance(USER, "orbit", cycle1);
  check("Pro gets no starter", (await db.select().from(creditGrants).where(eq(creditGrants.userId, USER))).every((g) => g.kind !== "starter"));
  await reset();
  await ledger.ensureAllowance(USER, "free", ledger.creditPeriodFor(null));
  fbal = await ledger.getCreditBalance(USER, "orbit", null, new Date(), { ensure: false });
  check("an account that had a starter keeps spending it on another plan", fbal.starterRemaining === 25 * 10_000 && fbal.spendable >= 25 * 10_000, fbal);

  console.log("\nThe 80% and 100% notices");
  const health = (credits: Parameters<typeof evaluateAccountHealth>[0]["credits"]) =>
    evaluateAccountHealth({
      hasAiKey: true, aiProvider: "gemini", onboardingCompletedAt: new Date(), gmail: null, outlook: null,
      googleCalendar: null, microsoftCalendar: null, appleCalendar: null, calendarErrorCount: 0, calendarErrorLabel: null,
      calendarErrorDetail: null, importFailedCount: 0, importFailedLabel: null, importFailedDetail: null, importStalledCount: 0,
      importStalledLabel: null, importStalledRows: null, importStalledTotal: null, plan: "orbit", planSource: "subscription",
      subscriptionStatus: "active", subscriptionPeriodEnd: null, contactLimit: null, contactCount: null, credits,
    } as Parameters<typeof evaluateAccountHealth>[0]).map((f) => f.code);
  const c = (allowanceRemaining: number, packRemaining = 0) => ({
    allowanceGranted: 2_000_000, allowanceRemaining, packRemaining,
    spendable: allowanceRemaining + packRemaining, resetsAt: "2026-11-03T09:00:00.000Z",
  });
  check("under 80% used: quiet", health(c(1_000_000)).every((code) => !code.startsWith("plan.credits")));
  check("80% used: a heads-up", health(c(400_000)).includes("plan.credits_near"));
  check("100% used with packs: now on pack credits", health(c(0, 500_000)).includes("plan.credits_on_packs"));
  check("100% used, no packs: AI paused, as an error", health(c(0)).includes("plan.credits_out"));
  check("…the two heads-ups can be dismissed; the stop cannot",
    isDismissible("plan.credits_near") && isDismissible("plan.credits_on_packs") && !isDismissible("plan.credits_out"));
  const out = toAccountAlerts(evaluateAccountHealth({ ...({} as object), credits: c(0) } as never)).find((a) => a.code === "plan.credits_out");
  check("…and says nothing is charged automatically", /Nothing is charged automatically/.test(out?.body ?? ""), out?.body);
  check("no credits, no credit notices", health(null).every((code) => !code.startsWith("plan.credits")));

  console.log("\nEquivalents from measured cost");
  check("no measured cost, no equivalents", equivalentsFor(2_000_000, {}).length === 0);
  const eq1 = equivalentsFor(2_500_000, { capture: 8_600, chat: 2_500 });
  check("250 credits ≈ 290 captures and 1,000 chat answers at the eval's measured costs",
    eq1.find((e) => e.action === "capture")?.count === 290 && eq1.find((e) => e.action === "chat")?.count === 1000, eq1);
  const thin = await measuredActionCosts(Date.now() + 2 * 60 * 60 * 1000);
  check(`fewer than ${MIN_SAMPLES} measured actions → no figure is invented`, thin.capture === undefined, thin);
  for (let i = 0; i < MIN_SAMPLES; i++) {
    await db.insert(usageEvents).values([
      { userId: USER, operation: "capture.parse", provider: "gemini", model: "gemini-3.8-flash", kind: "completion", keyOwner: "orbit", estimatedCostMicros: 6_000, success: 1 },
      { userId: USER, operation: "capture.details", provider: "gemini", model: "gemini-3.8-flash", kind: "completion", keyOwner: "orbit", estimatedCostMicros: 2_000, success: 1 },
    ]);
  }
  const measured = await measuredActionCosts(Date.now() + 4 * 60 * 60 * 1000);
  check("with enough captures, a capture costs the sum of its calls per capture", measured.capture === 8_000, measured);

  await reset();
  if (failures > 0) throw new Error(`${failures} credit check(s) failed`);
  console.log("\nAll credit checks passed.");
});
