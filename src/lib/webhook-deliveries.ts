import { getDb } from "@/db";
import { webhookDeliveries } from "@/db/schema";
import { toUserFacingError } from "@/lib/errors";

/**
 * The inbound-webhook ledger.
 *
 * Exists because "an event arrived and nothing happened" is otherwise indistinguishable
 * from "no event arrived". That matters most for `subscriptionItem.*`: a dropped or
 * silently-skipped billing event desyncs `user_settings` from Clerk, and every entitlement
 * gate reads those columns while nothing ever reconciles them.
 *
 * No `next/server` import — same event-loop hazard documented in `src/lib/user-settings.ts`.
 */

/** Closed, greppable set so these group cleanly in a GROUP BY. */
export const WEBHOOK_REASONS = {
  signatureInvalid: "signature_invalid",
  unhandledType: "unhandled_type",
  otherPlanSlug: "other_plan_slug",
  noPayerUserId: "no_payer_user_id",
  unmappedStatus: "unmapped_status",
  missingUserId: "missing_user_id",
  handlerThrew: "handler_threw",
  // Stripe-side outcomes. See `STRIPE_IGNORE_REASONS` in `billing-stripe.ts`, which is
  // the pure module's copy — kept in step by the smoke test rather than by an import,
  // because that module must not reach anything that touches the database.
  unpaidSession: "unpaid_session",
  noSubscriptionOnInvoice: "no_subscription_on_invoice",
  zeroAmount: "zero_amount",
  currencyUnsupported: "currency_unsupported",
  disputeWon: "dispute_won",
  noMovement: "no_movement",
} as const;

export type WebhookOutcome = "handled" | "ignored" | "invalid" | "error";

export type WebhookDeliveryRecord = {
  source?: string;
  eventId?: string | null;
  eventType?: string | null;
  outcome: WebhookOutcome;
  reason?: string | null;
  targetUserId?: string | null;
  resourceId?: string | null;
  detail?: Record<string, unknown>;
  error?: unknown;
  durationMs?: number | null;
};

/**
 * Never throws. A ledger failure must never become a non-2xx that makes Svix retry the
 * same event forever.
 */
export async function recordWebhookDelivery(
  rec: WebhookDeliveryRecord
): Promise<void> {
  try {
    const db = await getDb();
    await db.insert(webhookDeliveries).values({
      source: rec.source ?? "clerk",
      eventId: rec.eventId ?? null,
      eventType: rec.eventType ?? null,
      outcome: rec.outcome,
      reason: rec.reason ?? null,
      targetUserId: rec.targetUserId ?? null,
      resourceId: rec.resourceId ?? null,
      detail: rec.detail ?? {},
      error: rec.error
        ? toUserFacingError(rec.error, "Webhook failed").message.slice(0, 500)
        : null,
      durationMs: rec.durationMs ?? null,
    });
  } catch {
    // Telemetry must never surface as a webhook failure.
  }
}
