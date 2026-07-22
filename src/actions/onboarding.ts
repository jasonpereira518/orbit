"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import { ensureUserSettings } from "@/lib/user-settings";
import {
  needsOnboarding,
  persistOnboardingComplete,
} from "@/lib/onboarding";

/** Keep in sync with TOUR_STEPS ids in tour-config (avoid importing client icons here). */
const VALID_ONBOARDING_STEPS = new Set([
  "welcome",
  "contacts",
  "capture",
  "imports",
  "chat",
  "graph",
  "dashboard",
  "start",
]);

export async function getOnboardingStatus() {
  const userId = await requireUserId();
  return { needsOnboarding: await needsOnboarding(userId) };
}

async function markOnboardingComplete(userId: string) {
  await persistOnboardingComplete(userId);
  revalidatePath("/onboarding");
  revalidatePath("/dashboard");
  revalidatePath("/settings");
  revalidatePath("/contacts");
  revalidatePath("/capture");
  revalidatePath("/imports");
}

/** Mark onboarding done. Client should navigate — redirect() is unreliable inside useTransition. */
export async function completeOnboarding(redirectTo?: string) {
  const userId = await requireUserId();
  await markOnboardingComplete(userId);
  return { ok: true as const, redirectTo: redirectTo || "/dashboard" };
}

export async function skipOnboarding() {
  return completeOnboarding("/dashboard");
}

/** Persist the current tour step so a refresh resumes mid-walkthrough. */
export async function saveOnboardingStep(step: string) {
  if (!VALID_ONBOARDING_STEPS.has(step)) return { ok: false as const };

  const userId = await requireUserId();
  const db = await getDb();
  await ensureUserSettings(userId);
  await db
    .update(userSettings)
    .set({
      onboardingStep: step,
      updatedAt: new Date(),
    })
    .where(eq(userSettings.userId, userId));

  return { ok: true as const };
}

/** Opt-in replay from Settings — does not run automatically on later visits. */
export async function resetOnboarding() {
  const userId = await requireUserId();
  const db = await getDb();
  await ensureUserSettings(userId);
  await db
    .update(userSettings)
    .set({
      onboardingCompletedAt: null,
      onboardingStep: null,
      updatedAt: new Date(),
    })
    .where(eq(userSettings.userId, userId));

  revalidatePath("/onboarding");
  revalidatePath("/dashboard");
  revalidatePath("/settings");
  return { ok: true as const, redirectTo: "/onboarding" as const };
}
