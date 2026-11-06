import { getEntitlements } from "@/lib/entitlements";
import { recordGateHit, recordGateHitThrottled, type GateFeature } from "@/lib/gate-events";
import type { Plan } from "@/lib/plans/plan-config";

/**
 * Where a refusal happened: `surface` is who was asking (the closed `SURFACES` list in
 * `product-event-schemas.ts`: web, extension, mcp, api, cron, webhook) and `route` is the
 * endpoint or operation that hit the wall. Stored on `gate_events.context`, so a pricing-v2
 * refusal can be located in the product instead of reading as an empty object.
 */
export type GateContext = { surface: string; route: string };

/**
 * Record a gate hit for a wall that is NOT a `requireEntitlement` (credits, speech caps).
 *
 * Throttled by default, one row per account, feature and hour: these walls are hit by loops
 * (a mic that retries, a chat that makes several model calls, a nightly job per account) and
 * an unthrottled row per attempt would drown the demand signal. Never throws and never
 * changes what the caller does next; the caller returns its own refusal exactly as before.
 *
 * `plan` is optional for callers that already hold it. Without it the plan is resolved here,
 * and a failure to resolve it skips the row (a refusal that goes unrecorded costs one data
 * point; a refusal that throws while recording would turn a 402 into a 500).
 */
export async function recordGateRefusal(
  userId: string,
  feature: GateFeature,
  context: GateContext,
  opts: { plan?: Plan; throttled?: boolean } = {}
): Promise<void> {
  try {
    const plan = opts.plan ?? (await getEntitlements(userId)).plan;
    const record = opts.throttled === false ? recordGateHit : recordGateHitThrottled;
    await record({ userId, feature, plan, context });
  } catch {
    // See above: recording is best effort.
  }
}
