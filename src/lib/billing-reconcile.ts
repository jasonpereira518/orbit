import type Stripe from "stripe";
import { PLAN_METADATA_KEY, SUBSCRIPTION_USER_METADATA_KEY } from "@/lib/stripe-config";
import { subscriptionShape } from "@/lib/billing-stripe";
import { isPurchasablePlan } from "@/lib/plans/plan-config";

/**
 * Stripe against the database, the check the revenue ledger could never make for itself.
 *
 * The ledger's drift panel compares two things Orbit wrote: its own ledger and its own
 * mirror of each subscription. If a webhook is dropped, both are wrong the same way and the
 * panel stays at zero. The only independent witness is Stripe, so once a day this reads the
 * live subscriptions and compares them with `user_settings`.
 *
 * COUNTS, NEVER IDENTITIES, leave the job: it returns and records how many subscriptions it
 * checked and how many disagreed by kind, and the alert says the same. The mismatching
 * account ids are in the route's own response for the operator who triggers it by hand.
 *
 * Pure (no Stripe client, no DB) so `scripts/smoke-billing-reconcile.ts` can pin every
 * mismatch kind; the route in `src/app/api/ops/billing-reconcile/route.ts` does the I/O.
 */

/** Statuses that mean the customer is being billed and has access. */
export const LIVE_STRIPE_STATUSES = ["active", "past_due", "trialing"] as const;

export type StripeSubView = {
  id: string;
  customerId: string | null;
  /** From the subscription's own metadata; null on a subscription created outside Orbit's checkout. */
  userId: string | null;
  status: string;
  plan: string | null;
  monthlyCents: number | null;
};

export type DbSubView = {
  userId: string;
  stripeCustomerId: string | null;
  subscriptionPlan: string | null;
  subscriptionStatus: string | null;
  subscriptionMonthlyCents: number | null;
};

export type MismatchKind =
  | "in_stripe_not_in_db"
  | "in_db_not_in_stripe"
  | "plan_differs"
  | "amount_differs"
  | "status_differs";

export type ReconcileResult = {
  /** Live Stripe subscriptions plus live database subscriptions, each counted once. */
  checked: number;
  mismatches: Array<{ kind: MismatchKind; userId: string | null; subscriptionId: string | null }>;
  byKind: Record<MismatchKind, number>;
};

/** Reduce a Stripe subscription to the fields the comparison reads. */
export function viewStripeSubscription(sub: Stripe.Subscription): StripeSubView {
  const shape = subscriptionShape(sub);
  const metadata = (sub.metadata ?? {}) as Record<string, string | undefined>;
  const customer = typeof sub.customer === "string" ? sub.customer : sub.customer?.id ?? null;
  const plan = metadata[PLAN_METADATA_KEY];
  return {
    id: sub.id,
    customerId: customer,
    userId: metadata[SUBSCRIPTION_USER_METADATA_KEY] ?? null,
    status: sub.status,
    plan: isPurchasablePlan(plan) ? plan : null,
    monthlyCents: shape.monthlyCents,
  };
}

const live = (status: string | null) => (LIVE_STRIPE_STATUSES as readonly string[]).includes(status ?? "");

export function compareStripeToDb(stripe: readonly StripeSubView[], db: readonly DbSubView[]): ReconcileResult {
  const mismatches: ReconcileResult["mismatches"] = [];
  const liveStripe = stripe.filter((s) => live(s.status));
  const dbByUser = new Map(db.map((d) => [d.userId, d]));
  const dbByCustomer = new Map(db.filter((d) => d.stripeCustomerId).map((d) => [d.stripeCustomerId!, d]));
  const matchedUsers = new Set<string>();

  for (const sub of liveStripe) {
    const row = (sub.userId ? dbByUser.get(sub.userId) : undefined) ?? (sub.customerId ? dbByCustomer.get(sub.customerId) : undefined);
    if (!row) {
      mismatches.push({ kind: "in_stripe_not_in_db", userId: sub.userId, subscriptionId: sub.id });
      continue;
    }
    matchedUsers.add(row.userId);
    if (!live(row.subscriptionStatus)) {
      mismatches.push({ kind: "status_differs", userId: row.userId, subscriptionId: sub.id });
      continue;
    }
    if (sub.plan && row.subscriptionPlan && sub.plan !== row.subscriptionPlan) {
      mismatches.push({ kind: "plan_differs", userId: row.userId, subscriptionId: sub.id });
    }
    // Amounts are compared only when both sides know one: a legacy row with no stored monthly
    // value is a different problem (reported by the ledger drift panel), not a Stripe mismatch.
    if (sub.monthlyCents != null && row.subscriptionMonthlyCents != null && sub.monthlyCents !== row.subscriptionMonthlyCents) {
      mismatches.push({ kind: "amount_differs", userId: row.userId, subscriptionId: sub.id });
    }
  }

  const liveDb = db.filter((d) => live(d.subscriptionStatus) && d.subscriptionPlan);
  for (const row of liveDb) {
    if (!matchedUsers.has(row.userId)) {
      mismatches.push({ kind: "in_db_not_in_stripe", userId: row.userId, subscriptionId: null });
    }
  }

  const byKind: Record<MismatchKind, number> = {
    in_stripe_not_in_db: 0,
    in_db_not_in_stripe: 0,
    plan_differs: 0,
    amount_differs: 0,
    status_differs: 0,
  };
  for (const m of mismatches) byKind[m.kind] += 1;

  const checkedUsers = new Set([...liveStripe.map((s) => s.userId ?? s.customerId ?? s.id), ...liveDb.map((d) => d.userId)]);
  return { checked: checkedUsers.size, mismatches, byKind };
}
