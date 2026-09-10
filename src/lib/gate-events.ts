import { getDb } from "@/db";
import { gateEvents } from "@/db/schema";
import type { Plan } from "@/lib/plan-limits";

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

/** The `FeatureKey` values plus the free contact cap, which is gated separately. */
export type GateFeature =
  | "outreach"
  | "hostedSending"
  | "hostedEnrichment"
  | "recruiters"
  | "sync"
  | "extension"
  | "api"
  | "contacts";

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
      context: input.context ?? {},
    });
  } catch {
    // A refusal that goes unrecorded costs one data point. A refusal that throws while
    // recording would turn a paywall into a 500.
  }
}
