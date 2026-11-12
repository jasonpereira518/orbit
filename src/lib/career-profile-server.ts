/**
 * The database half of importing the user's own LinkedIn details. No auth: callers pass the user
 * id, so a PGlite smoke can drive it directly. `src/actions/imports.ts` is the authenticated door.
 */
import { eq, sql } from "drizzle-orm";
import { cleanSingleLine } from "@/lib/ai-security";
import { getDb } from "@/db";
import { userSettings, type CareerProfile } from "@/db/schema";
import type { YouCurrent, YouPatch } from "@/lib/career-profile";
import type { UserFocus } from "@/lib/focus-fit";
import { setSchools } from "@/lib/events/target-companies";

export async function loadYouCurrent(userId: string): Promise<YouCurrent> {
  const db = await getDb();
  const [row] = await db
    .select({ career: userSettings.careerProfile, senderBio: userSettings.senderBio, schools: userSettings.schools })
    .from(userSettings)
    .where(eq(userSettings.userId, userId))
    .limit(1);
  const schools = Array.isArray(row?.schools) ? row.schools.filter((s): s is string => typeof s === "string") : [];
  return { career: row?.career ?? null, senderBio: row?.senderBio ?? null, schools };
}

export function focusFromCareerProfile(career: CareerProfile | null | undefined): UserFocus | null {
  if (!career) return null;
  const skills = (career.skills ?? []).filter((s) => typeof s === "string" && s.trim());
  const roleKeywords = (career.roleKeywords ?? []).filter((s) => typeof s === "string" && s.trim());
  if (!skills.length && !roleKeywords.length) return null;
  return { skills, roleKeywords, role: career.role ?? null };
}

/**
 * What the user's LinkedIn export says they do and are looking for, or null when nothing was
 * imported. The one reader the recommenders share, next to `listActiveGoalTextsForUser`.
 */
export async function loadUserFocus(userId: string): Promise<UserFocus | null> {
  const { career } = await loadYouCurrent(userId);
  return focusFromCareerProfile(career);
}

/** The aim the person set in About you, or null. */
export async function loadUserAim(userId: string): Promise<NonNullable<CareerProfile["aim"]> | null> {
  const { career } = await loadYouCurrent(userId);
  return career?.aim ?? null;
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
  // Education.csv writes the user's own schools list, the same one Settings edits.
  if (patch.schools) await setSchools(userId, patch.schools);
}

/**
 * The city Radar looks for events in (`career_profile.city`). Kept apart from the
 * `profile.location` an import writes, so removing imported details never clears it. Empty
 * clears it. Returns what was stored.
 */
export async function setCity(userId: string, input: string): Promise<string | null> {
  const city = cleanSingleLine(input, 120);
  const db = await getDb();
  await db.execute(sql`
    INSERT INTO user_settings (user_id, career_profile)
    VALUES (${userId}, ${JSON.stringify(city ? { city } : {})}::jsonb)
    ON CONFLICT (user_id) DO UPDATE SET
      career_profile = CASE WHEN ${city}::text IS NULL
        THEN NULLIF(COALESCE(user_settings.career_profile, '{}'::jsonb) - 'city', '{}'::jsonb)
        ELSE COALESCE(user_settings.career_profile, '{}'::jsonb) || jsonb_build_object('city', ${city}::text) END,
      updated_at = now()
  `);
  return city;
}

/**
 * Forget what was imported. Leaves `sender_bio` and everything else the person typed alone,
 * including `aim`: that came from the onboarding About you step, not from an export.
 */
export async function clearCareerProfile(userId: string): Promise<void> {
  const db = await getDb();
  await db.execute(sql`
    UPDATE user_settings SET
      career_profile = NULLIF(jsonb_strip_nulls(jsonb_build_object(
        'aim', career_profile->'aim', 'majors', career_profile->'majors', 'city', career_profile->'city')), '{}'::jsonb),
      updated_at = now()
    WHERE user_id = ${userId}
  `);
}
