"use server";

import { after } from "next/server";
import { requireAuthenticatedUser } from "@/lib/auth";
import { loadAppPulse } from "@/lib/app-pulse";
import { refreshUserCalendarWindows } from "@/lib/calendar-events";
import { reportError } from "@/lib/report-error";

/** The one periodic read per tab. See `src/lib/app-pulse.ts` and `src/lib/app-pulse-store.ts`. */
export async function getAppPulse() {
  // The row the auth gate reads is handed on: in a Server Action `cache()` is a pass-through,
  // so re-reading it below would cost a round trip per helper.
  const { userId, settings } = await requireAuthenticatedUser();
  const now = new Date();
  // After the response: a fresh read shows on the NEXT pulse, and a slow or failing calendar
  // never costs this one. Throttled inside to one read per user per ten minutes.
  after(() =>
    refreshUserCalendarWindows(userId, now).catch((err) =>
      reportError(err, { where: "pulse.calendar-window", userId, level: "warning" })
    )
  );
  return loadAppPulse(userId, now, settings);
}
