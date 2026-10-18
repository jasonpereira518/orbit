import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import { isKnownGate, mostRecentGate, type KnownGate } from "@/lib/gate-events";
import { track } from "@/lib/product-events";
import { eventId } from "@/lib/product-event-ids";
import { CANCEL_REASONS, type INTERVALS, type PLANS } from "@/lib/product-event-schemas";

/**
 * `checkout_started` and `subscription_canceled`, shared by the billing actions and the smoke
 * (the actions need a Clerk session; these take a user id).
 *
 * Ids, enums and counts only. The `gate` is validated against the closed `GATES` list, so a
 * hand-edited `?gate=` can never put anything else on an event.
 */

/** The gate that sent someone to checkout: the explicit `?gate=` when it is a known key, else the most recent wall they hit in the last day. */
export async function resolveCheckoutGate(userId: string, explicit: unknown): Promise<KnownGate | undefined> {
  if (isKnownGate(explicit)) return explicit;
  return (await mostRecentGate(userId)) ?? undefined;
}

/**
 * A Stripe Checkout Session now exists. Recorded once per session id, so a retry inside one
 * call cannot double-count; a second click that opens a second session is a second start.
 * Best effort: the buyer is already on their way to Stripe.
 */
export async function trackCheckoutStarted(
  userId: string,
  input: {
    sessionId: string;
    plan: (typeof PLANS)[number];
    interval: (typeof INTERVALS)[number];
    /** The `gate` the page or button passed; validated here. */
    gate?: unknown;
  }
): Promise<void> {
  const gate = await resolveCheckoutGate(userId, input.gate);
  track(
    "checkout_started",
    { plan: input.plan, interval: input.interval, ...(gate ? { from_gate: gate } : {}) },
    { userId, id: eventId("checkout_started", input.sessionId) }
  );
}

function isCancelReason(value: unknown): value is (typeof CANCEL_REASONS)[number] {
  return typeof value === "string" && (CANCEL_REASONS as readonly string[]).includes(value);
}

/**
 * The person asked to cancel at the period end and Stripe accepted. One per cancellation
 * (user and the period it ends), so pressing Cancel twice, or cancelling again after a
 * resume in the same period, is one event. `tenure_days` is how long the account has existed.
 */
export async function trackSubscriptionCanceled(
  userId: string,
  input: { periodEnd: number | null; reason?: unknown }
): Promise<void> {
  const db = await getDb();
  const row = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
    columns: { createdAt: true },
  });
  const tenureDays = row ? Math.max(0, Math.floor((Date.now() - row.createdAt.getTime()) / 86_400_000)) : 0;
  track(
    "subscription_canceled",
    { tenure_days: tenureDays, ...(isCancelReason(input.reason) ? { reason: input.reason } : {}) },
    { userId, id: eventId("subscription_canceled", userId, String(input.periodEnd ?? "")) }
  );
}
