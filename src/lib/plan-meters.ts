import { and, eq, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { planMeterUsage } from "@/db/schema";

/**
 * Monthly per-plan counters that are counts rather than money or audio seconds — today, the
 * contact enrichments a plan may run on Orbit's own Apollo key (Pro 10, Max and Lifetime 25).
 *
 * The cap is enforced by ONE conditional upsert: the row only moves when the new total still
 * fits, so two concurrent enrichments at 9 of 10 cannot both land. The month is the UTC
 * calendar month (`period_key` YYYY-MM); a counter never resets anything but itself.
 */
export type PlanMeter = "hosted_enrichment";

export function meterPeriodKey(now = new Date()): string {
  return now.toISOString().slice(0, 7);
}

/** The first of next month (UTC), for "resets on …" copy. */
export function meterResetsAt(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/**
 * Spend `units` against `limit` for this month. True when they fit (and are now counted);
 * false when they would exceed it — nothing is counted then.
 */
export async function consumePlanMeter(
  userId: string,
  meter: PlanMeter,
  units: number,
  limit: number,
  now = new Date()
): Promise<boolean> {
  if (units <= 0) return true;
  if (units > limit) return false;
  const db = await getDb();
  const periodKey = meterPeriodKey(now);
  const result = await db.execute(sql`
    INSERT INTO plan_meter_usage (user_id, meter, period_key, used, updated_at)
    VALUES (${userId}, ${meter}, ${periodKey}, ${units}, now())
    ON CONFLICT (user_id, meter, period_key) DO UPDATE
      SET used = plan_meter_usage.used + ${units}, updated_at = now()
      WHERE plan_meter_usage.used + ${units} <= ${limit}
    RETURNING used
  `);
  return rowsOf<{ used: number }>(result).length > 0;
}

/** How much of this month's meter is used. */
export async function planMeterUsed(userId: string, meter: PlanMeter, now = new Date()): Promise<number> {
  const db = await getDb();
  const [row] = await db
    .select({ used: planMeterUsage.used })
    .from(planMeterUsage)
    .where(
      and(
        eq(planMeterUsage.userId, userId),
        eq(planMeterUsage.meter, meter),
        eq(planMeterUsage.periodKey, meterPeriodKey(now))
      )
    );
  return row?.used ?? 0;
}
