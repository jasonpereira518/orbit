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
