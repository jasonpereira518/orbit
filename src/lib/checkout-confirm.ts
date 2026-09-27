import type Stripe from "stripe";

/**
 * Pure checks for verify-on-return. Imports Stripe for types only.
 *
 * The return URL is not proof of payment: anyone can type `?session_id=`, and a session from
 * browser history may since have been refunded. So the retrieved session must belong to the
 * caller, be complete, be recent, and still hold its money. When any of that cannot be shown
 * (an unexpanded charge, a no-payment session), the answer is "skip": the webhook remains the
 * guarantee, and this path is only ever a shortcut.
 */
export const CONFIRM_WINDOW_SECONDS = 24 * 60 * 60;

type ChargeLike = { refunded?: boolean; amount_refunded?: number; disputed?: boolean };

export type ConfirmableSession = {
  id: string;
  client_reference_id: string | null;
  status: string | null;
  payment_status: string;
  mode: string;
  created: number;
  payment_intent?: string | { latest_charge?: string | ChargeLike | null } | null;
  subscription?: string | { status?: string } | null;
};

export type ConfirmVerdict =
  | { ok: true }
  | {
      ok: false;
      reason: "not_yours" | "incomplete" | "unpaid" | "too_old" | "unverifiable" | "reversed" | "subscription_inactive";
    };

export function checkoutSessionVerdict(
  session: ConfirmableSession,
  ctx: { userId: string; nowSeconds: number }
): ConfirmVerdict {
  if (session.client_reference_id !== ctx.userId) return { ok: false, reason: "not_yours" };
  if (session.status !== "complete") return { ok: false, reason: "incomplete" };
  if (session.payment_status === "unpaid") return { ok: false, reason: "unpaid" };
  if (ctx.nowSeconds - session.created > CONFIRM_WINDOW_SECONDS) return { ok: false, reason: "too_old" };

  if (session.mode === "payment") {
    const intent = session.payment_intent;
    const charge = intent && typeof intent === "object" ? intent.latest_charge : null;
    if (!charge || typeof charge !== "object") return { ok: false, reason: "unverifiable" };
    if (charge.refunded || (charge.amount_refunded ?? 0) > 0 || charge.disputed) {
      return { ok: false, reason: "reversed" };
    }
  }

  if (session.mode === "subscription") {
    const sub = session.subscription;
    const status = sub && typeof sub === "object" ? sub.status : null;
    if (status !== "active" && status !== "trialing") {
      return { ok: false, reason: "subscription_inactive" };
    }
  }

  return { ok: true };
}

/**
 * The session as the event the webhook would have delivered. `created` is the SESSION's,
 * which predates every subscription event it caused, so the ordering clock (Task 3) can
 * never mistake a replay for news.
 */
export function syntheticCheckoutEvent(session: Stripe.Checkout.Session): Stripe.Event {
  return {
    id: `confirm_${session.id}`,
    object: "event",
    type: "checkout.session.completed",
    created: session.created,
    data: { object: session },
  } as unknown as Stripe.Event;
}
