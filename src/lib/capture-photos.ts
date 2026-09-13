/**
 * Keeping the photos a capture was read from, so the history can show them again.
 *
 * Until this existed every capture photo was transcribed and dropped (`ingestCaptureMedia`
 * said so in as many words). That was the safe default, and the cost was that a capture's
 * results page could show what Orbit *extracted* from a whiteboard but never the whiteboard.
 *
 * The lifecycle, and why it is shaped this way — see `capturePhotos` in `schema.ts`:
 *   1. upload  → `storeCapturePhotos` writes each photo with `note_batch_id` null
 *   2. save    → `attachCapturePhotos` claims them for the new batch
 *   3. abandon → `pruneUnattachedCapturePhotos` (daily cron) deletes what was never claimed
 *
 * No auth and no `"use server"` here, so `scripts/smoke-capture-history.ts` can drive the
 * whole lifecycle against PGlite. Every function takes the user id and scopes by it.
 */
import { randomUUID } from "node:crypto";
import { del, put } from "@vercel/blob";
import { and, asc, eq, inArray, isNull, lt } from "drizzle-orm";
import { getDb } from "@/db";
import { capturePhotos } from "@/db/schema";
import { hasBlobStorage } from "@/lib/contact-avatar";
import { ERROR_SOURCES, recordErrorEvent } from "@/lib/error-events";

/**
 * Long edge of the stored copy. Big enough to read handwriting full-screen, small enough
 * that a photo is a few hundred kilobytes — which matters more than it looks, because with
 * no Blob store provisioned those kilobytes are base64 in a Postgres row.
 */
export const CAPTURE_PHOTO_MAX_EDGE = 1600;
const JPEG_QUALITY = 78;

/** How long an unsaved capture's photos wait for the save that would claim them. */
export const UNATTACHED_PHOTO_TTL_MS = 24 * 60 * 60 * 1000;

/** Rows the daily prune deletes per run. Bounded so a backlog cannot eat the cron. */
export const PRUNE_BATCH = 500;

/** More ids than this in one save is a client bug or a forgery, not a real capture. */
export const MAX_PHOTOS_PER_CAPTURE = 24;

export type CapturePhotoUpload = {
  filename: string;
  /** Raw base64, no `data:` prefix — what `normalizeCaptureInput` already works with. */
  base64: string;
};

export type StoredCapturePhoto = {
  id: string;
  width: number | null;
  height: number | null;
};

/**
 * Decode, orient, shrink and re-encode one photo as JPEG.
 *
 * The re-encode is doing three jobs at once. It bounds the size. It strips metadata —
 * sharp writes none unless asked, so a phone photo's GPS position never reaches storage.
 * And it means the stored bytes are always a JPEG this function produced, so the serving
 * route can state `image/jpeg` without trusting anything the client declared (the reason
 * `decodeScreenshot` sniffs magic bytes for feedback screenshots).
 *
 * Null when sharp cannot decode it (HEIC on a build without libheif, a corrupt file): that
 * photo simply is not kept. The capture already read its text; losing the thumbnail is not
 * worth failing it over.
 */
