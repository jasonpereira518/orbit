"use server";

import { requireUserId } from "@/lib/auth";
import { loadAppPulse } from "@/lib/app-pulse";

/** The one periodic read per tab. See `src/lib/app-pulse.ts` and `src/lib/app-pulse-store.ts`. */
export async function getAppPulse() {
  const userId = await requireUserId();
  return loadAppPulse(userId, new Date());
}
