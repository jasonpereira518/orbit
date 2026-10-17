/**
 * The credit ledger's pure helpers, with no database.
 *
 * `smoke-credits.ts` drives the ledger end to end on PGlite with a handful of hand-picked
 * dates. What it cannot do cheaply is sweep: the period arithmetic is calendar arithmetic, and
 * calendar arithmetic is wrong on particular days (month ends, leap years), not on average
 * ones. So `creditPeriodFor` is checked here as properties over two years of days:
 *
 *  - an annual subscriber's month slice always contains `now`, ends on one of the
 *    subscription's own monthly anniversaries, and is at most a month long;
 *  - a monthly subscriber with the period start on file gets exactly that period;
 *  - comped, Free and lapsed accounts get the UTC calendar month containing `now`.
 *
 * (What does not hold is any period whose START is not on file: a monthly one ending on the
 * 29th-31st, and an annual one in its last 31-35 days. Both are reproduced in
 * smoke-bug-credit-period-overflow.)
 *
 * Plus the small pure rules the balance and the notices rest on: which plans may spend packs,
 * credits <-> micros, the 80% / 100% notice thresholds and the "about N captures" equivalents.
 *
 * Pure: imports the ledger module but never calls anything that reaches the database.
 * Run: npx tsx scripts/smoke-credit-ledger-pure.ts
 */
import { creditPeriodFor, packsUsable } from "../src/lib/credits/ledger";
import { creditsToMicros, microsToCredits, MICROS_PER_CREDIT } from "../src/lib/credits/grants";
import { noticeLevelFor } from "../src/lib/credits/notices";
import { equivalentsFor } from "../src/lib/credits/equivalents";
import { PLAN_CONFIG, type Plan } from "../src/lib/plans/plan-config";
import { checker } from "./smoke/check";

const t = checker();
const DAY = 86_400_000;
const PLANS: Plan[] = ["free", "orbit", "max", "lifetime"];

console.log("\npacksUsable");
for (const plan of PLANS) {
  t.check(`${plan}: follows PLAN_CONFIG.features.creditPacks`, packsUsable(plan) === PLAN_CONFIG[plan].features.creditPacks);
}
t.check("Lifetime is the plan that freezes packs", packsUsable("lifetime") === false);
t.check("every subscription plan and Free can spend packs", packsUsable("free") && packsUsable("orbit") && packsUsable("max"));

console.log("\ncredits <-> micros");
t.check("1 credit is 10,000 micros", MICROS_PER_CREDIT === 10_000 && creditsToMicros(1) === 10_000);
t.check("a plan allowance converts exactly", creditsToMicros(300) === 3_000_000 && microsToCredits(3_000_000) === 300);
t.check("fractional credits round to whole micros", creditsToMicros(0.00004) === 0 && creditsToMicros(0.00005) === 1 && creditsToMicros(1.23456) === 12_346);
t.check("microsToCredits is fractional, not floored", microsToCredits(15_000) === 1.5);
t.check("round trip for every plan's allowance", PLANS.every((p) => microsToCredits(creditsToMicros(PLAN_CONFIG[p].monthlyCredits ?? 0)) === (PLAN_CONFIG[p].monthlyCredits ?? 0)));

console.log("\nnoticeLevelFor");
t.check("no allowance → never a notice", noticeLevelFor(0, 0) === 0 && noticeLevelFor(-1, -1) === 0);
t.check("79.99% used → nothing", noticeLevelFor(1_000_000, 200_001) === 0);
t.check("exactly 80% used → 80", noticeLevelFor(1_000_000, 200_000) === 80);
t.check("99.99% used → still 80", noticeLevelFor(1_000_000, 1) === 80);
t.check("all used → 100; overshoot (negative remaining) → 100", noticeLevelFor(1_000_000, 0) === 100 && noticeLevelFor(1_000_000, -50) === 100);
t.check("remaining above granted (a raise mid-cycle) → nothing", noticeLevelFor(1_000_000, 1_500_000) === 0);

console.log("\nequivalentsFor");
t.check("nothing measured → nothing", equivalentsFor(5_000_000, {}).length === 0);
t.check("a zero cost is skipped, not divided by", equivalentsFor(5_000_000, { capture: 0 }).length === 0);
const eq = equivalentsFor(1_000_000, { summary: 400_000, capture: 10_000, chat: 3_000 });
t.check("fixed order capture, chat, summary; floored counts", JSON.stringify(eq) === JSON.stringify([
  { action: "capture", count: 100 },
  { action: "chat", count: 333 },
  { action: "summary", count: 2 },
]), JSON.stringify(eq));
t.check("an action the balance cannot afford once is left out", equivalentsFor(300_000, { summary: 400_000, chat: 3_000 }).every((e) => e.action !== "summary"));
t.check("zero or negative balance → nothing", equivalentsFor(0, { chat: 1 }).length === 0 && equivalentsFor(-10, { chat: 1 }).length === 0);

