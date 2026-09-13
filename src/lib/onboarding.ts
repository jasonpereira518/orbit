import { cache } from "react";
import { eq } from "drizzle-orm";
import { after } from "next/server";
import { getDb } from "@/db";
import { contacts, imports, userSettings } from "@/db/schema";
import { ensureUserSettings } from "@/lib/user-settings";

async function persistOnboardingComplete(userId: string) {
  const db = await getDb();
  await ensureUserSettings(userId);
  const updated = await db
    .update(userSettings)
    .set({
      onboardingCompletedAt: new Date(),
      onboardingStep: null,
      updatedAt: new Date(),
    })
    .where(eq(userSettings.userId, userId))
    .returning();

  if (!updated[0]?.onboardingCompletedAt) {
    throw new Error("Could not mark onboarding complete");
  }
}

/**
 * Onboarding is first-run only: new accounts with no completion flag and no
 * existing network data. Returning users (or anyone who already added people /
 * imports) are treated as done and never forced through again.
 *
 * Cached per request so the main layout gate doesn't repeat work.
 */
export const needsOnboarding = cache(async (userId: string) => {
  const settings = await ensureUserSettings(userId);
  if (settings.onboardingCompletedAt) {
    return false;
  }

  const db = await getDb();
  const [existingContact, existingImport] = await Promise.all([
    db.query.contacts.findFirst({
      where: eq(contacts.userId, userId),
      columns: { id: true },
    }),
    db.query.imports.findFirst({
      where: eq(imports.userId, userId),
      columns: { id: true },
    }),
  ]);

  if (existingContact || existingImport) {
    // A tour the user deliberately restarted must not be completed out from under them.
    //
    // "Replay tour" in Settings clears `onboardingCompletedAt`, but this backfill writes
    // it straight back on the next gated page view — so the tour survived exactly one
    // navigation, and was unreachable for any account with a single contact, which is
    // every account past minute one. `onboardingStep` marks a tour in progress;
    // `resetOnboarding` now sets it, so an explicit replay is distinguishable from a
    // long-standing account that simply never had the flag written.
    if (!settings.onboardingStep) {
      // Don't block navigation on the backfill write.
      after(() => {
        void persistOnboardingComplete(userId).catch(() => {});
      });
    }
    return false;
  }

  return true;
});

export { persistOnboardingComplete };

/**
 * Which `(app)` paths the first-run gate applies to.
 *
 * Everything in the group except `/onboarding` itself (it must not redirect to itself) and
 * `/settings` (needed for API keys, and reachable from the tour). Kept as a pathname test
 * rather than a route-group check because the gate now runs in `(app)/layout.tsx`, which
 * wraps all three — see the comment there for why it cannot live in the nested layout.
 */
export function isOnboardingGatedPath(pathname: string) {
  return !/^\/(onboarding|settings)(\/|$)/.test(pathname);
}
