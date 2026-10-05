"use server";

/**
 * Google Drive into /capture: one picked Doc or Slides deck becomes one capture job.
 *
 * The /imports Drive flow reads a doc and SAVES it with no review — right for a folder of
 * old notes, wrong for the capture page, whose whole point is the review cards. So this
 * shares the reading (`exportDriveFileText` on the stored grant, the same readiness check
 * and the same browser-only `drive.file` Picker token) and hands the text to a capture job
 * instead, under the batch id the browser minted for this pick. The queue panel then shows
 * the docs like any other multi-file drop.
 *
 * One file per call, on purpose. The browser runs a few at a time, the way the notes
 * fan-out does, so each job's extraction gets its own `after()` — one call that queued
 * twenty-five docs would put twenty-five parses behind a single request's time budget.
 */
import { after } from "next/server";
import { and, desc, eq, ne } from "drizzle-orm";
import { getDb } from "@/db";
import { captureJobs } from "@/db/schema";
import { runCaptureJobById } from "@/lib/capture-job-runner";
import { createCaptureJob } from "@/lib/capture-jobs";
import { isDemoWorkspace } from "@/lib/demo-workspace";
import {
  DriveFileTooLargeError,
  DriveFileUnavailableError,
  DriveNotAuthorizedError,
  DriveRateLimitedError,
  exportDriveFileText,
} from "@/lib/drive";
import { asActionResult, ReauthRequiredError, UserFacingError, type ActionResult } from "@/lib/errors";
import { getValidAccessToken } from "@/lib/gmail";
import { DRIVE_MIME, type PickedDriveFile } from "@/lib/imports/drive-triage";
import { requireSyncUser } from "@/lib/plan-guards";
import { RATE_LIMITS, consumeBucket } from "@/lib/rate-limit";
import { hashSourceNote } from "@/lib/suggested-reminder-utils";

export type DriveCaptureOutcome =
  | { status: "queued"; jobId: string }
  /** This exact text was captured before; nothing new was queued. */
  | { status: "duplicate"; jobId: string };

const DRIVE_ID = /^[A-Za-z0-9_-]{10,200}$/;
const ALLOWED_MIME = new Set<string>(Object.values(DRIVE_MIME));

export async function queueDriveCapture(input: {
  file: PickedDriveFile;
  batchGroupId: string;
  /** Capture it again even though the same text was captured before. */
  force?: boolean;
}): Promise<ActionResult<DriveCaptureOutcome>> {
  // Outside the wrap for the reason `startDriveImport` gives: a plan denial is a
  // `PaywallError`, which `asActionResult` returns as data anyway.
  const userId = await requireSyncUser();
  return asActionResult(async () => {
    const { file } = input;
    // Browser-supplied: the id goes into a Google URL and the name onto the job.
    if (!DRIVE_ID.test(file?.id ?? "") || !ALLOWED_MIME.has(file?.mimeType ?? "")) {
      throw new UserFacingError("Pick a Google Doc or Slides deck to capture");
    }
    if (typeof input.batchGroupId !== "string" || !/^[\w-]{8,64}$/.test(input.batchGroupId)) {
      throw new UserFacingError("Couldn’t start that — try picking the files again");
    }
    if (await isDemoWorkspace(userId)) {
      throw new UserFacingError("Google Drive isn’t connected in the demo workspace");
    }
    await consumeBucket("capture", userId, RATE_LIMITS.capture);

    const text = await readDoc(userId, file.id);
    if (!text.trim()) throw new UserFacingError(`“${file.name}” is empty`);

    // The same doc picked twice — or the same text captured some other way — is not read
    // again. `source_hash` is written by the parse, over the corpus it read, which for a
    // plain doc is this text.
    if (!input.force) {
      const prior = await priorCaptureOf(userId, hashSourceNote(text));
      if (prior) return { status: "duplicate", jobId: prior };
    }

    const row = await createCaptureJob(userId, {
      sourceKind: "messy",
      status: "queued",
      inputText: text,
      batchGroupId: input.batchGroupId,
      sourceLabel: file.name.slice(0, 200),
    });
    after(() => runCaptureJobById(row.id).catch(() => null));
    return { status: "queued", jobId: row.id };
  });
}

/** Export the doc as text, with every way Google says no worded for the person. */
async function readDoc(userId: string, fileId: string): Promise<string> {
  try {
    const token = await getValidAccessToken(userId);
    return await exportDriveFileText(token, fileId);
  } catch (err) {
    if (err instanceof ReauthRequiredError) {
      throw new UserFacingError("Google needs you to reconnect before Orbit can read that — try Drive again");
    }
    if (err instanceof DriveFileTooLargeError) throw new UserFacingError("That doc is too long to read in one go");
    if (err instanceof DriveNotAuthorizedError) {
      throw new UserFacingError("Orbit wasn’t given access to that file — pick it again from Drive");
    }
    if (err instanceof DriveRateLimitedError) throw new UserFacingError("Google asked Orbit to slow down — try again in a minute");
    if (err instanceof DriveFileUnavailableError) throw new UserFacingError("That file is gone or can’t be opened");
    throw err;
  }
}

async function priorCaptureOf(userId: string, sourceHash: string): Promise<string | null> {
  const db = await getDb();
  const [row] = await db
    .select({ id: captureJobs.id })
    .from(captureJobs)
    .where(
      and(
        eq(captureJobs.userId, userId),
        eq(captureJobs.sourceHash, sourceHash),
        ne(captureJobs.status, "discarded")
      )
    )
    .orderBy(desc(captureJobs.updatedAt))
    .limit(1);
  return row?.id ?? null;
}
