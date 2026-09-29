"use server";

import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import { getCurrentUserProfile, requireUserId } from "@/lib/auth";
import { getShowcaseAccountId } from "@/lib/demo-account";
import { ERROR_SOURCES, recordErrorEvent } from "@/lib/error-events";
import { FEATURE_DENIAL, getEntitlements } from "@/lib/entitlements";
import {
  CREDIT_PACK_CREDITS,
  CREDIT_PACK_METADATA_VALUE,
  PLAN_METADATA_KEY,
  SUBSCRIPTION_USER_METADATA_KEY,
  getStripe,
  isCheckoutConfigured,
} from "@/lib/stripe";
import { resolvePriceIds } from "@/lib/stripe-prices";
import { confirmCheckoutForUser } from "@/lib/stripe-fulfilment";
import { createBillingPortalUrl, type BillingPortalResult } from "@/lib/billing-portal";
import { getAppBaseUrl } from "@/lib/app-url";
import { foundingAppliesToNewSubscription, foundingCheckoutTerms } from "@/lib/founding";
import { isPurchasablePlan, PLAN_LABELS, type Plan, type PurchasablePlan } from "@/lib/plans/plan-config";
import { setCompedPlan } from "@/lib/user-settings";
import { reportError } from "@/lib/report-error";
import { withReference } from "@/lib/errors";
import {
  cancelSubscription as cancelSubscriptionFor,
  createPlanSwitchUrl,
  getSubscriptionDetails as getSubscriptionDetailsFor,
  resumeSubscription as resumeSubscriptionFor,
  type SubscriptionDetails,
  type SubscriptionResult,
} from "@/lib/subscription-management";

export type CheckoutResult = { url: string } | { error: string };

const CHECKOUT_COPY = {
  notOpen: "Checkout isn’t open yet. Check back shortly.",
  onLifetime: "You have Orbit Lifetime — it already includes everything Orbit sells.",
  switchInSettings: "You already have a plan — switch between Pro and Max from Settings.",
  packsNeedPlan: FEATURE_DENIAL.creditPacks,
  failed: "Couldn’t start checkout — try again",
} as const;

async function billingRow(userId: string) {
  const db = await getDb();
  return db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
    columns: { stripeCustomerId: true, foundingEligible: true, foundingRedeemedAt: true },
  });
}

async function checkoutFailed(err: unknown, userId: string, what: string): Promise<CheckoutResult> {
  // Reported with the Stripe error code, and the person gets a reference to quote.
  const kind = stripeErrorKind(err);
  const ref = reportError(err, { where: "action.billing.checkout", userId, extra: { plan: what, stripeCode: kind } });
  await recordErrorEvent({
    source: ERROR_SOURCES.stripeCheckout,
    kind,
    userId,
    message: err,
    context: { plan: what, ref },
  });
  return { error: withReference(CHECKOUT_COPY.failed, ref) };
}

/**
 * Opens a Stripe Checkout Session for Orbit Pro or Orbit Max, monthly.
 *
 * Returns the URL rather than redirecting, so a refusal (already subscribed, not on sale)
 * renders inline beside the button. An account eligible for founding pricing that has never
 * had a paid subscription gets the founding coupon; Stripe's checkout page then shows the
 * discounted first months and the full price after, which is the disclosure.
 */
export async function startSubscriptionCheckout(plan: PurchasablePlan): Promise<CheckoutResult> {
  const userId = await requireUserId();
  if (!isPurchasablePlan(plan)) return { error: CHECKOUT_COPY.notOpen };
  if (!isCheckoutConfigured()) return { error: CHECKOUT_COPY.notOpen };

  // `getEntitlements` resolves comps too, so a comped account gets the same refusal a paying
  // one would. One plan at a time: tier changes go through Settings, never a second checkout.
  const entitlements = await getEntitlements(userId);
  if (entitlements.plan === "lifetime") return { error: CHECKOUT_COPY.onLifetime };
  if (entitlements.plan !== "free") return { error: CHECKOUT_COPY.switchInSettings };

  const row = await billingRow(userId);
  const founding = foundingAppliesToNewSubscription(row) ? foundingCheckoutTerms(plan) : null;
  const baseUrl = getAppBaseUrl();
  const profile = await getCurrentUserProfile();

  try {
    const prices = await resolvePriceIds();
    const planMeta = { [PLAN_METADATA_KEY]: plan, ...(founding?.metadata ?? {}) };
    const session = await getStripe().checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: prices[plan], quantity: 1 }],
      // How the webhook knows who paid. Checkout collects its own email, which need not
      // match the Orbit account, so the Clerk id is the only reliable link.
      client_reference_id: userId,
      metadata: planMeta,
      // Copied onto the subscription itself, so `customer.subscription.*` events (renewals,
      // cancellations, the founding window) can be attributed and valued without a session.
      subscription_data: {
        metadata: { ...planMeta, [SUBSCRIPTION_USER_METADATA_KEY]: userId },
      },
      ...(founding ? { discounts: [{ coupon: founding.coupon }] } : {}),
      // A returning subscriber keeps their Stripe customer (and invoice history).
      ...(row?.stripeCustomerId
        ? { customer: row.stripeCustomerId }
        : { customer_email: profile?.email || undefined }),
      // `upgraded` arms the celebration watcher's fast poll; `session_id` lets it confirm the
      // payment with Stripe directly, before the webhook lands.
      success_url: `${baseUrl}/settings?upgraded=${plan === "max" ? "max" : "pro"}&session_id={CHECKOUT_SESSION_ID}#settings-plan`,
      cancel_url: `${baseUrl}/pricing`,
    });
    if (!session.url) return { error: "Stripe did not return a checkout URL." };
    return { url: session.url };
  } catch (err) {
    return checkoutFailed(err, userId, plan);
  }
}

