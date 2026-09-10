import { verifyWebhook } from "@clerk/nextjs/webhooks";
import type { NextRequest } from "next/server";
import { purgeUserData } from "@/lib/user-data";
import {
  ensureUserSettings,
  setSubscriptionState,
  setUserEmail,
} from "@/lib/user-settings";
import { ORBIT_PLAN_SLUG } from "@/lib/entitlements";
import { mirrorForClerkStatus } from "@/lib/clerk-subscription";
import { recordOperationalEvent } from "@/lib/operational-events";

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

export async function POST(req: NextRequest) {
  const deliveryId = req.headers.get("svix-id");
  let evt;
  try {
    evt = await verifyWebhook(req);
  } catch {
    console.error("Clerk webhook verification failed.");
    await recordOperationalEvent({
      severity: "warn",
      source: "webhook",
      eventType: "webhook.clerk.verification_failed",
      message: "Clerk rejected a webhook signature.",
      success: false,
      correlationId: deliveryId,
      dedupeKey: deliveryId ? `clerk:${deliveryId}:verification` : null,
    });
    return new Response("Verification failed", { status: 400 });
  }

  const eventData = evt.data as {
    id?: string;
    payer?: { user_id?: string };
  };
  const journalUserId = eventData.payer?.user_id ?? eventData.id ?? null;

  try {

  // user.updated is handled too, otherwise the mirrored address rots whenever someone
  // changes or re-verifies their primary email in Clerk.
  // NOTE: `user.updated` must also be enabled on this endpoint's subscription in the
  // Clerk Dashboard — enabling it in code alone is not enough.
  if (evt.type === "user.created" || evt.type === "user.updated") {
    const userId = evt.data.id;
    if (userId) {
      await ensureUserSettings(userId);
      await setUserEmail(userId, primaryEmail(evt.data));
    }
  }

  // Billing. Clerk sells the $5/mo plan; these events mirror it into user_settings so
  // that `getEntitlements` — and therefore every gate, including ones in background jobs
  // — resolves from the database alone.
  if (evt.type.startsWith("subscriptionItem.")) {
    const data = evt.data as {
      id?: string;
      status?: string;
      period_end?: number | null;
      plan?: { slug?: string } | null;
      payer?: { user_id?: string };
    };
    const userId = data.payer?.user_id;
    const slug = data.plan?.slug;

    // Ignore items for any other plan, so a second product can be added later without
    // this handler silently granting Orbit.
    if (userId && slug === ORBIT_PLAN_SLUG && data.status) {
      const mirror = mirrorForClerkStatus(data.status, data.period_end ?? null);
      if (mirror) {
        await setSubscriptionState(userId, mirror, {
          eventKey: `clerk:${deliveryId ?? `${data.id ?? "item"}:${data.status}:${data.period_end ?? "none"}`}`,
        });
      }
    }
  }

  if (evt.type === "user.deleted") {
    const userId = evt.data.id;
    if (userId) {
      await purgeUserData(userId);
    }
  }
  } catch {
    await recordOperationalEvent({
      severity: "error",
      source: "webhook",
      eventType: `webhook.clerk.${evt.type}`,
      message: "Clerk webhook processing failed.",
      success: false,
      userId: journalUserId,
      correlationId: deliveryId,
      dedupeKey: deliveryId ? `clerk:${deliveryId}:failed` : null,
    });
    return new Response("Processing failed", { status: 500 });
  }

  await recordOperationalEvent({
    severity: "info",
    source: "webhook",
    eventType: `webhook.clerk.${evt.type}`,
    message: "Clerk webhook processed.",
    success: true,
    userId: journalUserId,
    correlationId: deliveryId,
    dedupeKey: deliveryId ? `clerk:${deliveryId}:processed` : null,
  });

  return new Response("OK", { status: 200 });
}
