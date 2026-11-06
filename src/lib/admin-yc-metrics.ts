import { and, count, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  MRR_KINDS,
  currentMrrDetail,
  ledgerRowCountsSql,
  mrrMovement,
} from "@/lib/billing-events";
import { deepgramCostMicros, managedAiCostMicros } from "@/lib/credits/admin-credits";
import { acquisitionSpendUsd, estimatedStripeFeesCents, monthlyCostSeries } from "@/lib/money-costs";
import {
  billingEvents,
  cashSnapshots,
  fundraisingInvestors,
  fundraisingRounds,
  nonDilutiveFunding,
  startupExpenses,
  userSettings,
} from "@/db/schema";
import { adminUserIds } from "@/lib/admin";
import { speechSpendMicros } from "@/lib/speech-credit";
import {
  computeArpaCents,
  computeCac,
  computeCapitalTotals,
  computeFundraisingProgress,
  computeGrossMargin,
  computeMonthlyBurn,
  computeObservedChurnPct,
  computePaybackMonths,
  computeRunway,
  computeSubscriberGrowth,
  resolveLtv,
  summarizeSubscriberLedger,
  MIN_SUBSCRIBER_MONTHS,
  type CapitalInflow,
} from "@/lib/admin-yc-calculations";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Cash, burn, and how long one divided by the other lasts.
 *
 * Burn has five components and they are reported separately, never pre-merged:
 *
 *  - **Ad-hoc expenses**, summed over a trailing 30-day window.
 *  - **Infrastructure**, taken from the most recent month with a bill actually entered.
 *  - **Included AI** (Pro and Max), the real model cost on Orbit's keys over the trailing
 *    30 days, from `usage_events` — `managedAiCostMicros`, the one managed-AI definition.
 *    It arrives as provider bills later, but waiting for them would overstate runway by
 *    exactly the months managed AI has been running.
 *  - **Deepgram**, priced from `speech_usage` seconds over the trailing 30 days
 *    (`speechSpendMicros`). It is paid from a prepaid credit until that runs out, but it is
 *    still what the product costs to run, and omitting the largest variable cost made burn
 *    flatter than it is (audit M4).
 *  - **Acquisition spend**, taken from the most recent calendar month with any entered —
 *    the same "latest month known" rule as infrastructure, because the Costs page and this
 *    page now read the same month-attributed rows (audit M7).
 *
 * Both AI figures here include the operator's own accounts: burn is cash, and dogfooding is
 * cash. (The customer-facing cost figures exclude them.)
 *
 * Mixing a rolling window with a calendar month needs justifying, and the justification is
 * that they are different kinds of number. Expenses are a *flow* — things that happened to
 * fall in the last 30 days. A provider bill is a *run rate*: it recurs monthly whether or
 * not this month's invoice has arrived yet, so the latest known bill is the best estimate
 * of the next one. Summing them is adding a monthly rate to a monthly total.
 *
 * `infraEntered` is surfaced so a month nobody has typed a bill into reads as unknown rather
 * than as a month that got cheaper.
 */
