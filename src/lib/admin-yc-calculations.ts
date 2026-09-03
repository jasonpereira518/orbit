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
