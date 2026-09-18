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
import { setCompedPlan, setPendingLifetimeCheckout } from "@/lib/user-settings";
import { reportError } from "@/lib/report-error";
import { withReference } from "@/lib/errors";
import {
  SUBSCRIPTION_COPY,
  cancelSubscription as cancelSubscriptionFor,
  changeBillingPeriod as changeBillingPeriodFor,
  endProForLifetime,
  getStripeCustomerId,
  getSubscriptionDetails as getSubscriptionDetailsFor,
  previewBillingPeriodChange as previewBillingPeriodChangeFor,
  resumeSubscription as resumeSubscriptionFor,
  type PeriodChangePreview,
  type SubscriptionDetails,
  type SubscriptionResult,
} from "@/lib/subscription-management";

export type CheckoutResult = { url: string } | { error: string };

/**
 * Opens a Stripe Checkout Session for the one-time Orbit Lifetime purchase.
 *
 * Returns the URL rather than redirecting, so the caller can surface a refusal (already
 * owned, not on sale) inline instead of bouncing the user to a page that explains it.
 */
export async function startLifetimeCheckout(
  opts: { replaceSubscription?: boolean } = {}
): Promise<CheckoutResult> {
  const userId = await requireUserId();
  const replaceSubscription = opts?.replaceSubscription === true;

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

  // One plan at a time. A Pro subscriber can only buy Lifetime through the switch dialog in
  // Settings, which tells them Pro ends on the spot with no refund; a checkout from anywhere
  // else is refused and pointed there, so nobody pays for Lifetime without having read that.
  const switchingFromPro = entitlements.source === "subscription";
  if (switchingFromPro && !replaceSubscription) {
    return { error: SUBSCRIPTION_COPY.switchInSettings };
  }

  // Reuse the account's Stripe customer when it has one. The Lifetime grant records the
  // session's customer, and a fresh one would orphan the link to a Pro subscription that
  // `endProForLifetime` then has to find and cancel.
  const existingCustomer = await getStripeCustomerId(userId);
  if (switchingFromPro && !existingCustomer) return { error: SUBSCRIPTION_COPY.noSubscription };

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
      // A known customer carries its own email; otherwise prefill it without forcing it —
      // the customer can still change it.
      ...(existingCustomer
        ? { customer: existingCustomer }
        : { customer_email: profile?.email || undefined }),
      // The plan card here already reads "Orbit Lifetime" once the webhook lands, so this
      // page confirms the purchase without needing a bespoke success screen. `upgraded`
      // arms the celebration watcher's fast poll; `session_id` (Stripe fills the template)
      // lets it confirm the payment with Stripe directly, before the webhook lands.
      success_url: `${baseUrl}/settings?upgraded=lifetime&session_id={CHECKOUT_SESSION_ID}#settings-plan`,
      cancel_url: switchingFromPro ? `${baseUrl}/settings#settings-plan` : `${baseUrl}/pricing`,
    });

    if (!session.url) return { error: "Stripe did not return a checkout URL." };
    // Remembered so the AI gate can recognise this payment if the webhook is slow — see
    // `src/lib/lifetime-checkout.ts`. Never an entitlement on its own.
    await setPendingLifetimeCheckout(userId, session.id);
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

export type SubscriptionOverview =
  | {
      ok: true;
      subscription: SubscriptionDetails;
      /** Null when a billing-period switch cannot be priced on this deployment. */
      canSwitchPeriod: boolean;
      /** The Lifetime price a switch would charge; null when Lifetime is not on sale. */
      lifetimePriceUsd: number | null;
    }
  | { ok: false; error: string };

/**
 * The caller's Pro subscription as Stripe has it right now, plus what the plan card may
 * offer from it. Read on demand by the card, so the settings page itself never waits on
 * Stripe.
 */
export async function getSubscriptionOverview(): Promise<SubscriptionOverview> {
  const userId = await requireUserId();
  const result = await getSubscriptionDetailsFor(userId);
  if (!result.ok) return result;
  const lifetimePriceUsd = isStripeConfigured() ? (await lifetimeOffer()).priceUsd : null;
  return {
    ok: true,
    subscription: result.subscription,
    canSwitchPeriod: isProCheckoutConfigured(),
    lifetimePriceUsd,
  };
}

/** Stop renewing at the end of the paid period. Access continues until then. */
export async function cancelSubscription(): Promise<SubscriptionResult> {
  const userId = await requireUserId();
  return cancelSubscriptionFor(userId);
}

/** Undo a pending cancellation. */
export async function resumeSubscription(): Promise<SubscriptionResult> {
  const userId = await requireUserId();
  return resumeSubscriptionFor(userId);
}

/** What a monthly ↔ annual switch would charge (or credit) today. */
export async function previewBillingPeriodChange(
  period: BillingPeriod
): Promise<PeriodChangePreview> {
  const userId = await requireUserId();
  return previewBillingPeriodChangeFor(userId, period);
}

/** Switch the Pro subscription between monthly and annual billing, prorated. */
export async function changeBillingPeriod(
  period: BillingPeriod
): Promise<SubscriptionResult> {
  const userId = await requireUserId();
  return changeBillingPeriodFor(userId, period);
}

/**
 * Confirm a checkout the moment the buyer is back, instead of waiting on the webhook. Called
 * once by the celebration watcher with the `session_id` Stripe put in the success URL.
 *
 * Two checks, both through the same idempotent writers as the webhook. First the general
 * one (`confirmCheckoutForUser`), which applies a paid Pro or Lifetime session for this
 * caller. When that applies nothing, the Lifetime check the AI gate also uses
 * (`confirmLifetimeCheckout`) says whether the payment is merely still clearing, so the
 * watcher can tell the buyer rather than stay silent. Anything else changes nothing.
 */
export async function confirmCheckoutSession(
  sessionId: string
): Promise<{ status: "granted" | "processing" | "unconfirmed" }> {
  const userId = await requireUserId();
  if (!isStripeConfigured()) return { status: "unconfirmed" };
  if (typeof sessionId !== "string" || !/^cs_[A-Za-z0-9_]{8,250}$/.test(sessionId)) {
    return { status: "unconfirmed" };
  }
  try {
    const result = await confirmCheckoutForUser(userId, sessionId, {
      retrieve: (id) =>
        getStripe().checkout.sessions.retrieve(id, {
          expand: ["payment_intent.latest_charge", "subscription"],
        }),
    });
    if (result.status === "applied") {
      if (result.grantedLifetime) await endProForLifetime(userId);
      return { status: "granted" };
    }
  } catch (err) {
    // Not recorded as a stripeCheckout error event: that source pages "nobody can pay".
    console.error("Checkout confirmation on return did not complete:", err);
  }
  try {
    const { confirmLifetimeCheckout } = await import("@/lib/lifetime-checkout");
    const verdict = await confirmLifetimeCheckout(userId, sessionId);
    if (verdict.kind === "paid") return { status: "granted" };
    if (verdict.kind === "processing") return { status: "processing" };
  } catch (err) {
    console.error("Lifetime checkout check on return did not complete:", err);
  }
  return { status: "unconfirmed" };
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