console.log("\ncreditPeriodFor: calendar-month fallbacks");
const sample = new Date("2026-10-17T15:30:00Z");
const month = { start: "2026-10-01T00:00:00.000Z", end: "2026-11-01T00:00:00.000Z" };
const iso = (p: { start: Date; end: Date }) => ({ start: p.start.toISOString(), end: p.end.toISOString() });
const same = (a: object, b: object) => JSON.stringify(a) === JSON.stringify(b);
t.check("no row → UTC calendar month", same(iso(creditPeriodFor(null, sample)), month));
t.check("no period end (checkout before the first subscription event) → calendar month", same(iso(creditPeriodFor({ subscriptionPeriodEnd: null }, sample)), month));
t.check("lapsed (period end in the past) → calendar month", same(iso(creditPeriodFor({ subscriptionPeriodEnd: new Date("2026-10-01T00:00:00Z") }, sample)), month));
t.check(
  "comped → calendar month even with a live Stripe period on file",
  same(iso(creditPeriodFor({ compedPlan: "orbit", subscriptionPeriodStart: new Date("2026-10-05T00:00:00Z"), subscriptionPeriodEnd: new Date("2026-11-05T00:00:00Z") }, sample)), month)
);
t.check("Dec rolls into next year", same(iso(creditPeriodFor(null, new Date("2026-12-31T23:59:59Z"))), { start: "2026-12-01T00:00:00.000Z", end: "2027-01-01T00:00:00.000Z" }));

console.log("\ncreditPeriodFor: monthly period with the start on file (property)");
{
  let total = 0;
  const bad: string[] = [];
  for (let s = Date.UTC(2026, 0, 1, 9); s < Date.UTC(2028, 0, 1); s += DAY) {
    const start = new Date(s);
    const y = start.getUTCFullYear();
    const m = start.getUTCMonth() + 1;
    const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const end = new Date(Date.UTC(y, m, Math.min(start.getUTCDate(), lastDay), 9));
    for (const now of [start, new Date((s + end.getTime()) / 2), new Date(end.getTime() - 1)]) {
      total++;
      const p = creditPeriodFor({ subscriptionPeriodStart: start, subscriptionPeriodEnd: end }, now);
      if (p.start.getTime() !== s || p.end.getTime() !== end.getTime()) bad.push(`${start.toISOString().slice(0, 10)} @ ${now.toISOString()}`);
    }
  }
  t.check("the period is exactly Stripe's, for every start day", bad.length === 0, bad.length ? bad.slice(0, 3).join("; ") : `${total} cases`);
  // A start "in the future" is not trusted as the start (it would not contain now).
  const future = creditPeriodFor({ subscriptionPeriodStart: new Date("2026-10-20T00:00:00Z"), subscriptionPeriodEnd: new Date("2026-11-05T00:00:00Z") }, sample);
  t.check("a start after now is ignored, and the result still contains now", future.start <= sample && sample < future.end, JSON.stringify(iso(future)));
}

// Start on file only. Without it the annual branch is chosen by "more than 35 days to run",
// which the 31-35 days before renewal fail: see smoke-bug-credit-period-overflow.
console.log("\ncreditPeriodFor: annual subscribers get monthly slices (property)");
{
  let total = 0;
  const bad: string[] = [];
  for (const anchor of [1, 15, 28, 29, 30, 31]) {
    for (const startMonth of [0, 1, 7, 10]) {
      const start = new Date(Date.UTC(2026, startMonth, anchor, 9));
      if (start.getUTCDate() !== anchor) continue; // no Feb 30
      const end = new Date(Date.UTC(2027, startMonth, anchor, 9));
      for (let n = start.getTime(); n < end.getTime(); n += DAY / 2) {
        const now = new Date(n);
        total++;
        for (const row of [{ subscriptionPeriodStart: start, subscriptionPeriodEnd: end }]) {
          const p = creditPeriodFor(row, now);
          const length = p.end.getTime() - p.start.getTime();
          const anniversaryOk = p.end.getUTCDate() === anchor || p.end.getUTCDate() === new Date(Date.UTC(p.end.getUTCFullYear(), p.end.getUTCMonth() + 1, 0)).getUTCDate();
          if (!(p.start <= now && now < p.end) || length > 31 * DAY || length < 28 * DAY || !anniversaryOk || p.end > end) {
            bad.push(`anchor ${start.toISOString().slice(0, 10)} now ${now.toISOString().slice(0, 13)} → ${p.start.toISOString().slice(0, 10)}..${p.end.toISOString().slice(0, 10)}`);
          }
        }
      }
    }
  }
  t.check("every slice contains now, is 28-31 days, ends on an anniversary, inside the year", bad.length === 0, bad.length ? `${bad.length} bad, e.g. ${bad.slice(0, 3).join("; ")}` : `${total} instants`);
}

t.done("credit ledger pure helpers");
