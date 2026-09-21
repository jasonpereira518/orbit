/**
 * The Drive import: picked Google Docs and Slides decks, read one at a time through capture's
 * own parse and save, with no review step.
 *
 * Staging writes one pending `import_job_rows` row per file and nothing else — no Drive call
 * happens until the runner claims the job. The runner is resumable like the other server-owned
 * imports: it works in small chunks, re-reads the job between them so a cancel lands, and
 * hands off to `/api/imports/[id]/continue` before the function's time ceiling.
 *
 * What makes this stricter than capture is the reminder policy (`drive-reminder-rules.ts`):
 * a doc can be years old and nobody reviews it, so only stated dates still ahead become
 * reminders, the generic follow-up is dropped once it would already be overdue, and a
 * recently-passed, high-confidence date is only flagged on the import.
 */
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  imports,
  importJobRows,
  noteBatches,
  isDriveFileRow,
  type DriveFileRowPayload,
  type ImportStats,
} from "@/db/schema";
import { classifyAiError, friendlyError, UserFacingError } from "@/lib/errors";
import { isAiAccessError } from "@/lib/ai-access";
import { internalFetch } from "@/lib/internal-auth";
import { reportError } from "@/lib/report-error";
import { failImport, truncateStoredError } from "@/lib/import-job-processor";
import { getValidAccessToken } from "@/lib/gmail";
import {
  DriveFileTooLargeError,
  DriveFileUnavailableError,
  exportDriveFileText,
} from "@/lib/drive";
import { NO_PEOPLE_OR_DATES_MESSAGE, runCaptureParse } from "@/lib/capture-parse";
import { saveNoteBatch } from "@/lib/note-batch-save";
import { saveInputFromParse } from "@/lib/capture-job-runner";
import { defaultMergeId } from "@/lib/capture/review-reducer";
import type { CaptureDecisions } from "@/lib/capture/types";
import { hashSourceNote } from "@/lib/suggested-reminder-utils";
import { DEFAULT_FOLLOW_UP_WINDOW_DAYS } from "@/lib/note-batches";
import {
  applyDriveReminderRules,
  followUpStillAhead,
} from "@/lib/imports/drive-reminder-rules";
import { DRIVE_MIME, type PickedDriveFile } from "@/lib/imports/drive-triage";
import { DRIVE_IMPORT_TYPE } from "@/lib/drive-import-type";

export { DRIVE_IMPORT_TYPE };

export const MAX_DRIVE_FILES_PER_IMPORT = 25;
/** Each row is an export plus a multi-call parse (~60 s for a busy doc), so a few per pass. */
const CHUNK_SIZE = 4;
/** The continue route's `maxDuration` (and the cron's): the platform kills the run here. */
const MAX_DURATION_MS = 300 * 1000;
/**
 * A row is only started with at least this much of the ceiling left: one busy doc's parse
 * alone is ~60 s, and a row killed mid-save is exactly what resuming has to avoid.
 */
const ROW_RESERVE_MS = 90 * 1000;
/** Past this, no new row starts and the job hands off to a fresh invocation. */
const START_ROW_DEADLINE_MS = MAX_DURATION_MS - ROW_RESERVE_MS;
const MAX_STORED_FLAGS = 20;

/** Per-row reasons, stored on `import_job_rows.error_message` and shown in the detail sheet. */
export const DRIVE_ROW_COPY = {
  unavailable: "Orbit can’t open this file any more — it may have been deleted or unshared",
  tooLarge: "This file is too long to read as notes",
  empty: "Nothing written in this one",
  nobody: "No people or dates in this one",
  alreadyImported: "Already brought in — unchanged since",
  unreadable: "Orbit couldn’t read this one",
  noAiKey: "Add an AI key in Settings so Orbit can read your Drive files",
} as const;

export const DRIVE_KEY_PROBLEM_COPY = {
  auth: "Your AI provider didn’t accept your API key — check it in Settings, then try again",
  quota: "Your AI provider says your account is out of credit — top up with them, then try again",
  model_unavailable: "Your AI model isn’t available — pick another in Settings, then try again",
} as const;

export type DriveImportDeps = {
  getAccessToken: (userId: string, opts?: { minValidityMs?: number }) => Promise<string>;
  exportText: (accessToken: string, fileId: string) => Promise<string>;
  parse: typeof runCaptureParse;
  save: typeof saveNoteBatch;
  continueLater: (importId: string) => Promise<void>;
  now: () => Date;
};

