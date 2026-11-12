/**
 * The capture history: every saved capture, newest first, a page at a time.
 *
 * Split from the `"use server"` wrapper in `src/actions/capture.ts` the same way
 * `unresolved-mentions.ts` is, so `scripts/smoke-capture-history.ts` can drive it against
 * PGlite with no auth.
 */
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { captureJobs, interactions, noteBatches, type CaptureSourceKind } from "@/db/schema";
import { listCapturePhotosForBatches } from "@/lib/capture-photos";
import { findActiveCaptureJobs } from "@/lib/capture-jobs";
import { contactOrgLogos, type MeetingCompany } from "@/lib/meetings-list";
import {
  captureAttendeeNames,
  captureExcerpt,
  captureHistoryTitle,
  captureMethod,
  captureNextStep,
  captureSourceKinds,
  captureSummary,
  type CaptureMethod,
  type NoteBatchResult,
} from "@/lib/note-batches";

export const CAPTURE_HISTORY_FIRST_PAGE = 5;
export const CAPTURE_HISTORY_PAGE = 10;
/** Thumbnails a history row shows before collapsing the rest into "+N". */
const ROW_THUMBNAILS = 3;

export type CaptureHistoryItem = {
  id: string;
  /** ISO. */
  createdAt: string;
  status: "saved" | "undone";
  entryPoint: "capture" | "profile" | "relationship";
  kinds: CaptureSourceKind[];
  method: CaptureMethod;
  title: string | null;
  /** Everyone the capture saved, each once. */
  names: string[];
  /** The same people, each with their company's (or school's) logo domain when one is known. */
  people: { name: string; org: MeetingCompany | null }[];
  /** Plain text, never markdown. */
  summary: string | null;
  nextSteps: string | null;
  excerpt: string;
  peopleCount: number;
  reminderCount: number;
  photoCount: number;
  thumbnailIds: string[];
};

export type PendingStatus = "extracting" | "ready" | "saving" | "failed";

/** One job in the queue: its own review, or one file of a drop. */
export type CaptureHistoryPendingFile = {
  id: string;
  status: PendingStatus;
  /** The doc's or file's name, when the job was given one. */
  title: string | null;
  peopleCount: number;
  error: string | null;
  /** Where its review lives: the meeting page for a recording, else this job on /capture. */
  href: string;
};

/**
 * An extraction that has not been saved yet. Cloud docs (picked or auto-extracted by the
 * drive scan), Granola and Notion picks and multi-file drops all wait here until someone
 * reviews them, and until then no note batch exists — so without these the history never
 * shows them.
 *
 * A drop (several files read together, one `batchGroupId`) is one entry with a row per
 * file: it is reviewed as one deck, so it is listed as one thing to do.
 */
export type CaptureHistoryPending =
  | ({ kind: "job"; createdAt: string; method: CaptureMethod } & CaptureHistoryPendingFile)
  | {
      kind: "drop";
      /** The `batchGroupId`, or the folded job's id once the drop is one review. */
      id: string;
      /** Set once the drop is folded into one review: discard that job, not a batch. */
      jobId: string | null;
      /** ISO; the newest file's. */
      createdAt: string;
      method: CaptureMethod;
      files: CaptureHistoryPendingFile[];
      /** Opens the drop's review: any of its files does, the flow folds the rest in. */
      href: string;
    };

/** Jobs read for the queue; they are not paged. ponytail: the finder's own 50 cap, page it if anyone hits it. */
const PENDING_LIMIT = 50;

const PENDING_STATUS: Partial<Record<string, PendingStatus>> = {
  queued: "extracting",
  extracting: "extracting",
  ready: "ready",
  reviewing: "ready",
  saving: "saving",
  failed: "failed",
};

/** A drop's files are still being uploaded and read while `ingesting`; a lone one is a draft. */
const DROP_READING: Partial<Record<string, PendingStatus>> = { ingesting: "extracting", transcribed: "extracting" };

/**
 * Everything still waiting, newest first, drops folded into one entry. Drafts (a lone job
 * still `ingesting` / `transcribed`: notes being typed or uploaded into the box) are not
 * extractions yet and stay out.
 */
