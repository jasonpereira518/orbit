import type Stripe from "stripe";
import { decideStripeEvent } from "@/lib/billing-stripe";
import { recordBillingEvent } from "@/lib/billing-events";
import { consumeBucket, RATE_LIMITS } from "@/lib/rate-limit";
import {
  getStripe,
  isStripeConfigured,
  LIFETIME_METADATA_KEY,
  LIFETIME_METADATA_VALUE,
} from "@/lib/stripe";
import {
  clearPendingLifetimeCheckout,
  setLifetimePurchase,
} from "@/lib/user-settings";

/**
 * Closing the gap between paying for Lifetime and the webhook saying so.
 *
 * The webhook is what grants Lifetime (`api/webhooks/stripe`), and it is usually a second or
 * two behind the payment — but "usually" is doing work there, and the moment right after
 * paying is exactly when someone tries the AI they just paid for. Before this, that moment
 * read "Add your AI API key in Settings". So two things now ask Stripe directly:
 *
 *  1. The success redirect. Stripe returns the buyer to `/settings?upgraded=lifetime&
 *     session_id=…`, and the celebration watcher calls `confirmCheckoutSession` with it.
 *  2. The AI gate. About to refuse a non-Lifetime account with no key, it checks whether
 *     that account has a Lifetime checkout in flight (`user_settings.lifetime_checkout_*`,
 *     written when the session was opened) and asks Stripe about it first.
 *
 * Either way the answer goes through the SAME pure decision the webhook uses —
 * `decideStripeEvent` on a synthetic `checkout.session.completed` — and the same idempotent
 * writers. The Lifetime cash booking is keyed on the session (`cs:<id>`), and
 * `setLifetimePurchase` keeps the first timestamp, so the webhook arriving afterwards changes
 * nothing. There is no grace period and no optimistic grant: an account is Lifetime exactly
 * when Stripe says the money is there.
 *
 * The launch plan (2026-09-15, phase 2) specifies a broader `confirmCheckoutSession` for Pro
 * as well; this is the Lifetime half, built to the same contract so that one can extend it.
 */

/** Sessions older than this are never replayed: that is the webhook's and the ledger's job. */
const CONFIRM_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** A Stripe call on the AI path must be short — the person is waiting on a spinner. */
const STRIPE_TIMEOUT_MS = 5_000;

export type LifetimeSessionVerdict =
  | { kind: "paid" }
  /** Complete, but an asynchronous payment method has not settled. */
  | { kind: "processing" }
  /** The buyer has not finished checkout. */
  | { kind: "open" }
  | { kind: "expired" }
  | { kind: "refused"; reason: "not_yours" | "not_lifetime" | "too_old" | "reversed" }
  /** Stripe could not be asked (unconfigured, timed out, 5xx). */
  | { kind: "unknown" };

type ReturnedSession = Pick<
  Stripe.Checkout.Session,
  "id" | "client_reference_id" | "metadata" | "status" | "payment_status" | "created"
> & {
  payment_intent?: string | { latest_charge?: string | ChargeFacts | null } | null;
};

type ChargeFacts = { refunded?: boolean | null; disputed?: boolean | null };

/**
 * What a returned session means for `userId`, decided without touching anything.
 *
 * `reversed` matters because this is a REPLAY path: without it, a refunded buyer could
 * revisit their old success URL and have the refund undone by their own browser.
 */
export function judgeLifetimeSession(
  session: ReturnedSession,
  userId: string,
  now: Date,
): LifetimeSessionVerdict {
  if (session.client_reference_id !== userId) return { kind: "refused", reason: "not_yours" };
  if (session.metadata?.[LIFETIME_METADATA_KEY] !== LIFETIME_METADATA_VALUE) {
    return { kind: "refused", reason: "not_lifetime" };
  }
  if (session.status === "expired") return { kind: "expired" };
  if (session.status === "open") return { kind: "open" };
  if (now.getTime() - session.created * 1000 > CONFIRM_MAX_AGE_MS) {
    return { kind: "refused", reason: "too_old" };
  }

  const intent = session.payment_intent;
  const charge =
    intent && typeof intent === "object" && intent.latest_charge && typeof intent.latest_charge === "object"
      ? intent.latest_charge
      : null;
  if (charge?.refunded || charge?.disputed) return { kind: "refused", reason: "reversed" };

  if (session.payment_status === "paid" || session.payment_status === "no_payment_required") {
    return { kind: "paid" };
  }
  return { kind: "processing" };
}

