import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { stripeProcessedEvents, userSettings } from "@/db/schema";
import {
  hasPriorRevenue,
  monthlyValueCents,
  recordBillingEventStrict,
} from "@/lib/billing-events";
import { resolveChargePurpose } from "@/lib/stripe-charge-purpose";
import { checkoutSessionVerdict, syntheticCheckoutEvent } from "@/lib/checkout-confirm";
import {
  decideStripeEvent,
  revocationPaymentIntent,
  stripeEventSubject,
  type Booking,
  type DecideContext,
  type StripeDecision,
} from "@/lib/billing-stripe";
import {
  findUserIdByStripeCustomerId,
  setLifetimePurchase,
  setSubscriptionState,
  revokeLifetimePurchase,
} from "@/lib/user-settings";

/**
 * The half of Stripe fulfilment that touches the database, shared by the webhook
 * (`src/app/api/webhooks/stripe/route.ts`) and the verify-on-return action
 * (`confirmCheckoutSession` in `src/actions/billing.ts`).
 *
 * What an event MEANS stays in the pure `decideStripeEvent`. This module only reads the
 * context that decision needs and applies what it says, so the two entry points cannot drift.
 *
 * ORDER IS LOAD-BEARING: bookings first, strictly, then the mirror. `beforeCents` is read
 * from the mirror, so a mirror written before a booking that then fails would make every
 * retry compute "no movement" and lose the ledger row forever. Written this way round, a
 * failure leaves the mirror untouched, the retry derives the same keyed bookings, and the
 * unique (source, event_id) index drops whichever of them already landed.
 *
 * No `next/server` import: tsx smoke scripts load this module.
 */

/** Resolve an event to an account: payload hints first, then the stored customer link. */
export async function attributeStripeEvent(event: Stripe.Event): Promise<string | null> {
  const { userIdHint, customerId } = stripeEventSubject(event);
  if (userIdHint) return userIdHint;
  if (!customerId) return null;
  return findUserIdByStripeCustomerId(customerId);
}

/**
 * Everything `decideStripeEvent` needs to know about the present, read once and before
 * anything is written — the only moment both sides of a transition are knowable.
 */
export async function readDecideContext(
  event: Stripe.Event,
  now: Date
): Promise<DecideContext> {
  const userId = await attributeStripeEvent(event);
  if (!userId) return { userId: null, beforeCents: 0, hadPriorRevenue: false, now };

  const db = await getDb();
  const row = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
    columns: {
      subscriptionPlan: true,
      subscriptionStatus: true,
      subscriptionPeriodEnd: true,
      subscriptionMonthlyCents: true,
      subscriptionEventAt: true,
    },
  });
  const beforeCents =
    row?.subscriptionPlan === "orbit"
      ? monthlyValueCents(
          row.subscriptionStatus,
          row.subscriptionPeriodEnd,
          now,
          row.subscriptionMonthlyCents
        )
      : 0;

  // Phase 0 (audit A4): only a full refund or a lost dispute can withdraw access, and only
  // those need to know what the charge paid for — so the lookup (ledger first, then Stripe)
  // runs for nothing else. A lookup that throws lands in the caller's catch: 500, and Stripe
  // retries.
  const revocationPi = revocationPaymentIntent(event);
  const chargePurpose = revocationPi ? await resolveChargePurpose(revocationPi) : undefined;

  return {
    userId,
    beforeCents,
    // Only consulted when there is nothing to lose by asking: a 0-to-positive move is the
    // sole case where new and reactivation differ.
    hadPriorRevenue: beforeCents === 0 ? await hasPriorRevenue(userId) : false,
    now,
    chargePurpose,
    lastSubscriptionEventAt: row?.subscriptionEventAt ?? null,
    currentSubscriptionStatus: row?.subscriptionStatus ?? null,
  };
}

export type StripeApplyDeps = {
  revokeLifetime: typeof revokeLifetimePurchase;
  book: (booking: Booking) => Promise<unknown>;
  setLifetime: typeof setLifetimePurchase;
  setSubscription: typeof setSubscriptionState;
};

