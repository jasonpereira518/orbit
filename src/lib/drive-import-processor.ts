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
import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { stageImportRows } from "@/lib/import-job-rows";
import {
  imports,
  importJobRows,
  isDriveFileRow,
  type DriveFileRowPayload,
  type ImportStats,
} from "@/db/schema";
import { classifyAiError, ReauthRequiredError, UserFacingError } from "@/lib/errors";
import { isAiAccessError } from "@/lib/ai-access";
import { kickEmbeddingBackfill } from "@/lib/embedding-backfill";
import { internalFetch } from "@/lib/internal-auth";
import { reportError } from "@/lib/report-error";
import { failImport, truncateStoredError } from "@/lib/import-job-processor";
import { getValidAccessToken } from "@/lib/gmail";
import {
  DriveFileTooLargeError,
  DriveFileUnavailableError,
  DriveNotAuthorizedError,
  DriveRateLimitedError,
  exportDriveFileText,
} from "@/lib/drive";
import { DRIVE_ROW_COPY } from "@/lib/imports/drive-row-copy";
import { NO_PEOPLE_OR_DATES_MESSAGE, runCaptureParse } from "@/lib/capture-parse";
import { saveNoteBatch } from "@/lib/note-batch-save";
import { saveInputFromParse } from "@/lib/capture-job-runner";
import type { CaptureDecisions } from "@/lib/capture/types";
import { hashSourceNote } from "@/lib/suggested-reminder-utils";
import { DEFAULT_FOLLOW_UP_WINDOW_DAYS } from "@/lib/note-batches";
import {
  applyDriveReminderRules,
  followUpStillAhead,
} from "@/lib/imports/drive-reminder-rules";
import { DRIVE_MIME, type PickedDriveFile } from "@/lib/imports/drive-triage";
import { DRIVE_IMPORT_TYPE } from "@/lib/drive-import-type";

export { DRIVE_IMPORT_TYPE, DRIVE_ROW_COPY };

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
/** A row started this many times without finishing is skipped: it keeps killing the run. */
const MAX_ROW_ATTEMPTS = 2;
/** Rate-limit hand-offs a single row may take before it is skipped as too busy. */
const MAX_RATE_LIMIT_HANDOFFS = 5;
/** Picker ids are Drive file ids: letters, digits, `-` and `_`. */
const DRIVE_FILE_ID = /^[A-Za-z0-9_-]+$/;
const MAX_FILE_NAME_CHARS = 500;

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
  /** Once, when a job completes — capture's own follow-on work (search embeddings). */
  kickEmbeddings: (userId: string) => Promise<void>;
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
  kickEmbeddings: kickEmbeddingBackfill,
  now: () => new Date(),
};

const SUPPORTED = new Set<string>([DRIVE_MIME.doc, DRIVE_MIME.slides]);

/**
 * The picked files as the browser sent them, checked: a server action's arguments are
 * whatever the caller posts, not what the Picker returned.
 */
function validatePicks(files: unknown, now: Date): PickedDriveFile[] {
  if (!Array.isArray(files)) throw new UserFacingError("Pick a Google Doc or Slides deck to import");
  // Counted before filtering by type, so a huge post can't slip under the cap.
  if (files.length > MAX_DRIVE_FILES_PER_IMPORT) {
    throw new UserFacingError(`Pick up to ${MAX_DRIVE_FILES_PER_IMPORT} files at a time`);
  }
  return files.map((f: unknown) => {
    const o = (f ?? {}) as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id : "";
    if (!id || !DRIVE_FILE_ID.test(id)) {
      throw new UserFacingError("Pick your files again from Google Drive");
    }
    const name = (typeof o.name === "string" && o.name.trim() ? o.name.trim() : "Untitled").slice(0, MAX_FILE_NAME_CHARS);
    const mimeType = typeof o.mimeType === "string" ? o.mimeType : "";
    const parsed = typeof o.modifiedTime === "string" ? new Date(o.modifiedTime) : null;
    const modifiedTime = parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : now.toISOString();
    return { id, name, mimeType, modifiedTime };
  });
}

