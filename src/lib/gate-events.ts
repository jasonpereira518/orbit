import { and, eq, gt } from "drizzle-orm";
import { getDb } from "@/db";
import { gateEvents } from "@/db/schema";
import { unlockPlanFor, type FeatureKey, type Plan } from "@/lib/plans/plan-config";

/**
 * Records every time a plan gate refused someone.
 *
 * WHY THIS IS NOT AN ERROR, and deliberately not in `error_events`. A free user hitting a
 * paywall is the product working exactly as designed. Filing it as an error would put
 * "somebody wanted to pay us" on the Health screen next to expired OAuth tokens and
 * corrupt the meaning of both screens at once — Health answers *what is broken*, and this
 * is not.
 *
 * WHY IT IS WORTH A TABLE. `usage_events` records what happened; by construction it cannot
 * record what someone tried to do and could not. That makes this the only evidence of
 * demand for a feature the user never reached — which is precisely the input the pricing
 * question needs. A wall somebody bounces off repeatedly is a feature they would pay for;
 * a wall nobody ever reaches is in the wrong tier.
 *
 * Awaited rather than deferred, which is affordable because it fires only on refusal:
 * steady-state cost is exactly zero, and the request is already on its way to throwing.
 * This module imports only drizzle and `@/db` — no `next/server`, which would hang every
 * tsx script that reaches it (see `src/lib/user-settings.ts`).
 */

/**
 * The `FeatureKey` values plus the metered caps gated outside `requireEntitlement`: the free
 * contact cap, and the monthly Apollo enrichment and speech allowances.
 */
export type GateFeature = FeatureKey | "contacts";

export async function recordGateHit(input: {
  userId: string;
  feature: GateFeature;
  plan: Plan;
  context?: Record<string, unknown>;
}): Promise<void> {
  try {
    const db = await getDb();
    await db.insert(gateEvents).values({
      userId: input.userId,
      feature: input.feature,
      // Denormalised on purpose: the row means "their plan was X when they hit this wall".
      // Reading it back off `user_settings` later would answer for today instead, and the
      // interesting rows are exactly the ones where the plan has since changed.
      plan: input.plan,
      // The cheapest plan someone could buy to get past this wall. Denormalised for the
      // same reason as `plan`: the demand screen reads "who wanted Max", and plan
      // boundaries move between pricing versions.
      unlockPlan: unlockPlanFor(input.feature),
      context: input.context ?? {},
    });
  } catch {
    // A refusal that goes unrecorded costs one data point. A refusal that throws while
    // recording would turn a paywall into a 500.
  }
}

/** A machine-driven wall is recorded at most once per user, feature and window. */
export const GATE_HIT_THROTTLE_MS = 60 * 60 * 1000;

/**
 * `recordGateHit` for paths a machine hits on a schedule: the REST API (an integration
 * polling every few minutes after its account moved to Pro) and bulk contact imports that
 * run into the free cap. Unthrottled, one polling integration writes hundreds of rows a
 * day and drowns the signal the table exists to collect. The read-then-insert can race
 * and record twice in one window, which costs a duplicate data point and nothing else.
 */
export async function recordGateHitThrottled(input: {
  userId: string;
  feature: GateFeature;
  plan: Plan;
  context?: Record<string, unknown>;
}): Promise<void> {
  try {
    const db = await getDb();
    const since = new Date(Date.now() - GATE_HIT_THROTTLE_MS);
    const [recent] = await db
      .select({ id: gateEvents.id })
      .from(gateEvents)
      .where(
        and(
          eq(gateEvents.userId, input.userId),
          eq(gateEvents.feature, input.feature),
          gt(gateEvents.createdAt, since)
        )
      )
      .limit(1);
    if (recent) return;
  } catch {
    return;
  }
  await recordGateHit(input);
}
