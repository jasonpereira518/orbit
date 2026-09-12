/**
 * The capture job's storage: creating rows, claiming them for a runner, recording card
 * decisions, and the view the client renders. Auth-free — `src/actions/capture-jobs.ts`
 * adds `requireUserId()` and scopes everything by user.
 *
 * Every state change is one guarded UPDATE. There are no transactions on neon-http, so
 * "claim then write the outcome" is two statements that can interleave with another
 * runner's; the `claim_token` is what makes the second statement safe — only the holder's
 * outcome lands, the other runner's UPDATE matches zero rows.
 */
import { and, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { getDb } from "@/db";
import { captureJobs } from "@/db/schema";
import type { CaptureParseHints } from "@/lib/ai";
import {
  ACTIVE_CAPTURE_JOB_STATUSES,
  type CaptureDecision,
  type CaptureDecisions,
  type CaptureIngestedBlock,
  type CaptureJobResult,
  type CaptureJobStatus,
  type CaptureReminderChoices,
  type CaptureSourceKind,
} from "@/lib/capture/types";

export type CaptureJobRow = typeof captureJobs.$inferSelect;

/**
 * How long a runner may hold a claim before the next reader or the sweep may take it. The
 * two-pass parse is a handful of sequential model calls, each bounded by `aiSignal`; a
 * save is a contact write per person. Four minutes covers both with room.
 */
export const CAPTURE_CLAIM_STALE_MS = 4 * 60 * 1000;
/** A queued job nobody picked up in this long lost its kick (preview → prod, a crash). */
export const CAPTURE_QUEUE_STALE_MS = 30 * 1000;
/** Backstop resumes before the sweep gives up on a job. */
export const MAX_CAPTURE_STALL_RESUMES = 3;
/** Terminal rows are kept this long for the receipt link, then swept. */
export const CAPTURE_JOB_RETENTION_DAYS = 30;

/** A job that failed this recently is still shown on /capture so the person sees why. */
const FAILED_VISIBLE_MS = 24 * 60 * 60 * 1000;

const CAPTURE_INPUT_MAX_CHARS = 100_000;

// ---------------------------------------------------------------------------------------
// The client's view

/** What the /capture page renders from. Text and structure only — nothing a client could misuse. */
export type CaptureJobView = {
  id: string;
  status: CaptureJobStatus;
  sourceKind: CaptureSourceKind;
  entryPoint: "capture" | "profile";
  seedContactId: string | null;
  inputText: string | null;
  blocks: CaptureIngestedBlock[];
  sources: string[];
  transcriptionEngine: string | null;
  meetingSessionId: string | null;
  result: CaptureJobResult | null;
  decisions: CaptureDecisions;
  noteBatchId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export function toCaptureJobView(row: CaptureJobRow): CaptureJobView {
  return {
    id: row.id,
    status: row.status,
    sourceKind: row.sourceKind,
    entryPoint: row.entryPoint,
    seedContactId: row.seedContactId,
    inputText: row.inputText,
    blocks: row.ingestedBlocks ?? [],
    sources: row.sources ?? [],
    transcriptionEngine: row.transcriptionEngine,
    meetingSessionId: row.meetingSessionId,
    result: row.result ?? null,
    decisions: row.decisions ?? {},
    noteBatchId: row.noteBatchId,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------------------
// Reads

export async function getCaptureJobRow(userId: string, id: string): Promise<CaptureJobRow | null> {
  const db = await getDb();
  const row = await db.query.captureJobs.findFirst({
    where: and(eq(captureJobs.id, id), eq(captureJobs.userId, userId)),
  });
  return row ?? null;
}

/** Loaded by the runner, which has the id and no user. */
export async function getCaptureJobById(id: string): Promise<CaptureJobRow | null> {
  const db = await getDb();
  const row = await db.query.captureJobs.findFirst({ where: eq(captureJobs.id, id) });
  return row ?? null;
}

/**
 * The job the /capture page should resume: the newest one still in flight, or one that
 * failed recently (so the error is seen once, with a way to start over).
 */
export async function findActiveCaptureJob(userId: string, now = new Date()): Promise<CaptureJobRow | null> {
  const db = await getDb();
  const row = await db.query.captureJobs.findFirst({
    where: and(
      eq(captureJobs.userId, userId),
      or(
        inArray(captureJobs.status, [...ACTIVE_CAPTURE_JOB_STATUSES]),
        and(eq(captureJobs.status, "failed"), gt(captureJobs.updatedAt, new Date(now.getTime() - FAILED_VISIBLE_MS)))
      )
    ),
    orderBy: [desc(captureJobs.updatedAt)],
  });
  return row ?? null;
}

// ---------------------------------------------------------------------------------------
// Creating and feeding

export type CreateCaptureJobInput = {
  sourceKind: CaptureSourceKind;
  status: Extract<CaptureJobStatus, "ingesting" | "transcribed" | "queued">;
  inputText?: string | null;
  inputHints?: CaptureParseHints | null;
  entryPoint?: "capture" | "profile";
  seedContactId?: string | null;
  meetingSessionId?: string | null;
  result?: CaptureJobResult | null;
};

export async function createCaptureJob(userId: string, input: CreateCaptureJobInput): Promise<CaptureJobRow> {
  const db = await getDb();
  const [row] = await db
    .insert(captureJobs)
    .values({
      userId,
      sourceKind: input.sourceKind,
      status: input.status,
      inputText: clipInput(input.inputText),
      inputHints: input.inputHints ?? {},
      entryPoint: input.entryPoint ?? "capture",
      seedContactId: input.seedContactId ?? null,
      meetingSessionId: input.meetingSessionId ?? null,
      result: input.result ?? null,
    })
    .returning();
  return row!;
}

function clipInput(text: string | null | undefined): string | null {
  const t = text?.trim();
  if (!t) return null;
  return t.length > CAPTURE_INPUT_MAX_CHARS ? t.slice(0, CAPTURE_INPUT_MAX_CHARS) : t;
}

/** Append transcribed media to a job that is still collecting (`ingesting`). */
export async function appendIngestedBlocks(
  id: string,
  blocks: CaptureIngestedBlock[],
  extra: { sources?: string[]; transcriptionEngine?: string | null } = {}
): Promise<void> {
  if (!blocks.length) return;
  const db = await getDb();
  await db
    .update(captureJobs)
    .set({
      ingestedBlocks: sql`coalesce(${captureJobs.ingestedBlocks}, '[]'::jsonb) || ${JSON.stringify(blocks)}::jsonb`,
      sources: sql`coalesce(${captureJobs.sources}, '[]'::jsonb) || ${JSON.stringify(extra.sources ?? [])}::jsonb`,
      ...(extra.transcriptionEngine ? { transcriptionEngine: extra.transcriptionEngine } : {}),
      updatedAt: new Date(),
    })
    .where(eq(captureJobs.id, id));
}

/** Media is all in; the person can now read the transcript and press Extract. */
export async function markCaptureJobTranscribed(id: string): Promise<void> {
  const db = await getDb();
  await db
    .update(captureJobs)
    .set({ status: "transcribed", error: null, updatedAt: new Date() })
    .where(and(eq(captureJobs.id, id), eq(captureJobs.status, "ingesting")));
}

/**
 * Extract pressed. From `transcribed` (edited text replaces the input) or a fresh row.
 * Returns the row when it moved to `queued`, null when it was in no state to.
 */
export async function queueCaptureJobRow(
  userId: string,
  id: string,
  input: { inputText?: string | null; inputHints?: CaptureParseHints | null }
): Promise<CaptureJobRow | null> {
  const db = await getDb();
  const [row] = await db
    .update(captureJobs)
    .set({
      status: "queued",
      ...(input.inputText !== undefined ? { inputText: clipInput(input.inputText) } : {}),
      ...(input.inputHints ? { inputHints: input.inputHints } : {}),
      error: null,
      claimToken: null,
      claimedAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(captureJobs.id, id),
        eq(captureJobs.userId, userId),
        inArray(captureJobs.status, ["transcribed", "ingesting", "failed"])
      )
    )
    .returning();
  return row ?? null;
}

// ---------------------------------------------------------------------------------------
// Claims

export function newClaimToken(): string {
  return randomBytes(12).toString("hex");
}

/**
 * Take ownership of a job for one phase. Succeeds from the phase's entry status, from the
 * phase's own status when nobody holds a token yet (`saveCaptureJob` moves the row to
 * `saving` before it kicks, so the runner arrives to a row already in its phase), or when
 * the previous holder went quiet for `CAPTURE_CLAIM_STALE_MS`.
 */
export async function claimCaptureJob(
  id: string,
  phase: "extracting" | "saving",
  opts: { now?: Date; staleMs?: number } = {}
): Promise<{ row: CaptureJobRow; token: string } | null> {
  const now = opts.now ?? new Date();
  const stale = new Date(now.getTime() - (opts.staleMs ?? CAPTURE_CLAIM_STALE_MS));
  const token = newClaimToken();
  const from: CaptureJobStatus[] = phase === "extracting" ? ["queued"] : ["ready", "reviewing", "failed"];
  const db = await getDb();
  const [row] = await db
    .update(captureJobs)
    .set({ status: phase, claimToken: token, claimedAt: now, updatedAt: now, error: null })
    .where(
      and(
        eq(captureJobs.id, id),
        or(
          inArray(captureJobs.status, from),
          and(eq(captureJobs.status, phase), isNull(captureJobs.claimToken)),
          and(eq(captureJobs.status, phase), lt(captureJobs.updatedAt, stale))
        )
      )
    )
    .returning();
  return row ? { row, token } : null;
}

/** Keep the claim fresh between model calls so the sweep does not take it mid-parse. */
export async function heartbeatCaptureJob(id: string, token: string): Promise<void> {
  const db = await getDb();
  await db
    .update(captureJobs)
    .set({ updatedAt: new Date() })
    .where(and(eq(captureJobs.id, id), eq(captureJobs.claimToken, token)));
}

/** Write a phase's outcome — only if we still hold the claim. Returns whether it landed. */
export async function settleCaptureJob(
  id: string,
  token: string,
  patch: Partial<Pick<CaptureJobRow, "status" | "result" | "sourceText" | "sourceHash" | "noteBatchId" | "error">>
): Promise<boolean> {
  const db = await getDb();
  // A settled phase releases its claim, so the next phase's claim never depends on the
  // caller remembering to clear it.
  const releases = patch.status && patch.status !== "extracting" && patch.status !== "saving";
  const rows = await db
    .update(captureJobs)
    .set({ ...patch, ...(releases ? { claimToken: null } : {}), updatedAt: new Date() })
    .where(and(eq(captureJobs.id, id), eq(captureJobs.claimToken, token)))
    .returning();
  return rows.length > 0;
}

// ---------------------------------------------------------------------------------------
// Decisions

/**
 * One card decided (or, with `decision: null`, un-decided by Back). Atomic and
 * idempotent: the people map is merged in SQL, so two tabs deciding different cards both
 * land, and the same card decided twice is last-writer-wins. Refused unless the job is
 * open for review.
 */
export async function recordCaptureDecisionRow(
  userId: string,
  id: string,
  personKey: string,
  decision: CaptureDecision | null
): Promise<CaptureJobRow | null> {
  const db = await getDb();
  const people = decision
    ? sql`coalesce(${captureJobs.decisions}->'people', '{}'::jsonb) || ${JSON.stringify({ [personKey]: decision })}::jsonb`
    : sql`coalesce(${captureJobs.decisions}->'people', '{}'::jsonb) - ${personKey}::text`;
  const [row] = await db
    .update(captureJobs)
    .set({
      decisions: sql`coalesce(${captureJobs.decisions}, '{}'::jsonb) || jsonb_build_object('people', ${people})`,
      status: "reviewing",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(captureJobs.id, id),
        eq(captureJobs.userId, userId),
        inArray(captureJobs.status, ["ready", "reviewing"])
      )
    )
    .returning();
  return row ?? null;
}

/** The summary's non-person choices: which dated commitments and meeting items to keep. */
export async function recordCaptureChoicesRow(
  userId: string,
  id: string,
  choices: { reminders?: CaptureReminderChoices; meeting?: CaptureDecisions["meeting"] }
): Promise<CaptureJobRow | null> {
  const patch: Record<string, unknown> = {};
  if (choices.reminders) patch.reminders = choices.reminders;
  if (choices.meeting) patch.meeting = choices.meeting;
  if (!Object.keys(patch).length) return getCaptureJobRow(userId, id);
  const db = await getDb();
  const [row] = await db
    .update(captureJobs)
    .set({
      decisions: sql`coalesce(${captureJobs.decisions}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
      status: "reviewing",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(captureJobs.id, id),
        eq(captureJobs.userId, userId),
        inArray(captureJobs.status, ["ready", "reviewing"])
      )
    )
    .returning();
  return row ?? null;
}

export async function discardCaptureJobRow(userId: string, id: string): Promise<boolean> {
  const db = await getDb();
  const rows = await db
    .update(captureJobs)
    .set({ status: "discarded", updatedAt: new Date() })
    .where(
      and(
        eq(captureJobs.id, id),
        eq(captureJobs.userId, userId),
        inArray(captureJobs.status, [...ACTIVE_CAPTURE_JOB_STATUSES, "failed"])
      )
    )
    .returning();
  return rows.length > 0;
}

// ---------------------------------------------------------------------------------------
// Stalls

/** Whether a read of this row should re-kick the runner (the primary safety net). */
export function captureJobLooksStuck(row: Pick<CaptureJobRow, "status" | "updatedAt">, now = new Date()): boolean {
  const age = now.getTime() - row.updatedAt.getTime();
  if (row.status === "queued") return age > CAPTURE_QUEUE_STALE_MS;
  if (row.status === "extracting" || row.status === "saving") return age > CAPTURE_CLAIM_STALE_MS;
  return false;
}

export async function bumpCaptureStallResumes(id: string): Promise<number> {
  const db = await getDb();
  const [row] = await db
    .update(captureJobs)
    .set({ stallResumes: sql`${captureJobs.stallResumes} + 1` })
    .where(eq(captureJobs.id, id))
    .returning();
  return row?.stallResumes ?? 0;
}

export async function failCaptureJob(id: string, message: string): Promise<void> {
  const db = await getDb();
  await db
    .update(captureJobs)
    .set({ status: "failed", error: message, claimToken: null, updatedAt: new Date() })
    .where(eq(captureJobs.id, id));
}

export type CaptureStallSweepResult = { found: number; resumed: number; resumeFailed: number; gaveUp: number; swept: number };

/**
 * The cron backstop, a copy of `resumeStalledImports`: pick up jobs that went quiet, a
 * bounded number of times, and purge terminal rows past their retention.
 */
export async function resumeStalledCaptureJobs(options: {
  now?: Date;
  thresholdMs?: number;
  maxResumes?: number;
  runner: (id: string) => Promise<unknown>;
}): Promise<CaptureStallSweepResult> {
  const now = options.now ?? new Date();
  const threshold = options.thresholdMs ?? CAPTURE_CLAIM_STALE_MS;
  const maxResumes = options.maxResumes ?? MAX_CAPTURE_STALL_RESUMES;
  const db = await getDb();

  const stalled = await db.query.captureJobs.findMany({
    where: and(
      inArray(captureJobs.status, ["queued", "extracting", "saving"]),
      lt(captureJobs.updatedAt, new Date(now.getTime() - threshold))
    ),
    columns: { id: true },
  });

  const result: CaptureStallSweepResult = { found: stalled.length, resumed: 0, resumeFailed: 0, gaveUp: 0, swept: 0 };
  for (const job of stalled) {
    const resumes = await bumpCaptureStallResumes(job.id);
    if (resumes > maxResumes) {
      await failCaptureJob(job.id, "Reading those notes stalled a few times and gave up — try extracting again.");
      result.gaveUp += 1;
      continue;
    }
    try {
      await options.runner(job.id);
      result.resumed += 1;
    } catch {
      result.resumeFailed += 1;
    }
  }

  const cutoff = new Date(now.getTime() - CAPTURE_JOB_RETENTION_DAYS * 86_400_000);
  const swept = await db
    .delete(captureJobs)
    .where(and(inArray(captureJobs.status, ["saved", "failed", "discarded"]), lt(captureJobs.updatedAt, cutoff)))
    .returning();
  result.swept = swept.length;
  return result;
}
