import { and, eq, ilike, inArray, isNotNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts, emailAvatars, linkedinAvatars, publicWorkHistory } from "@/db/schema";
import { recordAdminAction, requireReason } from "@/lib/admin-operations";
import { deleteAvatarBlobs, deleteSharedAvatarBlob } from "@/lib/avatar-blob";
import { UserFacingError } from "@/lib/errors";
import { emailAvatarKeySql } from "@/lib/contact-avatar-sql";
import { provablePublicPhotoSource } from "@/lib/shared-avatar-upkeep";
import { sharedEmailKey } from "@/lib/shared-avatars";

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
  // One takedown covers everything Orbit shares about the profile: its shared work history too.
  const blockedHistory = { answer: null, blockedAt: new Date(), blockedBy: adminUserId };
  await db
    .insert(publicWorkHistory)
    .values({ slug, ...blockedHistory })
    .onConflictDoUpdate({ target: publicWorkHistory.slug, set: blockedHistory });
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
  await db
    .delete(publicWorkHistory)
    .where(and(eq(publicWorkHistory.slug, slug), isNotNull(publicWorkHistory.blockedAt)));
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

/** An email pool key: the 64-hex hash itself, or an address to hash. Never stored raw. */
function cleanEmailKey(raw: string): string {
  const v = raw.trim().toLowerCase();
  const key = /^[0-9a-f]{64}$/.test(v) ? v : sharedEmailKey(v);
  if (!key) throw new UserFacingError("Enter an email address");
  return key;
}

/**
 * {@link blockSharedAvatar} for the email pool: remove the shared photo and block the address
 * hash so it is never re-fetched. Per-contact Gravatar copies of that address are removed in
 * every account; mailbox, extension, Apollo and uploaded photos are never touched. The audit
 * row names the hash, not the address.
 * ponytail: matching contacts hashes every address (a scan), fine for a rare admin action.
 */
export async function blockSharedEmailAvatar(
  adminUserId: string,
  input: { email: string; reason: string }
): Promise<void> {
  const key = cleanEmailKey(input.email);
  const reason = requireReason(input.reason);
  const db = await getDb();
  const [previous] = await db
    .select({ imageUrl: emailAvatars.imageUrl })
    .from(emailAvatars)
    .where(eq(emailAvatars.emailHash, key));

  await recordAdminAction({
    adminUserId,
    action: "avatar.block",
    resourceType: "email_avatar",
    resourceId: key,
    reason,
  });
  const set = { imageUrl: null, blockedAt: new Date(), blockedBy: adminUserId };
  await db
    .insert(emailAvatars)
    .values({ emailHash: key, source: "gravatar", ...set })
    .onConflictDoUpdate({ target: emailAvatars.emailHash, set });
  const sameAddress = sql`${contacts.email} IS NOT NULL AND ${emailAvatarKeySql} = ${key}`;
  const gravatarCopies = await db
    .select({ id: contacts.id, url: contacts.profileImageUrl })
    .from(contacts)
    .where(and(sameAddress, eq(contacts.profileImageSource, "gravatar")));
  await db.update(contacts).set({ profileImageCheckedAt: null }).where(sameAddress);
  if (gravatarCopies.length > 0) {
    await db
      .update(contacts)
      .set({ profileImageUrl: null, profileImageSource: null })
      .where(inArray(contacts.id, gravatarCopies.map((c) => c.id)));
  }
  await deleteAvatarBlobs(gravatarCopies.map((c) => c.url));
  await deleteSharedAvatarBlob(previous?.imageUrl);
}

/** Lift an email block. The row goes, so the next lookup resolves the address afresh. */
export async function unblockSharedEmailAvatar(
  adminUserId: string,
  input: { email: string; reason: string }
): Promise<void> {
  const key = cleanEmailKey(input.email);
  const reason = requireReason(input.reason);
  await recordAdminAction({
    adminUserId,
    action: "avatar.unblock",
    resourceType: "email_avatar",
    resourceId: key,
    reason,
  });
  const db = await getDb();
  await db
    .delete(emailAvatars)
    .where(and(eq(emailAvatars.emailHash, key), isNotNull(emailAvatars.blockedAt)));
}
