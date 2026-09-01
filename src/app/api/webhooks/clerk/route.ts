import { verifyWebhook } from "@clerk/nextjs/webhooks";
import type { NextRequest } from "next/server";
import { purgeUserData } from "@/lib/user-data";
import {
  ensureUserSettings,
  setUserEmail,
  setUserIdentity,
} from "@/lib/user-settings";
import { recordBillingEvent } from "@/lib/billing-events";
import {
  WEBHOOK_REASONS,
  recordWebhookDelivery,
  type WebhookOutcome,
} from "@/lib/webhook-deliveries";

type ClerkEmailAddress = { id?: string; email_address?: string };

/** Picks the primary address, falling back to the first one Clerk lists. */
function primaryEmail(data: {
  email_addresses?: ClerkEmailAddress[];
  primary_email_address_id?: string | null;
}) {
  const list = data.email_addresses ?? [];
  const primary =
    list.find((e) => e.id && e.id === data.primary_email_address_id) ?? list[0];
  return primary?.email_address?.toLowerCase() ?? null;
}

type HandlerResult = {
  outcome: WebhookOutcome;
  reason?: string;
  targetUserId?: string | null;
  resourceId?: string | null;
  detail?: Record<string, unknown>;
};

export async function POST(req: NextRequest) {
  const started = Date.now();
  // Clerk's event body carries no delivery id — `data.id` is the *resource*, which repeats
  // across retries. The Standard Webhooks / Svix header is the delivery id, and crucially
  // it is readable before verification, which is what makes the rejection path recordable.
  const eventId =
    req.headers.get("svix-id") ?? req.headers.get("webhook-id") ?? null;

  let evt;
  try {
    evt = await verifyWebhook(req);
  } catch (err) {
    console.error("Clerk webhook verification failed:", err);
    // Deliberately stores nothing from the body: an unverified payload is untrusted input.
    await recordWebhookDelivery({
      eventId,
      eventType: null,
      outcome: "invalid",
      reason: WEBHOOK_REASONS.signatureInvalid,
      error: err,
      durationMs: Date.now() - started,
    });
    return new Response("Verification failed", { status: 400 });
  }

  // `subscriptionItem.*` is deliberately absent: Orbit Pro is now sold exclusively through
  // Stripe (see api/webhooks/stripe), the Clerk "orbit" plan has been removed from the
  // Clerk Dashboard, and no Clerk subscription was ever sold — so any such event that
  // somehow still arrives correctly falls through to `ignored`/`unhandledType` below.
  let result: HandlerResult = {
    outcome: "ignored",
    reason: WEBHOOK_REASONS.unhandledType,
  };

  try {
    // user.updated is handled too, otherwise the mirrored address rots whenever someone
    // changes or re-verifies their primary email in Clerk.
    // NOTE: every event type below must also be enabled on this endpoint's subscription in
    // the Clerk Dashboard — handling them in code alone is not enough.
    if (evt.type === "user.created" || evt.type === "user.updated") {
      const userId = evt.data.id;
      if (userId) {
        await ensureUserSettings(userId);
        await setUserEmail(userId, primaryEmail(evt.data));
        // Name and avatar arrive in this same payload, so mirroring them costs nothing
        // beyond the write — and it is what lets the admin roster show a person rather
        // than a `user_2abc…` id without ever calling the Clerk API.
        await setUserIdentity(userId, {
          firstName: evt.data.first_name,
          lastName: evt.data.last_name,
          imageUrl: evt.data.image_url,
        });
        result = { outcome: "handled", targetUserId: userId, resourceId: userId };
      } else {
        result = { outcome: "ignored", reason: WEBHOOK_REASONS.missingUserId };
      }
    } else if (evt.type === "user.deleted") {
      const userId = evt.data.id;
      if (userId) {
        await purgeUserData(userId);
        result = { outcome: "handled", targetUserId: userId, resourceId: userId };
      } else {
        result = { outcome: "ignored", reason: WEBHOOK_REASONS.missingUserId };
      }
    } else if (evt.type.startsWith("paymentAttempt.")) {
      // A failed payment is otherwise invisible until the subscription eventually flips to
      // past_due, which can be days later — and by then the user has already been surprised.
      const data = evt.data as {
        id?: string;
        status?: string;
        payer?: { user_id?: string };
      };

      if (data.status === "failed" && eventId) {
        await recordBillingEvent({
          source: "clerk",
          eventId,
          kind: "payment_failed",
          userId: data.payer?.user_id ?? null,
          // No MRR delta: the subscription has not changed value yet, and booking a
          // churn here would report revenue lost that may well be collected on retry.
          detail: { paymentAttemptId: data.id ?? null },
        });
      }
      result = {
        outcome: "handled",
        targetUserId: data.payer?.user_id ?? null,
        resourceId: data.id ?? null,
        detail: { paymentStatus: data.status ?? null },
      };
    }
  } catch (err) {
    // Not a behaviour change — an unhandled throw already 500'd. It is just visible now.
    // Keeping the 500 is correct: Svix retries with backoff, so a transient DB blip
    // self-heals rather than permanently desyncing billing.
    await recordWebhookDelivery({
      eventId,
      eventType: evt.type,
      outcome: "error",
      reason: WEBHOOK_REASONS.handlerThrew,
      error: err,
      durationMs: Date.now() - started,
    });
    throw err;
  }

  await recordWebhookDelivery({
    eventId,
    eventType: evt.type,
    outcome: result.outcome,
    reason: result.reason ?? null,
    targetUserId: result.targetUserId ?? null,
    resourceId: result.resourceId ?? null,
    detail: result.detail ?? {},
    durationMs: Date.now() - started,
  });

  return new Response("OK", { status: 200 });
}
