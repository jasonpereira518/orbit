/**
 * Shared, cross-user LinkedIn photo cache (table `linkedin_avatars`), keyed by profile slug.
 * The key must equal the generated column `contacts.linkedin_slug` so reads can JOIN on it.
 * Fed only by public lookups (Unavatar, Microlink); an extension capture stays on its contact.
 *
 * Its email twin (`email_avatars`) is keyed by {@link sharedEmailKey} and fed only by Gravatar;
 * a Google/Outlook mailbox photo stays on its contact.
 */
import { createHash } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { emailAvatars, linkedinAvatars } from "@/db/schema";
import { AVATAR_RECHECK_DAYS } from "@/lib/avatar-backfill";
import { deleteSharedAvatarBlob } from "@/lib/avatar-blob";
import {
  downloadAndPersistSharedAvatar,
  fetchGravatarPhotoUrl,
  fetchLinkedInPhoto,
  fetchLinkedInPhotoUrl,
  gravatarAvatarUrl,
  hasBlobStorage,
} from "@/lib/contact-avatar";
import { isLinkedInProfilePhoto } from "@/lib/contact-avatar-url";
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
 * Adopt an external photo URL (e.g. from Chrome extension or direct capture) into the shared pool.
 * Only genuine LinkedIn profile photos on media.licdn.com are pooled.
 */
export async function adoptPhotoIntoSharedPool(
  slug: string,
  photoUrl: string,
  source: SharedAvatarSource = "extension"
): Promise<SharedLinkedInPhoto | null> {
  const row = await getSharedAvatar(slug);
  if (row?.blockedAt || (row?.imageUrl && isSharedFresh(row))) {
    return row?.imageUrl ? { sharedUrl: row.imageUrl } : null;
  }
  if (!isLinkedInProfilePhoto(photoUrl)) return null;

  if (hasBlobStorage()) {
    const stored = await downloadAndPersistSharedAvatar(slug, photoUrl);
    if (!stored) return null;
    return adoptSharedPhoto(slug, row, stored, source);
  }
  if (photoUrl.startsWith("https://")) {
    return adoptSharedPhoto(slug, row, photoUrl, source);
  }
  return null;
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
    if (!own && !row?.imageUrl) await upsertSharedAvatar({ slug, imageUrl: null, source: "linkedin_direct" });
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
  // Negative rows name the first tier asked.
  await upsertSharedAvatar({ slug, imageUrl: null, source: "linkedin_direct" });
  return null;
}

// ---------------------------------------------------------------------------------------------
// The email pool (`email_avatars`).

export type SharedEmailAvatarRow = typeof emailAvatars.$inferSelect;

/** Printable ASCII only, so JS and Postgres agree on lower() and trim (no locale cases). */
const SHAREABLE_EMAIL = /^[\x21-\x7e]+@[\x21-\x7e]+$/;
const EMAIL_KEY = /^[0-9a-f]{64}$/;

/**
 * The pool key for an address: sha256 hex of the lowercased, trimmed address (Gravatar's own
 * hash). Must equal `emailAvatarKeySql` in `contact-avatar-sql.ts`; null for an address the
 * pool does not take. The address itself is never stored.
 */
export function sharedEmailKey(email: string | null | undefined): string | null {
  const e = email?.trim().toLowerCase();
  if (!e || !SHAREABLE_EMAIL.test(e)) return null;
  return createHash("sha256").update(e, "utf8").digest("hex");
}

export async function getSharedEmailAvatar(emailHash: string): Promise<SharedEmailAvatarRow | null> {
  const db = await getDb();
  const [row] = await db.select().from(emailAvatars).where(eq(emailAvatars.emailHash, emailHash)).limit(1);
  return row ?? null;
}

/**
 * {@link upsertSharedAvatar} for the email pool, same rules: a blocked row is never written,
 * "found nothing" never replaces a photo unless `refresh`. Refuses anything that is not a
 * 64-hex key (a raw address can never land) and any image that is not https.
 */
export async function upsertSharedEmailAvatar(input: {
  emailHash: string;
  imageUrl: string | null;
  source?: SharedEmailAvatarRow["source"];
  refresh?: boolean;
}): Promise<boolean> {
  if (!EMAIL_KEY.test(input.emailHash)) return false;
  if (input.imageUrl !== null && !input.imageUrl.startsWith("https://")) return false;
  const db = await getDb();
  const values = {
    emailHash: input.emailHash,
    imageUrl: input.imageUrl,
    source: input.source ?? "gravatar",
    resolvedAt: new Date(),
  };
  const rows = await db
    .insert(emailAvatars)
    .values(values)
    .onConflictDoUpdate({
      target: emailAvatars.emailHash,
      set: { imageUrl: values.imageUrl, source: values.source, resolvedAt: values.resolvedAt },
      setWhere: and(
        isNull(emailAvatars.blockedAt),
        input.imageUrl !== null || input.refresh ? undefined : isNull(emailAvatars.imageUrl)
      ),
    })
    .returning();
  return rows.length > 0;
}

/**
 * The Gravatar step of every photo ladder, cache-first. A fresh row answers with no lookup
 * (photo, "found nothing", or blocked). Otherwise Gravatar is asked once for the address and
 * the answer goes to the pool, never the contact: Gravatar's `d=404` is authoritative, so a
 * miss replaces a stale photo. Without a Blob store the pool keeps only misses and a hit goes
 * on the contact as before. An address the pool does not take keeps the old per-contact path.
 */
export async function resolveGravatarCached(
  contactId: string,
  email: string
): Promise<string | SharedLinkedInPhoto | null> {
  const key = sharedEmailKey(email);
  if (!key) return fetchGravatarPhotoUrl(contactId, email);

  const row = await getSharedEmailAvatar(key);
  if (row?.blockedAt) return null;
  if (row && isSharedFresh(row)) return row.imageUrl ? { sharedUrl: row.imageUrl } : null;

  if (!hasBlobStorage()) {
    const own = await fetchGravatarPhotoUrl(contactId, email);
    if (!own) await upsertSharedEmailAvatar({ emailHash: key, imageUrl: null, refresh: true });
    return own;
  }

  return poolGravatarPhoto(key, row);
}

/**
 * Ask Gravatar for the address behind `key` (its URL is built from the hash alone) and record
 * the answer in the pool, photo or miss, replacing `previous`. Blob store required.
 */
export async function poolGravatarPhoto(
  key: string,
  previous: SharedEmailAvatarRow | null
): Promise<SharedLinkedInPhoto | null> {
  const stored = await downloadAndPersistSharedAvatar(key, gravatarAvatarUrl(key));
  const written = await upsertSharedEmailAvatar({ emailHash: key, imageUrl: stored, refresh: true });
  if (!written) {
    // Lost a race with a takedown.
    await deleteSharedAvatarBlob(stored);
    return null;
  }
  if (previous?.imageUrl && previous.imageUrl !== stored) await deleteSharedAvatarBlob(previous.imageUrl);
  return stored ? { sharedUrl: stored } : null;
}
