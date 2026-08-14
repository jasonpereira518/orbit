"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import { ensureUserSettings } from "@/lib/user-settings";

/** Keep in sync with the wizard's step ids in setup-wizard.tsx. */
const VALID_WIZARD_STEPS = new Set([
  "intro",
  "add-people",
  "manual",
  "capture",
  "import",
  "review",
]);

export async function getWizardStatus() {
  const userId = await requireUserId();
  const settings = await ensureUserSettings(userId);
  return {
    offered: Boolean(settings.wizardOfferedAt),
    completed: Boolean(settings.wizardCompletedAt),
    step: settings.wizardStep,
  };
}

/** Persist the current wizard step so a refresh resumes mid-flow. */
export async function saveWizardStep(step: string) {
  if (!VALID_WIZARD_STEPS.has(step)) return { ok: false as const };

  const userId = await requireUserId();
  const db = await getDb();
  await ensureUserSettings(userId);
  await db
    .update(userSettings)
    .set({
      wizardStep: step,
      updatedAt: new Date(),
    })
    .where(eq(userSettings.userId, userId));

  return { ok: true as const };
}

/** Fires once, from either button on the tour's end-of-tour offer step. */
export async function markWizardOffered() {
  const userId = await requireUserId();
  const db = await getDb();
  await ensureUserSettings(userId);
  await db
    .update(userSettings)
    .set({
      wizardOfferedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(userSettings.userId, userId));

  return { ok: true as const };
}

export async function completeWizard() {
  const userId = await requireUserId();
  const db = await getDb();
  await ensureUserSettings(userId);
  await db
    .update(userSettings)
    .set({
      wizardCompletedAt: new Date(),
      wizardStep: null,
      updatedAt: new Date(),
    })
    .where(eq(userSettings.userId, userId));

  revalidatePath("/onboarding/wizard");
  revalidatePath("/dashboard");
  revalidatePath("/settings");
  revalidatePath("/contacts");
  revalidatePath("/capture");
  revalidatePath("/imports");

  return { ok: true as const, redirectTo: "/dashboard" as const };
}

/** Opt-in re-entry from Settings — does not affect tour completion state. */
export async function resetWizard() {
  const userId = await requireUserId();
  const db = await getDb();
  await ensureUserSettings(userId);
  await db
    .update(userSettings)
    .set({
      wizardCompletedAt: null,
      wizardStep: null,
      updatedAt: new Date(),
    })
    .where(eq(userSettings.userId, userId));

  revalidatePath("/onboarding/wizard");
  revalidatePath("/settings");
  return { ok: true as const, redirectTo: "/onboarding/wizard" as const };
}
