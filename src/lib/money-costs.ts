import { and, desc, gte, lt, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import { acquisitionSpend, speechUsage, startupExpenses } from "@/db/schema";
import { infraBreakdown, monthStart, monthlyInfraCents } from "@/lib/infra-costs";
import { deepgramMicrosPerSecond } from "@/lib/speech-cost";

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
  /** Marketing and acquisition spend attributed to the month (by `created_at`; see below). */
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
 * Acquisition spend belongs to exactly ONE month: the one its `created_at` falls in. The
 * entry form takes a month and stamps the row at that month's first instant (the legacy
 * `period_start`/`period_end` columns are still filled, as that month's bounds, but nothing
 * reads them). The earlier rule counted rows by period OVERLAP, and because the form always
 * wrote "the 30 days ending now", a row logged on the 10th overlapped two calendar months and
 * was counted in both (audit M7).
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
      .where(and(gte(acquisitionSpend.createdAt, start), lt(acquisitionSpend.createdAt, end))),
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
 * What Stripe takes: 2.9% + 30c per successful charge, plus Stripe Billing's 0.7% on
 * subscription invoices.
 *
 * Computed rather than recorded, because Stripe's balance transactions are not mirrored
 * anywhere and five lines of arithmetic does not justify a sixth integration. It is an
 * ESTIMATE and is labelled as one on screen — the real figure moves with card type,
 * currency and country, and quoting a computed number as though it were reconciled is the
 * same mistake as `subscribers x $5`. `cost/reconcile` compares it with the real fee total.
 *
 * The 30c is per CHARGE. An earlier version passed one charge for the whole month, which
 * undercounted the fixed fee by 30c for every renewal after the first.
 */
export const STRIPE_PERCENT_FEE = 0.029;
export const STRIPE_FIXED_FEE_CENTS = 30;
export const STRIPE_BILLING_PERCENT_FEE = 0.007;

export function estimatedStripeFeesCents(
  grossCents: number,
  chargeCount: number,
  recurringCents = 0
): number {
  if (grossCents <= 0 || chargeCount <= 0) return 0;
  return Math.round(
    grossCents * STRIPE_PERCENT_FEE +
      chargeCount * STRIPE_FIXED_FEE_CENTS +
      Math.max(0, recurringCents) * STRIPE_BILLING_PERCENT_FEE
  );
}

/** Total acquisition spend whose month falls in `[since, until)`, in dollars. One month per row. */
export async function acquisitionSpendUsd(since: Date, until: Date): Promise<number> {
  const db = await getDb();
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${acquisitionSpend.amountUsd}), 0)` })
    .from(acquisitionSpend)
    .where(and(gte(acquisitionSpend.createdAt, since), lt(acquisitionSpend.createdAt, until)));
  const n = Number(row?.total ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** Acquisition spend grouped by channel, for CAC. Attributed by `created_at` month, as above. */
export async function acquisitionByChannel(since: Date, until: Date) {
  const db = await getDb();
  const rows = await db
    .select({
      channel: acquisitionSpend.channel,
      total: sql<string>`coalesce(sum(${acquisitionSpend.amountUsd}), 0)`,
    })
    .from(acquisitionSpend)
    .where(and(gte(acquisitionSpend.createdAt, since), lt(acquisitionSpend.createdAt, until)))
    .groupBy(acquisitionSpend.channel)
    .orderBy(desc(sql`sum(${acquisitionSpend.amountUsd})`));

  return rows.map((r) => ({
    channel: r.channel,
    spendCents: usdToCents(Number(r.total ?? 0)),
  }));
}

/**
 * SQL: micros of Deepgram spend for one `speech_usage` row, priced from the same per-second
 * rates `speechCostMicros` uses (`deepgramMicrosPerSecond`), so a grouped-in-SQL figure and the
 * JS-priced total cannot disagree on the rate — only on sub-micro rounding.
 */
export function speechMicrosSql(): SQL {
  const rate = (kind: "meeting" | "shortform", source: "stream" | "file") =>
    sql.raw(deepgramMicrosPerSecond(kind, source).toFixed(6));
  return sql`(${speechUsage.seconds}::numeric * CASE
    WHEN ${speechUsage.kind} = 'meeting' AND ${speechUsage.source} = 'stream' THEN ${rate("meeting", "stream")}
    WHEN ${speechUsage.kind} = 'meeting' THEN ${rate("meeting", "file")}
    WHEN ${speechUsage.source} = 'stream' THEN ${rate("shortform", "stream")}
    ELSE ${rate("shortform", "file")}
  END)`;
}

/** Deepgram spend per account in `[since, until)`, priced from `speech_usage` seconds. */
export async function speechSpendByUser(since: Date, until: Date = new Date()): Promise<Map<string, number>> {
  const db = await getDb();
  const rows = await db
    .select({
      userId: speechUsage.userId,
      micros: sql<string>`round(coalesce(sum(${speechMicrosSql()}), 0))::bigint`,
    })
    .from(speechUsage)
    .where(and(gte(speechUsage.createdAt, since), lt(speechUsage.createdAt, until)))
    .groupBy(speechUsage.userId);
  return new Map(rows.map((r) => [r.userId, Number(r.micros) || 0]));
}
