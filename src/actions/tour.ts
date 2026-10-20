"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import { removeTourExamples } from "@/lib/onboarding-examples/remove";
import { seedTourExamples } from "@/lib/onboarding-examples/seed";
import { isTourStopId } from "@/lib/tour/tour-stops";
import { ensureUserSettings } from "@/lib/user-settings";
import { z } from "zod";
import { defineAction } from "@/lib/input/action";
import { trackTourStopAdvance } from "@/lib/onboarding-events";

const TOURED_PATHS = [
  "/onboarding",
  "/dashboard",
  "/contacts",
  "/capture",
  "/reminders",
  "/chat",
  "/graph",
  "/imports",
  "/settings",
];

function revalidateToured() {
  for (const path of TOURED_PATHS) revalidatePath(path);
}

/**
 * The stage → app handoff. One UPDATE stamps the first-run gate flag and opens the in-app
 * tour together, so a reload between them cannot land on a half state: either the person
 * is still on the stage, or they are past the gate with the rail up. `tour_stop` starts
 * null, which the runtime reads as "the first stop".
 */
export const startInAppTour = defineAction(
  {},
  async (userId) => {
    const db = await getDb();
    await ensureUserSettings(userId);
    const now = new Date();
    await db
      .update(userSettings)
      .set({
        onboardingCompletedAt: now,
        onboardingStep: null,
        onboardingPath: "tour",
        tourStartedAt: now,
        tourStop: null,
        tourExitedAt: null,
        tourCompletedAt: null,
        updatedAt: now,
      })
      .where(eq(userSettings.userId, userId));
    // After the flag, never before: a failure here leaves the person past the gate with an
    // empty orbit and a retry button, not stuck on the stage.
    await seedTourExamples(userId);
    // No revalidatePath here, on purpose. The launch step leaves with a full page load, so
    // there is no client cache to refresh; and a revalidating action re-renders the page it
    // was posted to, which is /onboarding, which now redirects to the dashboard. That redirect
    // cut the launch animation off the moment the seed finished.
    return { ok: true as const, redirectTo: "/dashboard" as const };
  }
);

/** Persist the current stop so a reload or another tab resumes there. */
export const saveTourStop = defineAction(
  { schema: z.tuple([z.string()]), invalid: () => ({ ok: false as const }) },
  async (userId, stop: string) => {
    if (!isTourStopId(stop)) return { ok: false as const };
    const db = await getDb();
    // The stop being left is the one that was finished. A failed read only skips the event.
    const before = await db.query.userSettings
      .findFirst({ where: eq(userSettings.userId, userId), columns: { tourStop: true } })
      .catch(() => null);
    await db
      .update(userSettings)
      .set({ tourStop: stop, updatedAt: new Date() })
      .where(eq(userSettings.userId, userId));
    if (before) trackTourStopAdvance(userId, before.tourStop, stop);
    return { ok: true as const };
  }
);

/**
 * Exit for now. The rail hides, the example people go (they exist only while the tour is
 * running), and the stop is kept so Resume picks up where they left off.
 */
export const exitTour = defineAction(
  {},
  async (userId) => {
    const settings = await ensureUserSettings(userId);
    const db = await getDb();
    await db
      .update(userSettings)
      .set({ tourExitedAt: new Date(), updatedAt: new Date() })
      .where(eq(userSettings.userId, userId));
    await removeTourExamples(userId, { since: settings.tourStartedAt });
    revalidateToured();
    return { ok: true as const };
  }
);

/** Pick the tour back up at the saved stop, with the example people planted again. */
export const resumeTour = defineAction(
  {},
  async (userId) => {
    const db = await getDb();
    await ensureUserSettings(userId);
    await db
      .update(userSettings)
      .set({ tourExitedAt: null, tourCompletedAt: null, updatedAt: new Date() })
      .where(eq(userSettings.userId, userId));
    await seedTourExamples(userId);
    revalidateToured();
    return { ok: true as const, redirectTo: "/dashboard" as const };
  }
);

/** Start the in-app tour over from its first stop (Settings → Help). */
export const restartTour = defineAction(
  {},
  async (userId) => {
    const settings = await ensureUserSettings(userId);
    const db = await getDb();
    const now = new Date();
    await removeTourExamples(userId, { since: settings.tourStartedAt });
    await db
      .update(userSettings)
      .set({
        onboardingCompletedAt: settings.onboardingCompletedAt ?? now,
        onboardingPath: "tour",
        tourStartedAt: now,
        tourStop: null,
        tourExitedAt: null,
        tourCompletedAt: null,
        updatedAt: now,
      })
      .where(eq(userSettings.userId, userId));
    await seedTourExamples(userId);
    revalidateToured();
    return { ok: true as const, redirectTo: "/dashboard" as const };
  }
);

/**
 * The finish card. Stamps the tour done and `wizard_completed_at` (the admin funnel's
 * "Finished setup", on either path), removes the example people, and revalidates every
 * page they appeared on.
 */
export const finishTour = defineAction(
  {},
  async (userId) => {
    const settings = await ensureUserSettings(userId);
    const db = await getDb();
    const now = new Date();
    await db
      .update(userSettings)
      .set({
        tourCompletedAt: now,
        tourStop: null,
        tourExitedAt: null,
        wizardCompletedAt: settings.wizardCompletedAt ?? now,
        wizardStep: null,
        updatedAt: now,
      })
      .where(eq(userSettings.userId, userId));
    const { removed } = await removeTourExamples(userId, { since: settings.tourStartedAt });
    revalidateToured();
    return { ok: true as const, removed, redirectTo: "/dashboard" as const };
  }
);
