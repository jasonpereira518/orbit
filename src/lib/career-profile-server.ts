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
    .select({
      career: userSettings.careerProfile,
      senderBio: userSettings.senderBio,
      targetRole: userSettings.targetRole,
      searchStatus: userSettings.searchStatus,
    })
    .from(userSettings)
    .where(eq(userSettings.userId, userId))
    .limit(1);
  return {
    career: row?.career ?? null,
    senderBio: row?.senderBio ?? null,
    targetRole: row?.targetRole ?? null,
    searchStatus: row?.searchStatus ?? null,
  };
}

/**
 * What the user does and is looking for: their LinkedIn export plus the target role and search
 * status they typed in settings. Null when there is nothing at all. The one reader the
 * recommenders share, next to `listActiveGoalTextsForUser`.
 */
export async function loadUserFocus(userId: string): Promise<UserFocus | null> {
  const { career, targetRole, searchStatus } = await loadYouCurrent(userId);
  const skills = (career?.skills ?? []).filter((s) => typeof s === "string" && s.trim());
  const roleKeywords = (career?.roleKeywords ?? []).filter((s) => typeof s === "string" && s.trim());
  const role = targetRole?.trim();
  if (role && !roleKeywords.some((k) => k.toLowerCase() === role.toLowerCase())) roleKeywords.unshift(role);
  const searchActive = searchStatus === "active";
  if (!skills.length && !roleKeywords.length && !searchActive) return null;
  return { skills, roleKeywords, role: career?.role ?? null, searchActive };
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
