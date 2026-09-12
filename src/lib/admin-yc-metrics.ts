import { and, count, desc, eq, gte, lt } from "drizzle-orm";
import { getDb } from "@/db";
import { currentMrrCents, mrrMovement } from "@/lib/billing-events";
import { monthlyCostSeries } from "@/lib/money-costs";
import {
  acquisitionSpend,
  billingEvents,
  cashSnapshots,
  fundraisingInvestors,
  fundraisingRounds,
  nonDilutiveFunding,
  startupExpenses,
  userSettings,
} from "@/db/schema";
import { MONTHLY_AMOUNT } from "@/lib/plan-copy";
import { requireAdminUserId } from "@/lib/admin";
import {
  computeCac,
  computeCapitalTotals,
  computeFundraisingProgress,
  computeLtv,
  computeMonthlyBurn,
  computeRunway,
  computeSubscriberGrowth,
  type CapitalInflow,
} from "@/lib/admin-yc-calculations";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Cash, burn, and how long one divided by the other lasts.
 *
 * Burn has two components and they are reported separately, never pre-merged:
 *
 *  - **Ad-hoc expenses**, summed over a trailing 30-day window.
 *  - **Infrastructure**, taken from the most recent month with a bill actually entered.
 *
 * Mixing a rolling window with a calendar month needs justifying, and the justification is
 * that they are different kinds of number. Expenses are a *flow* — things that happened to
 * fall in the last 30 days. A provider bill is a *run rate*: it recurs monthly whether or
 * not this month's invoice has arrived yet, so the latest known bill is the best estimate
 * of the next one. Summing them is adding a monthly rate to a monthly total.
 *
 * Before this, burn was expenses alone — every provider bill was silently excluded and
 * runway was correspondingly overstated. `infraEntered` is surfaced so a month nobody has
 * typed a bill into reads as unknown rather than as a month that got cheaper.
 */
export async function loadRunwayMetrics(now = new Date()) {
  const db = await getDb();
  const [latestSnapshot, expenseRows, costMonths] = await Promise.all([
    db.query.cashSnapshots.findFirst({
      orderBy: [desc(cashSnapshots.asOf)],
    }),
    db.query.startupExpenses.findMany({
      where: gte(startupExpenses.incurredAt, new Date(now.getTime() - THIRTY_DAYS_MS)),
      orderBy: [desc(startupExpenses.incurredAt)],
    }),
    monthlyCostSeries(3),
  ]);

  // Newest month that actually has a bill recorded. An empty result means nobody has ever
  // entered one, which is reported as unknown rather than assumed to be zero.
  const latestInfra = [...costMonths].reverse().find((m) => !m.infraMissing) ?? null;
  const infraMonthlyUsd = latestInfra ? latestInfra.infraCents / 100 : 0;

  const cashBalanceUsd = latestSnapshot?.balanceUsd ?? 0;
  const expenseBurnUsd = computeMonthlyBurn(expenseRows, now);
  const monthlyBurnUsd = expenseBurnUsd + infraMonthlyUsd;

  return {
    cashBalanceUsd,
    monthlyBurnUsd,
    expenseBurnUsd,
    infraMonthlyUsd,
    infraEntered: !!latestInfra,
    infraMonth: latestInfra?.month ?? null,
    runwayMonths: computeRunway(cashBalanceUsd, monthlyBurnUsd),
    recentExpenses: expenseRows.map((e) => ({
      id: e.id,
      category: e.category,
      amountUsd: e.amountUsd,
      incurredAt: e.incurredAt,
      note: e.note,
    })),
  };
}

/**
 * MRR and how it moved.
 *
 * `mrrUsd` comes from `currentMrrCents`, the same derivation the Money section uses. It
 * previously multiplied the active-subscriber count by the list price, which was wrong in
 * both directions: it charged comped accounts, and it dropped a `canceled` subscriber who
 * has paid through the end of their period and is still entitled to the product.
 *
 * New-subscriber counts come from the billing ledger's `new` events, not from account
 * creation dates. The old version counted active subscribers whose *signup* fell in the
 * window — so somebody who signed up in June and subscribed yesterday was invisible, and
 * anyone who subscribed the same week they signed up was counted twice over as both a
 * signup and a conversion. `loadUnitEconomics` divided by that same number, so CAC
 * inherited the error.
 *
 * `ledgerStart` is the earliest event on record, read rather than hardcoded so that
 * running the backfill script moves it on its own. A window reaching back past it is
 * undercounting, and the page says so instead of presenting a partial series as complete.
 */