export async function loadRunwayMetrics(now = new Date()) {
  const db = await getDb();
  const [latestSnapshot, expenseRows, costMonths, managedMicros, deepgramMicros] = await Promise.all([
    db.query.cashSnapshots.findFirst({
      orderBy: [desc(cashSnapshots.asOf)],
    }),
    db.query.startupExpenses.findMany({
      where: gte(startupExpenses.incurredAt, new Date(now.getTime() - THIRTY_DAYS_MS)),
      orderBy: [desc(startupExpenses.incurredAt)],
    }),
    monthlyCostSeries(3),
    managedAiCostMicros(30, now, { includeInternal: true }),
    speechSpendMicros(new Date(now.getTime() - THIRTY_DAYS_MS), new Date(now.getTime() + 1)),
  ]);

  // Newest month that actually has a bill recorded. An empty result means nobody has ever
  // entered one, which is reported as unknown rather than assumed to be zero.
  const latestInfra = [...costMonths].reverse().find((m) => !m.infraMissing) ?? null;
  const infraMonthlyUsd = latestInfra ? latestInfra.infraCents / 100 : 0;

  // Likewise for acquisition: the newest month with any spend entered.
  const latestAcquisition = [...costMonths].reverse().find((m) => m.acquisitionCents > 0) ?? null;
  const acquisitionMonthlyUsd = latestAcquisition ? latestAcquisition.acquisitionCents / 100 : 0;

  const cashBalanceUsd = latestSnapshot?.balanceUsd ?? 0;
  const expenseBurnUsd = computeMonthlyBurn(expenseRows, now);
  const managedAiMonthlyUsd = managedMicros / 1_000_000;
  const deepgramMonthlyUsd = deepgramMicros / 1_000_000;
  const monthlyBurnUsd =
    expenseBurnUsd + infraMonthlyUsd + managedAiMonthlyUsd + deepgramMonthlyUsd + acquisitionMonthlyUsd;

  return {
    cashBalanceUsd,
    monthlyBurnUsd,
    expenseBurnUsd,
    infraMonthlyUsd,
    managedAiMonthlyUsd,
    deepgramMonthlyUsd,
    acquisitionMonthlyUsd,
    acquisitionMonth: latestAcquisition?.month ?? null,
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

  const [mrrDetail, current, previous, movement, earliest] = await Promise.all([
    currentMrrDetail(now),
    countNewSubscribers(since, now),
    countNewSubscribers(priorSince, since),
    mrrMovement(since, now),
    db.query.billingEvents.findFirst({ orderBy: [billingEvents.effectiveAt] }),
  ]);

  return {
    mrrUsd: mrrDetail.mrrCents / 100,
    /** The part of MRR whose payment is failing right now: counted at full value, shown apart. */
    pastDueUsd: mrrDetail.pastDueCents / 100,
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
 * flatter CAC by dividing spend across people the spend did not go out and find. Internal,
 * tester and comped accounts are not customers acquired either, so they are not counted.
 */
export async function countNewSubscribers(since: Date, until: Date) {
  const db = await getDb();
  const [row] = await db
    .select({ value: count() })
    .from(billingEvents)
    .where(
      and(
        eq(billingEvents.kind, "new"),
        gte(billingEvents.effectiveAt, since),
        lt(billingEvents.effectiveAt, until),
        // Internal / tester accounts and comped ones are not customers acquired.
        ledgerRowCountsSql(sql`${billingEvents.userId}`)
      )
    );
  return row?.value ?? 0;
}

/* ------------------------------------------------------------------- one CAC ----- */

const TRAILING_DAYS = 90;

export type CacWindow = {
  since: Date;
  until: Date;
  /** Calendar months the window spans, including the current partial one. */
  months: number;
};

/**
 * THE CAC window, shared by /admin/yc/economics and /admin/billing/costs: the current UTC
 * month so far plus the `months - 1` before it, starting at a month boundary.
 *
 * Month-aligned on purpose. Acquisition spend belongs to exactly one calendar month, so a
 * window that starts mid-month would take a fraction of a month's spend against a fraction of
 * its signups and mean nothing. Three months because one month of a small business is mostly
 * noise; the current month is included because it is the one being acted on, and the page
 * says so (its spend is usually entered after the fact, which flatters it until it is).
 */
export function cacWindow(now: Date = new Date(), months = 3): CacWindow {
  return {
    since: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1)),
    until: now,
    months,
  };
}

export type CacResult = {
  /** Dollars per new subscriber; `null` when no subscriber was acquired (undefined, not zero). */
  cac: number | null;
  spendUsd: number;
  newSubscribers: number;
  window: CacWindow;
};

/**
 * ONE CAC. Numerator: acquisition spend whose month falls in the window. Denominator: ledger
 * `new` rows in the window, excluding internal, tester and comped accounts (reactivations are
 * not acquisitions). Both money pages call this and nothing else computes CAC, so they cannot
 * disagree (audit M6).
 */
export async function cacFor(window: CacWindow = cacWindow()): Promise<CacResult> {
  const [spendUsd, newSubscribers] = await Promise.all([
    acquisitionSpendUsd(window.since, window.until),
    countNewSubscribers(window.since, window.until),
  ]);
  return { cac: computeCac(spendUsd, newSubscribers), spendUsd, newSubscribers, window };
}

/* ------------------------------------------------------------- churn override ----- */

/**
 * Admin ids in `ADMIN_USER_IDS` order, then the caller if given, then the local demo user
 * (where the env list is empty and every visitor is an admin).
 */
function churnOverrideCandidates(callerId?: string | null): string[] {
  const ids = adminUserIds();
  for (const extra of [callerId, "demo-user"]) {
    if (extra && !ids.includes(extra)) ids.push(extra);
  }
  return ids;
}

/**
 * The typed monthly-churn estimate, as ONE site-wide value despite living on a per-admin
 * column: the first non-null among the admins, in `ADMIN_USER_IDS` order — deterministic, so
 * every admin sees (and edits) the same number. Not available as a `site_settings` column
 * without a schema change, so this is the lowest-cost single source.
 */
export async function loadChurnOverride(
  callerId?: string | null
): Promise<{ pct: number | null; ownerId: string | null }> {
  const candidates = churnOverrideCandidates(callerId);
  const db = await getDb();
  const rows = await db
    .select({ userId: userSettings.userId, pct: userSettings.estimatedMonthlyChurnPct })
    .from(userSettings)
    .where(inArray(userSettings.userId, candidates));
  for (const id of candidates) {
    const row = rows.find((r) => r.userId === id && r.pct !== null);
    if (row) return { pct: row.pct, ownerId: id };
  }
  return { pct: null, ownerId: null };
}

/** Whose row `setEstimatedChurnAction` writes: the current owner of the value, else the caller. */
export async function churnOverrideOwner(callerId: string): Promise<string> {
  const { ownerId } = await loadChurnOverride(callerId);
  return ownerId ?? callerId;
}

/* ---------------------------------------------------------------- unit economics ----- */

/**
 * CAC, LTV, payback, margin: the YC unit-economics page.
 *
 * LTV is built from the ledger, not a constant. Over the trailing 90 days:
 *
 *   ARPA          = recurring revenue per paying account per month, integrated from the
 *                   ledger's own movements (so the plan mix, annual discounts and founding
 *                   pricing are in it, and Lifetime and packs are out — they are not recurring)
 *   gross margin  = (cash revenue − attributable cost) / cash revenue, where attributable
 *                   cost = managed AI + Deepgram + Stripe's estimated fees
 *   churn         = accounts that stopped paying ÷ subscriber-months
 *
 *   LTV     = ARPA × margin ÷ churn
 *   payback = CAC ÷ (ARPA × margin)
 *
 * Observed churn is shown only with at least `MIN_SUBSCRIBER_MONTHS` of subscriber time in
 * the window; below that the typed estimate is used and LABELLED as an estimate. Internal,
 * tester and comped accounts are out of every term.
 */
export async function loadUnitEconomics(now = new Date()) {
  const db = await getDb();
  const trailingSince = new Date(now.getTime() - TRAILING_DAYS * 86_400_000);

  const [cac, override, ledgerRows, movement, aiMicros, speechMicros] = await Promise.all([
    cacFor(cacWindow(now)),
    loadChurnOverride(),
    db
      .select({
        userId: billingEvents.userId,
        effectiveAt: billingEvents.effectiveAt,
        mrrDeltaCents: billingEvents.mrrDeltaCents,
      })
      .from(billingEvents)
      .where(
        and(
          inArray(billingEvents.kind, [...MRR_KINDS]),
          lt(billingEvents.effectiveAt, now),
          ledgerRowCountsSql(sql`${billingEvents.userId}`)
        )
      ),
    mrrMovement(trailingSince, now),
    managedAiCostMicros(TRAILING_DAYS, now),
    deepgramCostMicros(TRAILING_DAYS, now),
  ]);

  const subscribers = summarizeSubscriberLedger(
    ledgerRows.filter((r): r is typeof r & { userId: string } => r.userId !== null),
    trailingSince,
    now
  );
  const arpaCents = computeArpaCents(subscribers.mrrCentMonths, subscribers.subscriberMonths);
  const arpaUsd = arpaCents === null ? null : arpaCents / 100;
  const observedChurnPct = computeObservedChurnPct(subscribers.churned, subscribers.subscriberMonths);

  const revenueCents = movement.cashInCents - movement.refundedCents;
  const feesCents = estimatedStripeFeesCents(
    movement.cashInCents,
    Math.max(movement.chargeCount, movement.cashInCents > 0 ? 1 : 0),
    movement.paymentCents
  );
  const aiCents = Math.round(aiMicros / 10_000);
  const speechCents = Math.round(speechMicros / 10_000);
  const attributableCostCents = aiCents + speechCents + feesCents;
  const grossMargin = computeGrossMargin(revenueCents, attributableCostCents);

  const ltv = resolveLtv({
    arpaUsd,
    grossMargin,
    subscriberMonths: subscribers.subscriberMonths,
    observedChurnPct,
    typedChurnPct: override.pct,
  });
  const paybackMonths = computePaybackMonths(cac.cac, arpaUsd, grossMargin);

  return {
    cac: cac.cac,
    spendUsd: cac.spendUsd,
    newSubscribers: cac.newSubscribers,
    cacWindow: cac.window,
    arpaUsd,
    grossMargin,
    revenueCents,
    costBreakdown: { aiCents, speechCents, feesCents },
    subscriberMonths: subscribers.subscriberMonths,
    churnedLogos: subscribers.churned,
    observedChurnPct,
    minSubscriberMonths: MIN_SUBSCRIBER_MONTHS,
    ltv,
    ltvToCac: cac.cac && ltv.ltvUsd !== null ? ltv.ltvUsd / cac.cac : null,
    paybackMonths,
    estimatedMonthlyChurnPct: override.pct,
    churnOverrideOwnerId: override.ownerId,
    trailingDays: TRAILING_DAYS,
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
