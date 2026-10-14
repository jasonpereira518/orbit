import { and, eq, isNull, lt } from "drizzle-orm";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import { PLAN_CONFIG, type Plan } from "@/lib/plans/plan-config";

/**
 * The one-time "your AI credits are here" screen — who is owed it, and taking its single
 * showing. Same shape as the LinkedIn export reminder (`src/lib/linkedin-reminder.ts`): one
 * write-once `user_settings` column, the app layout arms a watcher with `due`, and a server
 * action claims the showing in ONE conditional UPDATE.
 *
 * No `next/*` imports: the smoke script calls these directly.
 */

/**
 * Accounts created before this saw Orbit without included AI and are owed the explanation.
 * Anyone created after it met credits in onboarding, so the screen would be a second welcome.
 * Set to the day included AI ships.
 */
export const CREDITS_INTRO_LAUNCHED_AT = new Date("2026-10-13T00:00:00Z");

/**
 * Whether the layout should arm the watcher. `includedAiAvailable` keeps it from announcing
 * credits while Orbit holds no managed key (the layout's own answer to that question): the
 * screen waits, unclaimed, until included AI can actually run.
 */
export function isCreditsIntroDue(input: {
  createdAt: Date;
  shownAt: Date | null;
  plan: Plan;
  includedAiAvailable: boolean;
}): boolean {
  return (
    input.shownAt == null &&
    input.createdAt < CREDITS_INTRO_LAUNCHED_AT &&
    PLAN_CONFIG[input.plan].features.hostedAi &&
    input.includedAiAvailable
  );
}

/**
 * Takes this account's one showing. True means "draw it"; false means another tab or device
 * already did, or the account is not one that is owed it.
 *
 * The rule is restated in the UPDATE's WHERE clause rather than read-then-written, so
 * concurrent claims serialise on the row and exactly one sees `shown_at IS NULL`.
 */
export async function claimCreditsIntroFor(userId: string): Promise<boolean> {
  const db = await getDb();
  const now = new Date();
  const claimed = await db
    .update(userSettings)
    .set({ creditsIntroShownAt: now, updatedAt: now })
    .where(
      and(
        eq(userSettings.userId, userId),
        isNull(userSettings.creditsIntroShownAt),
        lt(userSettings.createdAt, CREDITS_INTRO_LAUNCHED_AT),
      ),
    )
    .returning();
  return claimed.length > 0;
}
