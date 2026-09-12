"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { requireUserId } from "@/lib/auth";
import { friendlyError } from "@/lib/errors";
import { RATE_LIMITS, consumeBucket } from "@/lib/rate-limit";
import type { CaptureParseHints } from "@/lib/ai";
import {
  bumpCaptureStallResumes,
  captureJobLooksStuck,
  createCaptureJob,
  discardCaptureJobRow,
  failCaptureJob,
  findActiveCaptureJob,
  getCaptureJobRow,
  MAX_CAPTURE_STALL_RESUMES,
  queueCaptureJobRow,
  recordCaptureChoicesRow,
  recordCaptureDecisionRow,
  toCaptureJobView,
  type CaptureJobView,
} from "@/lib/capture-jobs";
import { runCaptureJobById } from "@/lib/capture-job-runner";
import { getDb } from "@/db";
import { captureJobs } from "@/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import type {
  CaptureDecision,
  CaptureReminderChoices,
  CaptureSourceKind,
} from "@/lib/capture/types";

/**
 * The /capture page's contract with its durable job. Every export is async (one non-async
 * export breaks every export in a "use server" file), every result is data rather than a
 * throw (so the message survives production builds), and every read is scoped by user.
 *
 * The heavy work — parsing, saving — never runs inside these: they move the row and hand
 * it to `runCaptureJobById` in `after()`, so the request returns at once and the job
 * outlives the tab. Media uploads take the route at `/api/capture/jobs` instead, because
 * a server action would have to carry the bytes as base64 and would block the page's
 * other actions while transcribing.
 */

type Fail = { ok: false; error: string };
type Ok = { ok: true; job: CaptureJobView };

function kick(id: string) {
  after(() => runCaptureJobById(id).catch(() => null));
}

/** What the page hydrates from. `null` means "show the input UI". */
export async function getActiveCaptureJob(): Promise<CaptureJobView | null> {
  const userId = await requireUserId();
  const row = await findActiveCaptureJob(userId);
  return row ? toCaptureJobView(row) : null;
}

/**
 * The poll. `unchanged` when nothing moved since the client's copy, so the 1.5 s cadence
 * costs one indexed read and no payload. A stuck row is re-kicked from here — the person
 * looking at the page is the fastest resumer there is, and `internalFetch` from a preview
 * deployment lands on production, so this is the safety net that always works.
 */
export async function getCaptureJob(
  id: string,
  sinceUpdatedAt?: string | null
): Promise<Ok | { ok: true; unchanged: true } | Fail> {
  try {
    const userId = await requireUserId();
    const row = await getCaptureJobRow(userId, id);
    if (!row) return { ok: false, error: "That capture no longer exists" };
    if (captureJobLooksStuck(row)) {
      const resumes = await bumpCaptureStallResumes(row.id);
      if (resumes > MAX_CAPTURE_STALL_RESUMES) {
        await failCaptureJob(row.id, "Reading those notes stalled a few times and gave up — try extracting again.");
      } else {
        kick(row.id);
      }
    }
    if (sinceUpdatedAt && row.updatedAt.toISOString() === sinceUpdatedAt) {
      return { ok: true, unchanged: true };
    }
    return { ok: true, job: toCaptureJobView(row) };
  } catch (err) {
    return { ok: false, error: friendlyError(err, "Couldn’t check on that capture — try again?") };
  }
}

/**
 * Extract pressed. Creates the row for text-only input, or queues the job a media upload
 * already created (the edited transcript replaces what was transcribed). Rate-limited
 * here, in request scope — never in the runner.
 */
