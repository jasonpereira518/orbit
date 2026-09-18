import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import { getEntitlements } from "@/lib/entitlements";
import { periodEndOf, subscriptionShape } from "@/lib/billing-stripe";
import type { BillingPeriod } from "@/lib/plan-copy";
import {
  LIFETIME_METADATA_KEY,
  PRO_ANNUAL_PRICE_ID,
  PRO_BILLING_PERIOD_METADATA_KEY,
  PRO_METADATA_VALUE,
  PRO_MONTHLY_PRICE_ID,
  getStripe,
} from "@/lib/stripe";

/**
 * In-app management of the Orbit Pro subscription: cancel (at period end), undo that, and
 * switch between monthly and annual billing.
 *
 * Nothing here writes plan state. Every change is made on Stripe, and the resulting
 * `customer.subscription.updated` / `.deleted` webhook mirrors it into `user_settings` through
 * the same decision the rest of billing uses — so the ledger books the MRR movement exactly
 * once, whichever surface (this card, Stripe's portal, the dashboard) made the change. What
 * the card shows is read live from Stripe for the same reason: the mirror deliberately does
 * not carry `cancel_at_period_end`, and a pending cancellation is precisely what the card has
 * to be right about.
 *
 * The subscription is always found through the caller's own `stripe_customer_id`, never from
 * input, so no one can reach a subscription that is not theirs.
 *
 * `deps` exists so the smoke can run without Stripe. No `next/server` import: tsx loads this.
 */

