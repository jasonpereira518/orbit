const DAY_MS = 24 * 60 * 60 * 1000;

/** Sum of expenses whose `incurredAt` falls within the trailing 30 days of `asOf`. */
export function computeMonthlyBurn(
  expenses: { amountUsd: number; incurredAt: Date }[],
  asOf: Date
): number {
  const since = asOf.getTime() - 30 * DAY_MS;
  return expenses
    .filter((e) => e.incurredAt.getTime() >= since)
    .reduce((sum, e) => sum + e.amountUsd, 0);
}

/**
 * Months of runway left. Zero or negative burn (net income, or nothing logged yet) reads
 * as infinite runway rather than a divide-by-zero — `null` means "not running out."
 */
export function computeRunway(
  cashBalanceUsd: number,
  monthlyBurnUsd: number
): number | null {
  if (monthlyBurnUsd <= 0) return null;
  return cashBalanceUsd / monthlyBurnUsd;
}

/**
 * Percent change from `previous` to `current`. `null` when there is no baseline to compare
 * against (both zero, or previous zero with a positive current) — undefined growth, not
 * infinite growth.
 */
export function computeSubscriberGrowth(
  current: number,
  previous: number
): number | null {
  if (previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

/** Cost to acquire one subscriber. `null` when no new subscribers arrived — undefined, not zero. */
export function computeCac(
  acquisitionSpendUsd: number,
  newSubscribers: number
): number | null {
  if (newSubscribers === 0) return null;
  return acquisitionSpendUsd / newSubscribers;
}

/**
 * Lifetime value: ARPU divided by monthly churn rate (as a percent, e.g. `2` for 2%).
 * `null` when churn is unset or zero — an unknown or zero churn rate makes LTV undefined,
 * not infinite.
 */
export function computeLtv(
  arpuUsd: number,
  monthlyChurnPct: number | null
): number | null {
  if (!monthlyChurnPct) return null;
  return arpuUsd / (monthlyChurnPct / 100);
}

/* ---------------------------------------------------------------- data-driven LTV ---- */

/** A calendar-free "month" for subscriber-months: 30 days, the same unit the typed churn uses. */
const MONTH_MS = 30 * DAY_MS;

/**
 * Observed churn and LTV are withheld below this many subscriber-months in the window.
 * One cancellation among a handful of subscribers is a double-digit swing in the monthly
 * rate; printing it as a rate would be a number that means nothing (audit §2.8).
 */
export const MIN_SUBSCRIBER_MONTHS = 100;

/** One recurring-revenue movement of one account, as booked in the ledger. */
export type LedgerMrrRow = { userId: string; effectiveAt: Date; mrrDeltaCents: number };

export type SubscriberWindowSummary = {
  /** Accounts paying at the start and at the end of the window. */
  startSubscribers: number;
  endSubscribers: number;
  /** Σ over accounts of the time each was paying, in 30-day months. */
  subscriberMonths: number;
  /** Σ over accounts of (monthly recurring value × time paying), in cent-months. */
  mrrCentMonths: number;
  /** Accounts that went from paying to not paying inside the window (logo churn). */
  churned: number;
  /** Accounts that went from not paying to paying inside the window (new + returning). */
  acquired: number;
};

/**
 * Replay the ledger's recurring movements over a window.
 *
 * An account is PAYING while its running Σ`mrr_delta_cents` is positive: `new` and
 * `reactivation` raise it from zero, `churn` brings it back, `expansion` and `contraction`
 * move the amount without changing whether it pays. Time is integrated exactly rather than
 * sampled, so two subscribers for half the window each are one subscriber-month at 30 days.
 *
 * Rows need not be sorted. Rows at or after `until` are ignored; rows before `since` only
 * establish the state the window starts in.
 */
export function summarizeSubscriberLedger(
  rows: readonly LedgerMrrRow[],
  since: Date,
  until: Date
): SubscriberWindowSummary {
  const out: SubscriberWindowSummary = {
    startSubscribers: 0,
    endSubscribers: 0,
    subscriberMonths: 0,
    mrrCentMonths: 0,
    churned: 0,
    acquired: 0,
  };
  const from = since.getTime();
  const to = until.getTime();
  if (!(to > from)) return out;

  const byUser = new Map<string, LedgerMrrRow[]>();
  for (const row of rows) {
    if (row.effectiveAt.getTime() >= to) continue;
    const list = byUser.get(row.userId);
    if (list) list.push(row);
    else byUser.set(row.userId, [row]);
  }

  for (const list of byUser.values()) {
    list.sort((a, b) => a.effectiveAt.getTime() - b.effectiveAt.getTime());
    let level = 0;
    let cursor = from;
    let started = false;

    const accrue = (until_: number) => {
      if (level > 0 && until_ > cursor) {
        const ms = until_ - cursor;
        out.subscriberMonths += ms / MONTH_MS;
        out.mrrCentMonths += (level * ms) / MONTH_MS;
      }
      cursor = until_;
    };

    for (const row of list) {
      const at = row.effectiveAt.getTime();
      if (at < from) {
        level += row.mrrDeltaCents;
        continue;
      }
      if (!started) {
        started = true;
        if (level > 0) out.startSubscribers++;
      }
      accrue(at);
      const was = level > 0;
      level += row.mrrDeltaCents;
      const is = level > 0;
      if (was && !is) out.churned++;
      if (!was && is) out.acquired++;
    }
    if (!started && level > 0) out.startSubscribers++;
    accrue(to);
    if (level > 0) out.endSubscribers++;
  }

  return out;
}

/** Average monthly recurring revenue per paying account, in cents. `null` with no subscriber time. */
export function computeArpaCents(mrrCentMonths: number, subscriberMonths: number): number | null {
  if (!(subscriberMonths > 0)) return null;
  return mrrCentMonths / subscriberMonths;
}

/**
 * Monthly logo churn, as a percent: accounts lost per subscriber-month. `null` when there is
 * no subscriber time to divide by. NOT gated on a minimum sample here — callers decide
 * whether to show it (`resolveLtv` does, at `MIN_SUBSCRIBER_MONTHS`).
 */
export function computeObservedChurnPct(churned: number, subscriberMonths: number): number | null {
  if (!(subscriberMonths > 0)) return null;
  return (churned / subscriberMonths) * 100;
}

/**
 * Gross margin as a fraction: (revenue − attributable cost) / revenue. `null` with no revenue
 * — a margin on nothing is undefined, not 0% and not 100%. Can be negative.
 */
export function computeGrossMargin(revenueCents: number, attributableCostCents: number): number | null {
  if (!(revenueCents > 0)) return null;
  return (revenueCents - attributableCostCents) / revenueCents;
}

/** Months of gross profit it takes to earn back CAC. `null` when any input is missing or the profit is not positive. */
export function computePaybackMonths(
  cacUsd: number | null,
  arpaUsd: number | null,
  grossMargin: number | null
): number | null {
  if (cacUsd === null || arpaUsd === null || grossMargin === null) return null;
  const monthlyProfit = arpaUsd * grossMargin;
  if (!(monthlyProfit > 0)) return null;
  return cacUsd / monthlyProfit;
}

export type LtvResolution =
  | { basis: "observed"; ltvUsd: number; churnPct: number }
  | { basis: "estimate"; ltvUsd: number; churnPct: number }
  | { basis: "none"; ltvUsd: null; churnPct: null; reason: string };

/**
 * LTV = ARPA × gross margin ÷ monthly churn — from OBSERVED churn when the window has enough
 * subscriber time to mean something, otherwise from the typed estimate, labelled as one.
 *
 *  - `observed`: ≥ `MIN_SUBSCRIBER_MONTHS` subscriber-months AND at least one cancellation.
 *  - `estimate`: the typed churn override (the caller labels it "estimate" on screen).
 *  - `none`: neither; `reason` says what is missing so the page can say so.
 *
 * With zero observed cancellations the observed rate is 0 and LTV is unbounded, which is not a
 * number: it falls through to the estimate (or `none`) rather than printing infinity.
 */
export function resolveLtv(input: {
  arpaUsd: number | null;
  grossMargin: number | null;
  subscriberMonths: number;
  observedChurnPct: number | null;
  typedChurnPct: number | null;
}): LtvResolution {
  const { arpaUsd, grossMargin, subscriberMonths, observedChurnPct, typedChurnPct } = input;
  if (arpaUsd === null) return { basis: "none", ltvUsd: null, churnPct: null, reason: "no subscribers yet" };
  if (grossMargin === null) return { basis: "none", ltvUsd: null, churnPct: null, reason: "no revenue yet to take a margin on" };
  const value = (churnPct: number) => Math.max(0, (arpaUsd * grossMargin) / (churnPct / 100));

  if (subscriberMonths >= MIN_SUBSCRIBER_MONTHS && observedChurnPct !== null && observedChurnPct > 0) {
    return { basis: "observed", ltvUsd: value(observedChurnPct), churnPct: observedChurnPct };
  }
  if (typedChurnPct !== null && typedChurnPct > 0) {
    return { basis: "estimate", ltvUsd: value(typedChurnPct), churnPct: typedChurnPct };
  }
  return {
    basis: "none",
    ltvUsd: null,
    churnPct: null,
    reason:
      subscriberMonths < MIN_SUBSCRIBER_MONTHS
        ? `${Math.round(subscriberMonths)} of ${MIN_SUBSCRIBER_MONTHS} subscriber-months needed, and no typed estimate`
        : "no cancellations observed yet, and no typed estimate",
  };
}

/** Percent of a fundraising target raised so far. Zero target reads as 0%, not NaN. */
export function computeFundraisingProgress(
  targetUsd: number,
  raisedUsd: number
): number {
  if (targetUsd === 0) return 0;
  return (raisedUsd / targetUsd) * 100;
}

/**
 * One piece of money coming in, flattened from either `fundraising_investors` (dilutive)
 * or `non_dilutive_funding`. The two tables stay separate — their lifecycles genuinely
 * differ — and meet here, so there is exactly one place that decides what counts.
 */
export type CapitalInflow = {
  amountUsd: number;
  dilutive: boolean;
  /** Credits and other value that never lands in a bank account. */
  inKind: boolean;
  repayable: boolean;
  repaidUsd: number;
  /** `null` means committed or awarded, but not yet landed. */
  receivedAt: Date | null;
  expiresAt: Date | null;
};

export type CapitalTotals = {
  dilutiveCashReceivedUsd: number;
  nonDilutiveCashReceivedUsd: number;
  /** Cash that actually landed, from every source. The headline number. */
  bankedUsd: number;
  inKindActiveUsd: number;
  inKindExpiredUsd: number;
  committedNotReceivedUsd: number;
  debtOutstandingUsd: number;
  /** `bankedUsd + inKindActiveUsd`. Never rendered without its own derivation beside it. */
  totalCapitalInUsd: number;
  netOfDebtUsd: number;
};

/**
 * Add up everything the company has been given, in a way that cannot flatter itself.
 *
 * Four rules, each of which exists because breaking it overstates the money on hand:
 *
 *  1. **In-kind never enters `bankedUsd`.** Credits do not pay salaries. This is the whole
 *     reason `non_dilutive_funding.form` exists as a column separate from `kind`.
 *  2. **Expired in-kind counts as nothing** except `inKindExpiredUsd` — which exists only
 *     so that the total dropping one day is explicable rather than mysterious.
 *  3. **Committed-but-not-received counts as nothing.** A signed SAFE is not money, and a
 *     grant letter is not money.
 *  4. **A loan is banked but still owed.** Loan cash really is in the account, so excluding
 *     it would understate; but reporting it without `debtOutstandingUsd` beside it is the
 *     one way this page could actively mislead. You cannot owe money you were never given,
 *     so an unreceived loan creates no debt.
 *
 * Unlike the ratios above, these are sums: an empty set is genuinely `0`, not `null`.
 */
export function computeCapitalTotals(
  inflows: CapitalInflow[],
  asOf: Date
): CapitalTotals {
  const totals = {
    dilutiveCashReceivedUsd: 0,
    nonDilutiveCashReceivedUsd: 0,
    bankedUsd: 0,
    inKindActiveUsd: 0,
    inKindExpiredUsd: 0,
    committedNotReceivedUsd: 0,
    debtOutstandingUsd: 0,
    totalCapitalInUsd: 0,
    netOfDebtUsd: 0,
  };

  for (const inflow of inflows) {
    // Rule 2 comes first: an expired credit is spent regardless of how it arrived.
    if (inflow.inKind && inflow.expiresAt && inflow.expiresAt.getTime() <= asOf.getTime()) {
      totals.inKindExpiredUsd += inflow.amountUsd;
      continue;
    }

    // Rule 3.
    if (!inflow.receivedAt) {
      totals.committedNotReceivedUsd += inflow.amountUsd;
      continue;
    }

    // Rule 1.
    if (inflow.inKind) {
      totals.inKindActiveUsd += inflow.amountUsd;
      continue;
    }

    totals.bankedUsd += inflow.amountUsd;
    if (inflow.dilutive) {
      totals.dilutiveCashReceivedUsd += inflow.amountUsd;
    } else {
      totals.nonDilutiveCashReceivedUsd += inflow.amountUsd;
    }

    // Rule 4. Clamped at zero so an over-recorded repayment reads as settled rather than
    // as the lender owing us money.
    if (inflow.repayable) {
      totals.debtOutstandingUsd += Math.max(0, inflow.amountUsd - inflow.repaidUsd);
    }
  }

  totals.totalCapitalInUsd = totals.bankedUsd + totals.inKindActiveUsd;
  totals.netOfDebtUsd = totals.totalCapitalInUsd - totals.debtOutstandingUsd;
  return totals;
}
