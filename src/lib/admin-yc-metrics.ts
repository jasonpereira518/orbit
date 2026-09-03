import { desc, eq, gte } from "drizzle-orm";
import { getDb } from "@/db";
import {
  acquisitionSpend,
  cashSnapshots,
  fundraisingInvestors,
  fundraisingRounds,
  startupExpenses,
  userSettings,
} from "@/db/schema";
import { loadAdminUserRows, windowCount } from "@/lib/admin-metrics";
import { MONTHLY_AMOUNT } from "@/lib/plan-copy";
import { requireAdminUserId } from "@/lib/admin";
import {
  computeCac,
  computeFundraisingProgress,
  computeLtv,
  computeMonthlyBurn,
  computeRunway,
  computeSubscriberGrowth,
} from "@/lib/admin-yc-calculations";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export async function loadRunwayMetrics(now = new Date()) {
  const db = await getDb();
  const [latestSnapshot, expenseRows] = await Promise.all([
    db.query.cashSnapshots.findFirst({
      orderBy: [desc(cashSnapshots.asOf)],
    }),
    db.query.startupExpenses.findMany({
      where: gte(startupExpenses.incurredAt, new Date(now.getTime() - THIRTY_DAYS_MS)),
      orderBy: [desc(startupExpenses.incurredAt)],
    }),
  ]);

  const cashBalanceUsd = latestSnapshot?.balanceUsd ?? 0;
  const monthlyBurnUsd = computeMonthlyBurn(expenseRows, now);

  return {
    cashBalanceUsd,
    monthlyBurnUsd,
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
 * Growth is a new-subscriber count comparison, not a claimed dollar MRR delta — Orbit has
 * one flat price and stores no historical MRR series, so subscriber growth is the honest
 * proxy for revenue growth at this stage.
 */
export async function loadRevenueGrowth(now = new Date()) {
  const rows = await loadAdminUserRows();
  const activeSubscribers = rows.filter((r) => r.subscriptionStatus === "active");
  const { current, previous } = windowCount(
    activeSubscribers.map((r) => r.signupAt),
    30,
    now
  );

  return {
    mrrUsd: activeSubscribers.length * MONTHLY_AMOUNT,
    subscriberGrowthPct: computeSubscriberGrowth(current, previous),
    newSubscribers30d: current,
    newSubscribersPrior30d: previous,
  };
}

export async function loadUnitEconomics(now = new Date()) {
  const db = await getDb();
  const since = new Date(now.getTime() - THIRTY_DAYS_MS);

  const [spendRows, rows, settings] = await Promise.all([
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
    loadAdminUserRows(),
    (async () => {
      const adminUserId = await requireAdminUserId();
      return db.query.userSettings.findFirst({
        where: eq(userSettings.userId, adminUserId),
      });
    })(),
  ]);

  const activeSubscribers = rows.filter((r) => r.subscriptionStatus === "active");
  const { current: newSubscribers30d } = windowCount(
    activeSubscribers.map((r) => r.signupAt),
    30,
    now
  );
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

export async function loadFundraisingSummary() {
  const db = await getDb();
  const [rounds, investors] = await Promise.all([
    db.query.fundraisingRounds.findMany({ orderBy: [desc(fundraisingRounds.createdAt)] }),
    db.query.fundraisingInvestors.findMany({ orderBy: [desc(fundraisingInvestors.committedAt)] }),
  ]);

  return {
    rounds: rounds.map((round) => {
      const roundInvestors = investors.filter((i) => i.roundId === round.id);
      const raisedUsd = roundInvestors.reduce((sum, i) => sum + i.amountUsd, 0);
      return {
        id: round.id,
        name: round.name,
        targetUsd: round.targetUsd,
        status: round.status,
        raisedUsd,
        progressPct: computeFundraisingProgress(round.targetUsd, raisedUsd),
        investors: roundInvestors.map((i) => ({
          id: i.id,
          name: i.name,
          amountUsd: i.amountUsd,
          committedAt: i.committedAt,
        })),
      };
    }),
  };
}
