/**
 * Shared, cross-user LinkedIn photo cache (table `linkedin_avatars`), keyed by profile slug.
 * The key must equal the generated column `contacts.linkedin_slug` so reads can JOIN on it.
 * Fed only by public lookups (Unavatar, Microlink); an extension capture stays on its contact.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { linkedinAvatars } from "@/db/schema";
import { AVATAR_RECHECK_DAYS } from "@/lib/avatar-backfill";
import { deleteSharedAvatarBlob } from "@/lib/avatar-blob";
import { fetchLinkedInPhoto, fetchLinkedInPhotoUrl, hasBlobStorage } from "@/lib/contact-avatar";
import { LINKEDIN_HOST_RE } from "@/lib/contact-avatar-sql";

export type SharedAvatarRow = typeof linkedinAvatars.$inferSelect;
export type SharedAvatarSource = SharedAvatarRow["source"];

/** `contacts.profile_image_source`: where a contact's OWN photo came from. Never a shared photo. */
export type ProfileImageSource =
  | "google"
  | "outlook"
  | "gravatar"
  | "apollo"
  | "public"
  | "extension"
  | "upload";

/** The contact displays the shared pool's photo for its slug; nothing goes on the contact. */
export type SharedLinkedInPhoto = { sharedUrl: string };

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

const LINKEDIN_HOST = new RegExp(LINKEDIN_HOST_RE, "i");

/**
 * The slug a contact may show a shared photo under: {@link sharedAvatarSlug}, but only when
 * `sharedAvatarUrlSql` would also accept the URL. Writers key on this so nothing is
 * resolved into the pool for a contact that could never display it.
 */
export function sharedPhotoSlug(linkedinUrl: string | null | undefined): string | null {
  return linkedinUrl && LINKEDIN_HOST.test(linkedinUrl) ? sharedAvatarSlug(linkedinUrl) : null;
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
  // Readers only ever show an https image; refuse anything else at the door too.
  if (input.imageUrl !== null && !input.imageUrl.startsWith("https://")) return false;
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

/**
 * Record a freshly stored shared photo. On a lost race with a takedown the new object is
 * deleted; when it replaces an older photo, the older object is.
 */
export async function adoptSharedPhoto(
  slug: string,
  previous: SharedAvatarRow | null,
  imageUrl: string,
  source: SharedAvatarSource
): Promise<SharedLinkedInPhoto | null> {
  const written = await upsertSharedAvatar({ slug, imageUrl, source, refresh: previous !== null });
  if (!written) {
    await deleteSharedAvatarBlob(imageUrl);
    return null;
  }
  if (previous?.imageUrl && previous.imageUrl !== imageUrl) {
    await deleteSharedAvatarBlob(previous.imageUrl);
  }
  return { sharedUrl: imageUrl };
}

/**
 * The LinkedIn step of every photo ladder, cache-first.
 *
 * A fresh shared row answers without any source call or quota: a photo means the contact
 * already displays it, "found nothing" means skip LinkedIn, a blocked slug is never fetched.
 * Missing or stale, the usual Unavatar/Microlink lookup runs, its photo goes to the shared
 * pool (never the contact) and a real miss is remembered for {@link AVATAR_RECHECK_DAYS}.
 * A miss on a stale photo keeps that photo and restarts its clock: the free tiers miss
 * often enough that one miss is not proof the photo is gone.
 *
 * Returns a plain URL for the contact's own column only where the pool cannot be used: no
 * shareable slug (exactly the old per-contact behaviour), or no Blob store (the pool holds
 * https URLs only). Throws what {@link fetchLinkedInPhotoUrl} throws, writing nothing.
 */
export async function resolveLinkedInPhotoCached(
  contactId: string,
  linkedinUrl: string,
  userId: string | null
): Promise<string | SharedLinkedInPhoto | null> {
  const slug = sharedPhotoSlug(linkedinUrl);
  if (!slug) return fetchLinkedInPhotoUrl(contactId, linkedinUrl, userId);

  const row = await getSharedAvatar(slug);
  if (row?.blockedAt) return null;
  if (row && isSharedFresh(row)) return row.imageUrl ? { sharedUrl: row.imageUrl } : null;

  if (!hasBlobStorage()) {
    // Rebuilt from the key, so the lookup and any negative row name the same person.
    const own = await fetchLinkedInPhotoUrl(contactId, `https://www.linkedin.com/in/${slug}`, userId);
    if (!own && !row?.imageUrl) await upsertSharedAvatar({ slug, imageUrl: null, source: "unavatar" });
    return own;
  }

  const found = await fetchLinkedInPhoto(linkedinUrl, userId, { sharedSlug: slug });
  if (found) return adoptSharedPhoto(slug, row, found.url, found.source);
  if (row?.imageUrl) {
    // Restart the photo's clock only if it is still the one we read: a concurrent refresh
    // may have replaced it (and deleted its object), which must never be written back.
    const db = await getDb();
    await db
      .update(linkedinAvatars)
      .set({ resolvedAt: sql`now()` })
      .where(
        and(
          eq(linkedinAvatars.slug, slug),
          eq(linkedinAvatars.imageUrl, row.imageUrl),
          isNull(linkedinAvatars.blockedAt)
        )
      );
    const current = await getSharedAvatar(slug);
    return current?.imageUrl && !current.blockedAt ? { sharedUrl: current.imageUrl } : null;
  }
  // Negative rows name the first tier asked; both were.
  await upsertSharedAvatar({ slug, imageUrl: null, source: "unavatar" });
  return null;
}
