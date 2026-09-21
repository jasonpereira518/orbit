import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { gateEvents } from "@/db/schema";
import type { ExtensionFeature } from "@/lib/extension/contract";
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
  | "extensionPro"
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

/**
 * A gate hit from the browser extension, at most once per user, per sub-feature, per day.
 *
 * `recordGateHit` writes a row per refusal, which is right for a page someone deliberately
 * navigates to. The extension panel is different: it stays open while the user browses,
 * and a locked section is on screen for every profile they pass. One row per profile would
 * drown the table in a single afternoon and turn "how many people want this" into "how
 * many LinkedIn pages did one person scroll". `gateDemand` already counts people, not
 * rows, so a daily throttle loses nothing it reads.
 *
 * `src/lib/api/auth.ts` makes the same argument for not calling `requireEntitlement` per
 * API request, but no throttle existed until this one. One statement, no schema change:
 * the NOT EXISTS probe rides `gate_events_user_created_idx`.
 */
export async function recordExtensionGateHit(input: {
  userId: string;
  plan: Plan;
  feature: ExtensionFeature;
  context?: Record<string, unknown>;
}): Promise<boolean> {
  try {
    const db = await getDb();
    const context = JSON.stringify({ ...input.context, feature: input.feature });
    const result = await db.execute(sql`
      INSERT INTO gate_events (user_id, feature, plan, context)
      SELECT ${input.userId}, 'extensionPro', ${input.plan}, ${context}::jsonb
      WHERE NOT EXISTS (
        SELECT 1 FROM gate_events
        WHERE user_id = ${input.userId}
          AND feature = 'extensionPro'
          AND context->>'feature' = ${input.feature}
          AND created_at > now() - interval '24 hours'
      )
      RETURNING id
    `);
    return rowsOf<{ id: string }>(result).length > 0;
  } catch {
    // Same contract as `recordGateHit`: an unrecorded refusal costs one data point.
    return false;
  }
}
