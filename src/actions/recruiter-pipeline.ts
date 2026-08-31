"use server";

import { and, desc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import {
  recruiterOpportunities,
  recruiterScanFindings,
  recruiterThreads,
} from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import { requireSyncUser } from "@/lib/plan-guards";
import {
  applyThreadFinding,
  recordVerdict,
  type ThreadFinding,
} from "@/lib/recruiter-opportunities";
import {
  STAGE_LABELS,
  isRecruiterStage,
  type RecruiterStage,
} from "@/lib/recruiter-stages";

/**
 * Read and review surface for the hiring pipeline the Gmail scan builds.
 *
 * Every export here is async — a single non-async export in a "use server" file breaks every
 * export in it, and TypeScript will not tell you.
 */

/** No activity for this long and a process is shown as stale. Derived, never stored. */
const STALE_AFTER_DAYS = 21;

export type PipelineOpportunity = {
  id: string;
  companyName: string;
  stage: RecruiterStage;
  stageLabel: string;
  stageEvidence: string | null;
  roles: string[];
  summary: string | null;
  nextStep: string | null;
  threadCount: number;
  confidence: number;
  lastActivityAt: string | null;
  /** Derived from `lastActivityAt`, so it is never stale itself. */
  isStale: boolean;
};

export type PendingFinding = {
  id: string;
  gmailThreadId: string;
  subject: string;
  company: string | null;
  correspondent: string | null;
  stage: RecruiterStage | null;
  stageLabel: string | null;
  /** The quote the stage was read from — what makes this reviewable at a glance. */
  stageEvidence: string | null;
  summary: string | null;
  confidence: number;
  createdAt: string;
};

function toOpportunity(
  row: typeof recruiterOpportunities.$inferSelect
): PipelineOpportunity {
  const stage: RecruiterStage = isRecruiterStage(row.stage)
    ? row.stage
    : "outreach_received";
  const last = row.lastActivityAt;
  return {
    id: row.id,
    companyName: row.companyName,
    stage,
    stageLabel: STAGE_LABELS[stage],
    stageEvidence: row.stageEvidence,
    roles: row.roles ?? [],
    summary: row.summary,
    nextStep: row.nextStep,
    threadCount: row.threadCount,
    confidence: row.confidence,
    lastActivityAt: last ? last.toISOString() : null,
    isStale:
      Boolean(last) &&
      stage !== "rejected" &&
      stage !== "withdrawn" &&
      Date.now() - (last as Date).getTime() > STALE_AFTER_DAYS * 86_400_000,
  };
}

export async function listOpportunities(): Promise<PipelineOpportunity[]> {
  const userId = await requireUserId();
  const db = await getDb();
  const rows = await db.query.recruiterOpportunities.findMany({
    where: eq(recruiterOpportunities.userId, userId),
    orderBy: [desc(recruiterOpportunities.lastActivityAt)],
  });
  return rows.map(toOpportunity);
}

/** Threads behind one process, newest first — the per-opportunity timeline. */
export async function listOpportunityThreads(opportunityId: string) {
  const userId = await requireUserId();
  const db = await getDb();
  const rows = await db.query.recruiterThreads.findMany({
    where: and(
      eq(recruiterThreads.userId, userId),
      eq(recruiterThreads.opportunityId, opportunityId)
    ),
    orderBy: [desc(recruiterThreads.lastMessageAt)],
  });
  return rows.map((r) => ({
    id: r.id,
    gmailThreadId: r.gmailThreadId,
    subject: r.subject,
    direction: r.direction,
    senderKind: r.senderKind,
    messageCount: r.messageCount,
    userReplied: r.userReplied === 1,
    stage: r.stageAtThread,
    lastMessageAt: r.lastMessageAt ? r.lastMessageAt.toISOString() : null,
  }));
}

export async function listPendingFindings(): Promise<PendingFinding[]> {
  const userId = await requireUserId();
  const db = await getDb();
  const rows = await db.query.recruiterScanFindings.findMany({
    where: and(
      eq(recruiterScanFindings.userId, userId),
      eq(recruiterScanFindings.status, "pending")
    ),
    orderBy: [desc(recruiterScanFindings.confidence)],
  });

  return rows.map((row) => {
    const p = row.payload as Partial<ThreadFinding>;
    const stage = typeof p.stage === "string" && isRecruiterStage(p.stage) ? p.stage : null;
    return {
      id: row.id,
      gmailThreadId: row.gmailThreadId,
      subject: typeof p.subject === "string" ? p.subject : "(no subject)",
      company: p.hiringCompany ?? p.recruiterFirm ?? null,
      correspondent: p.correspondentName ?? p.correspondentEmail ?? null,
      stage,
      stageLabel: stage ? STAGE_LABELS[stage] : null,
      stageEvidence: p.stageEvidence ?? null,
      summary: p.summary ?? null,
      confidence: row.confidence,
      createdAt: row.createdAt.toISOString(),
    };
  });
}

export async function countPendingFindings(): Promise<number> {
  const userId = await requireUserId();
  const db = await getDb();
  const rows = await db.query.recruiterScanFindings.findMany({
    where: and(
      eq(recruiterScanFindings.userId, userId),
      eq(recruiterScanFindings.status, "pending")
    ),
    columns: { id: true },
  });
  return rows.length;
}

/**
 * Applies a queued finding.
 *
 * Goes through the same `applyThreadFinding` the automatic path uses — deliberately one code
 * path, because two would drift and this is the one nobody exercises until it is wrong.
 */
export async function approveFinding(findingId: string): Promise<void> {
  const userId = await requireSyncUser();
  const db = await getDb();

  const row = await db.query.recruiterScanFindings.findFirst({
    where: and(
      eq(recruiterScanFindings.id, findingId),
      eq(recruiterScanFindings.userId, userId)
    ),
  });
  if (!row) throw new Error("Finding not found.");
  if (row.status !== "pending") return;

  const payload = row.payload as unknown as ThreadFinding;
  await applyThreadFinding(userId, {
    ...payload,
    // Dates survive the jsonb round trip as strings; the writer expects Date or null.
    firstMessageAt: payload.firstMessageAt ? new Date(payload.firstMessageAt) : null,
    lastMessageAt: payload.lastMessageAt ? new Date(payload.lastMessageAt) : null,
  });

  await db
    .update(recruiterScanFindings)
    .set({ status: "approved", appliedAt: new Date(), updatedAt: new Date() })
    .where(eq(recruiterScanFindings.id, findingId));

  revalidatePath("/recruiters");
}

/**
 * Dismisses a queued finding, and remembers the sender as not a recruiter.
 *
 * The verdict is the point: rejecting here trains the filter, so a sender dismissed once is
 * never classified again at this prompt version rather than reappearing every scan.
 */
export async function rejectFinding(findingId: string): Promise<void> {
  const userId = await requireSyncUser();
  const db = await getDb();

  const row = await db.query.recruiterScanFindings.findFirst({
    where: and(
      eq(recruiterScanFindings.id, findingId),
      eq(recruiterScanFindings.userId, userId)
    ),
  });
  if (!row) throw new Error("Finding not found.");

  const payload = row.payload as Partial<ThreadFinding>;
  if (payload.correspondentEmail) {
    await recordVerdict(userId, payload.correspondentEmail, "not_recruiter", 0);
  }

  await db
    .update(recruiterScanFindings)
    .set({ status: "rejected", updatedAt: new Date() })
    .where(eq(recruiterScanFindings.id, findingId));

  revalidatePath("/recruiters");
}