async function scheduleContinuation(importId: string) {
  try {
    await internalFetch(`/api/imports/${importId}/continue`, { method: "POST" });
  } catch (err) {
    // Best-effort — the process-stalled cron picks the job back up either way.
    reportError(err, { where: "job.drive-import.continuation-kick", level: "warning", extra: { importId } });
  }
}

const DEFAULT_DEPS: DriveImportDeps = {
  getAccessToken: getValidAccessToken,
  exportText: (token, fileId) => exportDriveFileText(token, fileId),
  parse: runCaptureParse,
  save: saveNoteBatch,
  continueLater: scheduleContinuation,
  now: () => new Date(),
};

const SUPPORTED = new Set<string>([DRIVE_MIME.doc, DRIVE_MIME.slides]);

/** Create the import and one pending row per supported file. Nothing is fetched yet. */
export async function stageDriveImport(
  userId: string,
  files: PickedDriveFile[],
): Promise<{ importId: string; totalRows: number }> {
  const usable = files.filter((f) => SUPPORTED.has(f.mimeType));
  if (usable.length > MAX_DRIVE_FILES_PER_IMPORT) {
    throw new UserFacingError(`Pick up to ${MAX_DRIVE_FILES_PER_IMPORT} files at a time`);
  }
  if (!usable.length) throw new UserFacingError("Pick a Google Doc or Slides deck to import");

  const db = await getDb();
  const [row] = await db
    .insert(imports)
    .values({
      userId,
      importType: DRIVE_IMPORT_TYPE,
      status: "processing",
      totalRows: usable.length,
      rowsProcessed: 0,
      fileName: usable.length === 1 ? usable[0].name : `${usable.length} Google Drive files`,
      stats: {},
    })
    .returning();

  await db.insert(importJobRows).values(
    usable.map((f, i) => ({
      importId: row.id,
      userId,
      rowIndex: i,
      status: "pending",
      payload: {
        kind: "drive_file",
        fileId: f.id,
        name: f.name,
        mimeType: f.mimeType,
        modifiedTime: f.modifiedTime,
      } satisfies DriveFileRowPayload,
    })),
  );

  return { importId: row.id, totalRows: usable.length };
}

/** Every person the parse found, accepted into their best existing match — no review step. */
function acceptEveryone(
  items: Awaited<ReturnType<typeof runCaptureParse>>["items"],
  keep: string[],
  at: string,
): CaptureDecisions {
  const people: NonNullable<CaptureDecisions["people"]> = {};
  items.forEach((item, index) => {
    people[item.key] = {
      decision: "accept",
      index,
      mergeContactId: defaultMergeId(item),
      relationshipScore: item.parsed.relationship_score_suggestion ?? 3,
      tagNames: item.parsed.tags ?? [],
      decidedAt: at,
    };
  });
  return { people, reminders: { checked: keep, overrides: {} } };
}

/**
 * A finished save of exactly this text, from any earlier import or capture.
 *
 * `saveNoteBatch` inserts its batch row as `saved` with an empty `result` BEFORE writing
 * anyone, and fills `result` only at the end. So a save killed or thrown part-way leaves a
 * `saved` batch that proves nothing; only one that recorded its participants counts. Anything
 * else is re-saved — interactions and reminders are idempotent on their own keys, and the
 * re-parse's duplicate check merges into whoever the partial save created, so the only cost
 * is one more batch row.
 */
async function priorBatchFor(userId: string, sourceHash: string) {
  const db = await getDb();
  return (
    (await db.query.noteBatches.findFirst({
      where: and(
        eq(noteBatches.userId, userId),
        eq(noteBatches.sourceHash, sourceHash),
        eq(noteBatches.status, "saved"),
        sql`jsonb_array_length(coalesce(${noteBatches.result}->'participants', '[]'::jsonb)) > 0`,
      ),
      orderBy: [desc(noteBatches.createdAt)],
      columns: { result: true },
    })) ?? null
  );
}

type RowOutcome =
  | {
      status: "done";
      contactIds: string[];
      flags: NonNullable<ImportStats["flaggedCommitments"]>;
      reminders: number;
      created: number;
      updated: number;
    }
  | { status: "skipped"; reason: string; already?: boolean; contactIds?: string[] };

