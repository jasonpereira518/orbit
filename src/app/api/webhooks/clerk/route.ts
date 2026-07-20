import { verifyWebhook } from "@clerk/nextjs/webhooks";
import type { NextRequest } from "next/server";
import { purgeUserData } from "@/lib/user-data";
import { ensureUserSettings } from "@/lib/user-settings";

export async function POST(req: NextRequest) {
  let evt;
  try {
    evt = await verifyWebhook(req);
  } catch (err) {
    console.error("Clerk webhook verification failed:", err);
    return new Response("Verification failed", { status: 400 });
  }

  if (evt.type === "user.created") {
    const userId = evt.data.id;
    if (userId) {
      await ensureUserSettings(userId);
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
