import { asc, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { billingCancellationQueue } from "@/db/schema";

/**
 * Cancelling a closing account's Stripe subscriptions, wherever the closing starts.
 *
 * An account is closed four ways: Settings → Delete account, Clerk's `user.deleted` webhook
 * (the person deleted themselves on Clerk's account page, or the operator did in the Clerk
 * dashboard), the admin hard-delete, and the orphan sweep. Only the first used to cancel
 * anything — the other three purged the settings row, and with it `stripe_customer_id`, the
 * one link back to a subscription that went on charging a person with no account to cancel
 * from. Cancelling now happens inside the purge itself (the `account` step in
 * `user-data.ts`), so no path can skip it.
 *
 * Three of those paths cannot refuse: the Clerk account is already gone. So a failed cancel
 * does not stop the erasure — the customer id goes into `billing_cancellation_queue`
 * (nothing else: no user id, no email) and the hourly job retries it until Stripe confirms.
 * `billing.cancel_stuck` pages the operator when one keeps failing.
 */

/** Stripe statuses that can still charge. */
export const CHARGEABLE_STATUSES = new Set(["active", "trialing", "past_due", "unpaid", "incomplete"]);

export type SubscriptionCanceller = (stripeCustomerId: string) => Promise<void>;

/** Cancels every subscription of this customer that could still charge. Idempotent. */
export const cancelChargeableSubscriptions: SubscriptionCanceller = async (stripeCustomerId) => {
  if (!process.env.STRIPE_SECRET_KEY) return;
  const { getStripe } = await import("@/lib/stripe");
  const stripe = getStripe();
  const subscriptions = await stripe.subscriptions.list({
    customer: stripeCustomerId,
    status: "all",
    limit: 100,
  });
  for (const subscription of subscriptions.data) {
    if (CHARGEABLE_STATUSES.has(subscription.status)) {
      await stripe.subscriptions.cancel(subscription.id);
    }
  }
};

let cancellerOverride: SubscriptionCanceller | null = null;

/** Smoke scripts stand in for Stripe here; `null` restores the real call. */
export function setSubscriptionCancellerForTests(fn: SubscriptionCanceller | null): void {
  cancellerOverride = fn;
}

function canceller(): SubscriptionCanceller {
  return cancellerOverride ?? cancelChargeableSubscriptions;
}

/**
 * Cancel now, or queue for the hourly retry. Never throws: an erasure must not wait on Stripe.
 * Returns whether the cancel went through.
 */
export async function cancelOrQueue(stripeCustomerId: string): Promise<boolean> {
  try {
    await canceller()(stripeCustomerId);
    return true;
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    const db = await getDb();
    await db
      .insert(billingCancellationQueue)
      .values({ stripeCustomerId, lastError: message })
      .onConflictDoUpdate({
        target: billingCancellationQueue.stripeCustomerId,
        set: { lastError: message, lastAttemptAt: new Date() },
      });
    return false;
  }
}

/** The hourly retry. A row leaves the queue only when Stripe confirms the cancel. */
export async function retryQueuedCancellations(opts: { now: Date; limit?: number }) {
  const db = await getDb();
  const stats = { found: 0, cancelled: 0, stillFailing: 0 };
  const rows = await db
    .select()
    .from(billingCancellationQueue)
    .orderBy(asc(billingCancellationQueue.lastAttemptAt))
    .limit(opts.limit ?? 25);
  stats.found = rows.length;
  for (const row of rows) {
    try {
      await canceller()(row.stripeCustomerId);
      await db
        .delete(billingCancellationQueue)
        .where(eq(billingCancellationQueue.stripeCustomerId, row.stripeCustomerId));
      stats.cancelled += 1;
    } catch (err) {
      await db
        .update(billingCancellationQueue)
        .set({
          attempts: sql`${billingCancellationQueue.attempts} + 1`,
          lastError: (err instanceof Error ? err.message : String(err)).slice(0, 500),
          lastAttemptAt: opts.now,
        })
        .where(eq(billingCancellationQueue.stripeCustomerId, row.stripeCustomerId));
      stats.stillFailing += 1;
    }
  }
  return stats;
}
