"use server";

import { requireAuthenticatedUser } from "@/lib/auth";
import { loadAppPulse } from "@/lib/app-pulse";

/** The one periodic read per tab. See `src/lib/app-pulse.ts` and `src/lib/app-pulse-store.ts`. */
export async function getAppPulse() {
  // The row the auth gate reads is handed on: in a Server Action `cache()` is a pass-through,
  // so re-reading it below would cost a round trip per helper.
  const { userId, settings } = await requireAuthenticatedUser();
  return loadAppPulse(userId, new Date(), settings);
}