async function processDoc(
  userId: string,
  importId: string,
  payload: DriveFileRowPayload,
  accessToken: string,
  deps: DriveImportDeps,
): Promise<RowOutcome> {
  let text: string;
  try {
    text = await deps.exportText(accessToken, payload.fileId);
  } catch (err) {
    if (err instanceof DriveFileUnavailableError) return { status: "skipped", reason: DRIVE_ROW_COPY.unavailable };
    if (err instanceof DriveFileTooLargeError) return { status: "skipped", reason: DRIVE_ROW_COPY.tooLarge };
    // Any other Drive failure is this file's problem, never the AI key's. Handled here so it
    // can't reach `keyProblem`, whose classifier would read "Drive export returned 401" as
    // a rejected AI key and stop the whole job with the wrong sentence.
    reportError(err, { where: "job.drive-import.export", level: "warning", extra: { importId } });
    return { status: "skipped", reason: DRIVE_ROW_COPY.unreadable };
  }
  if (!text.trim()) return { status: "skipped", reason: DRIVE_ROW_COPY.empty };

  const sourceHash = hashSourceNote(text);
  const prior = await priorBatchFor(userId, sourceHash);
  if (prior) {
    return {
      status: "skipped",
      reason: DRIVE_ROW_COPY.alreadyImported,
      already: true,
      contactIds: (prior.result?.participants ?? []).map((p) => p.contactId),
    };
  }

  const now = deps.now();
  let result;
  try {
    // The doc's own date is the anchor, so "next Tuesday" in an old doc means next from then.
    result = await deps.parse(userId, text, { eventDate: payload.modifiedTime.slice(0, 10) }, { now });
  } catch (err) {
    if (err instanceof UserFacingError && err.message === NO_PEOPLE_OR_DATES_MESSAGE) {
      return { status: "skipped", reason: DRIVE_ROW_COPY.nobody };
    }
    throw err;
  }

  const { keep, flags } = applyDriveReminderRules(result.suggestedReminders, now);
  const input = await saveInputFromParse({
    userId,
    result,
    decisions: acceptEveryone(result.items, keep, now.toISOString()),
    sourceText: text,
    sourceHash,
    entryPoint: "capture",
    seedContactId: null,
    inputSources: ["file"],
    meetingSessionId: null,
  });
  // Rule 1 applies to the generic follow-up too: for an old doc it is already overdue.
  input.participants = input.participants.map((p) => ({
    ...p,
    createReminder:
      p.createReminder &&
      followUpStillAhead(
        input.anchorIso,
        p.followUpDays || p.parsed.follow_up_days || DEFAULT_FOLLOW_UP_WINDOW_DAYS,
        now,
      ),
  }));
  // `saveNoteBatch` throws on an empty save; a parse with nothing to keep is a plain skip.
  if (!input.participants.length && !input.commitments.length) {
    return { status: "skipped", reason: DRIVE_ROW_COPY.nobody };
  }

  const out = await deps.save(userId, input);
  const idByName = new Map(out.result.participants.map((p) => [p.name.trim().toLowerCase(), p.contactId]));
  return {
    status: "done",
    contactIds: out.contactIds,
    reminders: out.remindersCreated,
    created: out.created,
    updated: out.updated,
    flags: flags.map((f) => ({
      ...f,
      id: `${payload.fileId}:${f.key}`,
      contactId: f.personName ? (idByName.get(f.personName.trim().toLowerCase()) ?? null) : null,
      docName: payload.name,
    })),
  };
}

function keyProblem(err: unknown): string | null {
  // No usable AI key at all: every doc would hit the same wall, so the job stops at the first.
  if (isAiAccessError(err)) return friendlyError(err, DRIVE_ROW_COPY.noAiKey);
  const kind = classifyAiError(err);
  if (kind === "auth" || kind === "quota" || kind === "model_unavailable") {
    return friendlyError(err, DRIVE_KEY_PROBLEM_COPY[kind]);
  }
  return null;
}

