/**
 * The capture history: every saved capture, newest first, a page at a time.
 *
 * Split from the `"use server"` wrapper in `src/actions/capture.ts` the same way
 * `unresolved-mentions.ts` is, so `scripts/smoke-capture-history.ts` can drive it against
 * PGlite with no auth.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { noteBatches, type CaptureSourceKind } from "@/db/schema";
import { listCapturePhotosForBatches } from "@/lib/capture-photos";
import { captureExcerpt, captureHistoryTitle, captureSourceKinds } from "@/lib/note-batches";

export const CAPTURE_HISTORY_FIRST_PAGE = 5;
export const CAPTURE_HISTORY_PAGE = 10;
/** Thumbnails a history row shows before collapsing the rest into "+N". */
const ROW_THUMBNAILS = 3;

export type CaptureHistoryItem = {
  id: string;
  /** ISO. */
  createdAt: string;
  status: "saved" | "undone";
  entryPoint: "capture" | "profile";
  kinds: CaptureSourceKind[];
  title: string | null;
  excerpt: string;
  peopleCount: number;
  reminderCount: number;
  photoCount: number;
  thumbnailIds: string[];
};

export type CaptureHistoryPage = {
  items: CaptureHistoryItem[];
  /** Opaque; hand it back to get the next page. Null when there is nothing older. */
  nextCursor: string | null;
};

/**
 * `createdAt` as Postgres prints it, plus the id, joined by `|`.
 *
 * The timestamp is carried as Postgres's own text rather than a JS `Date` because
 * `created_at` has microsecond precision and a `Date` has milliseconds: a cursor rounded
 * through JavaScript sorts a hair after the row it came from, and a keyset page built on
 * it silently repeats or skips captures that landed in the same millisecond.
 */
function encodeCursor(createdAtText: string, id: string) {
  return `${createdAtText}|${id}`;
}

function decodeCursor(cursor: string | null | undefined): { at: string; id: string } | null {
  if (!cursor) return null;
  const bar = cursor.lastIndexOf("|");
  if (bar <= 0) return null;
  const at = cursor.slice(0, bar);
  const id = cursor.slice(bar + 1);
  // Both halves are cast inside the query, so junk would throw there; refuse it here and
  // hand back the first page instead of an error.
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:?\d{2})?|Z)?$/.test(at)) return null;
  return { at, id };
}

export async function listCaptureHistoryFor(
  userId: string,
  opts: { cursor?: string | null; limit?: number } = {}
): Promise<CaptureHistoryPage> {
  const limit = Math.min(Math.max(opts.limit ?? CAPTURE_HISTORY_PAGE, 1), 50);
  const after = decodeCursor(opts.cursor);
  const db = await getDb();

  const rows = await db
    .select({
      id: noteBatches.id,
      createdAt: noteBatches.createdAt,
      createdAtText: sql<string>`${noteBatches.createdAt}::text`,
      status: noteBatches.status,
      entryPoint: noteBatches.entryPoint,
      inputSources: noteBatches.inputSources,
      // Only the head of the notes: the full text can run to pages, and this is a list.
      head: sql<string>`left(${noteBatches.sourceText}, 400)`,
      result: noteBatches.result,
    })
    .from(noteBatches)
    .where(
      and(
        eq(noteBatches.userId, userId),
        after
          ? sql`(${noteBatches.createdAt}, ${noteBatches.id}) < (${after.at}::timestamptz, ${after.id}::uuid)`
          : undefined
      )
    )
    .orderBy(desc(noteBatches.createdAt), desc(noteBatches.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const photos = await listCapturePhotosForBatches(
    userId,
    page.map((r) => r.id)
  );
  const photosByBatch = new Map<string, string[]>();
  for (const photo of photos) {
    const list = photosByBatch.get(photo.noteBatchId) ?? [];
    list.push(photo.id);
    photosByBatch.set(photo.noteBatchId, list);
  }

  const items: CaptureHistoryItem[] = page.map((row) => {
    const photoIds = photosByBatch.get(row.id) ?? [];
    const participants = row.result?.participants ?? [];
    const reminders = row.result?.reminders ?? [];
    // Stored labels are the source of truth; a photo row is proof enough on its own for a
    // batch saved before the labels existed. A pre-label batch with no photo has no record
    // of how it arrived, and `captureSourceKinds` reads that as typed text.
    const stored = row.inputSources ?? [];
    const kinds = captureSourceKinds(
      photoIds.length && !stored.includes("photo") ? [...stored, "photo"] : stored
    );
    return {
      id: row.id,
      createdAt: new Date(row.createdAt).toISOString(),
      status: row.status,
      entryPoint: row.entryPoint,
      kinds,
      title: captureHistoryTitle({ participants, reminders }),
      excerpt: captureExcerpt(row.head ?? ""),
      peopleCount: participants.length,
      reminderCount: reminders.length,
      photoCount: photoIds.length,
      thumbnailIds: photoIds.slice(0, ROW_THUMBNAILS),
    };
  });

  const last = page[page.length - 1];
  return {
    items,
    nextCursor: rows.length > limit && last ? encodeCursor(last.createdAtText, last.id) : null,
  };
}
