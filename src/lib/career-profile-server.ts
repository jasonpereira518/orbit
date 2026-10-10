/**
 * The database half of importing the user's own LinkedIn details. No auth: callers pass the user
 * id, so a PGlite smoke can drive it directly. `src/actions/imports.ts` is the authenticated door.
 */
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import type { YouCurrent, YouPatch } from "@/lib/career-profile";
import type { UserFocus } from "@/lib/focus-fit";

export async function loadYouCurrent(userId: string): Promise<YouCurrent> {
  const db = await getDb();
  const [row] = await db
    .select({ career: userSettings.careerProfile, senderBio: userSettings.senderBio })
    .from(userSettings)
    .where(eq(userSettings.userId, userId))
    .limit(1);
  return { career: row?.career ?? null, senderBio: row?.senderBio ?? null };
}

/**
 * What the user's LinkedIn export says they do and are looking for, or null when nothing was
 * imported. The one reader the recommenders share, next to `listActiveGoalTextsForUser`.
 */
export async function loadUserFocus(userId: string): Promise<UserFocus | null> {
  const { career } = await loadYouCurrent(userId);
  if (!career) return null;
  const skills = (career.skills ?? []).filter((s) => typeof s === "string" && s.trim());
  const roleKeywords = (career.roleKeywords ?? []).filter((s) => typeof s === "string" && s.trim());
  if (!skills.length && !roleKeywords.length) return null;
  return { skills, roleKeywords, role: career.role ?? null };
}

/**
 * Apply a patch. `career_profile` is merged one top-level key at a time (`||` replaces whole
 * keys), so importing Skills never disturbs the headline. `sender_bio` is written only when the
 * patch carries one: `COALESCE(excluded, existing)` keeps what the person typed otherwise.
 */
export async function saveCareerPatch(userId: string, patch: YouPatch): Promise<void> {
  const db = await getDb();
  await db.execute(sql`
    INSERT INTO user_settings (user_id, career_profile, sender_bio)
    VALUES (${userId}, ${JSON.stringify(patch.career)}::jsonb, ${patch.senderBio})
    ON CONFLICT (user_id) DO UPDATE SET
      career_profile = COALESCE(user_settings.career_profile, '{}'::jsonb) || excluded.career_profile,
      sender_bio = COALESCE(excluded.sender_bio, user_settings.sender_bio),
      updated_at = now()
  `);
}

/** Forget what was imported. Leaves `sender_bio` and everything else the person typed alone. */
export async function clearCareerProfile(userId: string): Promise<void> {
  const db = await getDb();
  await db
    .update(userSettings)
    .set({ careerProfile: null, updatedAt: new Date() })
    .where(eq(userSettings.userId, userId));
}
