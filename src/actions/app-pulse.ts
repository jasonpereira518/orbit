"use server";

import { after } from "next/server";
import { requireAuthenticatedUser } from "@/lib/auth";
import { loadAppPulse } from "@/lib/app-pulse";
import { refreshUserCalendarWindows } from "@/lib/calendar-window";
import { reportError } from "@/lib/report-error";
import { defineAction } from "@/lib/input/action";

/** The one periodic read per tab. See `src/lib/app-pulse.ts` and `src/lib/app-pulse-store.ts`. */
export const getAppPulse = defineAction(
  { auth: () => requireAuthenticatedUser() },
  async ({ userId, settings }) => {
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
);
