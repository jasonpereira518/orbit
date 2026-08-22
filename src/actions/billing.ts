"use server";

import { getCurrentUserProfile, requireUserId } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import { LIFETIME_SEAT_LIMIT } from "@/lib/plan-limits";
import { countLifetimePurchases } from "@/lib/user-settings";
import {
  LIFETIME_METADATA_KEY,
  LIFETIME_METADATA_VALUE,
  LIFETIME_PRICE_ID,
  getStripe,
  isStripeConfigured,
} from "@/lib/stripe";
import { getAppBaseUrl } from "@/lib/app-url";

export type CheckoutResult = { url: string } | { error: string };

/**
 * Opens a Stripe Checkout Session for the one-time Orbit Lifetime purchase.
 *
 * Returns the URL rather than redirecting, so the caller can surface a refusal (sold out,
 * already owned) inline instead of bouncing the user to a page that explains it.
 */
export async function startLifetimeCheckout(): Promise<CheckoutResult> {
  const userId = await requireUserId();

  if (!isStripeConfigured() || !LIFETIME_PRICE_ID) {
    return { error: "Lifetime isn't on sale yet. Check back shortly." };
  }

  const entitlements = await getEntitlements(userId);
  if (entitlements.plan === "lifetime") {
    return { error: "You already have Orbit Lifetime." };
  }

  // The cap is checked before a session is created, not at fulfilment, so two people
  // checking out simultaneously on the last seat can both succeed. At 100 seats that
  // risks selling a small handful extra, which is cheaper than holding inventory —
  // tighten this with a reservation row if it ever matters.
  const sold = await countLifetimePurchases();
  if (sold >= LIFETIME_SEAT_LIMIT) {
    return { error: "All Orbit Lifetime spots have been claimed." };
  }

  const baseUrl = getAppBaseUrl();
  const profile = await getCurrentUserProfile();

  try {
    const session = await getStripe().checkout.sessions.create({
      mode: "payment",
      line_items: [{ price: LIFETIME_PRICE_ID, quantity: 1 }],
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

/** Seat availability for the pricing page, without exposing Stripe details to the client. */
export async function getLifetimeAvailability() {
  const sold = await countLifetimePurchases().catch(() => 0);
  return {
    seatsLeft: Math.max(0, LIFETIME_SEAT_LIMIT - sold),
    purchasable: isStripeConfigured(),
  };
}
