import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import { getEntitlements } from "@/lib/entitlements";
import { periodEndOf, subscriptionShape } from "@/lib/billing-stripe";
import {
  LIFETIME_METADATA_KEY,
  MAX_METADATA_VALUE,
  PRO_METADATA_VALUE,
  getStripe,
  planForLookupKey,
} from "@/lib/stripe";
import { resolvePortalConfigurationId, resolvePriceIds, subscriptionPriceId } from "@/lib/stripe-prices";
import { getAppBaseUrl } from "@/lib/app-url";
import type { PurchasablePlan } from "@/lib/plans/plan-config";

/**
 * In-app management of the subscription: cancel (at period end), undo that, and switch
 * between Orbit Pro and Orbit Max.
 *
 * Nothing here writes plan state. Every change is made on Stripe, and the resulting
 * `customer.subscription.updated` / `.deleted` webhook mirrors it into `user_settings` through
 * the same decision the rest of billing uses — so the ledger books the MRR movement exactly
 * once, whichever surface (this card, Stripe's portal, the dashboard) made the change. What
 * the card shows is read live from Stripe for the same reason: the mirror deliberately does
 * not carry `cancel_at_period_end`, and a pending cancellation is precisely what the card has
 * to be right about.
 *
 * A tier switch is confirmed on Stripe's own portal page (`subscription_update_confirm`),
 * which shows the exact prorated charge before anyone agrees to it. The portal configuration
 * decides the timing: Pro → Max immediately and prorated, Max → Pro at the period end.
 *
 * The subscription is always found through the caller's own `stripe_customer_id`, never from
 * input, so no one can reach a subscription that is not theirs.
 *
 * `deps` exists so the smoke can run without Stripe. No `next/server` import: tsx loads this.
 */

export type SubscriptionDetails = {
  /** The tier the subscription's price sells. Legacy $5/$50 prices are Pro. */
  plan: PurchasablePlan;
  /** Billing cadence. Pricing v2 is monthly; only legacy annual subscribers read "annual". */
  period: "monthly" | "annual";
  status: "active" | "trialing" | "past_due";
  /** Unix seconds: the next renewal, or the day access ends when `cancelAtPeriodEnd`. */
  periodEnd: number | null;
  cancelAtPeriodEnd: boolean;
  /** Per billing period, in the price's smallest unit. */
  amountCents: number | null;
  currency: string;
};

export type SubscriptionResult =
  | { ok: true; subscription: SubscriptionDetails }
  | { ok: false; error: string };

export const SUBSCRIPTION_COPY = {
  noSubscription: "There’s no subscription on this account to manage",
  unavailable: "Couldn’t reach billing just now — try again in a moment",
  notConfigured: "Plan changes aren’t open yet — check back shortly",
  alreadyOnPlan: "You’re already on that plan",
  cancelPending: "Resume your subscription first, then switch plans",
} as const;

export type SubscriptionStripe = {
  list: (customer: string) => Promise<Stripe.Subscription[]>;
  update: (id: string, params: Stripe.SubscriptionUpdateParams) => Promise<Stripe.Subscription>;
  portal: (params: Stripe.BillingPortal.SessionCreateParams) => Promise<{ url: string | null }>;
  /** Price id for a tier and billing period, resolved by lookup key. */
  priceFor: (plan: PurchasablePlan, period: "monthly" | "annual") => Promise<string>;
  portalConfiguration: () => Promise<string | undefined>;
};

function liveStripe(): SubscriptionStripe {
  return {
    list: async (customer) =>
      (await getStripe().subscriptions.list({ customer, status: "all", limit: 20 })).data,
    update: (id, params) => getStripe().subscriptions.update(id, params),
    portal: (params) => getStripe().billingPortal.sessions.create(params),
    priceFor: async (plan, period) => subscriptionPriceId(await resolvePriceIds(), plan, period),
    portalConfiguration: () => resolvePortalConfigurationId(),
  };
}

const MANAGEABLE = new Set(["active", "trialing", "past_due"]);

/**
 * The account's current Orbit subscription, if any: not ended, and not another product's.
 * A subscription created in the dashboard carries no metadata; that is still Orbit's, which
 * is the same rule the webhook applies.
 */
export function pickProSubscription(subs: Stripe.Subscription[]): Stripe.Subscription | null {
  const candidates = subs.filter((s) => {
    if (!MANAGEABLE.has(s.status)) return false;
    const plan = s.metadata?.[LIFETIME_METADATA_KEY];
    return !plan || plan === PRO_METADATA_VALUE || plan === MAX_METADATA_VALUE;
  });
  candidates.sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
  return candidates[0] ?? null;
}

