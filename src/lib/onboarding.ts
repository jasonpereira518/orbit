import { cache } from "react";
import { and, eq } from "drizzle-orm";
import { after } from "next/server";
import { getDb } from "@/db";
import { notTourExample } from "@/lib/onboarding-examples/sql";
import { contacts, imports, userSettings } from "@/db/schema";
import { ensureUserSettings } from "@/lib/user-settings";

/**
 * Stamps the first-run gate flag. `clearStep` is false only for the backfill below: a
 * replay from Settings clears the flag but keeps `onboarding_step`, and `/onboarding` keeps
 * rendering while that step is set — so the backfill firing mid-replay (the account has
 * contacts) must not wipe the step and bounce the person to the dashboard.
 */
async function persistOnboardingComplete(userId: string, opts: { clearStep?: boolean } = {}) {
  const db = await getDb();
  await ensureUserSettings(userId);
  const updated = await db
    .update(userSettings)
    .set({
      onboardingCompletedAt: new Date(),
      ...(opts.clearStep === false ? {} : { onboardingStep: null }),
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
 * It is also shown only ONCE: the tour records its step the moment it mounts, so
 * someone who opened it and wandered off without finishing or skipping is not
 * redirected back on their next visit. `/onboarding` itself still resumes them if
 * they go there (or replay it from Settings).
 *
 * Cached per request so the main layout gate doesn't repeat work.
 */
export const needsOnboarding = cache(async (userId: string) => {
  const settings = await ensureUserSettings(userId);
  if (settings.onboardingCompletedAt || settings.onboardingStep) {
    return false;
  }

  const db = await getDb();
  const [existingContact, existingImport] = await Promise.all([
    // The tour's example people are not the person's own data, so they never count as
    // "has a network" here (they only exist after the handoff anyway, which stamps the flag).
    db.query.contacts.findFirst({
      where: and(eq(contacts.userId, userId), notTourExample(contacts.source)),
      columns: { id: true },
    }),
    db.query.imports.findFirst({
      where: eq(imports.userId, userId),
      columns: { id: true },
    }),
  ]);

  if (existingContact || existingImport) {
    // Don't block navigation on the backfill write.
    after(() => {
      void persistOnboardingComplete(userId, { clearStep: false }).catch(() => {});
    });
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
