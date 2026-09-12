import { and, asc, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { planUpgradeEvents } from "@/db/schema";
import {
  resolvePlan,
  type BillingColumns,
} from "@/lib/entitlements";

export type PlanUpgradeEvent = {
  id: string;
  plan: "orbit" | "lifetime";
  source: "subscription" | "lifetime" | "comp";
  createdAt: string;
};

const PLAN_RANK = { free: 0, orbit: 1, lifetime: 2 } as const;

/**
 * Queue a celebration only when effective access actually moves upward.
 *
 * This intentionally compares resolved plans rather than individual billing columns: a
 * subscription webhook must not celebrate Pro over an existing Lifetime grant, and adding
 * a comp for the same plan is provenance—not an upgrade. Database uniqueness handles both
 * webhook retries and concurrent deliveries.
 */
export async function queuePlanUpgradeTransition(input: {
  userId: string;
  before: BillingColumns | null | undefined;
  after: BillingColumns | null | undefined;
  eventKey: string;
}) {
  const previous = resolvePlan(input.before);
  const next = resolvePlan(input.after);
  if (next.plan === "free" || PLAN_RANK[next.plan] <= PLAN_RANK[previous.plan]) {
    return null;
  }

  const source = next.source;
  if (source === "free") return null;

  const db = await getDb();
  const [created] = await db
    .insert(planUpgradeEvents)
    .values({
      userId: input.userId,
      plan: next.plan,
      source,
      eventKey: input.eventKey,
    })
    .onConflictDoNothing()
    .returning();

  return created ?? null;
}

/**
 * Atomically claims the oldest pending celebration for one account.
 *
 * The read-then-conditional-update shape is deliberate: simultaneous tabs may both read
 * the same row, but only one can change `claimed_at` from null. The loser returns nothing
 * and therefore never animates a duplicate.
 */
export async function claimPendingPlanUpgrade(
  userId: string
): Promise<PlanUpgradeEvent | null> {
  const db = await getDb();
  const pending = await db.query.planUpgradeEvents.findFirst({
    where: and(
      eq(planUpgradeEvents.userId, userId),
      isNull(planUpgradeEvents.claimedAt)
    ),
    orderBy: [asc(planUpgradeEvents.createdAt)],
  });
  if (!pending) return null;

  const [claimed] = await db
    .update(planUpgradeEvents)
    .set({ claimedAt: new Date() })
    .where(
      and(
        eq(planUpgradeEvents.id, pending.id),
        eq(planUpgradeEvents.userId, userId),
        isNull(planUpgradeEvents.claimedAt)
      )
    )
    .returning();

  if (!claimed) return null;
  return {
    id: claimed.id,
    plan: claimed.plan,
    source: claimed.source,
    createdAt: claimed.createdAt.toISOString(),
  };
}
