"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import { ensureUserSettings } from "@/lib/user-settings";
import type { WizardStep } from "@/components/onboarding/wizard/setup-wizard";

/**
 * Every step id the wizard can be resumed at.
 *
 * A `Record<WizardStep, true>` rather than a bare `Set` of strings so that
 * adding a step to the union in setup-wizard.tsx without adding it here is a
 * compile error. It used to be a hand-maintained set behind a "keep in sync"
 * comment, and it fell out of sync the moment `triage` landed: `saveWizardStep`
 * silently returned `{ok: false}` for the whole step, so anyone who refreshed
 * mid-triage resumed at `import` and did the import again. The import is
 * type-only and erased at build time, so this does not pull a client component
 * into the server bundle.
 */
const WIZARD_STEP_IDS: Record<WizardStep, true> = {
  intro: true,
  "add-people": true,
  "connect-google": true,
  manual: true,
  capture: true,
  import: true,
  triage: true,
  "ai-key": true,
  review: true,
};
const VALID_WIZARD_STEPS = new Set<string>(Object.keys(WIZARD_STEP_IDS));

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
