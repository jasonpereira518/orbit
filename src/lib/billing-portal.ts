import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import { getAppBaseUrl } from "@/lib/app-url";
import { getEntitlements } from "@/lib/entitlements";
import { getStripe } from "@/lib/stripe";

/**
 * Opens Stripe's hosted customer portal, where a subscriber cancels, changes card or reads
 * invoices. Orbit renders none of that itself: cancellation handled by Stripe is cancellation
 * whose webhook (`customer.subscription.updated` / `.deleted`) the existing handler already
 * turns into the right plan.
 *
 * Only an account whose plan comes from a subscription gets a session. A Lifetime buyer has
 * a Stripe customer too, but nothing recurring to manage — sending them to a portal that
 * shows an empty subscription list reads as a bug. The customer id always comes from the
 * caller's own settings row, never from input.
 *
 * `deps.createSession` exists so the smoke can run without Stripe.
 */

export type BillingPortalResult = { url: string } | { error: string };

export const BILLING_PORTAL_COPY = {
  noSubscription: "There’s no subscription on this account to manage",
  unavailable: "Couldn’t open billing just now — try again in a moment",
} as const;

type CreateSession = (args: { customer: string; return_url: string }) => Promise<{ url: string | null }>;

export async function createBillingPortalUrl(
  userId: string,
  deps: { createSession?: CreateSession } = {}
): Promise<BillingPortalResult> {
  const { source } = await getEntitlements(userId);
  const db = await getDb();
  const row = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
    columns: { stripeCustomerId: true },
  });
  const customer = row?.stripeCustomerId?.trim();
  if (source !== "subscription" || !customer) {
    return { error: BILLING_PORTAL_COPY.noSubscription };
  }

  const createSession: CreateSession =
    deps.createSession ?? ((args) => getStripe().billingPortal.sessions.create(args));
  try {
    const session = await createSession({
      customer,
      return_url: `${getAppBaseUrl()}/settings#settings-plan`,
    });
    return session.url ? { url: session.url } : { error: BILLING_PORTAL_COPY.unavailable };
  } catch (err) {
    console.error("Stripe billing portal session failed:", err);
    return { error: BILLING_PORTAL_COPY.unavailable };
  }
}
