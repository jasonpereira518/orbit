"use server";

import { getCurrentUserProfile, requireUserId } from "@/lib/auth";
import { getShowcaseAccountId } from "@/lib/demo-account";
import { ERROR_SOURCES, recordErrorEvent } from "@/lib/error-events";
import { getEntitlements } from "@/lib/entitlements";
import {
  LIFETIME_METADATA_KEY,
  LIFETIME_METADATA_VALUE,
  LIFETIME_PRICE_ID,
  PRO_ANNUAL_PRICE_ID,
  PRO_BILLING_PERIOD_METADATA_KEY,
  PRO_METADATA_VALUE,
  PRO_MONTHLY_PRICE_ID,
  SUBSCRIPTION_USER_METADATA_KEY,
  getStripe,
  isProCheckoutConfigured,
  isStripeConfigured,
} from "@/lib/stripe";
import { confirmCheckoutForUser } from "@/lib/stripe-fulfilment";
import { createBillingPortalUrl, type BillingPortalResult } from "@/lib/billing-portal";
import { getAppBaseUrl } from "@/lib/app-url";
import { lifetimeOffer } from "@/lib/lifetime-offer";
import type { BillingPeriod } from "@/lib/plan-copy";
import type { Plan } from "@/lib/plan-limits";
import { setCompedPlan } from "@/lib/user-settings";
import { reportError } from "@/lib/report-error";
import { withReference } from "@/lib/errors";

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
      success_url: `${baseUrl}/settings?upgraded=lifetime&session_id={CHECKOUT_SESSION_ID}#settings-plan`,
      cancel_url: `${baseUrl}/pricing`,
    });

    if (!session.url) return { error: "Stripe did not return a checkout URL." };
    return { url: session.url };
  } catch (err) {
    // Reported with the Stripe error code, and the person gets a reference to quote. This
    // used to return a generic line as a 200, and the real cause lived only in a
    // console.error on whichever server happened to run it.
    const kind = stripeErrorKind(err);
    const ref = reportError(err, { where: "action.billing.checkout", userId, extra: { plan: "lifetime", stripeCode: kind } });
    await recordErrorEvent({
      source: ERROR_SOURCES.stripeCheckout,
      kind,
      userId,
      message: err,
      context: { plan: "lifetime", ref },
    });
    return { error: withReference("Couldn’t start checkout — try again", ref) };
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
      metadata: {
        [LIFETIME_METADATA_KEY]: PRO_METADATA_VALUE,
        // Read by the webhook's optimistic grant, which happens before any subscription
        // object exists to read a price from. Without it annual books as $5/mo and the
        // next subscription event looks like a -83 contraction.
        [PRO_BILLING_PERIOD_METADATA_KEY]: period,
      },
      // Copied onto the subscription object itself, so `customer.subscription.*` events
      // (renewals, cancellations) can be attributed without a session in hand.
      subscription_data: {
        metadata: {
          [LIFETIME_METADATA_KEY]: PRO_METADATA_VALUE,
          [SUBSCRIPTION_USER_METADATA_KEY]: userId,
          [PRO_BILLING_PERIOD_METADATA_KEY]: period,
        },
      },
      customer_email: profile?.email || undefined,
      // `upgraded` arms the celebration watcher's fast poll; see the Lifetime session.
      success_url: `${baseUrl}/settings?upgraded=pro&session_id={CHECKOUT_SESSION_ID}#settings-plan`,
      cancel_url: `${baseUrl}/pricing`,
    });

    if (!session.url) return { error: "Stripe did not return a checkout URL." };
    return { url: session.url };
  } catch (err) {
    // Reported with the Stripe error code, and the person gets a reference to quote. This
    // used to return a generic line as a 200, and the real cause lived only in a
    // console.error on whichever server happened to run it.
    const kind = stripeErrorKind(err);
    const ref = reportError(err, { where: "action.billing.checkout", userId, extra: { plan: "pro", stripeCode: kind } });
    await recordErrorEvent({
      source: ERROR_SOURCES.stripeCheckout,
      kind,
      userId,
      message: err,
      context: { plan: "pro", ref },
    });
    return { error: withReference("Couldn’t start checkout — try again", ref) };
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

/** Stripe's customer portal for the caller's own subscription. Returns the URL, like checkout. */
export async function openBillingPortal(): Promise<BillingPortalResult> {
  const userId = await requireUserId();
  return createBillingPortalUrl(userId);
}

/**
 * Verify-on-return. The webhook stays the guarantee; this only shortens the wait, so every
 * failure is swallowed into a status and the caller carries on polling.
 */
export async function confirmCheckoutSession(
  sessionId: string
): Promise<{ status: "applied" | "skipped" | "unavailable" }> {
  const userId = await requireUserId();
  if (!isStripeConfigured()) return { status: "unavailable" };
  if (typeof sessionId !== "string" || !/^cs_[A-Za-z0-9_]{8,250}$/.test(sessionId)) {
    return { status: "skipped" };
  }
  try {
    const result = await confirmCheckoutForUser(userId, sessionId, {
      retrieve: (id) =>
        getStripe().checkout.sessions.retrieve(id, {
          expand: ["payment_intent.latest_charge", "subscription"],
        }),
    });
    return { status: result.status };
  } catch (err) {
    // Not recorded as a stripeCheckout error event: that source pages "nobody can pay".
    console.error("Checkout confirmation on return did not complete:", err);
    return { status: "unavailable" };
  }
}

/**
 * Live-demo cheat code: grants Lifetime with a keypress instead of a real checkout.
 *
 * Deliberately narrow. The gate is not "is this dev/staging" but "is this literally the one
 * account the showcase runs from": `DEMO_ACCOUNT_USER_ID` names that account's Clerk id, and
 * every other caller gets `{ ok: false }` with nothing changed. `src/lib/env.ts` forbids the
 * variable in production builds, so there it is always unset and the shortcut is off; live
 * demos run from a preview or local deployment.
 */
export async function triggerDemoCelebration(): Promise<{ ok: boolean }> {
  const userId = await requireUserId();
  const demoAccountId = getShowcaseAccountId();
  if (!demoAccountId || userId !== demoAccountId) return { ok: false };

  await setCompedPlan(userId, "lifetime", {
    note: "Live demo shortcut (Ctrl+Shift+U)",
  });
  return { ok: true };
}

/**
 * Low-cardinality kind for a failed checkout: Stripe's own error `code` when it has one
 * (`resource_missing` is the live one — a price id from the wrong mode), else its `type`.
 */
function stripeErrorKind(err: unknown): string {
  const e = err as { code?: unknown; type?: unknown } | null;
  if (e && typeof e.code === "string") return e.code;
  if (e && typeof e.type === "string") return e.type;
  return "unknown";
}
