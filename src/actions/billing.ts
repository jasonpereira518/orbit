"use server";

import { getCurrentUserProfile, requireUserId } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import {
  LIFETIME_METADATA_KEY,
  LIFETIME_METADATA_VALUE,
  LIFETIME_PRICE_ID,
  PRO_ANNUAL_PRICE_ID,
  PRO_METADATA_VALUE,
  PRO_MONTHLY_PRICE_ID,
  SUBSCRIPTION_USER_METADATA_KEY,
  getStripe,
  isProCheckoutConfigured,
  isStripeConfigured,
} from "@/lib/stripe";
import { getAppBaseUrl } from "@/lib/app-url";
import { lifetimeOffer } from "@/lib/lifetime-offer";
import type { BillingPeriod } from "@/lib/plan-copy";
import type { Plan } from "@/lib/plan-limits";
import { setCompedPlan } from "@/lib/user-settings";

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
      // page confirms the purchase without needing a bespoke success screen. `upgraded`
      // arms the celebration watcher's fast poll — the webhook may not have landed yet.
      success_url: `${baseUrl}/settings?upgraded=lifetime#settings-plan`,
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
 * Opens a Stripe Checkout Session for the recurring Orbit Pro subscription.
 *
 * Same contract as `startLifetimeCheckout`: the URL comes back to the caller so refusals
 * (already subscribed, not on sale) render inline next to the button.
 */
export async function startProCheckout(
  period: BillingPeriod
): Promise<CheckoutResult> {
  const userId = await requireUserId();

  const priceId =
    period === "annual" ? PRO_ANNUAL_PRICE_ID : PRO_MONTHLY_PRICE_ID;
  if (!isProCheckoutConfigured() || !priceId) {
    return { error: "Pro checkout isn't open yet. Check back shortly." };
  }

  // `getEntitlements` resolves comps too, so a comped account gets the same refusal a
  // paying one would.
  const entitlements = await getEntitlements(userId);
  if (entitlements.plan === "lifetime") {
    return {
      error: "You already have Orbit Lifetime — it includes everything in Pro.",
    };
  }
  if (entitlements.plan === "orbit") {
    return { error: "You already have Orbit Pro." };
  }

  const baseUrl = getAppBaseUrl();
  const profile = await getCurrentUserProfile();

  try {
    const session = await getStripe().checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      // How the webhook knows who paid — same rationale as the Lifetime session above.
      client_reference_id: userId,
      metadata: { [LIFETIME_METADATA_KEY]: PRO_METADATA_VALUE },
      // Copied onto the subscription object itself, so `customer.subscription.*` events
      // (renewals, cancellations) can be attributed without a session in hand.
      subscription_data: {
        metadata: {
          [LIFETIME_METADATA_KEY]: PRO_METADATA_VALUE,
          [SUBSCRIPTION_USER_METADATA_KEY]: userId,
        },
      },
      customer_email: profile?.email || undefined,
      // `upgraded` arms the celebration watcher's fast poll; see the Lifetime session.
      success_url: `${baseUrl}/settings?upgraded=pro#settings-plan`,
      cancel_url: `${baseUrl}/pricing`,
    });

    if (!session.url) return { error: "Stripe did not return a checkout URL." };
    return { url: session.url };
  } catch (err) {
    console.error("Stripe subscription checkout failed:", err);
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

/**
 * The resolved plan, for the celebration watcher's polls. `getEntitlements`
 * memoizes per request only, so every poll is a fresh read — which is the
 * point: this is how a webhook grant or an admin/demo comp reaches a client
 * that has no realtime channel.
 */
export async function getCurrentPlan(): Promise<Plan> {
  const userId = await requireUserId();
  const { plan } = await getEntitlements(userId);
  return plan;
}

/**
 * Live-demo cheat code: grants Lifetime with a keypress instead of a real checkout.
 *
 * Deliberately narrow. This is reachable from production (see the comment in
 * `plan-celebration-watcher.tsx` on why it has to be), so the gate can't be "is this
 * dev/staging" — it has to be "is this literally the one account the showcase runs
 * from". `DEMO_ACCOUNT_USER_ID` names that account's Clerk id; every other caller,
 * however they reached this action, gets `{ ok: false }` and nothing changes. Unset
 * (the default in any environment that hasn't configured a showcase account) disables
 * the shortcut entirely rather than falling back to some other check.
 */
export async function triggerDemoCelebration(): Promise<{ ok: boolean }> {
  const userId = await requireUserId();
  const demoAccountId = process.env.DEMO_ACCOUNT_USER_ID?.trim();
  if (!demoAccountId || userId !== demoAccountId) return { ok: false };

  await setCompedPlan(userId, "lifetime", {
    note: "Live demo shortcut (Ctrl+Shift+U)",
  });
  return { ok: true };
}
