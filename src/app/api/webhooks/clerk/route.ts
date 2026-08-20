import { verifyWebhook } from "@clerk/nextjs/webhooks";
import type { NextRequest } from "next/server";
import { purgeUserData } from "@/lib/user-data";
import { ensureUserSettings, setUserEmail } from "@/lib/user-settings";

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

  if (evt.type === "user.deleted") {
    const userId = evt.data.id;
    if (userId) {
      await purgeUserData(userId);
    }
  }

  return new Response("OK", { status: 200 });
}
