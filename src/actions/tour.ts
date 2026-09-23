"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import { seedTourExamples } from "@/lib/onboarding-examples/seed";
import { ensureUserSettings } from "@/lib/user-settings";

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
export async function startInAppTour() {
  const userId = await requireUserId();
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
  revalidateToured();
  return { ok: true as const, redirectTo: "/dashboard" as const };
}
