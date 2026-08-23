"use server";

import { getCurrentUserProfile, requireUserId } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import {
  LIFETIME_METADATA_KEY,
  LIFETIME_METADATA_VALUE,
  LIFETIME_PRICE_ID,
  getStripe,
  isStripeConfigured,
} from "@/lib/stripe";
import { getAppBaseUrl } from "@/lib/app-url";
import { lifetimeOffer } from "@/lib/lifetime-offer";

export type CheckoutResult = { url: string } | { error: string };

/**
 * Opens a Stripe Checkout Session for the one-time Orbit Lifetime purchase.
 *
 * Returns the URL rather than redirecting, so the caller can surface a refusal (already
 * owned, not on sale) inline instead of bouncing the user to a page that explains it.
 */
export async function startLifetimeCheckout(): Promise<CheckoutResult> {
  const userId = await requireUserId();

  if (!isStripeConfigured() || !LIFETIME_PRICE_ID) {
    return { error: "Lifetime isn't on sale yet. Check back shortly." };
  }

  // The SAME resolution the pricing page renders from. Reading the price id here
  // independently is what would let the page advertise one number while checkout charges
  // another — the failure mode worth engineering against, because it is the one that
  // turns a stale string into a consumer-protection problem.
  const offer = await lifetimeOffer();

  const entitlements = await getEntitlements(userId);
  if (entitlements.plan === "lifetime") {
    return { error: "You already have Orbit Lifetime." };
  }

  const baseUrl = getAppBaseUrl();
  const profile = await getCurrentUserProfile();

  try {
    const session = await getStripe().checkout.sessions.create({
      mode: "payment",
      line_items: [{ price: offer.stripePriceId ?? LIFETIME_PRICE_ID, quantity: 1 }],
      // How the webhook knows who paid. Checkout collects its own email, which need not
      // match the Orbit account, so the Clerk id is the only reliable link.
      client_reference_id: userId,
      metadata: { [LIFETIME_METADATA_KEY]: LIFETIME_METADATA_VALUE },
      // Prefills the email without forcing it — the customer can still change it.
      customer_email: profile?.email || undefined,
      // The plan card here already reads "Orbit Lifetime" once the webhook lands, so this
      // page confirms the purchase without needing a bespoke success screen.
      success_url: `${baseUrl}/settings#settings-plan`,
      cancel_url: `${baseUrl}/pricing`,
    });

    if (!session.url) return { error: "Stripe did not return a checkout URL." };
    return { url: session.url };
  } catch (err) {
    console.error("Stripe checkout session failed:", err);
    return { error: "Could not start checkout. Please try again." };
  }
}

/**
 * Whether Lifetime can actually be bought, without exposing Stripe details to the client.
 *
 * Lifetime is sold open-endedly, so this is purely a configuration question: false means
 * the deployment has no Stripe keys, and the caller should state that rather than render a
 * button that fails on click.
 */
export async function getLifetimeAvailability() {
  return { purchasable: isStripeConfigured() };
}