/** Create the import and one pending row per supported file. Nothing is fetched yet. */
export async function stageDriveImport(
  userId: string,
  files: PickedDriveFile[],
  now: Date = new Date(),
): Promise<{ importId: string; totalRows: number }> {
  const usable = validatePicks(files, now).filter((f) => SUPPORTED.has(f.mimeType));
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

  await stageImportRows(
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

/**
 * Every person the parse found, accepted — no review step.
 *
 * Merged only into the parse's own confident suggestion (`suggestedMergeId`). A weaker
 * lookalike is NOT merged unattended: the person is created, and the duplicate machinery
 * flags the pair for review, where a human decides.
 */
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
      mergeContactId: item.suggestedMergeId ?? null,
      relationshipScore: item.parsed.relationship_score_suggestion ?? 3,
      tagNames: item.parsed.tags ?? [],
      decidedAt: at,
    };
  });
  return { people, reminders: { checked: keep, overrides: {} } };
}

/**
 * An earlier Drive row that finished importing exactly this text.
 *
 * The proof is our own row, not `note_batches`: `saveNoteBatch` inserts its batch as `saved`
 * before writing anyone and, if it throws part-way, persists whatever it had written, so a
 * batch can't tell a finished save from a broken one. A Drive row is only marked `done` with
 * a `sourceHash` after its save returned, so a part-way failure is never a marker and the
 * next import re-saves (interactions and reminders are idempotent on their own keys). It
 * also recognises a finished commitments-only doc, which has no participants to show for it.
 */
async function priorImportFor(userId: string, sourceHash: string, excludeRowId: string) {
  const db = await getDb();
  const [row] = await db
    .select({ payload: importJobRows.payload })
    .from(importJobRows)
    .where(
      and(
        eq(importJobRows.userId, userId),
        eq(importJobRows.status, "done"),
        ne(importJobRows.id, excludeRowId),
        sql`${importJobRows.payload}->>'kind' = 'drive_file'`,
        sql`${importJobRows.payload}->>'sourceHash' = ${sourceHash}`,
      ),
    )
    .orderBy(desc(importJobRows.updatedAt))
    .limit(1);
  return row && isDriveFileRow(row.payload) ? row.payload : null;
}

type RowOutcome =
  | {
      status: "done";
      contactIds: string[];
      sourceHash: string;
      flags: NonNullable<ImportStats["flaggedCommitments"]>;
      reminders: number;
      interactions: number;
      created: number;
      updated: number;
    }
  | { status: "skipped"; reason: string; already?: boolean; contactIds?: string[]; sourceHash?: string }
  /** Google asked us to slow down: the row goes back to pending for a later run. */
  | { status: "rate_limited" };

/**
 * A problem with the whole job, not this doc — every later doc would hit the same wall, so the
 * job stops with this error (the original instance where there is one, so `failImport`
 * classifies it precisely) and the row is left pending.
 */
class DriveJobStop extends Error {
  constructor(readonly failure: unknown) {
    super("Drive import stopped");
    this.name = "DriveJobStop";
  }
}