export async function loadRevenueGrowth(now = new Date()) {
  const since = new Date(now.getTime() - THIRTY_DAYS_MS);
  const priorSince = new Date(now.getTime() - 2 * THIRTY_DAYS_MS);
  const db = await getDb();

  const [mrrCents, current, previous, movement, earliest] = await Promise.all([
    currentMrrCents(now),
    countNewSubscribers(since, now),
    countNewSubscribers(priorSince, since),
    mrrMovement(since, now),
    db.query.billingEvents.findFirst({ orderBy: [billingEvents.effectiveAt] }),
  ]);

  return {
    mrrUsd: mrrCents / 100,
    subscriberGrowthPct: computeSubscriberGrowth(current, previous),
    newSubscribers30d: current,
    newSubscribersPrior30d: previous,
    movement,
    ledgerStart: earliest?.effectiveAt ?? null,
    /** True when the 30-day window reaches back past the ledger's own first event. */
    windowPredatesLedger: !!earliest && earliest.effectiveAt.getTime() > since.getTime(),
  };
}

/**
 * First-time subscriptions that started in a window, from the billing ledger.
 *
 * Counts `new` only, and deliberately excludes `reactivation` — somebody who churned and
 * came back is revenue regained, not a customer acquired, and folding them in would
 * flatter CAC by dividing spend across people the spend did not go out and find.
 */
async function countNewSubscribers(since: Date, until: Date) {
  const db = await getDb();
  const [row] = await db
    .select({ value: count() })
    .from(billingEvents)
    .where(
      and(
        eq(billingEvents.kind, "new"),
        gte(billingEvents.effectiveAt, since),
        lt(billingEvents.effectiveAt, until)
      )
    );
  return row?.value ?? 0;
}

export async function loadUnitEconomics(now = new Date()) {
  const db = await getDb();
  const since = new Date(now.getTime() - THIRTY_DAYS_MS);

  const [spendRows, newSubscribers30d, settings] = await Promise.all([
    db.query.acquisitionSpend.findMany({
      // Filtered on `created_at` (when the row was logged), not `period_start`/`period_end`
      // (the self-reported period the row claims to cover). `LogAcquisitionSpendForm`
      // always writes `periodStart = now-30d, periodEnd = now` at write time, so every row
      // claims to cover "the trailing 30 days" as of whenever it was submitted. A filter on
      // that self-reported period has to pick one of two wrong behaviors: filtering on
      // `periodStart` at read time makes spend silently vanish once its 30-day-old period
      // start recedes past the window (a stale row is simply dropped from every future CAC
      // calculation), while filtering on period *overlap* makes logging spend more than
      // once in a 30-day span — the expected workflow — double- or triple-count the same
      // dollars, since each new row's rolling window overlaps almost entirely with the
      // last one's. `created_at` has neither failure: it is a fixed point in time, so a row
      // counts exactly once, for exactly the 30 days after it was actually logged.
      where: gte(acquisitionSpend.createdAt, since),
    }),
    // Ledger-derived, matching `loadRevenueGrowth`. This used to count accounts *created*
    // in the window, which is a different population entirely — see that function.
    countNewSubscribers(since, now),
    (async () => {
      const adminUserId = await requireAdminUserId();
      return db.query.userSettings.findFirst({
        where: eq(userSettings.userId, adminUserId),
      });
    })(),
  ]);

  const spend30dUsd = spendRows.reduce((sum, r) => sum + r.amountUsd, 0);
  const estimatedMonthlyChurnPct = settings?.estimatedMonthlyChurnPct ?? null;

  const cac = computeCac(spend30dUsd, newSubscribers30d);
  const ltv = computeLtv(MONTHLY_AMOUNT, estimatedMonthlyChurnPct);

  return {
    cac,
    ltv,
    ltvToCac: cac && ltv ? ltv / cac : null,
    spend30dUsd,
    newSubscribers30d,
    estimatedMonthlyChurnPct,
  };
}