/**
 * Opens a Stripe Checkout Session for one $5 pack of 250 credits. Pro and Max only: the
 * credits are for Orbit's included AI, which Free and Lifetime do not run on. Never
 * automatic — a person clicks, sees the price and pays.
 */
export async function startCreditPackCheckout(): Promise<CheckoutResult> {
  const userId = await requireUserId();
  if (!isCheckoutConfigured()) return { error: CHECKOUT_COPY.notOpen };
  const entitlements = await getEntitlements(userId);
  if (!entitlements.canBuyCreditPacks) return { error: CHECKOUT_COPY.packsNeedPlan };

  const row = await billingRow(userId);
  const baseUrl = getAppBaseUrl();
  const profile = await getCurrentUserProfile();
  const metadata = {
    [PLAN_METADATA_KEY]: CREDIT_PACK_METADATA_VALUE,
    orbit_credits: String(CREDIT_PACK_CREDITS),
  };
  try {
    const prices = await resolvePriceIds();
    const session = await getStripe().checkout.sessions.create({
      mode: "payment",
      line_items: [{ price: prices.creditPack, quantity: 1 }],
      client_reference_id: userId,
      metadata,
      // On the payment intent too, so a refund or dispute of the charge can be traced back
      // to the pack from the payment alone.
      payment_intent_data: { metadata: { ...metadata, [SUBSCRIPTION_USER_METADATA_KEY]: userId } },
      ...(row?.stripeCustomerId
        ? { customer: row.stripeCustomerId }
        : { customer_email: profile?.email || undefined, customer_creation: "always" as const }),
      // The AI settings are a dialog opened by `?integration=ai` (see `integrationHref`).
      success_url: `${baseUrl}/settings?integration=ai&credits=added&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/settings?integration=ai`,
    });
    if (!session.url) return { error: "Stripe did not return a checkout URL." };
    return { url: session.url };
  } catch (err) {
    return checkoutFailed(err, userId, "credit_pack");
  }
}

/** Switch between Pro and Max on Stripe's own confirmation page. Returns its URL. */
export async function startPlanSwitch(target: PurchasablePlan): Promise<CheckoutResult> {
  const userId = await requireUserId();
  if (!isCheckoutConfigured()) return { error: CHECKOUT_COPY.notOpen };
  const result = await createPlanSwitchUrl(userId, target);
  return result.ok ? { url: result.url } : { error: result.error };
}

/**
 * What the pricing page needs to know about a signed-in visitor: their plan, and whether a
 * founding price applies to them. Founding prices are shown ONLY to an account for which
 * this is true — never to anyone signed out.
 */
export async function getPricingViewer(): Promise<{ plan: Plan; founding: boolean }> {
  const userId = await requireUserId();
  const [{ plan }, row] = await Promise.all([getEntitlements(userId), billingRow(userId)]);
  return { plan, founding: plan === "free" && foundingAppliesToNewSubscription(row) };
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
  | { ok: true; subscription: SubscriptionDetails; planLabel: string }
  | { ok: false; error: string };

/**
 * The caller's subscription as Stripe has it right now. Read on demand by the plan card, so
 * the settings page itself never waits on Stripe.
 */
export async function getSubscriptionOverview(): Promise<SubscriptionOverview> {
  const userId = await requireUserId();
  const result = await getSubscriptionDetailsFor(userId);
  if (!result.ok) return result;
  return { ok: true, subscription: result.subscription, planLabel: PLAN_LABELS[result.subscription.plan] };
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

/**
 * Confirm a checkout the moment the buyer is back, instead of waiting on the webhook. Called
 * once by the celebration watcher (or the credits card) with the `session_id` Stripe put in
 * the success URL. Same decision, same idempotent writers as the webhook, so whichever
 * lands second finds nothing left to do.
 */
export async function confirmCheckoutSession(
  sessionId: string
): Promise<{ status: "granted" | "processing" | "unconfirmed" }> {
  const userId = await requireUserId();
  if (!isCheckoutConfigured()) return { status: "unconfirmed" };
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
    if (result.status === "applied") return { status: "granted" };
    // An async payment (a bank debit) completes the session before the money settles.
    if (result.reason === "unpaid") return { status: "processing" };
  } catch (err) {
    // Not recorded as a stripeCheckout error event: that source pages "nobody can pay".
    console.error("Checkout confirmation on return did not complete:", err);
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