export async function listPendingCapturesFor(userId: string): Promise<CaptureHistoryPending[]> {
  const jobs = await findActiveCaptureJobs(userId, PENDING_LIMIT);
  const out: CaptureHistoryPending[] = [];
  const drops = new Map<string, Extract<CaptureHistoryPending, { kind: "drop" }>>();
  const fileCreated = new Map<string, string>();
  for (const job of jobs) {
    const status = PENDING_STATUS[job.status] ?? (job.batchGroupId ? DROP_READING[job.status] : undefined);
    if (!status || job.noteBatchId) continue;
    const method = captureMethod({
      meeting: false,
      granola: job.sourceKind === "granola",
      jobSource: job.sourceKind,
      jobTags: job.sources,
      kinds: [],
    });
    const file: CaptureHistoryPendingFile = {
      id: job.id,
      status,
      title: job.sourceLabel,
      peopleCount: job.result?.items.length ?? 0,
      error: status === "failed" ? job.error : null,
      href: job.meetingSessionId ? `/meetings/${job.meetingSessionId}` : `/capture?job=${job.id}`,
    };
    const createdAt = new Date(job.createdAt).toISOString();
    // A drop already folded into one review: still listed file by file, from the label every
    // card keeps (`combineCaptureResults`), so the files never read as one blob of notes.
    if (!job.batchGroupId && job.result?.parts?.length) {
      const byNote = new Map<string, number>();
      for (const item of job.result.items) {
        const label = item.noteLabel ?? "Untitled note";
        byNote.set(label, (byNote.get(label) ?? 0) + 1);
      }
      out.push({
        kind: "drop",
        id: job.id,
        jobId: job.id,
        createdAt,
        method,
        files: [...byNote].map(([title, peopleCount], i) => ({ ...file, id: `${job.id}:${i}`, title, peopleCount })),
        href: file.href,
      });
      continue;
    }
    if (!job.batchGroupId) {
      out.push({ kind: "job", createdAt, method, ...file });
      continue;
    }
    let drop = drops.get(job.batchGroupId);
    if (!drop) {
      drop = { kind: "drop", id: job.batchGroupId, jobId: null, createdAt, method, files: [], href: file.href };
      drops.set(job.batchGroupId, drop);
      out.push(drop);
    }
    drop.files.push(file);
    fileCreated.set(file.id, createdAt);
    if (createdAt > drop.createdAt) drop.createdAt = createdAt;
  }
  for (const drop of drops.values()) {
    // Oldest file first, the order they were dropped; open on a file that has been read.
    drop.files.sort((a, b) => fileCreated.get(a.id)!.localeCompare(fileCreated.get(b.id)!));
    drop.href = (drop.files.find((f) => f.status === "ready") ?? drop.files[0]).href;
  }
  return out;
}

