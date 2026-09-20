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
  discardCaptureBatchRows,
  discardCaptureJobRow,
  failCaptureJob,
  findActiveCaptureJob,
  findActiveCaptureJobs,
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
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { MentionPick } from "@/lib/mentions/mention-picks";
import type {
  CaptureDecision,
  CaptureDecisions,
  CaptureOpportunityChoices,
  CaptureReminderChoices,
  CaptureJobSource,
} from "@/lib/capture/types";
import { actionFailure } from "@/lib/action-failure";

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
 * Every job still reachable, for the multi-file queue. Bounded, because a page that renders
 * one row per job must not be handed an unbounded list.
 */
export async function getActiveCaptureJobs(limit = 25): Promise<CaptureJobView[]> {
  const userId = await requireUserId();
  const rows = await findActiveCaptureJobs(userId, Math.min(Math.max(1, limit), 50));
  return rows.map(toCaptureJobView);
}

/**
 * Discard a whole multi-file drop.
 *
 * Takes the batch id rather than "everything open" so Start over on one queue cannot throw
 * away a single capture the person left in another tab.
 */
export async function discardCaptureBatch(
  batchGroupId: string
): Promise<{ ok: true; discarded: number } | Fail> {
  try {
    const userId = await requireUserId();
    if (typeof batchGroupId !== "string" || !batchGroupId.trim()) {
      return { ok: false, error: "That batch is no longer open" };
    }
    const discarded = await discardCaptureBatchRows(userId, batchGroupId.trim());
    revalidatePath("/capture");
    return { ok: true, discarded };
  } catch (err) {
    return { ok: false, error: friendlyError(err, "Couldn’t discard those captures — try again?") };
  }
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
    return { ok: false, error: await actionFailure(err, "Couldn’t check on that capture — try again?", "capture-jobs.get-capture-job") };
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
  sourceKind: CaptureJobSource;
  entryPoint?: "capture" | "profile";
  seedContactId?: string | null;
  meetingSessionId?: string | null;
  /** Set when this job is one file of a multi-file drop. Suspends the discard rule below. */
  batchGroupId?: string | null;
  sourceLabel?: string | null;
  mentionPicks?: MentionPick[] | null;
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
          mentionPicks: input.mentionPicks ?? undefined,
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
      //
      // Suspended for a multi-file drop, and ONLY for one. The rule exists because a lone
      // Extract has no way back to the cards it displaced — there is no list of them. A
      // batch does: `CaptureQueuePanel` renders every job in the group and can open any of
      // them, so the twelve meeting notes somebody just uploaded are exactly what this
      // would otherwise delete eleven of.
      if (!input.batchGroupId) {
        const db = await getDb();
        await db
          .update(captureJobs)
          .set({ status: "discarded", updatedAt: new Date() })
          .where(
            and(
              eq(captureJobs.userId, userId),
              inArray(captureJobs.status, ["ready", "reviewing", "failed", "transcribed"]),
              // A row that carries its OWN `batchGroupId` is exempt too, not just this call's
              // incoming one: a multi-file drop's leftover cards, or a note the public API
              // enqueued (src/app/api/v1/notes/route.ts gives every job it creates a
              // single-item batchGroupId for exactly this), are not the lone orphan this rule
              // exists to clear away — `CaptureQueuePanel` can always get back to them. This
              // was previously missing, which meant EVERY job in these statuses was
              // discarded by a bare Extract regardless of its own group.
              isNull(captureJobs.batchGroupId)
            )
          );
      }
      row = await createCaptureJob(userId, {
        sourceKind: input.sourceKind,
        status: "queued",
        inputText: text,
        inputHints: input.hints ?? null,
        entryPoint: input.entryPoint,
        seedContactId: input.seedContactId,
        meetingSessionId: input.meetingSessionId,
        batchGroupId: input.batchGroupId ?? null,
        sourceLabel: input.sourceLabel ?? null,
        mentionPicks: input.mentionPicks ?? null,
      });
    }
    kick(row.id);
    return { ok: true, job: toCaptureJobView(row) };
  } catch (err) {
    return { ok: false, error: await actionFailure(err, "Couldn’t start reading those notes — try again?", "capture-jobs.queue-capture-job") };
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
    return { ok: false, error: await actionFailure(err, "Couldn’t save that decision — it’ll be asked again", "capture-jobs.record-capture-decision") };
  }
}

/** The summary's ticks: which dated commitments and meeting items become reminders. */
export async function recordCaptureChoices(
  jobId: string,
  choices: {
    reminders?: CaptureReminderChoices;
    meeting?: CaptureDecisions["meeting"];
    opportunities?: CaptureOpportunityChoices;
  }
): Promise<Ok | Fail> {
  try {
    const userId = await requireUserId();
    const row = await recordCaptureChoicesRow(userId, jobId, choices);
    if (!row) return { ok: false, error: "That capture is no longer open for review" };
    return { ok: true, job: toCaptureJobView(row) };
  } catch (err) {
    return { ok: false, error: await actionFailure(err, "Couldn’t save that choice — try again?", "capture-jobs.record-capture-choices") };
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
    return { ok: false, error: await actionFailure(err, "Couldn’t save those people — try again?", "capture-jobs.save-capture-job") };
  }
}

export async function discardCaptureJob(jobId: string): Promise<{ ok: true } | Fail> {
  try {
    const userId = await requireUserId();
    await discardCaptureJobRow(userId, jobId);
    revalidatePath("/capture");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: await actionFailure(err, "Couldn’t clear that capture — try again?", "capture-jobs.discard-capture-job") };
  }
}
