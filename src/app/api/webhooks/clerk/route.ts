import { verifyWebhook } from "@clerk/nextjs/webhooks";
import type { NextRequest } from "next/server";
import { purgeUserData } from "@/lib/user-data";
import {
  ensureUserSettings,
  setSubscriptionState,
  setUserEmail,
} from "@/lib/user-settings";
import { ORBIT_PLAN_SLUG } from "@/lib/entitlements";

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

export async function POST(req: NextRequest) {
  let evt;
  try {
    evt = await verifyWebhook(req);
  } catch (err) {
    console.error("Clerk webhook verification failed:", err);
    return new Response("Verification failed", { status: 400 });
  }

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
      const mirror = mirrorForStatus(data.status, data.period_end ?? null);
      if (mirror) await setSubscriptionState(userId, mirror);
    }
  }

  if (evt.type === "user.deleted") {
    const userId = evt.data.id;
    if (userId) {
      await purgeUserData(userId);
    }
  }

  return new Response("OK", { status: 200 });
}
