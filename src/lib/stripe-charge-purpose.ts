import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { billingEvents } from "@/db/schema";
import type { ChargePurpose } from "@/lib/billing-stripe";
import {
  getStripe,
  LIFETIME_METADATA_KEY,
  LIFETIME_METADATA_VALUE,
} from "@/lib/stripe";

/**
 * What a refunded or disputed charge originally paid for — the one fact the pure decision
 * in `billing-stripe.ts` needs before it can withdraw access, and cannot look up itself.
 *
 * A Charge on current Stripe API versions carries a `payment_intent` and no invoice. So:
 *
 *   1. Our own ledger. Every Lifetime `cs:` booking written since the refund work records
 *      its `paymentIntentId` in `detail` — free, and it covers every new purchase.
 *   2. The Checkout Session that created the payment intent. Covers Lifetime purchases
 *      booked before (1) existed; its `orbit_plan` metadata says what was bought.
 *   3. An invoice payment for the payment intent. Only Orbit Pro raises invoices, so any
 *      match is a subscription charge.
 *
 * Anything else — a manual charge made in the dashboard, say — is "unknown" and revokes
 * nothing. A lookup that throws propagates on purpose: the webhook answers 500 and Stripe
 * retries, rather than silently keeping a refunded buyer's access.
 *
 * No `next/server`: the webhook route and tsx scripts both import this.
 */
export type ChargePurposeLookups = {
  /** A Lifetime booking on our own ledger was paid with this payment intent. */
  lifetimeOnLedger(paymentIntentId: string): Promise<boolean>;
  /** `orbit_plan` metadata of the Checkout Session that created this payment intent. */
  checkoutSessionPlan(paymentIntentId: string): Promise<string | null>;
  /** This payment intent paid an invoice. */
  hasInvoicePayment(paymentIntentId: string): Promise<boolean>;
};

export const stripeChargePurposeLookups: ChargePurposeLookups = {
  async lifetimeOnLedger(paymentIntentId) {
    const db = await getDb();
    const rows = await db
      .select({ id: billingEvents.id })
      .from(billingEvents)
      .where(
        and(
          eq(billingEvents.source, "stripe"),
          eq(billingEvents.kind, "lifetime"),
          sql`${billingEvents.detail}->>'paymentIntentId' = ${paymentIntentId}`
        )
      )
      .limit(1);
    return rows.length > 0;
  },
  async checkoutSessionPlan(paymentIntentId) {
    const page = await getStripe().checkout.sessions.list({
      payment_intent: paymentIntentId,
      limit: 1,
    });
    return page.data[0]?.metadata?.[LIFETIME_METADATA_KEY] ?? null;
  },
  async hasInvoicePayment(paymentIntentId) {
    const page = await getStripe().invoicePayments.list({
      payment: { type: "payment_intent", payment_intent: paymentIntentId },
      limit: 1,
    });
    return page.data.length > 0;
  },
};

export async function resolveChargePurpose(
  paymentIntentId: string | null,
  lookups: ChargePurposeLookups = stripeChargePurposeLookups
): Promise<ChargePurpose> {
  if (!paymentIntentId) return "unknown";
  if (await lookups.lifetimeOnLedger(paymentIntentId)) return "lifetime";
  const plan = await lookups.checkoutSessionPlan(paymentIntentId);
  if (plan === LIFETIME_METADATA_VALUE) return "lifetime";
  if (await lookups.hasInvoicePayment(paymentIntentId)) return "subscription";
  return "unknown";
}
