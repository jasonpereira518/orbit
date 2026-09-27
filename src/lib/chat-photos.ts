import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts } from "@/db/schema";
import { clientAvatarUrlSql } from "@/lib/contact-avatar-sql";
import type { StepEmitter } from "@/lib/chat-steps";
import type { ChatStepKind, ChatStepRef } from "@/lib/chat-stream-protocol";

/**
 * Contact photos for the chat's activity scene, resolved without slowing the answer down.
 *
 * The orbit shows the people a stage touched, and it should show their faces — but a stage
 * reports the moment it finishes, and waiting on a photo lookup would add a database round
 * trip to every stage of the critical path. So the stage goes out first, without photos, and
 * `attachPhotos` patches them on a moment later (see `StepEmitter.update`); the browser
 * swaps the illustration for the photo when it arrives.
 *
 * Only a URL the browser can actually use is ever sent. `clientAvatarUrlSql` decides that in
 * Postgres, so the stored column — which is base64 up to 120 KB per contact when Blob storage
 * is not configured — never leaves the database, and a `data:` photo becomes the short
 * same-origin `/api/avatars/{id}` route. It also never triggers the metered third-party
 * resolution that route falls back to: a contact with no stored photo simply has none here.
 */

/** Ids looked up so far in this request, so a person in three stages costs one query. */
export type PhotoCache = Map<string, string | null>;

export function createPhotoCache(): PhotoCache {
  return new Map();
}

export async function loadPhotoUrls(
  userId: string,
  ids: readonly string[],
  cache: PhotoCache
): Promise<PhotoCache> {
  const missing = [...new Set(ids)].filter((id) => !cache.has(id));
  if (missing.length === 0) return cache;

  const db = await getDb();
  const rows = await db
    .select({ id: contacts.id, photoUrl: clientAvatarUrlSql.as("photo_url") })
    .from(contacts)
    // Scoped to the user like every other read: an id the user does not own resolves to
    // nothing rather than someone else's photo.
    .where(and(eq(contacts.userId, userId), inArray(contacts.id, missing)));

  for (const row of rows) cache.set(row.id, row.photoUrl ?? null);
  // Ids that matched no row are remembered as "no photo" so they are not asked for again.
  for (const id of missing) if (!cache.has(id)) cache.set(id, null);
  return cache;
}

/**
 * Patch photos onto a finished stage's contact refs, in the background.
 *
 * Returns immediately. Every failure is swallowed on purpose: a photo is decoration, and a
 * lookup that errors must never surface as a failed answer.
 */
export function attachPhotos(
  steps: StepEmitter,
  kind: ChatStepKind,
  refs: ChatStepRef[] | undefined,
  userId: string,
  cache: PhotoCache
): void {
  const contactRefs = (refs ?? []).filter((r) => r.kind === "contact");
  if (contactRefs.length === 0) return;

  void loadPhotoUrls(
    userId,
    contactRefs.map((r) => r.id),
    cache
  )
    .then(() => {
      // Nothing to add if none of them has a photo — an update would only re-send the same
      // step for no visible change.
      if (!contactRefs.some((r) => cache.get(r.id))) return;
      steps.update(kind, {
        refs: (refs ?? []).map((r) =>
          r.kind === "contact" ? { ...r, photoUrl: cache.get(r.id) ?? null } : r
        ),
      });
    })
    .catch(() => {});
}