export async function encodeCapturePhoto(
  input: Buffer
): Promise<{ buf: Buffer; width: number; height: number } | null> {
  try {
    const sharp = (await import("sharp")).default;
    const { data, info } = await sharp(input)
      .rotate()
      .resize(CAPTURE_PHOTO_MAX_EDGE, CAPTURE_PHOTO_MAX_EDGE, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    if (data.byteLength === 0) return null;
    return { buf: data, width: info.width, height: info.height };
  } catch {
    return null;
  }
}

function cleanFileName(name: string): string | null {
  // Control characters out: this is rendered as alt text and a download name.
  const trimmed = name.replace(/\p{Cc}/gu, "").trim().slice(0, 200);
  return trimmed || null;
}

/**
 * Store the photos from one upload, unattached. Returns the ids of the ones that were kept,
 * in upload order; a photo that could not be decoded or stored is left out rather than
 * failing the rest.
 */
export async function storeCapturePhotos(
  userId: string,
  uploads: CapturePhotoUpload[]
): Promise<StoredCapturePhoto[]> {
  if (!uploads.length) return [];
  const db = await getDb();
  const useBlob = hasBlobStorage();
  const stored: StoredCapturePhoto[] = [];

  for (const [position, upload] of uploads.entries()) {
    const encoded = await encodeCapturePhoto(Buffer.from(upload.base64, "base64"));
    if (!encoded) continue;

    // The id is minted here rather than by the insert so the Blob path can carry it, which
    // is what lets an operator match an object in the store back to its row.
    const id = randomUUID();
    let blobUrl: string | null = null;
    try {
      if (useBlob) {
        // Random suffix, like feedback screenshots and unlike avatars: the id is in the DOM,
        // and a guessable public URL for a photo of someone's notes is not acceptable. The
        // URL never reaches the browser either way — `/api/capture/photos/[id]` proxies it.
        const blob = await put(`capture-photos/${id}.jpg`, encoded.buf, {
          access: "public",
          contentType: "image/jpeg",
          addRandomSuffix: true,
        });
        blobUrl = blob.url;
      }
      await db.insert(capturePhotos).values({
        id,
        userId,
        noteBatchId: null,
        position,
        fileName: cleanFileName(upload.filename),
        storage: blobUrl ? "blob" : "inline",
        blobUrl,
        inlineData: blobUrl ? null : encoded.buf.toString("base64"),
        contentType: "image/jpeg",
        byteSize: encoded.buf.byteLength,
        width: encoded.width,
        height: encoded.height,
      });
      stored.push({ id, width: encoded.width, height: encoded.height });
    } catch (err) {
      if (blobUrl) await del(blobUrl).catch(() => {});
      await recordErrorEvent({
        source: ERROR_SOURCES.capturePhotoStore,
        kind: useBlob ? "blob_or_insert_failed" : "insert_failed",
        userId,
        message: err,
      });
    }
  }
  return stored;
}

/** Best-effort Blob cleanup. The row going is the contract; an orphaned object is a cost. */
async function deleteBlobs(urls: (string | null)[]) {
  for (const url of urls) {
    if (!url) continue;
    try {
      await del(url);
    } catch {
      // See above — never worth failing the caller over.
    }
  }
}

/**
 * Throw away photos from an upload that went nowhere — the transcription failed, so there
 * is no text for a capture to be saved from. Only ever touches unattached rows.
 */
export async function discardCapturePhotos(userId: string, ids: string[]) {
  if (!ids.length) return;
  const db = await getDb();
  const where = and(
    eq(capturePhotos.userId, userId),
    inArray(capturePhotos.id, ids),
    isNull(capturePhotos.noteBatchId)
  );
  const rows = await db.select({ blobUrl: capturePhotos.blobUrl }).from(capturePhotos).where(where);
  await db.delete(capturePhotos).where(where);
  await deleteBlobs(rows.map((r) => r.blobUrl));
}

/**
 * Claim a saved capture's photos. Scoped to the user AND to rows no batch owns yet, so a
 * forged id can neither steal someone else's photo nor move one between captures. Returns
 * how many were claimed.
 */
export async function attachCapturePhotos(
  userId: string,
  noteBatchId: string,
  ids: string[]
): Promise<number> {
  const unique = [...new Set(ids)].slice(0, MAX_PHOTOS_PER_CAPTURE);
  if (!unique.length) return 0;
  const db = await getDb();
  const claimable = and(
    eq(capturePhotos.userId, userId),
    inArray(capturePhotos.id, unique),
    isNull(capturePhotos.noteBatchId)
  );
  // Counted by a select rather than `.returning()`: a field selector on `.returning` defeats
  // Drizzle's overload resolution in this TS version (see `createFeedbackSubmission`), and a
  // bare one would ship every photo's inline base64 back just to be counted.
  const rows = await db.select({ id: capturePhotos.id }).from(capturePhotos).where(claimable);
  if (!rows.length) return 0;
  await db.update(capturePhotos).set({ noteBatchId }).where(claimable);
  return rows.length;
}

export type CapturePhotoMeta = {
  id: string;
  noteBatchId: string;
  fileName: string | null;
  width: number | null;
  height: number | null;
};

/**
 * Photo metadata for a set of batches, in display order. Never selects the bytes: an inline
 * photo is hundreds of kilobytes of base64, and this feeds lists.
 */
export async function listCapturePhotosForBatches(
  userId: string,
  noteBatchIds: string[]
): Promise<CapturePhotoMeta[]> {
  if (!noteBatchIds.length) return [];
  const db = await getDb();
  const rows = await db
    .select({
      id: capturePhotos.id,
      noteBatchId: capturePhotos.noteBatchId,
      fileName: capturePhotos.fileName,
      width: capturePhotos.width,
      height: capturePhotos.height,
    })
    .from(capturePhotos)
    .where(and(eq(capturePhotos.userId, userId), inArray(capturePhotos.noteBatchId, noteBatchIds)))
    .orderBy(asc(capturePhotos.createdAt), asc(capturePhotos.position));
  return rows.filter((r): r is CapturePhotoMeta => r.noteBatchId !== null);
}

/**
 * Delete photos whose capture was never saved. Run by the daily cron; returns how many went.
 *
 * Global rather than per-user, and bounded per run — a backlog just takes a few days. The
 * TTL is generous on purpose: someone who uploads a photo, gets pulled into a meeting and
 * comes back to hit Save that afternoon must still find it attached.
 */
export async function pruneUnattachedCapturePhotos(
  now: Date = new Date(),
  limit = PRUNE_BATCH
): Promise<number> {
  const db = await getDb();
  const cutoff = new Date(now.getTime() - UNATTACHED_PHOTO_TTL_MS);
  const stale = await db
    .select({ id: capturePhotos.id, blobUrl: capturePhotos.blobUrl })
    .from(capturePhotos)
    .where(and(isNull(capturePhotos.noteBatchId), lt(capturePhotos.createdAt, cutoff)))
    .limit(limit);
  if (!stale.length) return 0;
  await db.delete(capturePhotos).where(
    inArray(
      capturePhotos.id,
      stale.map((r) => r.id)
    )
  );
  await deleteBlobs(stale.map((r) => r.blobUrl));
  return stale.length;
}

/**
 * Every capture photo a user has, rows and Blob objects both. For `purgeUserData`, which
 * must reach the objects by hand: nothing cascades into the store.
 */
export async function purgeCapturePhotosForUser(userId: string) {
  const db = await getDb();
  const rows = await db
    .select({ blobUrl: capturePhotos.blobUrl })
    .from(capturePhotos)
    .where(eq(capturePhotos.userId, userId));
  await db.delete(capturePhotos).where(eq(capturePhotos.userId, userId));
  await deleteBlobs(rows.map((r) => r.blobUrl));
}
