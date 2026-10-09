import { and, eq, gt, gte, inArray, ne, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { billingEvents, errorEvents, usageEvents } from "@/db/schema";
import { managedAiSwitchedOff, managedCostSql, managedKeysConfigured } from "@/lib/ai-access";
import { ERROR_SOURCES } from "@/lib/error-events";
import type { ManagedAiOpsFacts } from "@/lib/ops-alerts";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * The aggregate picture of Orbit's managed AI keys, for the ops sweep's catalogue
 * (`managedAiConditions` in `ops-alerts.ts`): who is on included AI, what it cost, the
 * revenue behind it, who has run dry, and which provider keys are failing. Five small reads,
 * all on indexed columns or small tables.
 */
export async function loadManagedAiOpsFacts(now: Date): Promise<ManagedAiOpsFacts> {
  const db = await getDb();
  const hourAgo = new Date(now.getTime() - HOUR_MS);
  const dayAgo = new Date(now.getTime() - DAY_MS);
  const monthAgo = new Date(now.getTime() - 30 * DAY_MS);
  const orbit = eq(usageEvents.keyOwner, "orbit");
  // Deepgram rows carry keyOwner "orbit" too (Orbit's own key), but they are metered by
  // `speech_usage`, not credits — without this, voice-note volume would inflate the
  // spend-spike and margin alerts below.
  const notDeepgram = ne(usageEvents.provider, "deepgram");

  const [included, spend, revenue, dry, failing] = await Promise.all([
    // `resolvePlan`, in SQL, narrowed to the plans with included AI.
    db.execute(sql`
      SELECT count(*)::int AS n FROM user_settings s
       WHERE CASE
               WHEN s.comped_plan IS NOT NULL THEN s.comped_plan
               WHEN s.lifetime_purchased_at IS NOT NULL THEN 'lifetime'
               WHEN s.subscription_plan IN ('orbit', 'max')
                AND (s.subscription_status = 'active' OR s.subscription_period_end > now())
                 THEN s.subscription_plan
               ELSE 'free'
             END IN ('orbit', 'max')
    `),
    db
      .select({
        day: sql<string>`coalesce(sum(${managedCostSql()}) FILTER (WHERE ${usageEvents.createdAt} > ${dayAgo}), 0)::bigint`,
        month: sql<string>`coalesce(sum(${managedCostSql()}), 0)::bigint`,
      })
      .from(usageEvents)
      .where(and(orbit, gt(usageEvents.createdAt, monthAgo), notDeepgram)),
    db
      .select({ cents: sql<string>`coalesce(sum(${billingEvents.amountCents}), 0)::bigint` })
      .from(billingEvents)
      .where(and(inArray(billingEvents.kind, ["payment", "credit_pack"]), gt(billingEvents.effectiveAt, monthAgo))),
    db.execute(sql`
      SELECT count(DISTINCT a.user_id)::int AS n
        FROM credit_grants a
       WHERE a.kind = 'allowance' AND a.status = 'active'
         AND a.period_start <= now() AND a.period_end > now()
         AND a.plan IN ('orbit', 'max')
         AND a.micros_remaining = 0
         AND NOT EXISTS (
           SELECT 1 FROM credit_grants p
            WHERE p.user_id = a.user_id AND p.kind = 'pack' AND p.status = 'active' AND p.micros_remaining > 0
         )
    `),
    db
      .selectDistinct({ provider: sql<string | null>`${errorEvents.context}->>'provider'` })
      .from(errorEvents)
      .where(and(eq(errorEvents.source, ERROR_SOURCES.managedAi), gte(errorEvents.createdAt, hourAgo))),
  ]);

  return {
    configured: Object.values(managedKeysConfigured()).some(Boolean),
    switchedOff: managedAiSwitchedOff(),
    includedAccounts: Number(rowsOf<{ n: number }>(included)[0]?.n ?? 0),
    spentLast24hMicros: Number(spend[0]?.day ?? 0),
    spentLast30dMicros: Number(spend[0]?.month ?? 0),
    revenueLast30dCents: Number(revenue[0]?.cents ?? 0),
    accountsAtCap: Number(rowsOf<{ n: number }>(dry)[0]?.n ?? 0),
    failingProviders: failing.map((f) => f.provider ?? "unknown"),
  };
}
