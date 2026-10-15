import { and, desc, eq, ne, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { captureJobs, cloudNoteFiles } from "@/db/schema";
import { runCaptureJobById } from "@/lib/capture-job-runner";
import { createCaptureJob, kickCaptureJob } from "@/lib/capture-jobs";
import { cloudAccessToken, readFileText, type CloudCtx, type CloudFile, type CloudProvider } from "@/lib/cloud-files";
import { DriveFileTooLargeError, DriveFileUnavailableError, DriveNotAuthorizedError, DriveRateLimitedError } from "@/lib/drive";
import { ReauthRequiredError, UserFacingError } from "@/lib/errors";
import { hashSourceNote } from "@/lib/suggested-reminder-utils";

/**
 * Cloud docs into capture jobs. Each doc becomes its own reviewable job under one batch id, so
 * the queue panel shows the set like any multi-file drop — extracting never saves anything to
 * contacts on its own; the person reviews the cards.
 */

export type CaptureFromTextOutcome =
  | { status: "queued"; jobId: string }
  /** This exact text was captured before; nothing new was queued. */
  | { status: "duplicate"; jobId: string };

/** The newest live capture of this exact text, if any. */
export async function priorCaptureOf(userId: string, sourceHash: string): Promise<string | null> {
  const db = await getDb();
  const [row] = await db
    .select({ id: captureJobs.id })
    .from(captureJobs)
    .where(and(eq(captureJobs.userId, userId), eq(captureJobs.sourceHash, sourceHash), ne(captureJobs.status, "discarded")))
    .orderBy(desc(captureJobs.updatedAt))
    .limit(1);
  return row?.id ?? null;
}

/**
 * One doc's text as a queued capture job — or the job that already captured it. The caller
 * starts the run, so a batch can queue everything first. Shared with the Google Picker path
 * in `actions/capture-drive.ts`.
 */
export async function createCaptureFromText(
  userId: string,
  input: { text: string; label: string; batchGroupId: string; force?: boolean },
): Promise<CaptureFromTextOutcome> {
  // `source_hash` is written by the parse over the corpus it read, which for a plain doc is this text.
  if (!input.force) {
    const prior = await priorCaptureOf(userId, hashSourceNote(input.text));
    if (prior) return { status: "duplicate", jobId: prior };
  }
  const row = await createCaptureJob(userId, {
    sourceKind: "messy",
    status: "queued",
    inputText: input.text,
    batchGroupId: input.batchGroupId,
    sourceLabel: input.label.slice(0, 200),
  });
  return { status: "queued", jobId: row.id };
}

/** Every way a drive says no, worded for the person. Anything unrecognised is rethrown. */
export function cloudReadError(err: unknown, provider: CloudProvider): UserFacingError {
  const drive = provider === "google" ? "Google Drive" : "OneDrive";
  if (err instanceof UserFacingError) return err;
  if (err instanceof ReauthRequiredError) return new UserFacingError(`Reconnect ${drive} so Orbit can read your notes`);
  if (err instanceof DriveFileTooLargeError) return new UserFacingError("That doc is too long to read in one go");
  if (err instanceof DriveNotAuthorizedError) return new UserFacingError(`${drive} didn’t let Orbit open that file`);
  if (err instanceof DriveRateLimitedError) return new UserFacingError(`${drive} asked Orbit to slow down — try again in a minute`);
  if (err instanceof DriveFileUnavailableError) return new UserFacingError("That file is gone or can’t be opened");
  throw err;
}

export type CloudExtractResult = {
  queued: { fileId: string; jobId: string }[];
  duplicates: { fileId: string; jobId: string }[];
  failed: { fileId: string; name: string; message: string }[];
};

export type ExtractFile = Pick<CloudFile, "id" | "name"> & Partial<Pick<CloudFile, "webUrl" | "modifiedTime">>;

/**
 * Read each doc and queue it as a capture job, recording the doc as `queued` so the scan and
 * the panel stop offering it. A dead grant fails the whole batch (one reconnect fixes all of
 * it); any other per-file failure is reported and the rest carry on. Does not start the runs —
 * `startCaptureRuns` does, from the caller's `after()`.
 */
export async function extractCloudFiles(
  userId: string,
  input: { provider: CloudProvider; files: readonly ExtractFile[]; batchGroupId: string },
  deps: { ctx?: CloudCtx } = {},
): Promise<CloudExtractResult> {
  const { provider } = input;
  let ctx = deps.ctx;
  if (!ctx) {
    try {
      ctx = { token: await cloudAccessToken(userId, provider) };
    } catch (err) {
      throw cloudReadError(err, provider);
    }
  }
  const result: CloudExtractResult = { queued: [], duplicates: [], failed: [] };
  const db = await getDb();

  // Three reads at a time: a drive answers in about a second each, and 25 in series would sit
  // on the action for half a minute.
  const queue = [...input.files];
  async function worker(ctx: CloudCtx) {
    for (let file = queue.shift(); file; file = queue.shift()) {
      let text: string;
      try {
        text = await readFileText(ctx, provider, file);
      } catch (err) {
        if (err instanceof ReauthRequiredError) throw cloudReadError(err, provider);
        result.failed.push({ fileId: file.id, name: file.name, message: cloudReadError(err, provider).message });
        continue;
      }
      if (!text.trim()) {
        result.failed.push({ fileId: file.id, name: file.name, message: `“${file.name}” is empty` });
        continue;
      }
      const outcome = await createCaptureFromText(userId, { text, label: file.name, batchGroupId: input.batchGroupId });
      (outcome.status === "queued" ? result.queued : result.duplicates).push({ fileId: file.id, jobId: outcome.jobId });
      await db
        .insert(cloudNoteFiles)
        .values({
          userId,
          provider,
          fileId: file.id,
          name: file.name.slice(0, 300),
          webUrl: file.webUrl ?? null,
          modifiedAt: file.modifiedTime ? new Date(file.modifiedTime) : null,
          status: "queued",
          detectedBy: "picked",
          captureJobId: outcome.jobId,
        })
        .onConflictDoUpdate({
          target: [cloudNoteFiles.userId, cloudNoteFiles.provider, cloudNoteFiles.fileId],
          set: { status: "queued", captureJobId: outcome.jobId, updatedAt: sql`now()` },
        });
    }
  }
  await Promise.all([worker(ctx), worker(ctx), worker(ctx)]);
  return result;
}

/**
 * Start each queued job in its own invocation — the internal run route has 300s per job, where
 * one `after()` running ten parses would share the calling request's budget. A kick that cannot
 * reach the route runs in place; the stall sweep backstops both.
 */
export async function startCaptureRuns(jobIds: readonly string[]): Promise<void> {
  await Promise.all(jobIds.map((id) => kickCaptureJob(id).catch(() => runCaptureJobById(id).catch(() => null))));
}
