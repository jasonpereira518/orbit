/**
 * KNOWN BUG — documented, not fixed.
 *
 * Symptom: when a subscriber's period START is not on file, `creditPeriodFor` can return a
 * cycle that begins in the FUTURE: up to three days for a monthly period ending on the 29th,
 * 30th or 31st, and up to four days for an annual period in its last 31-35 days. For those first days of the cycle the allowance grant exists but is not
 * spendable: the credits card shows no allowance and a managed AI call with no packs or
 * starter credits behind it is refused at the hard stop.
 *
 * Why: with no known start, `creditPeriodFor` (src/lib/credits/ledger.ts:95-112) derives one as
 * `minusOneMonth(end)` (:56), which builds `Date.UTC(y, m - 1, day)` without clamping. For an
 * end of Mar 31 that is "Feb 31", which JavaScript rolls to Mar 3 — after a `now` of Mar 1.
 * Stripe clamps the other way (the period really began Feb 28), and the module already has
 * `addMonthsClamped` (:62) for exactly this; the annual branch uses it, the monthly fallback
 * does not. Separately, with no start the annual/monthly choice is "more than 35 days left"
 * (:106), so an annual period 31-35 days from renewal takes the monthly fallback, whose start
 * (one month before the end) is after now even without any overflow. `ensureAllowance` then inserts the cycle's grant with `period_start` = Mar 3, and
 * every spend query requires `period_start <= now()` (`spendableSql`, :252).
 *
 * Trigger path: `getCreditBalance` / the AI gate for a row with `subscription_period_end` set
 * and `subscription_period_start` NULL — accounts mirrored before the start column existed,
 * or a Stripe payload without `current_period_start`. The next `customer.subscription.updated`
 * fills the start in, so exposure is at most a few days of one cycle per such account.
 *
 * Severity: low — allowance delayed (not lost) by up to ~4 days, for a narrow set of rows.
 *
 * Fix: clamp (`addMonthsClamped(end, -1)`) and, when that start is still after now, fall back
 * to the annual slice / calendar month. This script then exits 0 and should be promoted to
 * the pglite tier.
 *
 * Writes to local PGlite. Run: npx tsx scripts/smoke-bug-credit-period-overflow.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { getDb } from "../src/db";
import { creditPeriodFor, getCreditBalance } from "../src/lib/credits/ledger";
import { creditsToMicros } from "../src/lib/credits/grants";
import { PLAN_CONFIG } from "../src/lib/plans/plan-config";
import { checker } from "./smoke/check";
import { fakeUserId, purgeUsers } from "./smoke/factories";

const t = checker();
const DAY = 86_400_000;

/** Where Stripe starts a monthly period ending at `end`: one calendar month back, clamped. */
function stripeStart(end: Date): Date {
  const y = end.getUTCFullYear();
  const m = end.getUTCMonth() - 1;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(end.getUTCDate(), lastDay), end.getUTCHours(), end.getUTCMinutes()));
}

