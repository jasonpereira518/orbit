import { and, desc, gte, lte, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { acquisitionSpend, startupExpenses } from "@/db/schema";
import { infraBreakdown, monthStart, monthlyInfraCents } from "@/lib/infra-costs";

/**
 * One answer to "what did Orbit spend this month", assembled from the two tables that
 * each hold half of it.
 *
 * WHY THIS EXISTS. `infra_costs` and `startup_expenses` both record hand-entered money
 * out, and nothing made them agree. Runway's burn read only `startup_expenses`; anything
 * computing gross margin would naturally read only `infra_costs`. Two screens would then
 * quote different costs for the same month with equal confidence, and there would be no
 * way to tell from either one which was wrong.
 *
 * They are NOT merged into one table, because they are genuinely different shapes and the
 * difference is load-bearing:
 *
 *   `infra_costs`      one row per provider per month, upserted. A bill gets restated, and
 *                      the correction must replace the first figure rather than double it.
 *   `startup_expenses` an append-only log of one-off costs — a domain, an incorporation
 *                      fee, a conference. Upserting these would silently collapse two real
 *                      expenses that happened to share a category and a month.
 *
 * So the reconciliation is a read, not a migration: one function both callers use.
 *
 * Cents throughout. `startup_expenses.amount_usd` is a `real`, which is exactly why it is
 * converted here and never summed alongside integer cents in the caller.
 */

/** `startup_expenses` stores dollars as a float; the ledger and infra costs use cents. */
function usdToCents(usd: number): number {
  return Math.round(usd * 100);
}

export type MonthlyCosts = {
  month: Date;
  /** Recurring provider bills for the month. */
  infraCents: number;
  /** One-off expenses incurred within the month. */
  oneOffCents: number;
  /** Marketing and acquisition spend overlapping the month. */
  acquisitionCents: number;
  totalCents: number;
  /**
   * True when no provider bill was entered for this month at all. Rendered as "not
   * entered", never as $0 — a zero that means "unknown" is the fastest route to a
   * confidently wrong margin.
   */
  infraMissing: boolean;
};

/**
 * Everything Orbit spent in one calendar month.
 *
 * Acquisition spend is counted by OVERLAP rather than by start date, for the same reason
 * `loadUnitEconomics` does it: the entry form always writes `periodEnd = now`, so a row
 * logged mid-month starts before the month it is being counted for and a start-based
 * filter drops it entirely.
 */
export async function monthlyCosts(month: Date): Promise<MonthlyCosts> {
  const db = await getDb();
  const start = monthStart(month);
  const end = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)
  );

  const [infraCents, infraRows, oneOffRows, acquisitionRows] = await Promise.all([
    monthlyInfraCents(start),
    infraBreakdown(start),
    db
      .select({ total: sql<string>`coalesce(sum(${startupExpenses.amountUsd}), 0)` })
      .from(startupExpenses)
      .where(
        and(
          gte(startupExpenses.incurredAt, start),
          sql`${startupExpenses.incurredAt} < ${end}`
        )
      ),
    db
      .select({ total: sql<string>`coalesce(sum(${acquisitionSpend.amountUsd}), 0)` })
      .from(acquisitionSpend)
      .where(
        and(
          gte(acquisitionSpend.periodEnd, start),
          lte(acquisitionSpend.periodStart, end)
        )
      ),
  ]);

  const num = (v: string | number | null | undefined) => {
    const n = typeof v === "number" ? v : Number(v ?? 0);
    return Number.isFinite(n) ? n : 0;
  };

  const oneOffCents = usdToCents(num(oneOffRows[0]?.total));
  const acquisitionCents = usdToCents(num(acquisitionRows[0]?.total));

  return {
    month: start,
    infraCents,
    oneOffCents,
    acquisitionCents,
    totalCents: infraCents + oneOffCents + acquisitionCents,
    infraMissing: infraRows.length === 0,
  };
}

/** The same figure, for a run of consecutive months, oldest first. */
export async function monthlyCostSeries(months = 6): Promise<MonthlyCosts[]> {
  const now = monthStart(new Date());
  const wanted: Date[] = [];
  for (let i = months - 1; i >= 0; i--) {
    wanted.push(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)));
  }
  return Promise.all(wanted.map((m) => monthlyCosts(m)));
}

/**
 * What Stripe takes: 2.9% + 30c per successful charge.
 *
 * Computed rather than recorded, because Stripe's balance transactions are not mirrored
 * anywhere and five lines of arithmetic does not justify a sixth integration. It is an
 * ESTIMATE and is labelled as one on screen — the real figure moves with card type,
 * currency and country, and quoting a computed number as though it were reconciled is the
 * same mistake as `subscribers x $5`.
 */
export const STRIPE_PERCENT_FEE = 0.029;
export const STRIPE_FIXED_FEE_CENTS = 30;

export function estimatedStripeFeesCents(
  grossCents: number,
  chargeCount: number
): number {
  if (grossCents <= 0 || chargeCount <= 0) return 0;
  return Math.round(grossCents * STRIPE_PERCENT_FEE + chargeCount * STRIPE_FIXED_FEE_CENTS);
}

/** Acquisition spend grouped by channel, for CAC. Overlap-based, as above. */
export async function acquisitionByChannel(since: Date, until: Date) {
  const db = await getDb();
  const rows = await db
    .select({
      channel: acquisitionSpend.channel,
      total: sql<string>`coalesce(sum(${acquisitionSpend.amountUsd}), 0)`,
    })
    .from(acquisitionSpend)
    .where(
      and(gte(acquisitionSpend.periodEnd, since), lte(acquisitionSpend.periodStart, until))
    )
    .groupBy(acquisitionSpend.channel)
    .orderBy(desc(sql`sum(${acquisitionSpend.amountUsd})`));

  return rows.map((r) => ({
    channel: r.channel,
    spendCents: usdToCents(Number(r.total ?? 0)),
  }));
}
