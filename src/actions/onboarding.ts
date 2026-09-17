"use server";

import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import { ensureUserSettings } from "@/lib/user-settings";
import { persistOnboardingComplete } from "@/lib/onboarding";
import { isOnboardingStep, isPeopleStep } from "@/lib/onboarding-steps";

async function markOnboardingComplete(userId: string) {
  await persistOnboardingComplete(userId);
  revalidatePath("/onboarding");
  revalidatePath("/dashboard");
  revalidatePath("/settings");
  revalidatePath("/contacts");
  revalidatePath("/capture");
  revalidatePath("/imports");
}

/**
 * Mark onboarding done. Client should navigate — redirect() is unreliable inside
 * useTransition.
 *
 * `finished` is the done step's "Go to your dashboard", as opposed to "Skip setup". Only a
 * finish stamps `wizard_completed_at`, which the admin funnel reads as "Finished setup" —
 * the one flow replaced the tour + wizard pair, and that column kept its meaning.
 */
export async function completeOnboarding(opts: { finished?: boolean } = {}) {
  const userId = await requireUserId();
  if (opts.finished) {
    const db = await getDb();
    await ensureUserSettings(userId);
    await db
      .update(userSettings)
      .set({ wizardCompletedAt: new Date(), wizardStep: null, updatedAt: new Date() })
      .where(eq(userSettings.userId, userId));
  }
  await markOnboardingComplete(userId);
  return { ok: true as const, redirectTo: "/dashboard" as const };
}

/** Persist the current step so a refresh resumes mid-flow. */
export async function saveOnboardingStep(step: string) {
  if (!isOnboardingStep(step)) return { ok: false as const };

  const userId = await requireUserId();
  const db = await getDb();
  await ensureUserSettings(userId);
  await db
    .update(userSettings)
    .set({ onboardingStep: step, updatedAt: new Date() })
    .where(eq(userSettings.userId, userId));

  // Reaching "add your first people" is what the admin funnel has always counted as being
  // offered setup. Write-once in SQL, so walking back and forth does not move it.
  if (isPeopleStep(step)) {
    await db
      .update(userSettings)
      .set({ wizardOfferedAt: new Date() })
      .where(and(eq(userSettings.userId, userId), isNull(userSettings.wizardOfferedAt)));
  }

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