export async function runDriveImportJob(
  importId: string,
  deps: DriveImportDeps = DEFAULT_DEPS,
): Promise<void> {
  const db = await getDb();
  const jobStart = deps.now().getTime();

  const importRow = await db.query.imports.findFirst({ where: eq(imports.id, importId) });
  if (!importRow) return;
  if (["completed", "failed", "cancelled"].includes(importRow.status)) return;
  const userId = importRow.userId;

  let accessToken: string;
  try {
    accessToken = await deps.getAccessToken(userId, { minValidityMs: MAX_DURATION_MS + 60_000 });
  } catch (err) {
    await failImport(importId, err);
    return;
  }

  try {
    for (;;) {
      if (deps.now().getTime() - jobStart > START_ROW_DEADLINE_MS) {
        await deps.continueLater(importId);
        return;
      }
      // Re-read so a cancel from the UI takes effect between chunks.
      const current = await db.query.imports.findFirst({ where: eq(imports.id, importId) });
      if (!current || current.status !== "processing") return;

      const pending = await db.query.importJobRows.findMany({
        where: and(eq(importJobRows.importId, importId), eq(importJobRows.status, "pending")),
        orderBy: [asc(importJobRows.rowIndex)],
        limit: CHUNK_SIZE,
      });
      if (!pending.length) break;

      const stats: ImportStats = { ...(current.stats ?? {}) };
      // Nullable columns: `?? 0`, not destructuring defaults, which only catch undefined.
      let contactsCreated = current.contactsCreated ?? 0;
      let contactsUpdated = current.contactsUpdated ?? 0;
      let rowsProcessed = current.rowsProcessed ?? 0;
      const flushProgress = () =>
        db
          .update(imports)
          .set({ rowsProcessed, contactsCreated, contactsUpdated, stats, updatedAt: new Date() })
          .where(eq(imports.id, importId));

      for (const row of pending) {
        if (deps.now().getTime() - jobStart > START_ROW_DEADLINE_MS) break;
        const payload = row.payload;
        if (!isDriveFileRow(payload)) {
          const claimed = await db
            .update(importJobRows)
            .set({ status: "skipped", updatedAt: new Date() })
            .where(and(eq(importJobRows.id, row.id), eq(importJobRows.status, "pending")))
            .returning();
          if (claimed.length) {
            rowsProcessed++;
            await flushProgress();
          }
          continue;
        }

        let outcome: RowOutcome;
        try {
          outcome = await processDoc(userId, importId, payload, accessToken, deps);
        } catch (err) {
          const problem = keyProblem(err);
          if (problem) {
            // Keep what earlier rows in this chunk already saved, then stop with this row pending.
            await flushProgress();
            await failImport(importId, new Error(problem));
            return;
          }
          reportError(err, { where: "job.drive-import.row", level: "warning", extra: { importId } });
          outcome = { status: "skipped", reason: DRIVE_ROW_COPY.unreadable };
        }

        const contactIds = outcome.status === "done" ? outcome.contactIds : (outcome.contactIds ?? []);
        // Guarded on `pending`: if the stall cron started a second runner that finished this
        // row first, its result stands and this one neither overwrites it nor counts it.
        const claimed = await db
          .update(importJobRows)
          .set({
            // An unchanged re-import is recorded as done: it touched these people, and the
            // detail sheet should list them. Its reason is kept for the row view.
            status: outcome.status === "done" || outcome.already ? "done" : "skipped",
            contactId: contactIds[0] ?? null,
            payload: { ...payload, contactIds },
            errorMessage: outcome.status === "skipped" ? truncateStoredError(outcome.reason) : null,
            updatedAt: new Date(),
          })
          .where(and(eq(importJobRows.id, row.id), eq(importJobRows.status, "pending")))
          .returning();
        if (!claimed.length) continue;

        if (outcome.status === "done") {
          stats.docsRead = (stats.docsRead ?? 0) + 1;
          stats.remindersCreated = (stats.remindersCreated ?? 0) + outcome.reminders;
          stats.flaggedCommitments = [...(stats.flaggedCommitments ?? []), ...outcome.flags].slice(0, MAX_STORED_FLAGS);
          contactsCreated += outcome.created;
          contactsUpdated += outcome.updated;
        } else if (outcome.already) {
          stats.docsAlreadyImported = (stats.docsAlreadyImported ?? 0) + 1;
        }
        rowsProcessed++;
        // Per row, not per chunk: this bumps `imports.updated_at`, which the stall cron reads.
        // A chunk of busy docs can outlast its 3-minute threshold and invite a second runner.
        await flushProgress();
      }
    }

    await db
      .update(imports)
      .set({ status: "completed", updatedAt: new Date() })
      .where(and(eq(imports.id, importId), eq(imports.status, "processing")));
  } catch (err) {
    await failImport(importId, err);
  }
}