/** An investor commitment, flattened into the shape `computeCapitalTotals` understands. */
function investorInflow(row: {
  amountUsd: number;
  receivedAt: Date | null;
}): CapitalInflow {
  return {
    amountUsd: row.amountUsd,
    dilutive: true,
    inKind: false,
    repayable: false,
    repaidUsd: 0,
    receivedAt: row.receivedAt,
    expiresAt: null,
  };
}

/** The same, for a grant / prize / credit / accelerator award / loan. */
function nonDilutiveInflow(row: {
  amountUsd: number;
  form: "cash" | "in_kind";
  repayable: boolean;
  repaidUsd: number;
  receivedAt: Date | null;
  expiresAt: Date | null;
}): CapitalInflow {
  return {
    amountUsd: row.amountUsd,
    dilutive: false,
    inKind: row.form === "in_kind",
    repayable: row.repayable,
    repaidUsd: row.repaidUsd,
    receivedAt: row.receivedAt,
    expiresAt: row.expiresAt,
  };
}

/**
 * Everything the company has been given, dilutive and not, in one read.
 *
 * Per-round subtotals call `computeCapitalTotals` with that round's slice rather than
 * summing separately, so a round's numbers and the company total cannot drift apart.
 *
 * Cash on hand rides along for the reconciliation panel and is deliberately NOT folded
 * into any total: `cash_snapshots` is a hand-asserted bank balance updated *after* a wire
 * lands, so adding banked capital to it double-counts the moment it is updated.
 */
export async function loadFundingTotals(now = new Date()) {
  const db = await getDb();
  const [rounds, investors, nonDilutive, latestSnapshot] = await Promise.all([
    db.query.fundraisingRounds.findMany({ orderBy: [desc(fundraisingRounds.createdAt)] }),
    db.query.fundraisingInvestors.findMany({ orderBy: [desc(fundraisingInvestors.committedAt)] }),
    db.query.nonDilutiveFunding.findMany({ orderBy: [desc(nonDilutiveFunding.awardedAt)] }),
    db.query.cashSnapshots.findFirst({ orderBy: [desc(cashSnapshots.asOf)] }),
  ]);

  const totals = computeCapitalTotals(
    [...investors.map(investorInflow), ...nonDilutive.map(nonDilutiveInflow)],
    now
  );

  return {
    totals,
    rounds: rounds.map((round) => {
      const roundInvestors = investors.filter((i) => i.roundId === round.id);
      const roundTotals = computeCapitalTotals(roundInvestors.map(investorInflow), now);
      const committedUsd = roundInvestors.reduce((sum, i) => sum + i.amountUsd, 0);
      return {
        id: round.id,
        name: round.name,
        targetUsd: round.targetUsd,
        status: round.status,
        closedAt: round.closedAt,
        committedUsd,
        receivedUsd: roundTotals.bankedUsd,
        // Progress is measured on commitments, because it answers "is the round full?" —
        // a question a signed-but-unwired commitment does close out. `receivedUsd` is the
        // separate, more conservative number, shown beside it.
        progressPct: computeFundraisingProgress(round.targetUsd, committedUsd),
        investors: roundInvestors.map((i) => ({
          id: i.id,
          name: i.name,
          amountUsd: i.amountUsd,
          committedAt: i.committedAt,
          receivedAt: i.receivedAt,
          note: i.note,
        })),
      };
    }),
    nonDilutive: nonDilutive.map((row) => ({
      id: row.id,
      source: row.source,
      kind: row.kind,
      form: row.form,
      repayable: row.repayable,
      repaidUsd: row.repaidUsd,
      amountUsd: row.amountUsd,
      awardedAt: row.awardedAt,
      receivedAt: row.receivedAt,
      expiresAt: row.expiresAt,
      note: row.note,
      // Derived against `now` rather than stored, so a credit lapses on its own without a
      // job having to notice.
      expired: !!row.expiresAt && row.expiresAt.getTime() <= now.getTime(),
    })),
    cash: latestSnapshot
      ? { balanceUsd: latestSnapshot.balanceUsd, asOf: latestSnapshot.asOf }
      : null,
  };
}
