import { and, desc, eq, ilike, isNotNull } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts, linkedinAvatars } from "@/db/schema";
import { recordAdminAction, requireReason } from "@/lib/admin-operations";
import { deleteSharedAvatarBlob } from "@/lib/avatar-blob";
import { UserFacingError } from "@/lib/errors";

/**
 * Admin takedown of a shared LinkedIn photo. The caller (`src/actions/admin.ts`) has already
 * passed `requireAdminUserId()`; these take the operator's id so the audit row names them.
 */

function cleanSlug(raw: string): string {
  const slug = raw.trim().toLowerCase();
  if (!slug || slug.length > 200 || /[\s/?#]/.test(slug)) {
    throw new UserFacingError("Enter a LinkedIn profile slug, like “jane-doe”.");
  }
  return slug;
}

/**
 * Remove the shared photo and block the slug: it is never re-fetched or re-contributed
 * (every writer refuses a blocked row). Every account's own sources get another go at the
 * contact, since they were skipped while the shared photo was showing.
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
  await db.update(contacts).set({ profileImageCheckedAt: null }).where(eq(contacts.linkedinSlug, slug));
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
    .orderBy(desc(linkedinAvatars.blockedAt), linkedinAvatars.slug)
    .limit(100);
}
