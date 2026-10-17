"use server";

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { contacts, reminders, userSettings } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import { TERMS_VERSION } from "@/lib/legal";
import { persistOnboardingComplete } from "@/lib/onboarding";
import { removeTourExamples } from "@/lib/onboarding-examples/remove";
import { notTourExample } from "@/lib/onboarding-examples/sql";
import { isOnboardingPath, isOnboardingStep, stepAllowedOnPath, type OnboardingPath } from "@/lib/onboarding-steps";
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
 * The welcome screen's choice: the guided tour or quick setup. Both paths open on their
 * first main-line step. `wizard_offered_at` keeps its old funnel meaning of "reached setup",
 * write-once in SQL so choosing again later does not move it.
 */
export async function startOnboardingPath(path: string, first: string) {
  if (!isOnboardingPath(path)) return { ok: false as const };
  const step = isOnboardingStep(first) && stepAllowedOnPath(first, path) ? first : "welcome";
  const userId = await requireUserId();
  const db = await getDb();
  await ensureUserSettings(userId);
  await db
    .update(userSettings)
    .set({
      onboardingPath: path,
      onboardingStep: step,
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
      // "welcome" marks onboarding as in progress, which is what keeps `needsOnboarding`'s
      // backfill from re-completing it on the next page view — with null here, a replay
      // lasted exactly one navigation.
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

export type FirstWinPerson = {
  id: string;
  name: string;
  /** What to call them in a headline: their preferred name, or the first word of their name. */
  firstName: string;
  /** "Campus Recruiter at Datadog", or whichever half is known. */
  subtitle: string | null;
  /** The earliest thing Orbit will bring this person back for, or null when nothing is set. */
  followUp: { title: string; dueDate: string } | null;
};

/**
 * What the first-win screen shows back: the people this account added most recently (at most
 * three, newest first), each with the follow-up Orbit set, and how many real people it has in
 * all. Tour examples never count. Read once, when the screen opens.
 */
export async function getFirstWinSummary(): Promise<{ people: FirstWinPerson[]; total: number }> {
  const userId = await requireUserId();
  const db = await getDb();
  const own = and(eq(contacts.userId, userId), notTourExample(contacts.source));
  const [recent, [counted]] = await Promise.all([
    db
      .select({
        id: contacts.id,
        fullName: contacts.fullName,
        preferredName: contacts.preferredName,
        company: contacts.company,
        title: contacts.title,
        nextFollowUpAt: contacts.nextFollowUpAt,
      })
      .from(contacts)
      .where(own)
      .orderBy(desc(contacts.createdAt), desc(contacts.id))
      .limit(3),
    db.select({ total: sql<number>`count(*)::int` }).from(contacts).where(own),
  ]);
  if (recent.length === 0) return { people: [], total: 0 };

  const due = await db
    .select({ contactId: reminders.contactId, title: reminders.title, dueDate: reminders.dueDate })
    .from(reminders)
    .where(
      and(
        eq(reminders.userId, userId),
        eq(reminders.status, "pending"),
        inArray(
          reminders.contactId,
          recent.map((c) => c.id)
        )
      )
    )
    .orderBy(asc(reminders.dueDate));

  const people = recent.map((c): FirstWinPerson => {
    const name = c.preferredName?.trim() || c.fullName;
    const reminder = due.find((r) => r.contactId === c.id && r.dueDate);
    const followUp = reminder
      ? { title: reminder.title, dueDate: reminder.dueDate!.toISOString() }
      : c.nextFollowUpAt
        ? { title: `Follow up with ${name}`, dueDate: c.nextFollowUpAt.toISOString() }
        : null;
    const subtitle = c.title && c.company ? `${c.title} at ${c.company}` : c.title || c.company || null;
    const firstName = c.preferredName?.trim() || c.fullName.trim().split(/\s+/)[0] || c.fullName;
    return { id: c.id, name: c.fullName, firstName, subtitle, followUp };
  });
  return { people, total: counted?.total ?? people.length };
}