/** How a session is fetched. Injectable so the smoke test can play Stripe. */
export type SessionRetriever = (sessionId: string) => Promise<Stripe.Checkout.Session>;

const retrieveFromStripe: SessionRetriever = (sessionId) =>
  getStripe().checkout.sessions.retrieve(
    sessionId,
    { expand: ["payment_intent.latest_charge"] },
    { timeout: STRIPE_TIMEOUT_MS, maxNetworkRetries: 0 },
  );

/**
 * Ask Stripe about one Lifetime session and, if it is paid, grant Lifetime now.
 *
 * Never throws: a Stripe that cannot be reached answers `unknown`, and the caller treats
 * that as "not confirmed" — the webhook remains the guarantee.
 */
export async function confirmLifetimeCheckout(
  userId: string,
  sessionId: string,
  now = new Date(),
  retrieve?: SessionRetriever,
): Promise<LifetimeSessionVerdict> {
  if (!sessionId.startsWith("cs_")) return { kind: "unknown" };
  if (!retrieve && !isStripeConfigured()) return { kind: "unknown" };

  let session: Stripe.Checkout.Session;
  try {
    session = await (retrieve ?? retrieveFromStripe)(sessionId);
  } catch (err) {
    console.warn("[lifetime-checkout] could not retrieve session", err);
    return { kind: "unknown" };
  }

  const verdict = judgeLifetimeSession(session, userId, now);

  if (verdict.kind === "paid") {
    const synthetic = {
      // Not an `evt_` id, so it can never collide with a real delivery. The money row is
      // keyed on the session regardless, which is what makes this and the webhook one row.
      id: `confirm_${session.id}`,
      type: "checkout.session.completed",
      created: session.created,
      data: { object: session },
    } as unknown as Stripe.Event;
    const decision = decideStripeEvent(synthetic, {
      userId,
      beforeCents: 0,
      hadPriorRevenue: false,
      now,
    });
    if (decision.mirror?.type === "lifetime") {
      await setLifetimePurchase(userId, { stripeCustomerId: decision.mirror.stripeCustomerId });
      for (const booking of decision.bookings) {
        await recordBillingEvent({ source: "stripe", ...booking });
      }
      // One plan at a time — see `endProForLifetime`.
      const { endProForLifetime } = await import("@/lib/subscription-management");
      await endProForLifetime(userId);
    }
  } else if (verdict.kind === "expired" || verdict.kind === "refused") {
    await clearPendingLifetimeCheckout(userId, sessionId);
  }

  return verdict;
}

export type PendingLifetimeFacts = {
  lifetimeCheckoutSessionId?: string | null;
  lifetimeCheckoutStartedAt?: Date | null;
};

/**
 * The AI gate's question: "this account is about to be refused — did it just pay?"
 *
 *  - `granted`     Stripe says paid; Lifetime is now recorded, re-resolve and carry on
 *  - `processing`  paid with a method that has not settled; say so, do not grant
 *  - `none`        nothing in flight, abandoned, or Stripe could not be asked
 *
 * Rate-limited per account: a free account with no key and an abandoned checkout would
 * otherwise put a Stripe round trip on every refused AI call for a day.
 */
export async function checkPendingLifetime(
  userId: string,
  facts: PendingLifetimeFacts,
  now = new Date(),
  retrieve?: SessionRetriever,
): Promise<"granted" | "processing" | "none"> {
  const sessionId = facts.lifetimeCheckoutSessionId;
  const startedAt = facts.lifetimeCheckoutStartedAt;
  if (!sessionId || !startedAt) return "none";
  if (now.getTime() - startedAt.getTime() > CONFIRM_MAX_AGE_MS) {
    await clearPendingLifetimeCheckout(userId, sessionId);
    return "none";
  }
  try {
    await consumeBucket("lifetime-confirm", userId, RATE_LIMITS.lifetimeConfirm);
  } catch {
    return "none";
  }
  const verdict = await confirmLifetimeCheckout(userId, sessionId, now, retrieve);
  if (verdict.kind === "paid") return "granted";
  if (verdict.kind === "processing") return "processing";
  return "none";
}
