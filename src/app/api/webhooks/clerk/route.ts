import { verifyWebhook } from "@clerk/nextjs/webhooks";
import type { NextRequest } from "next/server";
import { purgeUserData } from "@/lib/user-data";
import {
  ensureUserSettings,
  setSubscriptionState,
  setUserEmail,
  setUserIdentity,
} from "@/lib/user-settings";
import { ORBIT_PLAN_SLUG } from "@/lib/entitlements";
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

/**
 * Maps a Clerk subscription-item status onto what Orbit stores.
 *
 * `upcoming` is a scheduled future item, not an entitlement, so it is ignored entirely.
 * Terminal states clear the plan. `canceled` is kept rather than cleared because the user
 * has paid through `period_end` — `resolvePlan` honours that remaining time.
 */
function mirrorForStatus(
  status: string,
  periodEnd: number | null
): { plan: "orbit" | null; status: "active" | "past_due" | "canceled" | null; periodEnd: number | null } | null {
  switch (status) {
    case "active":
      return { plan: "orbit", status: "active", periodEnd };
    case "past_due":
      return { plan: "orbit", status: "past_due", periodEnd };
    case "canceled":
      return { plan: "orbit", status: "canceled", periodEnd };
    case "ended":
    case "expired":
    case "abandoned":
    case "incomplete":
      return { plan: null, status: null, periodEnd: null };
    default:
      return null;
  }
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
    } else if (evt.type.startsWith("subscriptionItem.")) {
      // Billing. Clerk sells the $5/mo plan; these events mirror it into user_settings so
      // that `getEntitlements` — and therefore every gate, including ones in background
      // jobs — resolves from the database alone.
      //
      // The three drop cases are split apart rather than collapsed into one condition,
      // because "we ignored a billing event" is exactly the thing worth being able to
      // query later.
      const data = evt.data as {
        id?: string;
        status?: string;
        period_end?: number | null;
        plan?: { slug?: string } | null;
        payer?: { user_id?: string };
      };
      const userId = data.payer?.user_id ?? null;
      const slug = data.plan?.slug ?? null;
      const detail = {
        slug,
        status: data.status ?? null,
        periodEnd: data.period_end ?? null,
      };

      if (!userId) {
        result = {
          outcome: "ignored",
          reason: WEBHOOK_REASONS.noPayerUserId,
          resourceId: data.id ?? null,
          detail,
        };
      } else if (slug !== ORBIT_PLAN_SLUG) {
        // Ignore items for any other plan, so a second product can be added later without
        // this handler silently granting Orbit.
        result = {
          outcome: "ignored",
          reason: WEBHOOK_REASONS.otherPlanSlug,
          targetUserId: userId,
          resourceId: data.id ?? null,
          detail,
        };
      } else {
        const mirror = data.status
          ? mirrorForStatus(data.status, data.period_end ?? null)
          : null;
        if (!mirror) {
          // `upcoming`, or a status Clerk has added since this was written.
          result = {
            outcome: "ignored",
            reason: WEBHOOK_REASONS.unmappedStatus,
            targetUserId: userId,
            resourceId: data.id ?? null,
            detail,
          };
        } else {
          await setSubscriptionState(userId, mirror);
          result = {
            outcome: "handled",
            targetUserId: userId,
            resourceId: data.id ?? null,
            detail,
          };
        }
      }
    } else if (evt.type.startsWith("waitlistEntry.")) {
      // Not mirrored into a table — the ledger IS the record. The landing page's waitlist
      // form posts straight to Clerk, so without this there is no local trace of it at all.
      const data = evt.data as {
        id?: string;
        status?: string;
        email_address?: string;
      };
      result = {
        outcome: "handled",
        resourceId: data.id ?? null,
        detail: {
          waitlistStatus: data.status ?? null,
          email: data.email_address?.toLowerCase() ?? null,
        },
      };
    } else if (evt.type.startsWith("paymentAttempt.")) {
      // Also ledger-only. A failed payment is otherwise invisible until the subscription
      // eventually flips to past_due, which can be days later.
      const data = evt.data as {
        id?: string;
        status?: string;
        payer?: { user_id?: string };
      };
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
