import { and, desc, eq, gte, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { usageEvents } from "@/db/schema";
import { usageOperationLabel, type UsageSummary } from "@/lib/usage-summary-types";

export const USAGE_SUMMARY_DAYS = 30;

/**
 * One grouped statement over `usage_events_user_created_idx` (user_id, created_at). Costs
 * are the estimates stored per row at write time, so a price-table change never rewrites
 * what a past month cost. float8 sums: a bigint sum comes back as a string on neon-http.
 */
export async function loadUsageSummary(
  userId: string,
  opts: { now?: Date; days?: number } = {}
): Promise<UsageSummary> {
  const now = opts.now ?? new Date();
  const days = opts.days ?? USAGE_SUMMARY_DAYS;
  const since = new Date(now.getTime() - days * 86_400_000);
  const db = await getDb();

  const cost = sql<number>`coalesce(sum(${usageEvents.estimatedCostMicros}), 0)::float8`;
  const rows = await db
    .select({
      operation: usageEvents.operation,
      calls: sql<number>`count(*)::int`,
      failures: sql<number>`(count(*) filter (where ${usageEvents.success} = 0))::int`,
      inputTokens: sql<number>`coalesce(sum(${usageEvents.inputTokens}), 0)::float8`,
      outputTokens: sql<number>`coalesce(sum(${usageEvents.outputTokens}), 0)::float8`,
      costMicros: cost,
      unpricedCalls: sql<number>`(count(*) filter (where ${usageEvents.estimatedCostMicros} is null and ${usageEvents.success} = 1))::int`,
    })
    .from(usageEvents)
    .where(and(eq(usageEvents.userId, userId), gte(usageEvents.createdAt, since), sql`${usageEvents.createdAt} <= ${now}`))
    .groupBy(usageEvents.operation)
    .orderBy(desc(cost));

  const mapped = rows.map((r) => ({
    operation: r.operation,
    label: usageOperationLabel(r.operation),
    calls: Number(r.calls),
    failures: Number(r.failures),
    inputTokens: Number(r.inputTokens),
    outputTokens: Number(r.outputTokens),
    costMicros: Number(r.costMicros),
    unpricedCalls: Number(r.unpricedCalls),
  }));

  return {
    since: since.toISOString(),
    days,
    rows: mapped,
    totalCalls: mapped.reduce((n, r) => n + r.calls, 0),
    totalCostMicros: mapped.reduce((n, r) => n + r.costMicros, 0),
    unpricedCalls: mapped.reduce((n, r) => n + r.unpricedCalls, 0),
  };
}