export async function queueCaptureJob(input: {
  jobId?: string | null;
  text: string;
  hints?: CaptureParseHints | null;
  sourceKind: CaptureSourceKind;
  entryPoint?: "capture" | "profile";
  seedContactId?: string | null;
  meetingSessionId?: string | null;
}): Promise<Ok | Fail> {
  try {
    const userId = await requireUserId();
    await consumeBucket("capture", userId, RATE_LIMITS.capture);
    const text = input.text.trim();
    if (!text && !input.jobId) return { ok: false, error: "Notes are required" };

    let row = input.jobId
      ? await queueCaptureJobRow(userId, input.jobId, {
          // An edited transcript supersedes the transcribed blocks: the corpus becomes the
          // text as the person left it, not the text plus what it was edited from.
          inputText: text || null,
          inputHints: input.hints ?? undefined,
        })
      : null;
    if (input.jobId && row) {
      // The transcript now lives in `input_text`; the blocks would double it.
      const db = await getDb();
      await db
        .update(captureJobs)
        .set({ ingestedBlocks: [] })
        .where(and(eq(captureJobs.id, row.id), eq(captureJobs.userId, userId)));
    }
    if (!row) {
      if (!text) return { ok: false, error: "Notes are required" };
      // Only one capture is in review at a time: a second Extract while one is waiting
      // would leave orphaned cards nobody can get back to.
      const db = await getDb();
      await db
        .update(captureJobs)
        .set({ status: "discarded", updatedAt: new Date() })
        .where(and(eq(captureJobs.userId, userId), inArray(captureJobs.status, ["ready", "reviewing", "failed", "transcribed"])));
      row = await createCaptureJob(userId, {
        sourceKind: input.sourceKind,
        status: "queued",
        inputText: text,
        inputHints: input.hints ?? null,
        entryPoint: input.entryPoint,
        seedContactId: input.seedContactId,
        meetingSessionId: input.meetingSessionId,
      });
    }
    kick(row.id);
    return { ok: true, job: toCaptureJobView(row) };
  } catch (err) {
    return { ok: false, error: friendlyError(err, "Couldn’t start reading those notes — try again?") };
  }
}

/** One card decided; `null` is Back. Idempotent per (job, person). */
export async function recordCaptureDecision(
  jobId: string,
  personKey: string,
  decision: CaptureDecision | null
): Promise<Ok | Fail> {
  try {
    const userId = await requireUserId();
    const row = await recordCaptureDecisionRow(userId, jobId, personKey, decision);
    if (!row) return { ok: false, error: "That capture is no longer open for review" };
    return { ok: true, job: toCaptureJobView(row) };
  } catch (err) {
    return { ok: false, error: friendlyError(err, "Couldn’t save that decision — it’ll be asked again") };
  }
}

/** The summary's ticks: which dated commitments and meeting items become reminders. */
export async function recordCaptureChoices(
  jobId: string,
  choices: { reminders?: CaptureReminderChoices; meeting?: { extraReminderKeys: string[] } }
): Promise<Ok | Fail> {
  try {
    const userId = await requireUserId();
    const row = await recordCaptureChoicesRow(userId, jobId, choices);
    if (!row) return { ok: false, error: "That capture is no longer open for review" };
    return { ok: true, job: toCaptureJobView(row) };
  } catch (err) {
    return { ok: false, error: friendlyError(err, "Couldn’t save that choice — try again?") };
  }
}

/**
 * Save pressed. Moves the row to `saving` and kicks the runner; a double-click, a second
 * tab or a reload mid-save all find the row already moved and simply return it.
 */
export async function saveCaptureJob(jobId: string): Promise<Ok | Fail> {
  try {
    const userId = await requireUserId();
    const db = await getDb();
    const [moved] = await db
      .update(captureJobs)
      .set({ status: "saving", error: null, claimToken: null, updatedAt: new Date() })
      .where(
        and(
          eq(captureJobs.id, jobId),
          eq(captureJobs.userId, userId),
          inArray(captureJobs.status, ["ready", "reviewing", "failed"])
        )
      )
      .returning();
    const row = moved ?? (await getCaptureJobRow(userId, jobId));
    if (!row) return { ok: false, error: "That capture no longer exists" };
    if (moved) {
      if (!moved.result) {
        await failCaptureJob(moved.id, "Extract people before saving");
        return { ok: false, error: "Extract people before saving" };
      }
      kick(moved.id);
      revalidatePath("/capture");
      revalidatePath("/contacts");
      revalidatePath("/reminders");
    }
    return { ok: true, job: toCaptureJobView(moved ?? row) };
  } catch (err) {
    return { ok: false, error: friendlyError(err, "Couldn’t save those people — try again?") };
  }
}

export async function discardCaptureJob(jobId: string): Promise<{ ok: true } | Fail> {
  try {
    const userId = await requireUserId();
    await discardCaptureJobRow(userId, jobId);
    revalidatePath("/capture");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: friendlyError(err, "Couldn’t clear that capture — try again?") };
  }
}