export type CaptureHistoryPage = {
  items: CaptureHistoryItem[];
  /** Unsaved extractions, on the first page only (empty on every later one). */
  pending: CaptureHistoryPending[];
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

/**
 * A relationship-engine run keeps its reminders in a note batch so its Undo can reuse
 * capture's, but it is not a capture: the history never lists it and the capture actions
 * (open, undo, delete) treat it as not found. The run is undone from its own surface.
 */
export const CAPTURE_BATCH_SQL = ne(noteBatches.entryPoint, "relationship");
/** A capture the history can show: finished, or finished and then undone. Never one mid-write or one that threw. */
export const FINISHED_BATCH_SQL = inArray(noteBatches.status, ["saved", "undone"]);

/** True when `batchId` is one of `userId`'s captures (not a relationship run batch). */
export async function isCaptureBatchFor(userId: string, batchId: string): Promise<boolean> {
  const db = await getDb();
  const row = await db.query.noteBatches.findFirst({
    where: and(eq(noteBatches.id, batchId), eq(noteBatches.userId, userId), CAPTURE_BATCH_SQL),
    columns: { id: true },
  });
  return Boolean(row);
}

/**
 * One batch's method, from the same evidence `listCaptureHistoryFor` reads, so the results
 * page names a capture the way its history row does.
 */
export async function captureMethodFor(
  userId: string,
  batch: { id: string; result: NoteBatchResult; kinds: CaptureSourceKind[] }
): Promise<CaptureMethod> {
  const db = await getDb();
  const interactionIds = batch.result.participants
    .map((p) => p.interactionId)
    .filter((id): id is string => Boolean(id));
  const [jobs, granola] = await Promise.all([
    db
      .select({ sourceKind: captureJobs.sourceKind, sources: captureJobs.sources })
      .from(captureJobs)
      .where(and(eq(captureJobs.userId, userId), eq(captureJobs.noteBatchId, batch.id)))
      .limit(1),
    interactionIds.length
      ? db
          .select({ id: interactions.id })
          .from(interactions)
          .where(
            and(
              eq(interactions.userId, userId),
              inArray(interactions.id, interactionIds),
              eq(interactions.source, "granola")
            )
          )
          .limit(1)
      : [],
  ]);
  return captureMethod({
    meeting: Boolean(batch.result.meeting),
    granola: granola.length > 0,
    jobSource: jobs[0]?.sourceKind,
    jobTags: jobs[0]?.sources,
    kinds: batch.kinds,
  });
}

export async function listCaptureHistoryFor(
  userId: string,
  opts: { cursor?: string | null; limit?: number } = {}
): Promise<CaptureHistoryPage> {
  const limit = Math.min(Math.max(opts.limit ?? CAPTURE_HISTORY_PAGE, 1), 50);
  const after = decodeCursor(opts.cursor);
  const db = await getDb();
  // A side read: the saved history still renders if it fails.
  const pendingPromise = after ? Promise.resolve([]) : listPendingCapturesFor(userId).catch(() => []);

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
        CAPTURE_BATCH_SQL,
        FINISHED_BATCH_SQL,
        after
          ? sql`(${noteBatches.createdAt}, ${noteBatches.id}) < (${after.at}::timestamptz, ${after.id}::uuid)`
          : undefined
      )
    )
    .orderBy(desc(noteBatches.createdAt), desc(noteBatches.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const batchIds = page.map((r) => r.id);
  const interactionIds = [
    ...new Set(page.flatMap((r) => (r.result?.participants ?? []).map((p) => p.interactionId).filter((id): id is string => Boolean(id)))),
  ];
  // One read per source for the whole page. Interactions are found by their primary key
  // (the snapshot names them) rather than by note_batch_id, which has no index.
  const contactIds = [...new Set(page.flatMap((r) => (r.result?.participants ?? []).map((p) => p.contactId)))];
  const [photos, jobs, people, orgs] = await Promise.all([
    listCapturePhotosForBatches(userId, batchIds),
    batchIds.length
      ? db
          .select({ noteBatchId: captureJobs.noteBatchId, sourceKind: captureJobs.sourceKind, sources: captureJobs.sources })
          .from(captureJobs)
          .where(and(eq(captureJobs.userId, userId), inArray(captureJobs.noteBatchId, batchIds)))
      : [],
    interactionIds.length
      ? db
          .select({
            id: interactions.id,
            source: interactions.source,
            summary: sql<string | null>`left(${interactions.aiSummary}, 600)`,
          })
          .from(interactions)
          .where(and(eq(interactions.userId, userId), inArray(interactions.id, interactionIds)))
      : [],
    contactOrgLogos(userId, contactIds),
  ]);
  const photosByBatch = new Map<string, string[]>();
  for (const photo of photos) {
    const list = photosByBatch.get(photo.noteBatchId) ?? [];
    list.push(photo.id);
    photosByBatch.set(photo.noteBatchId, list);
  }
  const jobByBatch = new Map(jobs.map((j) => [j.noteBatchId, j]));
  const interactionById = new Map(people.map((p) => [p.id, p]));

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
    const saved = participants.map((p) => (p.interactionId ? interactionById.get(p.interactionId) : undefined));
    const meeting = row.result?.meeting;
    const names = captureAttendeeNames(participants);
    const title = captureHistoryTitle({ meetingTitle: meeting?.title, head: row.head ?? "", names, reminders });
    const nextSteps = row.result ? captureNextStep(row.result) : null;
    return {
      id: row.id,
      createdAt: new Date(row.createdAt).toISOString(),
      // Narrowed by FINISHED_BATCH_SQL above; the column also carries `saving` and `failed`.
      status: row.status as CaptureHistoryItem["status"],
      entryPoint: row.entryPoint,
      kinds,
      method: captureMethod({
        meeting: Boolean(meeting),
        granola: saved.some((i) => i?.source === "granola"),
        jobSource: jobByBatch.get(row.id)?.sourceKind,
        jobTags: jobByBatch.get(row.id)?.sources,
        kinds,
      }),
      title,
      names,
      people: names.map((name) => {
        const id = participants.find((p) => p.name.trim() === name)?.contactId;
        return { name, org: (id && orgs.get(id)) || null };
      }),
      summary: captureSummary(meeting?.summary, saved.map((i) => i?.summary)),
      // A dates-only note is already titled by its reminder; don't repeat it underneath.
      nextSteps: nextSteps === title ? null : nextSteps,
      excerpt: captureExcerpt(row.head ?? ""),
      peopleCount: names.length,
      reminderCount: reminders.length,
      photoCount: photoIds.length,
      thumbnailIds: photoIds.slice(0, ROW_THUMBNAILS),
    };
  });

  const last = page[page.length - 1];
  return {
    items,
    pending: await pendingPromise,
    nextCursor: rows.length > limit && last ? encodeCursor(last.createdAtText, last.id) : null,
  };
}