export const defaultStripeApplyDeps: StripeApplyDeps = {
  revokeLifetime: revokeLifetimePurchase,
  book: (booking) => recordBillingEventStrict({ source: "stripe", ...booking }),
  setLifetime: setLifetimePurchase,
  setSubscription: setSubscriptionState,
};

/** Apply a decision: every booking (throwing on failure), then the mirror. */
export async function applyStripeDecision(
  decision: StripeDecision,
  deps: StripeApplyDeps = defaultStripeApplyDeps
): Promise<void> {
  for (const booking of decision.bookings) {
    await deps.book(booking);
  }

  const mirror = decision.mirror;
  if (!mirror) return;

  switch (mirror.type) {
    case "lifetime":
      // Idempotent: `setLifetimePurchase` keeps the first timestamp.
      await deps.setLifetime(mirror.userId, { stripeCustomerId: mirror.stripeCustomerId });
      return;
    case "subscription":
      await deps.setSubscription(
        mirror.userId,
        {
          plan: mirror.plan,
          status: mirror.status,
          periodEnd: mirror.periodEnd,
          monthlyCents: mirror.monthlyCents,
          interval: mirror.interval,
        },
        {
          stripeCustomerId: mirror.stripeCustomerId,
          ...(mirror.eventAt ? { eventAt: mirror.eventAt } : {}),
        }
      );
      return;
    case "lifetime_revoked":
      // Phase 0 (audit A4): a full refund or a lost dispute ends Lifetime.
      await deps.revokeLifetime(mirror.userId);
      return;
    case "subscription_revoked":
      // monthlyCents and interval are omitted, so the stored price stays for display;
      // status canceled with a period end of now is what drops `resolvePlan` to free.
      await deps.setSubscription(mirror.userId, {
        plan: "orbit",
        status: "canceled",
        periodEnd: mirror.periodEnd,
      });
      return;
    default: {
      const unhandled: never = mirror;
      throw new Error(`Unhandled Stripe mirror instruction: ${JSON.stringify(unhandled)}`);
    }
  }
}

export async function isStripeEventProcessed(eventId: string): Promise<boolean> {
  const db = await getDb();
  const [row] = await db
    .select({ eventId: stripeProcessedEvents.eventId })
    .from(stripeProcessedEvents)
    .where(eq(stripeProcessedEvents.eventId, eventId))
    .limit(1);
  return Boolean(row);
}

/** Called only after a `handled` decision has been fully applied. */
export async function markStripeEventProcessed(
  eventId: string,
  eventType: string
): Promise<void> {
  const db = await getDb();
  await db.insert(stripeProcessedEvents).values({ eventId, eventType }).onConflictDoNothing();
}

/**
 * Verify-on-return: apply a Checkout Session the caller just paid for, without waiting for
 * the webhook. Same decision, same apply, so the later webhook finds nothing left to do.
 */
export async function confirmCheckoutForUser(
  userId: string,
  sessionId: string,
  deps: { retrieve: (sessionId: string) => Promise<Stripe.Checkout.Session>; now?: Date }
): Promise<{ status: "applied" | "skipped"; reason?: string; grantedLifetime?: boolean }> {
  const session = await deps.retrieve(sessionId);
  const now = deps.now ?? new Date();
  const verdict = checkoutSessionVerdict(session, {
    userId,
    nowSeconds: Math.floor(now.getTime() / 1000),
  });
  if (!verdict.ok) return { status: "skipped", reason: verdict.reason };

  const event = syntheticCheckoutEvent(session);
  const decision = decideStripeEvent(event, await readDecideContext(event, now));
  if (decision.outcome !== "handled") {
    return { status: "skipped", reason: decision.reason ?? "ignored" };
  }
  await applyStripeDecision(decision);
  return {
    status: "applied",
    grantedLifetime: decision.mirror?.type === "lifetime",
  };
}
