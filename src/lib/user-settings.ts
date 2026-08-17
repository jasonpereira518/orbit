import { cache } from "react";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";

/** Ensure a per-user settings row exists (idempotent). Cached per request. */
export const ensureUserSettings = cache(async (userId: string) => {
  const db = await getDb();
  const existing = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
  });
  if (existing) return existing;

  const [created] = await db
    .insert(userSettings)
    .values({ userId })
    .returning();
  return created;
});

/**
 * Mirrors the user's own email from Clerk into the DB, so background work (which has no
 * request context) can reach them without a Clerk API call.
 *
 * Writes only on change: `user.updated` fires for many unrelated profile edits, and this
 * is also called opportunistically on page loads.
 */
export async function setUserEmail(userId: string, email: string | null) {
  const normalized = email?.trim().toLowerCase() || null;
  const existing = await ensureUserSettings(userId);
  if (existing?.email === normalized) return;

  const db = await getDb();
  await db
    .update(userSettings)
    .set({ email: normalized, updatedAt: new Date() })
    .where(eq(userSettings.userId, userId));
}
