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
    // Don't block navigation on the backfill write.
    after(() => {
      void persistOnboardingComplete(userId).catch(() => {});
    });
    return false;
  }

  return true;
});

export { persistOnboardingComplete };
