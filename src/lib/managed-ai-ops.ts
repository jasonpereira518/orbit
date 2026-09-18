import { and, eq, gt, gte, isNull, or, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { billingEvents, errorEvents, usageEvents, userSettings } from "@/db/schema";
import { managedAiSwitchedOff, managedCostSql, managedKeysConfigured } from "@/lib/ai-access";
import { ERROR_SOURCES } from "@/lib/error-events";
import { MANAGED_AI_BUDGET, managedWindow } from "@/lib/managed-ai-policy";
import type { ManagedAiOpsFacts } from "@/lib/ops-alerts";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * The aggregate picture of Orbit's managed AI keys, for the ops sweep's catalogue
 * (`managedAiConditions` in `ops-alerts.ts`). Five small reads, all on indexed columns:
 * spend windows ride `usage_events_created_idx`, the at-cap count rides the per-user index
 * over one month, and the Lifetime counts are a scan of a table with one row per account.
 */
export async function loadManagedAiOpsFacts(now: Date): Promise<ManagedAiOpsFacts> {
  const db = await getDb();
  const hourAgo = new Date(now.getTime() - HOUR_MS);
  const dayAgo = new Date(now.getTime() - DAY_MS);
  const monthAgo = new Date(now.getTime() - 30 * DAY_MS);
  const { start: monthStart } = managedWindow(now);
  const orbit = eq(usageEvents.keyOwner, "orbit");

  const [lifetime, spend, cash, atCap, failing] = await Promise.all([
    // `resolvePlan`'s Lifetime branch: a lifetime comp, or a purchase with no comp over it.
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(userSettings)
      .where(
        or(
          eq(userSettings.compedPlan, "lifetime"),
          and(isNull(userSettings.compedPlan), sql`${userSettings.lifetimePurchasedAt} IS NOT NULL`),
        ),
      ),
    db
      .select({
        day: sql<string>`coalesce(sum(${managedCostSql()}) FILTER (WHERE ${usageEvents.createdAt} > ${dayAgo}), 0)::bigint`,
        month: sql<string>`coalesce(sum(${managedCostSql()}), 0)::bigint`,
      })
      .from(usageEvents)
      .where(and(orbit, gt(usageEvents.createdAt, monthAgo))),
    db
      .select({ cents: sql<string>`coalesce(sum(${billingEvents.amountCents}), 0)::bigint` })
      .from(billingEvents)
      .where(eq(billingEvents.kind, "lifetime")),
    db.execute(sql`
      SELECT count(*)::int AS n FROM (
        SELECT ${usageEvents.userId}
          FROM ${usageEvents}
         WHERE ${usageEvents.keyOwner} = 'orbit' AND ${usageEvents.createdAt} >= ${monthStart}
         GROUP BY ${usageEvents.userId}
        HAVING sum(${managedCostSql()}) >= ${MANAGED_AI_BUDGET.monthlyCostMicros}
            OR count(*) >= ${MANAGED_AI_BUDGET.monthlyCalls}
      ) capped
    `),
    db
      .selectDistinct({ provider: sql<string | null>`${errorEvents.context}->>'provider'` })
      .from(errorEvents)
      .where(and(eq(errorEvents.source, ERROR_SOURCES.managedAi), gte(errorEvents.createdAt, hourAgo))),
  ]);

  return {
    configured: Object.values(managedKeysConfigured()).some(Boolean),
    switchedOff: managedAiSwitchedOff(),
    lifetimeAccounts: lifetime[0]?.n ?? 0,
    spentLast24hMicros: Number(spend[0]?.day ?? 0),
    spentLast30dMicros: Number(spend[0]?.month ?? 0),
    lifetimeCashCents: Number(cash[0]?.cents ?? 0),
    accountsAtCap: Number(rowsOf<{ n: number }>(atCap)[0]?.n ?? 0),
    failingProviders: failing.map((f) => f.provider ?? "unknown"),
  };
}