export function detailsOf(sub: Stripe.Subscription): SubscriptionDetails {
  const shape = subscriptionShape(sub);
  const item = sub.items?.data?.[0];
  const unit = item?.price?.unit_amount;
  // `cancel_at` covers the newer API shape, where "at period end" is expressed as a date.
  const periodEnd = periodEndOf(sub);
  const cancelAt = typeof sub.cancel_at === "number" ? sub.cancel_at : null;
  return {
    plan: planForLookupKey(shape.lookupKey),
    period: shape.interval === "year" ? "annual" : "monthly",
    status: sub.status as SubscriptionDetails["status"],
    periodEnd: cancelAt ?? periodEnd,
    cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end) || cancelAt !== null,
    amountCents: typeof unit === "number" ? unit * (item?.quantity ?? 1) : null,
    currency: (item?.price?.currency ?? "usd").toLowerCase(),
  };
}

/** The caller's own Stripe customer — the only way into their subscription. */
export async function getStripeCustomerId(userId: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
    columns: { stripeCustomerId: true },
  });
  return row?.stripeCustomerId?.trim() || null;
}

type Found =
  | { ok: true; sub: Stripe.Subscription; customer: string; stripe: SubscriptionStripe }
  | { ok: false; error: string };

async function findForUser(userId: string, stripe?: SubscriptionStripe): Promise<Found> {
  const { source } = await getEntitlements(userId);
  const customer = await getStripeCustomerId(userId);
  if (source !== "subscription" || !customer) {
    return { ok: false, error: SUBSCRIPTION_COPY.noSubscription };
  }
  const client = stripe ?? liveStripe();
  let subs: Stripe.Subscription[];
  try {
    subs = await client.list(customer);
  } catch (err) {
    console.error("Stripe subscription lookup did not complete:", err);
    return { ok: false, error: SUBSCRIPTION_COPY.unavailable };
  }
  const sub = pickProSubscription(subs);
  if (!sub) return { ok: false, error: SUBSCRIPTION_COPY.noSubscription };
  return { ok: true, sub, customer, stripe: client };
}

export async function getSubscriptionDetails(
  userId: string,
  deps: { stripe?: SubscriptionStripe } = {}
): Promise<SubscriptionResult> {
  const found = await findForUser(userId, deps.stripe);
  if (!found.ok) return found;
  return { ok: true, subscription: detailsOf(found.sub) };
}

async function setCancelAtPeriodEnd(
  userId: string,
  cancel: boolean,
  deps: { stripe?: SubscriptionStripe }
): Promise<SubscriptionResult> {
  const found = await findForUser(userId, deps.stripe);
  if (!found.ok) return found;
  if (Boolean(found.sub.cancel_at_period_end) === cancel && (cancel || found.sub.cancel_at == null)) {
    return { ok: true, subscription: detailsOf(found.sub) };
  }
  try {
    const updated = await found.stripe.update(
      found.sub.id,
      // Undoing clears `cancel_at` too, in case the dashboard set a date rather than the flag.
      cancel ? { cancel_at_period_end: true } : { cancel_at_period_end: false, cancel_at: "" }
    );
    return { ok: true, subscription: detailsOf(updated) };
  } catch (err) {
    console.error("Stripe subscription update did not complete:", err);
    return { ok: false, error: SUBSCRIPTION_COPY.unavailable };
  }
}

/**
 * Ends the subscription when the paid period runs out. Access continues until then, which
 * `resolvePlan` already honours, and the `.deleted` webhook drops the plan to Free.
 */
export function cancelSubscription(userId: string, deps: { stripe?: SubscriptionStripe } = {}) {
  return setCancelAtPeriodEnd(userId, true, deps);
}

/** Undoes a pending cancellation. Nothing is charged; renewal simply happens as before. */
export function resumeSubscription(userId: string, deps: { stripe?: SubscriptionStripe } = {}) {
  return setCancelAtPeriodEnd(userId, false, deps);
}

/**
 * A Stripe-hosted confirmation page for switching between Pro and Max. Stripe shows the
 * prorated amount (upgrade) or the date it takes effect (downgrade) before anything changes;
 * the webhook then mirrors the new tier, and `reconcileFoundingDiscount` carries a founding
 * discount across to it. The switch keeps the billing period: an annual subscriber moves to
 * the other tier's annual price. (Monthly ↔ annual is the portal's own choice.)
 */
