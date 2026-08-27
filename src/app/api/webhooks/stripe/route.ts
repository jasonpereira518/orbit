import type { NextRequest } from "next/server";
import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import {
  LIFETIME_METADATA_KEY,
  LIFETIME_METADATA_VALUE,
  PRO_METADATA_VALUE,
  SUBSCRIPTION_USER_METADATA_KEY,
  getStripe,
} from "@/lib/stripe";
import {
  findUserIdByStripeCustomerId,
  setLifetimePurchase,
  setSubscriptionState,
  type SubscriptionMirror,
} from "@/lib/user-settings";
import { classifyMovement, monthlyValueCents, recordBillingEvent } from "@/lib/billing-events";

/**
 * Fulfils Stripe purchases: the one-time Orbit Lifetime tier and the recurring Orbit Pro
 * subscription.
 *
 * Webhooks — not the success page — are what actually grant the plan. A customer can pay
 * and then lose their connection before any redirect loads, so the redirect is a
 * convenience and this endpoint is the guarantee.
 *
 * NOTE: `customer.subscription.updated` and `customer.subscription.deleted` must also be
 * enabled on this endpoint in the Stripe Dashboard — handling them in code alone is not
 * enough.
 */

/** `checkout.session.completed` fires for instant methods; the async variant covers
 *  delayed ones (bank debits), where funds land after the session closes. */
const FULFIL_EVENTS = new Set<Stripe.Event["type"]>([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
]);

/** Renewals, cancellations, and payment failures for the Pro subscription. */
const SUBSCRIPTION_EVENTS = new Set<Stripe.Event["type"]>([
  "customer.subscription.updated",
  "customer.subscription.deleted",
]);

/** `customer` arrives as an id, an expanded object, or null depending on the object. */
function customerIdOf(obj: {
  customer: string | Stripe.Customer | Stripe.DeletedCustomer | null;
}) {
  const customer = obj.customer;
  if (!customer) return null;
  return typeof customer === "string" ? customer : customer.id;
}

/**
 * Where the paid-through timestamp lives moved across Stripe API versions: recent
 * versions carry `current_period_end` on the subscription item, older ones on the
 * subscription root. The SDK is unpinned here, so read the item first and fall back.
 */
function periodEndOf(subscription: Stripe.Subscription): number | null {
  const item = subscription.items?.data?.[0] as
    | { current_period_end?: number }
    | undefined;
  if (typeof item?.current_period_end === "number") {
    return item.current_period_end;
  }
  const root = (subscription as unknown as { current_period_end?: number })
    .current_period_end;
  if (typeof root === "number") return root;
  console.error(
    `Stripe subscription ${subscription.id} carries no current_period_end on item or root.`
  );
  return null;
}

/**
 * Same status semantics the legacy Clerk mirror used: `canceled` keeps the plan with its
 * period end so access runs to the paid-through date (`resolvePlan` handles the expiry),
 * while states where money never settled clear the mirror entirely.
 */
function mirrorForStatus(
  status: Stripe.Subscription.Status,
  periodEnd: number | null
): SubscriptionMirror {
  switch (status) {
    case "active":
    case "trialing":
      return { plan: "orbit", status: "active", periodEnd };
    case "past_due":
      return { plan: "orbit", status: "past_due", periodEnd };
    case "canceled":
      return { plan: "orbit", status: "canceled", periodEnd };
    default:
      // incomplete, incomplete_expired, unpaid, paused — never live entitlement.
      return { plan: null, status: null, periodEnd: null };
  }
}

/**
 * Books the Pro subscription's MRR movement into `billing_events`, mirroring exactly the
 * pattern the legacy Clerk webhook used (see git history of api/webhooks/clerk/route.ts):
 * read the recurring value BEFORE the mirror is overwritten — the only moment both sides of
 * a transition are knowable — then classify the before/after delta and record it.
 *
 * Called from both the checkout-completion branch (the "new" transition) and the
 * subscription-lifecycle branch (renewals, cancellations, dunning). Safe to call from both:
 * the checkout branch's optimistic grant already establishes the new cents value, so the
 * very next `customer.subscription.updated` for that same transition reads identical
 * before/after state and `classifyMovement` naturally returns null — no double-count.
 */
