import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import { isAdminUser } from "@/lib/admin";
import { ledgerMrrCents, monthlyValueCents, recordBillingEventStrict } from "@/lib/billing-events";
import { isClerkConfigured, isDemoMode } from "@/lib/demo-account";
import { resolvePlan } from "@/lib/entitlements";
import { UserFacingError } from "@/lib/errors";
import { track } from "@/lib/product-events";
import { reportError } from "@/lib/report-error";
import { purgeUserData } from "@/lib/user-data";

/**
 * Deleting your own account, from Settings.
 *
 * Four steps, in an order chosen for which half-finished state is safe to be stuck in:
 *   1. Cancel any live Stripe subscription. Orbit has no self-serve cancellation, so a
 *      deleted account that kept its subscription would be billed with no way back in.
 *      If this fails, nothing else happens.
 *   2. While the account still exists: book its churn in the billing ledger and record the
 *      `account_deleted` product event (`bookChurnOnDeletion`, below). Neither can fail the
 *      deletion.
 *   3. `purgeUserData(userId, { keepSettings: false })` — every table, the settings row,
 *      keys and tokens included. Idempotent.
 *   4. Delete the Clerk user. Clerk then fires `user.deleted`, whose purge finds nothing.
 *
 * The external calls are injected so `scripts/smoke-delete-my-account.ts` can exercise every
 * ordering without Stripe or Clerk.
 */
export type AccountDeletionDeps = {
  cancelSubscriptions: (stripeCustomerId: string) => Promise<void>;
  deleteLogin: (userId: string) => Promise<void>;
};

/** Stripe statuses that can still charge. */
const CHARGEABLE = new Set(["active", "trialing", "past_due", "unpaid", "incomplete"]);

export const defaultAccountDeletionDeps: AccountDeletionDeps = {
  async cancelSubscriptions(stripeCustomerId) {
    if (!process.env.STRIPE_SECRET_KEY) return;
    const { getStripe } = await import("@/lib/stripe");
    const stripe = getStripe();
    const subscriptions = await stripe.subscriptions.list({
      customer: stripeCustomerId,
      status: "all",
      limit: 100,
    });
    for (const subscription of subscriptions.data) {
      if (CHARGEABLE.has(subscription.status)) {
        await stripe.subscriptions.cancel(subscription.id);
      }
    }
  },
  async deleteLogin(userId) {
    if (!isClerkConfigured() || isDemoMode()) return;
    const { clerkClient } = await import("@clerk/nextjs/server");
    const clerk = await clerkClient();
    try {
      await clerk.users.deleteUser(userId);
    } catch (err) {
      // Already gone (a retry after a timeout that did succeed) is success.
      if ((err as { status?: number }).status === 404) return;
      throw err;
    }
  },
};

/**
 * Take a deleted account's subscription out of the ledger BEFORE its row is purged.
 *
 * WHY. `purgeUserData` removes the `user_settings` row, and Stripe's
 * `customer.subscription.deleted` arrives afterwards: `attributeStripeEvent` finds no account,
 * `beforeCents` reads 0, and no churn is ever booked. The ledger then holds the subscriber's
 * +MRR forever — MRR, ARR and growth overstated, and the drift panel blaming a webhook that
 * did arrive (audit M2).
 *
 * WHAT. One `churn` row for the account's current recurring value, effective now, keyed
 * `del:<userId>:<customer>` so a retry of this function cannot book it twice. The later Stripe
 * event then finds no row at all and books nothing, so there is no second churn to add.
 *
 * CAPPED BY THE LEDGER. The amount is `min(live value, what the ledger currently holds for the
 * account)`. If Stripe's `deleted` webhook raced the cancel call and already booked the churn,
 * the ledger holds 0 for this account and nothing more is booked; if the account was never in
 * the ledger (pre-ledger subscriber) nothing is booked, which is also what keeps the drift at
 * zero. Booking the raw value in either case would push the ledger below the truth.
 *
 * NEVER BLOCKS. Billing has already been stopped at this point, and deleting a person's data
 * on request outranks tidy books: any failure is swallowed and reported at warning level (the
 * drift panel is the backstop for the one account that slips through).
 *
 * Returns the cents booked, for the smoke test.
 */