export type SubscriptionDetails = {
  period: BillingPeriod;
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

export type PeriodChangePreview =
  | {
      ok: true;
      /** Positive: charged today. Negative: credit that pays future invoices. */
      totalCents: number;
      currency: string;
    }
  | { ok: false; error: string };

export const SUBSCRIPTION_COPY = {
  noSubscription: "There’s no subscription on this account to manage",
  unavailable: "Couldn’t reach billing just now — try again in a moment",
  notConfigured: "Plan changes aren’t open yet — check back shortly",
  alreadyOnPeriod: "You’re already on that billing period",
  cancelPending: "Resume your subscription first, then switch billing",
  paymentDeclined: "Your card was declined — update it under Manage billing, then try again",
  switchInSettings: "You’re on Orbit Pro — switch to Lifetime from Settings, where you can see what changes",
} as const;

export type SubscriptionStripe = {
  list: (customer: string) => Promise<Stripe.Subscription[]>;
  update: (id: string, params: Stripe.SubscriptionUpdateParams) => Promise<Stripe.Subscription>;
  preview: (params: Stripe.InvoiceCreatePreviewParams) => Promise<Pick<Stripe.Invoice, "total" | "currency">>;
  cancel: (id: string, params: Stripe.SubscriptionCancelParams) => Promise<unknown>;
};

function liveStripe(): SubscriptionStripe {
  return {
    list: async (customer) =>
      (await getStripe().subscriptions.list({ customer, status: "all", limit: 20 })).data,
    update: (id, params) => getStripe().subscriptions.update(id, params),
    preview: (params) => getStripe().invoices.createPreview(params),
    cancel: (id, params) => getStripe().subscriptions.cancel(id, params),
  };
}

const MANAGEABLE = new Set(["active", "trialing", "past_due"]);

/**
 * The account's current Pro subscription, if any: not ended, and not another product's.
 * A subscription created in the dashboard carries no metadata; that is still Pro, which is
 * the same rule the webhook applies.
 */
export function pickProSubscription(subs: Stripe.Subscription[]): Stripe.Subscription | null {
  const candidates = subs.filter((s) => {
    if (!MANAGEABLE.has(s.status)) return false;
    const plan = s.metadata?.[LIFETIME_METADATA_KEY];
    return !plan || plan === PRO_METADATA_VALUE;
  });
  candidates.sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
  return candidates[0] ?? null;
}

function priceIdFor(period: BillingPeriod): string | null {
  return period === "annual" ? PRO_ANNUAL_PRICE_ID : PRO_MONTHLY_PRICE_ID;
}

export function detailsOf(sub: Stripe.Subscription): SubscriptionDetails {
  const shape = subscriptionShape(sub);
  const item = sub.items?.data?.[0];
  const unit = item?.price?.unit_amount;
  // `cancel_at` covers the newer API shape, where "at period end" is expressed as a date.
  const periodEnd = periodEndOf(sub);
  const cancelAt = typeof sub.cancel_at === "number" ? sub.cancel_at : null;
  return {
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

type PeriodChange =
  | { ok: true; found: Extract<Found, { ok: true }>; itemId: string; priceId: string }
  | { ok: false; error: string };

async function preparePeriodChange(
  userId: string,
  period: BillingPeriod,
  stripe?: SubscriptionStripe
): Promise<PeriodChange> {
  if (period !== "monthly" && period !== "annual") {
    return { ok: false, error: SUBSCRIPTION_COPY.unavailable };
  }
  const priceId = priceIdFor(period);
  if (!priceId || !PRO_MONTHLY_PRICE_ID || !PRO_ANNUAL_PRICE_ID) {
    return { ok: false, error: SUBSCRIPTION_COPY.notConfigured };
  }
  const found = await findForUser(userId, stripe);
  if (!found.ok) return found;
  const details = detailsOf(found.sub);
  if (details.cancelAtPeriodEnd) return { ok: false, error: SUBSCRIPTION_COPY.cancelPending };
  const item = found.sub.items?.data?.[0];
  if (!item) return { ok: false, error: SUBSCRIPTION_COPY.unavailable };
  if (item.price?.id === priceId || details.period === period) {
    return { ok: false, error: SUBSCRIPTION_COPY.alreadyOnPeriod };
  }
  return { ok: true, found, itemId: item.id, priceId };
}

/**
 * Prorations are invoiced at once in both directions. Monthly → annual charges the year now,
 * less the unused part of the month. Annual → monthly starts monthly billing now, and the
 * unused part of the year becomes account credit that pays the following monthly invoices —
 * so nobody pays twice for the same days, and nothing waits on a scheduled change.
 */
const PRORATION: Stripe.SubscriptionUpdateParams.ProrationBehavior = "always_invoice";

/** What switching would cost today, as Stripe itself computes it. */
export async function previewBillingPeriodChange(
  userId: string,
  period: BillingPeriod,
  deps: { stripe?: SubscriptionStripe } = {}
): Promise<PeriodChangePreview> {
  const prep = await preparePeriodChange(userId, period, deps.stripe);
  if (!prep.ok) return prep;
  try {
    const invoice = await prep.found.stripe.preview({
      customer: prep.found.customer,
      subscription: prep.found.sub.id,
      subscription_details: {
        items: [{ id: prep.itemId, price: prep.priceId }],
        proration_behavior: PRORATION,
      },
    });
    return { ok: true, totalCents: invoice.total ?? 0, currency: (invoice.currency ?? "usd").toLowerCase() };
  } catch (err) {
    console.error("Stripe invoice preview did not complete:", err);
    return { ok: false, error: SUBSCRIPTION_COPY.unavailable };
  }
}

export async function changeBillingPeriod(
  userId: string,
  period: BillingPeriod,
  deps: { stripe?: SubscriptionStripe } = {}
): Promise<SubscriptionResult> {
  const prep = await preparePeriodChange(userId, period, deps.stripe);
  if (!prep.ok) return prep;
  try {
    const updated = await prep.found.stripe.update(prep.found.sub.id, {
      items: [{ id: prep.itemId, price: prep.priceId }],
      proration_behavior: PRORATION,
      // A declined upgrade charge rejects the change outright, rather than leaving the
      // subscription `past_due` on a price the person never managed to pay for.
      payment_behavior: "error_if_incomplete",
      // Kept in step with the price so the webhook's interval fallback agrees with it.
      metadata: { [PRO_BILLING_PERIOD_METADATA_KEY]: period },
    });
    return { ok: true, subscription: detailsOf(updated) };
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (code === "card_declined" || code === "subscription_payment_intent_requires_action") {
      return { ok: false, error: SUBSCRIPTION_COPY.paymentDeclined };
    }
    console.error("Stripe billing period change did not complete:", err);
    return { ok: false, error: SUBSCRIPTION_COPY.unavailable };
  }
}

/* ---------------------------------------------------------- Pro → Lifetime -------- */

/**
 * One plan at a time: once Lifetime is granted, any live Pro subscription is canceled on the
 * spot — no renewal, no refund of the rest of the period, and Pro's extras stop with it
 * (`getEntitlements` no longer unions them into Lifetime). The switch dialog and
 * `startLifetimeCheckout` say so before anyone pays.
 *
 * Called from every path that grants Lifetime (the webhook, verify-on-return, the AI gate's
 * own check), so whichever lands first does the work and the rest find nothing to cancel.
 * Never throws: the Lifetime grant has already landed, and failing the webhook over this
 * would retry a purchase that succeeded. A failure is logged for the operator; the
 * subscription's next renewal would be the visible symptom.
 */
export async function endProForLifetime(
  userId: string,
  deps: { stripe?: SubscriptionStripe } = {}
): Promise<"canceled" | "none" | "error"> {
  try {
    const customer = await getStripeCustomerId(userId);
    if (!customer) return "none";
    const client = deps.stripe ?? liveStripe();
    const live = (await client.list(customer)).filter((s) => pickProSubscription([s]) !== null);
    if (live.length === 0) return "none";
    for (const sub of live) {
      await client.cancel(sub.id, { prorate: false, invoice_now: false });
    }
    return "canceled";
  } catch (err) {
    console.error("Ending Pro after a Lifetime purchase did not complete:", err);
    return "error";
  }
}
