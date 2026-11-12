"use server";

import { cookies } from "next/headers";
import { after } from "next/server";
import { requireAuthenticatedUser } from "@/lib/auth";
import { loadAppPulse } from "@/lib/app-pulse";
import { refreshUserCalendarWindows } from "@/lib/calendar-window";
import { captureRadarTimeZone } from "@/lib/radar/digest";
import { TZ_COOKIE } from "@/lib/reminder-due-bucket";
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
  // Radar's "5am your time" and the Monday email need the person's zone, which only the
  // browser knows. Saved from whatever page is open, and only when it changed: the pulse runs
  // every 90 seconds, and an unchanged zone must cost no write.
  const tz = (await cookies()).get(TZ_COOKIE)?.value;
  if (tz && tz !== settings?.radarDigestTz) {
    after(() => captureRadarTimeZone(userId, tz).catch(() => undefined));
  }
  return loadAppPulse(userId, now, settings);
}
