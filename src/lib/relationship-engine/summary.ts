/**
 * What one relationship run did, for the import sheet, the /imports card and the bell.
 * User-scoped on every read: the run, its batch's reminders with names, flag names,
 * truncated and parked counts, and while the run is active the people still to read: pending
 * contacts plus this run's contacts out in a batch (the pending count leaves those out).
 */
import { and, desc, eq, gt, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts, relationshipDigests, relationshipRuns, reminders, type RelationshipRunRow, type RelationshipRunStatus } from "@/db/schema";
import { pendingRelationshipContactCount } from "@/lib/relationship-engine/pending";
import { runSummaryCopy, type RunSummary } from "@/lib/relationship-engine/summary-copy";

export * from "@/lib/relationship-engine/summary-copy";

const ACTIVE: RelationshipRunStatus[] = ["queued", "running", "waiting_key"];
const PARKED_ATTEMPTS = 3;
const NOTICE_DAYS = 3;

async function build(userId: string, run: RelationshipRunRow, now: Date): Promise<RunSummary> {
  const db = await getDb();
  const flagContactIds = [...new Set(run.flags.map((f) => f.contactId))];
  const active = ACTIVE.includes(run.status);
  const [reminderRows, flagNames, truncated, parked, pending, inFlight] = await Promise.all([
    run.noteBatchId
      ? db
          .select({ id: reminders.id, title: reminders.title, dueDate: reminders.dueDate, contactId: reminders.contactId, contactName: contacts.fullName, status: reminders.status })
          .from(reminders)
          .leftJoin(contacts, eq(contacts.id, reminders.contactId))
          .where(and(eq(reminders.userId, userId), eq(reminders.noteBatchId, run.noteBatchId)))
          .orderBy(desc(reminders.dueDate))
          .limit(20)
      : Promise.resolve([]),
    flagContactIds.length
      ? db.select({ id: contacts.id, name: contacts.fullName }).from(contacts).where(and(eq(contacts.userId, userId), inArray(contacts.id, flagContactIds)))
      : Promise.resolve([]),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(relationshipDigests)
      .where(and(eq(relationshipDigests.userId, userId), eq(relationshipDigests.runId, run.id), isNotNull(relationshipDigests.historyTruncatedBefore))),
    db
      .select({ contactId: relationshipDigests.contactId, name: contacts.fullName })
      .from(relationshipDigests)
      .innerJoin(contacts, eq(contacts.id, relationshipDigests.contactId))
      .where(and(eq(relationshipDigests.userId, userId), gte(relationshipDigests.attempts, PARKED_ATTEMPTS), gte(relationshipDigests.updatedAt, run.createdAt)))
      .limit(5),
    active ? pendingRelationshipContactCount(userId, now) : Promise.resolve(0),
    active
      ? db
          .select({ n: sql<number>`count(*)::int` })
          .from(relationshipDigests)
          .where(and(eq(relationshipDigests.userId, userId), eq(relationshipDigests.runId, run.id), gt(relationshipDigests.batchPendingUntil, now)))
      : Promise.resolve([{ n: 0 }]),
  ]);
  const remaining = pending + Number(inFlight[0]?.n ?? 0);
  const nameOf = new Map(flagNames.map((c) => [c.id, c.name]));
  return {
    id: run.id,
    importId: run.importId,
    status: run.status,
    processed: run.processed,
    skipped: run.skipped,
    failed: run.failed,
    remindersCreated: run.remindersCreated,
    openThreadsAdded: run.openThreadsAdded,
    factsAdded: run.factsAdded,
    remaining,
    reminders: reminderRows.map((r) => ({
      id: r.id, title: r.title, contactId: r.contactId, contactName: r.contactName, status: r.status,
      dueIso: r.dueDate ? r.dueDate.toISOString().slice(0, 10) : null,
    })),
    flags: run.flags.map((f) => ({ ...f, contactName: nameOf.get(f.contactId) ?? "Someone" })),
    truncatedPeople: Number(truncated[0]?.n ?? 0),
    parkedPeople: parked.map((p) => ({ contactId: p.contactId, name: p.name })),
    createdAt: run.createdAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    undoable: (run.status === "done" || run.status === "failed") && !!run.noteBatchId,
  };
}

export async function loadRunSummary(userId: string, runId: string, now: Date = new Date()): Promise<RunSummary | null> {
  const db = await getDb();
  const run = await db.query.relationshipRuns.findFirst({ where: and(eq(relationshipRuns.id, runId), eq(relationshipRuns.userId, userId)) });
  return run ? build(userId, run, now) : null;
}

export async function loadLatestRunSummary(userId: string, now: Date = new Date()): Promise<RunSummary | null> {
  const db = await getDb();
  const run = await db.query.relationshipRuns.findFirst({ where: eq(relationshipRuns.userId, userId), orderBy: desc(relationshipRuns.createdAt) });
  return run ? build(userId, run, now) : null;
}

export async function loadImportRunSummary(userId: string, importId: string, now: Date = new Date()): Promise<RunSummary | null> {
  const db = await getDb();
  const run = await db.query.relationshipRuns.findFirst({
    where: and(eq(relationshipRuns.userId, userId), eq(relationshipRuns.importId, importId)),
    orderBy: desc(relationshipRuns.createdAt),
  });
  return run ? build(userId, run, now) : null;
}

/** The bell's one-line summary of the latest run. One statement: counters come off the row. */
export async function latestRunNotice(userId: string, now: Date = new Date()) {
  const db = await getDb();
  const run = await db.query.relationshipRuns.findFirst({ where: eq(relationshipRuns.userId, userId), orderBy: desc(relationshipRuns.createdAt) });
  if (!run || run.status === "undone") return undefined;
  const active = ACTIVE.includes(run.status);
  if (!active && (!run.finishedAt || now.getTime() - run.finishedAt.getTime() > NOTICE_DAYS * 86_400_000)) return undefined;
  const { headline } = runSummaryCopy({
    id: run.id, importId: run.importId, status: run.status,
    processed: run.processed, skipped: run.skipped, failed: run.failed,
    remindersCreated: run.remindersCreated, openThreadsAdded: run.openThreadsAdded, factsAdded: run.factsAdded,
    remaining: 0, reminders: [], flags: [], truncatedPeople: 0, parkedPeople: [],
    createdAt: run.createdAt.toISOString(), finishedAt: run.finishedAt?.toISOString() ?? null, undoable: false,
  });
  return { runId: run.id, headline, status: run.status };
}
