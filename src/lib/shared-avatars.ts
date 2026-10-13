/**
 * Shared, cross-user LinkedIn photo cache (table `linkedin_avatars`), keyed by profile slug.
 * The key must equal the generated column `contacts.linkedin_slug` so reads can JOIN on it.
 */
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { linkedinAvatars } from "@/db/schema";
import { AVATAR_RECHECK_DAYS } from "@/lib/avatar-backfill";

export type SharedAvatarRow = typeof linkedinAvatars.$inferSelect;
export type SharedAvatarSource = SharedAvatarRow["source"];

/** A positive (photo found) row is trusted this long before it is re-resolved. */
export const SHARED_AVATAR_POSITIVE_DAYS = 180;
const DAY_MS = 86_400_000;

/**
 * Exactly what `LINKEDIN_SLUG_EXPRESSION` computes in SQL, for real LinkedIn URLs: split on
 * the first case-sensitive "/in/", cut at ?, # and /, lowercase. No percent-decoding (the
 * JOIN does none either). Null for a non-linkedin.com host or no slug.
 * smoke-linkedin-slug-guard asserts JS == SQL.
 */
export function sharedAvatarSlug(linkedinUrl: string | null | undefined): string | null {
  if (!linkedinUrl) return null;
  const host = /^(?:[a-z][a-z0-9+.-]*:\/\/|\/\/)?([^/?#]*)/i.exec(linkedinUrl.trim())?.[1] ?? "";
  const bare = host.replace(/^.*@/, "").replace(/:\d*$/, "").toLowerCase();
  if (bare !== "linkedin.com" && !bare.endsWith(".linkedin.com")) return null;
  // SQL runs on the stored value untrimmed; split_part(x, '/in/', 2) is "" without the marker.
  const afterIn = linkedinUrl.split("/in/")[1] ?? "";
  const slug = afterIn.split("?")[0].split("#")[0].split("/")[0].toLowerCase();
  return slug === "" ? null : slug;
}

export async function getSharedAvatar(slug: string): Promise<SharedAvatarRow | null> {
  const db = await getDb();
  const [row] = await db.select().from(linkedinAvatars).where(eq(linkedinAvatars.slug, slug)).limit(1);
  return row ?? null;
}

/** Negative rows are fresh AVATAR_RECHECK_DAYS, positive ones SHARED_AVATAR_POSITIVE_DAYS. A blocked row is always fresh: never re-fetched. */
export function isSharedFresh(
  row: Pick<SharedAvatarRow, "imageUrl" | "resolvedAt" | "blockedAt">,
  now: Date = new Date()
): boolean {
  if (row.blockedAt) return true;
  const days = row.imageUrl ? SHARED_AVATAR_POSITIVE_DAYS : AVATAR_RECHECK_DAYS;
  return now.getTime() - row.resolvedAt.getTime() < days * DAY_MS;
}

/**
 * Insert or update a slug's row. Never touches a blocked row; a "found nothing" result
 * (imageUrl null) never replaces a stored photo unless `refresh` (a deliberate re-check).
 * Returns whether the row was written.
 */
export async function upsertSharedAvatar(input: {
  slug: string;
  imageUrl: string | null;
  source: SharedAvatarSource;
  refresh?: boolean;
}): Promise<boolean> {
  const db = await getDb();
  const values = { slug: input.slug, imageUrl: input.imageUrl, source: input.source, resolvedAt: new Date() };
  const rows = await db
    .insert(linkedinAvatars)
    .values(values)
    .onConflictDoUpdate({
      target: linkedinAvatars.slug,
      set: { imageUrl: values.imageUrl, source: values.source, resolvedAt: values.resolvedAt },
      setWhere: and(
        isNull(linkedinAvatars.blockedAt),
        input.imageUrl !== null || input.refresh
          ? undefined
          : isNull(linkedinAvatars.imageUrl)
      ),
    })
    .returning();
  return rows.length > 0;
}
