import { and, eq, ilike, inArray, isNotNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts, linkedinAvatars } from "@/db/schema";
import { recordAdminAction, requireReason } from "@/lib/admin-operations";
import { deleteAvatarBlobs, deleteSharedAvatarBlob } from "@/lib/avatar-blob";
import { UserFacingError } from "@/lib/errors";
import { provablePublicPhotoSource } from "@/lib/shared-avatar-upkeep";

/**
 * Admin takedown of a shared LinkedIn photo. The caller (`src/actions/admin.ts`) has already
 * passed `requireAdminUserId()`; these take the operator's id so the audit row names them.
 */

function cleanSlug(raw: string): string {
  const slug = raw.trim().toLowerCase();
  if (!slug || slug.length > 200 || /[\s/?#]/.test(slug)) {
    throw new UserFacingError("Enter a LinkedIn profile slug, like “jane-doe”");
  }
  return slug;
}

/**
 * Remove the shared photo and block the slug: it is never re-fetched (every writer refuses a
 * blocked row). Works on a slug with no row yet (a removal request ahead of any lookup): the
 * blocked row is inserted. Per-contact copies Orbit can prove came from a public lookup
 * (source "public", or unlabelled with an Unavatar LinkedIn URL) are removed too, in every
 * account; extension captures (the user's own), Google, Outlook, Gravatar, Apollo and
 * uploaded photos are never touched. Every account's own sources get another go at the contact.
 */
export async function blockSharedAvatar(
  adminUserId: string,
  input: { slug: string; reason: string }
): Promise<void> {
  const slug = cleanSlug(input.slug);
  const reason = requireReason(input.reason);
  const db = await getDb();
  const [previous] = await db
    .select({ imageUrl: linkedinAvatars.imageUrl })
    .from(linkedinAvatars)
    .where(eq(linkedinAvatars.slug, slug));

  // Audit first: an unlogged takedown is worse than a slow one.
  await recordAdminAction({
    adminUserId,
    action: "avatar.block",
    resourceType: "linkedin_avatar",
    resourceId: slug,
    reason,
  });
  const set = { imageUrl: null, blockedAt: new Date(), blockedBy: adminUserId };
  await db
    .insert(linkedinAvatars)
    .values({ slug, source: "unavatar", ...set })
    .onConflictDoUpdate({ target: linkedinAvatars.slug, set });
  const owners = await db
    .select({ id: contacts.id, source: contacts.profileImageSource, url: contacts.profileImageUrl })
    .from(contacts)
    .where(eq(contacts.linkedinSlug, slug));
  const publicCopies = owners.filter(
    (c) => c.source === "public" || (c.source === null && provablePublicPhotoSource(c.url) !== null)
  );
  await db.update(contacts).set({ profileImageCheckedAt: null }).where(eq(contacts.linkedinSlug, slug));
  if (publicCopies.length > 0) {
    await db
      .update(contacts)
      .set({ profileImageUrl: null, profileImageSource: null })
      .where(inArray(contacts.id, publicCopies.map((c) => c.id)));
  }
  await deleteAvatarBlobs(publicCopies.map((c) => c.url));
  await deleteSharedAvatarBlob(previous?.imageUrl);
}

/** Lift a block. The row goes, so the next lookup resolves the person afresh. */
export async function unblockSharedAvatar(
  adminUserId: string,
  input: { slug: string; reason: string }
): Promise<void> {
  const slug = cleanSlug(input.slug);
  const reason = requireReason(input.reason);
  await recordAdminAction({
    adminUserId,
    action: "avatar.unblock",
    resourceType: "linkedin_avatar",
    resourceId: slug,
    reason,
  });
  const db = await getDb();
  await db
    .delete(linkedinAvatars)
    .where(and(eq(linkedinAvatars.slug, slug), isNotNull(linkedinAvatars.blockedAt)));
}

/** Blocked slugs; with `q`, every shared row whose slug contains it. */
export async function listSharedAvatars(input: { q?: string }) {
  const q = input.q?.trim().toLowerCase();
  const db = await getDb();
  const where = q
    ? ilike(linkedinAvatars.slug, `%${q.replace(/[\\%_]/g, "\\$&")}%`)
    : isNotNull(linkedinAvatars.blockedAt);
  return db
    .select({
      slug: linkedinAvatars.slug,
      imageUrl: linkedinAvatars.imageUrl,
      source: linkedinAvatars.source,
      blockedAt: linkedinAvatars.blockedAt,
      blockedBy: linkedinAvatars.blockedBy,
    })
    .from(linkedinAvatars)
    .where(where)
    .orderBy(sql`${linkedinAvatars.blockedAt} DESC NULLS LAST`, linkedinAvatars.slug)
    .limit(100);
}