async function processDoc(
  userId: string,
  importId: string,
  rowId: string,
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
    if (err instanceof DriveNotAuthorizedError) return { status: "skipped", reason: DRIVE_ROW_COPY.notAuthorized };
    if (err instanceof DriveRateLimitedError) return { status: "rate_limited" };
    // The grant itself is dead: no later doc can be read either, so stop for a reconnect.
    if (err instanceof ReauthRequiredError) throw new DriveJobStop(err);
    // Any other Drive failure is this file's problem, never the AI key's. Handled here so it
    // can't reach `keyProblem`, whose classifier would read "Drive export returned 401" as
    // a rejected AI key and stop the whole job with the wrong sentence.
    reportError(err, { where: "job.drive-import.export", level: "warning", extra: { importId } });
    return { status: "skipped", reason: DRIVE_ROW_COPY.unreadable };
  }
  if (!text.trim()) return { status: "skipped", reason: DRIVE_ROW_COPY.empty };

  const sourceHash = hashSourceNote(text);
  const prior = await priorImportFor(userId, sourceHash, rowId);
  if (prior) {
    return {
      status: "skipped",
      reason: DRIVE_ROW_COPY.alreadyImported,
      already: true,
      contactIds: prior.contactIds ?? [],
      sourceHash,
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
    // Only the parse is checked for a key problem: a save-step error mentioning "model" or
    // "404" is this doc's problem, never the AI key's.
    const stop = keyProblem(err);
    if (stop) throw new DriveJobStop(stop);
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
    sourceHash,
    reminders: out.remindersCreated,
    interactions: out.result.participants.filter((p) => p.interactionId != null).length,
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

/** The error to fail the job with when the parse says the AI key is the problem, else null. */
function keyProblem(err: unknown): unknown {
  // No usable AI key at all (or the allowance is spent): the gate's own error, passed through
  // so `failImport` classifies it by name and stores the gate's own sentence.
  if (isAiAccessError(err)) return err;
  const kind = classifyAiError(err);
  if (kind === "auth" || kind === "quota" || kind === "model_unavailable") {
    return Object.assign(new Error(DRIVE_KEY_PROBLEM_COPY[kind]), { cause: err });
  }
  return null;
}

/** Append this row's flags to the import in one statement, so a dismissal mid-run survives. */
function appendFlagsSql(flags: NonNullable<ImportStats["flaggedCommitments"]>) {
  return sql`jsonb_set(
    coalesce(${imports.stats}, '{}'::jsonb),
    '{flaggedCommitments}',
    (
      select coalesce(jsonb_agg(t.e order by t.ord), '[]'::jsonb)
      from (
        select e, ord
        from jsonb_array_elements(
          coalesce(${imports.stats}->'flaggedCommitments', '[]'::jsonb) || ${JSON.stringify(flags)}::jsonb
        ) with ordinality as x(e, ord)
        order by ord
        limit ${MAX_STORED_FLAGS}
      ) t
    )
  )`;
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

      // Counters only. The flags list is appended in SQL (`appendFlagsSql`) and never written
      // from here, so a flag dismissed while this runs isn't put back by the next flush.
      const { flaggedCommitments: _flags, ...counters } = current.stats ?? {};
      void _flags;
      const stats: ImportStats = counters;
      // Nullable columns: `?? 0`, not destructuring defaults, which only catch undefined.
      let contactsCreated = current.contactsCreated ?? 0;
      let contactsUpdated = current.contactsUpdated ?? 0;
      let rowsProcessed = current.rowsProcessed ?? 0;
      const flushProgress = (flags?: NonNullable<ImportStats["flaggedCommitments"]>) =>
        db
          .update(imports)
          .set({
            rowsProcessed,
            contactsCreated,
            contactsUpdated,
            stats: flags?.length
              ? sql`${appendFlagsSql(flags)} || ${JSON.stringify(stats)}::jsonb`
              : sql`coalesce(${imports.stats}, '{}'::jsonb) || ${JSON.stringify(stats)}::jsonb`,
            updatedAt: new Date(),
          })
          .where(eq(imports.id, importId));

      for (const row of pending) {
        if (deps.now().getTime() - jobStart > START_ROW_DEADLINE_MS) break;
        // Per row, not only per chunk: a cancel stops after the doc being read now.
        const live = await db.query.imports.findFirst({
          where: eq(imports.id, importId),
          columns: { status: true },
        });
        if (live?.status !== "processing") return;

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

        // Started twice already and never finished: this doc kills the run (too long to parse
        // inside the ceiling, most likely). Skip it rather than loop on it forever.
        const attempts = payload.attempts ?? 0;
        let outcome: RowOutcome;
        if (attempts >= MAX_ROW_ATTEMPTS) {
          outcome = { status: "skipped", reason: DRIVE_ROW_COPY.tookTooLong };
        } else {
          const started = await db
            .update(importJobRows)
            .set({ payload: { ...payload, attempts: attempts + 1 }, updatedAt: new Date() })
            .where(and(eq(importJobRows.id, row.id), eq(importJobRows.status, "pending")))
            .returning();
          if (!started.length) continue; // another runner finished it
          try {
            outcome = await processDoc(userId, importId, row.id, payload, accessToken, deps);
          } catch (err) {
            if (err instanceof DriveJobStop) {
              // Keep what earlier rows already saved, then stop with this row pending — and
              // its attempt given back, since the doc itself was never the problem.
              await db
                .update(importJobRows)
                .set({ payload: { ...payload, attempts }, updatedAt: new Date() })
                .where(and(eq(importJobRows.id, row.id), eq(importJobRows.status, "pending")));
              await flushProgress();
              await failImport(importId, err.failure);
              return;
            }
            reportError(err, { where: "job.drive-import.row", level: "warning", extra: { importId } });
            outcome = { status: "skipped", reason: DRIVE_ROW_COPY.unreadable };
          }
        }

        if (outcome.status === "rate_limited") {
          const handoffs = (payload.rateLimitHandoffs ?? 0) + 1;
          if (handoffs <= MAX_RATE_LIMIT_HANDOFFS) {
            // Back to pending with its attempt given back: the doc was never read. A fresh
            // run picks it up; the hand-off count keeps a Drive that stays busy from looping.
            await db
              .update(importJobRows)
              .set({ payload: { ...payload, attempts, rateLimitHandoffs: handoffs }, updatedAt: new Date() })
              .where(and(eq(importJobRows.id, row.id), eq(importJobRows.status, "pending")));
            await flushProgress();
            await deps.continueLater(importId);
            return;
          }
          outcome = { status: "skipped", reason: DRIVE_ROW_COPY.busy };
        }

        const contactIds = outcome.status === "done" ? outcome.contactIds : (outcome.contactIds ?? []);
        const finished = outcome.status === "done" || Boolean(outcome.already);
        // Guarded on `pending`: if the stall cron started a second runner that finished this
        // row first, its result stands and this one neither overwrites it nor counts it.
        const claimed = await db
          .update(importJobRows)
          .set({
            // An unchanged re-import is recorded as done: it touched these people, and the
            // detail sheet should list them. Its reason is kept for the row view.
            status: finished ? "done" : "skipped",
            contactId: contactIds[0] ?? null,
            // `sourceHash` on a done row is what marks this text imported (`priorImportFor`).
            payload: {
              ...payload,
              // The skip-without-reading path never bumped it; every other path read once more.
              attempts: attempts >= MAX_ROW_ATTEMPTS ? attempts : attempts + 1,
              contactIds,
              ...(finished && outcome.sourceHash ? { sourceHash: outcome.sourceHash } : {}),
            },
            errorMessage: outcome.status === "skipped" ? truncateStoredError(outcome.reason) : null,
            updatedAt: new Date(),
          })
          .where(and(eq(importJobRows.id, row.id), eq(importJobRows.status, "pending")))
          .returning();
        if (!claimed.length) continue;

        let newFlags: NonNullable<ImportStats["flaggedCommitments"]> = [];
        if (outcome.status === "done") {
          stats.docsRead = (stats.docsRead ?? 0) + 1;
          stats.remindersCreated = (stats.remindersCreated ?? 0) + outcome.reminders;
          stats.interactionsLogged = (stats.interactionsLogged ?? 0) + outcome.interactions;
          newFlags = outcome.flags;
          contactsCreated += outcome.created;
          contactsUpdated += outcome.updated;
        } else if (outcome.already) {
          stats.docsAlreadyImported = (stats.docsAlreadyImported ?? 0) + 1;
        }
        rowsProcessed++;
        // Per row, not per chunk: this bumps `imports.updated_at`, which the stall cron reads.
        // A chunk of busy docs can outlast its 3-minute threshold and invite a second runner.
        await flushProgress(newFlags);
      }
    }

    const completed = await db
      .update(imports)
      .set({ status: "completed", updatedAt: new Date() })
      .where(and(eq(imports.id, importId), eq(imports.status, "processing")))
      .returning();
    // Capture's own follow-on: new people become searchable. Best-effort; the daily cron
    // backstops it. Briefs are deliberately not regenerated (an AI call per contact).
    if (completed.length) await deps.kickEmbeddings(userId).catch(() => {});
  } catch (err) {
    await failImport(importId, err);
  }
}
