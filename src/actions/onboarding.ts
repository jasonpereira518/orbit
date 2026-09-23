"use server";

import { eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import { TERMS_VERSION } from "@/lib/legal";
import { persistOnboardingComplete } from "@/lib/onboarding";
import { removeTourExamples } from "@/lib/onboarding-examples/remove";
import { isOnboardingPath, isOnboardingStep, type OnboardingPath } from "@/lib/onboarding-steps";
import { ensureUserSettings, recordTermsAcceptance } from "@/lib/user-settings";

function revalidateOnboarding() {
  for (const path of ["/onboarding", "/dashboard", "/settings", "/contacts", "/capture", "/imports"]) {
    revalidatePath(path);
  }
}

/** The fallback consent for accounts Clerk did not record one for (also `TermsUpdateNotice`). */
export async function acceptTerms() {
  const userId = await requireUserId();
  await ensureUserSettings(userId);
  await recordTermsAcceptance(userId, { acceptedAt: new Date(), version: TERMS_VERSION });
  return { ok: true as const };
}

/**
 * The welcome screen's choice: the guided tour or quick setup. Both paths open on the
 * LinkedIn step. `wizard_offered_at` keeps its old funnel meaning of "reached setup",
 * write-once in SQL so choosing again later does not move it.
 */
export async function startOnboardingPath(path: string) {
  if (!isOnboardingPath(path)) return { ok: false as const };
  const userId = await requireUserId();
  const db = await getDb();
  await ensureUserSettings(userId);
  await db
    .update(userSettings)
    .set({
      onboardingPath: path,
      onboardingStep: "linkedin",
      wizardOfferedAt: sql`COALESCE(${userSettings.wizardOfferedAt}, now())`,
      updatedAt: new Date(),
    })
    .where(eq(userSettings.userId, userId));
  return { ok: true as const };
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

  return { ok: true as const };
}

/**
 * Mark the stage done. The client navigates — redirect() is unreliable inside
 * useTransition.
 *
 * `finished` is quick setup's "Go to dashboard", as opposed to "Skip setup". Only a finish
 * stamps `wizard_completed_at`, which the admin funnel reads as "Finished setup". The tour
 * path never calls this: its handoff is `startInAppTour` and its finish is `finishTour`.
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
  await persistOnboardingComplete(userId);
  revalidateOnboarding();
  return { ok: true as const, redirectTo: "/dashboard" as const };
}

/**
 * Opt-in replay from Settings — never automatic on later visits. Clears the gate flag but
 * sets `onboarding_step` to "welcome": `/onboarding` renders while a step is set, which is
 * what lets a populated account (whose gate backfill re-stamps the flag) walk the stage
 * again. In-app tour state is cleared too, so a replayed tour starts from its first stop.
 */
export async function resetOnboarding(opts: { path?: OnboardingPath } = {}) {
  const userId = await requireUserId();
  const db = await getDb();
  const settings = await ensureUserSettings(userId);
  // A replayed tour seeds afresh; anything left from an earlier one goes first.
  await removeTourExamples(userId, { since: settings.tourStartedAt });
  await db
    .update(userSettings)
    .set({
      onboardingCompletedAt: null,
      onboardingStep: "welcome",
      onboardingPath: opts.path ?? null,
      tourStartedAt: null,
      tourStop: null,
      tourExitedAt: null,
      tourCompletedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(userSettings.userId, userId));

  revalidateOnboarding();
  return { ok: true as const, redirectTo: "/onboarding" as const };
}