run(async () => {
  console.log("\nProperty: for every real monthly period, the derived cycle contains now...");
  let total = 0;
  const failures: string[] = [];
  const byDay = new Map<number, number>();
  for (let e = Date.UTC(2026, 0, 1, 9); e < Date.UTC(2028, 0, 1, 9); e += DAY) {
    const end = new Date(e);
    for (let n = stripeStart(end).getTime(); n < e; n += 6 * 3_600_000) {
      const now = new Date(n);
      const p = creditPeriodFor({ subscriptionPeriodEnd: end }, now);
      total++;
      if (!(p.start <= now && now < p.end && p.end.getTime() === end.getTime())) {
        failures.push(`end ${end.toISOString().slice(0, 10)}, now ${now.toISOString().slice(0, 13)}h → start ${p.start.toISOString().slice(0, 10)}`);
        byDay.set(end.getUTCDate(), (byDay.get(end.getUTCDate()) ?? 0) + 1);
      }
    }
  }
  t.check("the property ran over two years of periods", total > 50_000, `${total} (end, now) pairs`);
  t.check(
    "every failing pair is an end on the 29th-31st (nothing else is wrong)",
    [...byDay.keys()].every((d) => d >= 29),
    JSON.stringify(Object.fromEntries(byDay))
  );
  t.knownBug(
    "BUG: creditPeriodFor with no known start returns a period starting after now for ends on the 29th-31st",
    failures.length === 0,
    `${failures.length}/${total} pairs, e.g. ${failures.slice(0, 2).join("; ")}`
  );

  // The same fallback, reached from an ANNUAL period with no start on file: "more than 35
  // days to run" picks the annual branch, so the 31-35 days before renewal take the monthly
  // fallback, whose start is one calendar month before the end, i.e. after now.
  let annualTotal = 0;
  const annualFailures: string[] = [];
  for (const anchor of [1, 15, 28]) {
    for (const startMonth of [0, 4, 10]) {
      const start = new Date(Date.UTC(2026, startMonth, anchor, 9));
      const end = new Date(Date.UTC(2027, startMonth, anchor, 9));
      for (let n = start.getTime(); n < end.getTime(); n += DAY / 2) {
        const now = new Date(n);
        annualTotal++;
        const p = creditPeriodFor({ subscriptionPeriodEnd: end }, now);
        if (!(p.start <= now && now < p.end)) {
          annualFailures.push(`end ${end.toISOString().slice(0, 10)}, now ${now.toISOString().slice(0, 13)}h → ${p.start.toISOString().slice(0, 10)}`);
        }
      }
    }
  }
  t.knownBug(
    "BUG: creditPeriodFor with no known start returns a period starting after now in an annual plan's last 31-35 days",
    annualFailures.length === 0,
    `${annualFailures.length}/${annualTotal} instants, e.g. ${annualFailures.slice(0, 2).join("; ")}`
  );

  const withStart = creditPeriodFor({ subscriptionPeriodStart: new Date("2027-02-28T09:00:00Z"), subscriptionPeriodEnd: new Date("2027-03-31T09:00:00Z") }, new Date("2027-03-01T12:00:00Z"));
  t.check("with the start on file the same period is right", withStart.start.toISOString() === "2027-02-28T09:00:00.000Z");

  console.log("\nConsequence: the cycle's allowance is not spendable until the bogus start...");
  const db = await getDb();
  const NO_START = fakeUserId("credit-overflow-nostart");
  const WITH_START = fakeUserId("credit-overflow-start");
  await purgeUsers(db, [NO_START, WITH_START]);
  try {
    const end = new Date("2027-03-31T09:00:00Z");
    const now = new Date("2027-03-01T12:00:00Z"); // day two of the cycle that began Feb 28
    const allowance = creditsToMicros(PLAN_CONFIG.orbit.monthlyCredits ?? 0);
    t.check("setup: Pro has a monthly allowance", allowance > 0);

    const good = await getCreditBalance(WITH_START, "orbit", { subscriptionPeriodStart: stripeStart(end), subscriptionPeriodEnd: end }, now);
    t.check("start on file: the allowance is there and spendable", good.allowance !== null && good.spendable === allowance, JSON.stringify(good));

    const bad = await getCreditBalance(NO_START, "orbit", { subscriptionPeriodStart: null, subscriptionPeriodEnd: end }, now);
    t.knownBug(
      "BUG: no start on file: a Pro subscriber has 0 spendable credits on day two of the cycle",
      bad.allowance !== null && bad.spendable === allowance,
      `allowance=${JSON.stringify(bad.allowance)}, spendable=${bad.spendable}`
    );

    const later = await getCreditBalance(NO_START, "orbit", { subscriptionPeriodStart: null, subscriptionPeriodEnd: end }, new Date("2027-03-03T10:00:00Z"));
    t.check(
      "…the same grant becomes spendable once the bogus start passes (delayed, not lost)",
      later.allowance !== null && later.spendable === allowance,
      JSON.stringify(later.allowance)
    );
  } finally {
    await purgeUsers(db, [NO_START, WITH_START]);
  }

  t.done("credit period overflow (known bug)");
});