export async function bookChurnOnDeletion(userId: string, now: Date = new Date()): Promise<number> {
  try {
    const db = await getDb();
    const row = await db.query.userSettings.findFirst({
      where: eq(userSettings.userId, userId),
      columns: {
        stripeCustomerId: true,
        foundingSubscriptionId: true,
        subscriptionPlan: true,
        subscriptionStatus: true,
        subscriptionPeriodEnd: true,
        subscriptionMonthlyCents: true,
      },
    });
    if (!row || (row.subscriptionPlan !== "orbit" && row.subscriptionPlan !== "max")) return 0;

    // active, past_due, or canceled-but-paid-through all carry their full value; anything
    // else (canceled and lapsed, never subscribed) is worth 0 and has nothing to take out.
    const value = monthlyValueCents(
      row.subscriptionStatus,
      row.subscriptionPeriodEnd,
      now,
      row.subscriptionMonthlyCents,
      row.subscriptionPlan
    );
    if (value <= 0) return 0;

    const held = await ledgerMrrCents(userId);
    const amount = Math.min(value, held);
    if (amount <= 0) return 0;

    const wrote = await recordBillingEventStrict({
      source: "stripe",
      eventId: `del:${userId}:${row.foundingSubscriptionId ?? row.stripeCustomerId ?? "local"}`,
      kind: "churn",
      userId,
      mrrDeltaCents: -amount,
      effectiveAt: now,
      detail: { reason: "account_deleted", valueCents: value, ledgerCents: held },
    });
    return wrote ? amount : 0;
  } catch (err) {
    reportError(err, { where: "account-deletion.book-churn", level: "warning", userId });
    return 0;
  }
}

/** The `account_deleted` product event: tenure and plan, with no user id. Never throws. */
async function trackAccountDeleted(userId: string): Promise<void> {
  try {
    const db = await getDb();
    const row = await db.query.userSettings.findFirst({
      where: eq(userSettings.userId, userId),
      columns: {
        createdAt: true,
        compedPlan: true,
        lifetimePurchasedAt: true,
        subscriptionPlan: true,
        subscriptionStatus: true,
        subscriptionPeriodEnd: true,
      },
    });
    const { plan } = resolvePlan(row);
    const tenureDays = row?.createdAt
      ? Math.max(0, Math.floor((Date.now() - row.createdAt.getTime()) / 86_400_000))
      : 0;
    // `userId: null` on purpose: the event outlives the account, and a deleted person's id
    // must not survive in analytics. The cancellation `reason` is a survey answer we do not
    // collect on this path, so it is omitted rather than invented.
    track("account_deleted", { tenure_days: tenureDays, plan }, { userId: null });
  } catch (err) {
    reportError(err, { where: "account-deletion.track", level: "warning", userId });
  }
}

export async function deleteOwnAccount(
  userId: string,
  deps: AccountDeletionDeps = defaultAccountDeletionDeps
): Promise<void> {
  if (isAdminUser(userId)) {
    throw new UserFacingError(
      "Operator accounts can’t be deleted from Settings — remove the id from ADMIN_USER_IDS first"
    );
  }

  const db = await getDb();
  const settings = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
    columns: { stripeCustomerId: true },
  });

  if (settings?.stripeCustomerId) {
    try {
      await deps.cancelSubscriptions(settings.stripeCustomerId);
    } catch (err) {
      console.error("[account-deletion] cancelling the subscription threw", err);
      throw new UserFacingError(
        "Couldn’t cancel your Orbit subscription, so nothing was deleted — try again, or contact us"
      );
    }
  }

  // Both of these read the account while it still exists, so they must run BEFORE the purge,
  // and neither may ever stop the deletion: each swallows its own failure.
  await bookChurnOnDeletion(userId);
  await trackAccountDeleted(userId);

  await purgeUserData(userId, { keepSettings: false });

  try {
    await deps.deleteLogin(userId);
  } catch (err) {
    console.error("[account-deletion] removing the sign-in threw", err);
    throw new UserFacingError(
      "Your data is deleted, but your sign-in couldn’t be removed — try again, or contact us"
    );
  }
}