async function recordProMovement(
  eventId: string | null,
  userId: string,
  apply: () => Promise<void>,
  detail: Record<string, unknown>
) {
  const db = await getDb();
  const before = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
    columns: {
      subscriptionPlan: true,
      subscriptionStatus: true,
      subscriptionPeriodEnd: true,
    },
  });
  const beforeCents =
    before?.subscriptionPlan === "orbit"
      ? monthlyValueCents(before.subscriptionStatus, before.subscriptionPeriodEnd)
      : 0;

  await apply();

  const after = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
    columns: { subscriptionStatus: true, subscriptionPeriodEnd: true },
  });
  const afterCents = monthlyValueCents(
    after?.subscriptionStatus ?? null,
    after?.subscriptionPeriodEnd ?? null
  );

  const movement = classifyMovement(beforeCents, afterCents);
  // No event id means no way to deduplicate, and Stripe retries — recording would risk
  // counting the same movement several times.
  if (movement && eventId) {
    await recordBillingEvent({
      source: "stripe",
      eventId,
      kind: movement.kind,
      userId,
      mrrDeltaCents: movement.deltaCents,
      detail: { ...detail, beforeCents, afterCents },
    });
  }
}

export async function POST(req: NextRequest) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.error("STRIPE_WEBHOOK_SECRET is not set; refusing webhook.");
    return new Response("Stripe webhook is not configured", { status: 500 });
  }

  const signature = req.headers.get("stripe-signature");
  if (!signature) return new Response("Missing signature", { status: 400 });

  // Signature verification needs the exact bytes Stripe signed. Reading this as JSON and
  // re-serialising would change the payload and silently fail every signature, so the raw
  // text is read first and parsed only by the SDK.
  const payload = await req.text();

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(payload, signature, secret);
  } catch (err) {
    // Includes replay attempts and stale secrets after a roll — both should be rejected.
    console.error("Stripe webhook verification failed:", err);
    return new Response("Verification failed", { status: 400 });
  }

  if (FULFIL_EVENTS.has(event.type)) {
    const session = event.data.object as Stripe.Checkout.Session;

    // The metadata routes the grant, so a session for any other product — or a plan
    // added later — cannot hand out the wrong tier by accident.
    const planMeta = session.metadata?.[LIFETIME_METADATA_KEY];
    const userId = session.client_reference_id;

    // `unpaid` covers sessions that completed without funds actually settling.
    if (userId && session.payment_status !== "unpaid") {
      if (planMeta === LIFETIME_METADATA_VALUE) {
        // Idempotent by design: Stripe retries for up to three days, and both event
        // types above can fire for the same session. `setLifetimePurchase` keeps the
        // first purchase timestamp and ignores repeats.
        await setLifetimePurchase(userId, {
          stripeCustomerId: customerIdOf(session),
        });
      } else if (planMeta === PRO_METADATA_VALUE) {
        // Grant immediately so entitlements are live when the buyer lands back on the
        // settings page; the first `customer.subscription.updated` fills in the real
        // period end. Overwrite-idempotent, so retries are harmless.
        await recordProMovement(
          event.id,
          userId,
          () =>
            setSubscriptionState(
              userId,
              { plan: "orbit", status: "active", periodEnd: null },
              { stripeCustomerId: customerIdOf(session) }
            ),
          { checkoutSessionId: session.id }
        );
      }
    }
  }

  if (SUBSCRIPTION_EVENTS.has(event.type)) {
    const subscription = event.data.object as Stripe.Subscription;

    // Ignore subscriptions for unrelated products. Absent metadata still proceeds —
    // a dashboard-created subscription carries none — and is attributed by customer id.
    const planMeta = subscription.metadata?.[LIFETIME_METADATA_KEY];
    if (!planMeta || planMeta === PRO_METADATA_VALUE) {
      const userId =
        subscription.metadata?.[SUBSCRIPTION_USER_METADATA_KEY] ||
        (await (async () => {
          const customerId = customerIdOf(subscription);
          return customerId
            ? await findUserIdByStripeCustomerId(customerId)
            : null;
        })());

      if (userId) {
        // A `deleted` event is terminal regardless of the status snapshot it carries.
        const status =
          event.type === "customer.subscription.deleted"
            ? "canceled"
            : subscription.status;
        await recordProMovement(
          event.id,
          userId,
          () =>
            setSubscriptionState(
              userId,
              mirrorForStatus(status, periodEndOf(subscription)),
              { stripeCustomerId: customerIdOf(subscription) }
            ),
          { subscriptionId: subscription.id, stripeStatus: status }
        );
      } else {
        console.error(
          `Stripe subscription ${subscription.id} could not be attributed to a user.`
        );
      }
    }
  }

  return new Response("OK", { status: 200 });
}
