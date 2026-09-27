import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import { isAdminUser } from "@/lib/admin";
import { isClerkConfigured, isDemoMode } from "@/lib/demo-account";
import { UserFacingError } from "@/lib/errors";
import { purgeUserData } from "@/lib/user-data";

/**
 * Deleting your own account, from Settings.
 *
 * Three steps, in an order chosen for which half-finished state is safe to be stuck in:
 *   1. Cancel any live Stripe subscription. Orbit has no self-serve cancellation, so a
 *      deleted account that kept its subscription would be billed with no way back in.
 *      If this fails, nothing else happens.
 *   2. `purgeUserData(userId, { keepSettings: false })` — every table, the settings row,
 *      keys and tokens included. Idempotent.
 *   3. Delete the Clerk user. Clerk then fires `user.deleted`, whose purge finds nothing.
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
        "Couldn’t cancel your Orbit Pro subscription, so nothing was deleted — try again, or contact us"
      );
    }
  }

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