export async function createPlanSwitchUrl(
  userId: string,
  target: PurchasablePlan,
  deps: { stripe?: SubscriptionStripe } = {}
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  if (target !== "orbit" && target !== "max") return { ok: false, error: SUBSCRIPTION_COPY.unavailable };
  const found = await findForUser(userId, deps.stripe);
  if (!found.ok) return found;
  const details = detailsOf(found.sub);
  if (details.cancelAtPeriodEnd) return { ok: false, error: SUBSCRIPTION_COPY.cancelPending };
  const item = found.sub.items?.data?.[0];
  if (!item) return { ok: false, error: SUBSCRIPTION_COPY.unavailable };
  // Only a real tier change is offered here. That includes a legacy $5/$50 Pro subscriber
  // asking for Pro: moving them onto a v2 price would be a price rise, not a switch.
  if (details.plan === target) {
    return { ok: false, error: SUBSCRIPTION_COPY.alreadyOnPlan };
  }
  try {
    const [price, configuration] = await Promise.all([
      found.stripe.priceFor(target, details.period),
      found.stripe.portalConfiguration(),
    ]);
    const returnUrl = `${getAppBaseUrl()}/settings?upgraded=${target === "max" ? "max" : "pro"}#settings-plan`;
    const session = await found.stripe.portal({
      customer: found.customer,
      ...(configuration ? { configuration } : {}),
      return_url: `${getAppBaseUrl()}/settings#settings-plan`,
      flow_data: {
        type: "subscription_update_confirm",
        subscription_update_confirm: {
          subscription: found.sub.id,
          items: [{ id: item.id, price, quantity: 1 }],
        },
        after_completion: { type: "redirect", redirect: { return_url: returnUrl } },
      },
    });
    return session.url ? { ok: true, url: session.url } : { ok: false, error: SUBSCRIPTION_COPY.unavailable };
  } catch (err) {
    console.error("Stripe plan-switch session did not complete:", err);
    return { ok: false, error: SUBSCRIPTION_COPY.unavailable };
  }
}

/* ------------------------------------------------------- admin Lifetime grant ------ */

export type LifetimeSubscriptionEffect =
  | { kind: "none" }
  | { kind: "ends_at_period_end"; plan: PurchasablePlan; periodEnd: number | null; alreadyEnding: boolean };

/**
 * What granting Lifetime would do to this account's subscription, for the admin's
 * confirmation dialog: nothing, or "their subscription ends at the period end on <date>".
 */
export async function lifetimeGrantSubscriptionEffect(
  userId: string,
  deps: { stripe?: SubscriptionStripe } = {}
): Promise<LifetimeSubscriptionEffect | { kind: "error"; error: string }> {
  const customer = await getStripeCustomerId(userId);
  if (!customer) return { kind: "none" };
  try {
    const sub = pickProSubscription(await (deps.stripe ?? liveStripe()).list(customer));
    if (!sub) return { kind: "none" };
    const details = detailsOf(sub);
    return {
      kind: "ends_at_period_end",
      plan: details.plan,
      periodEnd: details.periodEnd,
      alreadyEnding: details.cancelAtPeriodEnd,
    };
  } catch (err) {
    console.error("Stripe lookup for a Lifetime grant did not complete:", err);
    return { kind: "error", error: SUBSCRIPTION_COPY.unavailable };
  }
}

/**
 * One plan at a time: an admin's Lifetime grant sets the account's live subscription to end
 * at the close of the period already paid for. No refund, no proration, and no charge after
 * it. Idempotent; never throws (the grant itself has already been written).
 */
export async function endSubscriptionForLifetime(
  userId: string,
  deps: { stripe?: SubscriptionStripe } = {}
): Promise<"scheduled" | "none" | "error"> {
  try {
    const customer = await getStripeCustomerId(userId);
    if (!customer) return "none";
    const client = deps.stripe ?? liveStripe();
    const live = (await client.list(customer)).filter((s) => pickProSubscription([s]) !== null);
    if (live.length === 0) return "none";
    for (const sub of live) {
      if (sub.cancel_at_period_end) continue;
      await client.update(sub.id, { cancel_at_period_end: true });
    }
    return "scheduled";
  } catch (err) {
    console.error("Ending a subscription for a Lifetime grant did not complete:", err);
    return "error";
  }
}
