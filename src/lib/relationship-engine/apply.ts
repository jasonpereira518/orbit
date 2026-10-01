/**
 * The relationship engine's only writer. No transactions exist on neon-http, so every write
 * is idempotent on its own key and the order is chosen so a crash part-way leaves the
 * contact PENDING (the watermark moves last): the next pass re-applies, and the hashes make
 * the second apply write nothing it already wrote.
 *
 *   action items  — unique (user_id, item_hash), actionItemHash(interactionId, text)
 *   reminders     — unique (user_id, item_hash), buildSuggestionItemHash("relationship:" + interactionId, day, title)
 *   key facts     — case/space-insensitive dedupe against what is on the contact
 *   digest        — upsert on contact_id; watermark advanced in the same statement, last
 */
// Bare `.returning()` throughout: a partial selector breaks on this repo's neon-http/PGlite split.
import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  actionItems,
  contacts,
  noteBatches,
  relationshipDigests,
  relationshipRuns,
  reminders,
  type NoteBatchResult,
  type RelationshipOpenThread,
  type RelationshipTopic,
} from "@/db/schema";
import { actionItemHash } from "@/lib/action-items";
import { detectJobChanges, loadJobBaseline, recordJobChanges } from "@/lib/job-changes";
import { emptyNoteBatchResult } from "@/lib/note-batches";
import { undoNoteBatchForUser } from "@/lib/note-batch-save";
import { getInboxListId } from "@/lib/reminder-lists";
import { buildSuggestionItemHash, isoDay } from "@/lib/suggested-reminder-utils";
import type {
  DigestWritePlan,
  MessageWindow,
  PreviousDigest,
  ValidatedDigest,
} from "@/lib/relationship-engine/types";

const JOB_CHANGE_MAX_AGE_DAYS = 90;

export type ApplyInput = {
  userId: string;
  runId: string;
  contactId: string;
  window: MessageWindow;
  validated: ValidatedDigest;
  plan: DigestWritePlan;
  now?: Date;
};

export type ApplyResult = {
  remindersCreated: number;
  actionItemsCreated: number;
  factsAdded: number;
  openThreadsAdded: number;
};

export async function ensureRunNoteBatch(userId: string, runId: string): Promise<string> {
  const db = await getDb();
  const run = await db.query.relationshipRuns.findFirst({
    where: and(eq(relationshipRuns.id, runId), eq(relationshipRuns.userId, userId)),
    columns: { noteBatchId: true },
  });
  if (run?.noteBatchId) return run.noteBatchId;
  const sourceHash = `relationship:${runId}`;
  const existing = await db.query.noteBatches.findFirst({
    where: and(eq(noteBatches.userId, userId), eq(noteBatches.sourceHash, sourceHash)),
    columns: { id: true },
  });
  const batchId =
    existing?.id ??
    (
      await db
        .insert(noteBatches)
        .values({
          userId,
          sourceHash,
          sourceText: "Relationship analysis of imported conversations",
          entryPoint: "relationship",
          anchorDate: new Date(),
          anchorBasis: "upload",
          result: emptyNoteBatchResult(),
        })
        .returning()
    )[0].id;
  await db.update(relationshipRuns).set({ noteBatchId: batchId }).where(eq(relationshipRuns.id, runId));
  return batchId;
}

export async function loadPreviousDigest(
  userId: string,
  contactId: string
): Promise<{ previous: PreviousDigest | null; threads: RelationshipOpenThread[]; openKeys: Set<string> }> {
  const db = await getDb();
  const [digest, open] = await Promise.all([
    db.query.relationshipDigests.findFirst({ where: and(eq(relationshipDigests.contactId, contactId), eq(relationshipDigests.userId, userId)) }),
    db.query.actionItems.findMany({
      where: and(eq(actionItems.userId, userId), eq(actionItems.contactId, contactId), eq(actionItems.status, "open")),
      columns: { id: true, text: true },
      limit: 20,
    }),
  ]);
  const threads = digest?.openThreads ?? [];
  const openItems = [
    ...threads.map((t) => ({ key: t.key, text: t.text })),
    ...open.map((a) => ({ key: `ai:${a.id}`, text: a.text })),
  ];
  const previous: PreviousDigest | null =
    digest || openItems.length
      ? {
          summary: digest?.summary ?? null,
          whatTheyDo: digest?.whatTheyDo ?? null,
          workingOn: digest?.workingOn ?? null,
          topics: (digest?.topics ?? []).map((t) => t.label),
          openItems,
        }
      : null;
  return { previous, threads, openKeys: new Set(openItems.map((o) => o.key)) };
}

function mergeTopics(existing: RelationshipTopic[], labels: string[], at: Date): RelationshipTopic[] {
  const byKey = new Map(existing.map((t) => [t.label.toLowerCase(), t]));
  for (const label of labels) byKey.set(label.toLowerCase(), { label, lastDiscussedAt: at.toISOString().slice(0, 10) });
  return [...byKey.values()].sort((a, b) => b.lastDiscussedAt.localeCompare(a.lastDiscussedAt)).slice(0, 12);
}

async function appendBatchResult(batchId: string, add: Pick<NoteBatchResult, "reminders" | "actionItems">) {
  if (!add.reminders.length && !add.actionItems.length) return;
  const db = await getDb();
  await db.execute(sql`
    UPDATE note_batches
       SET result = jsonb_set(
             jsonb_set(result, '{reminders}', coalesce(result->'reminders', '[]'::jsonb) || ${JSON.stringify(add.reminders)}::jsonb),
             '{actionItems}', coalesce(result->'actionItems', '[]'::jsonb) || ${JSON.stringify(add.actionItems)}::jsonb)
     WHERE id = ${batchId}::uuid
  `);
}

export async function applyDigestPlan(input: ApplyInput): Promise<ApplyResult> {
  const { userId, runId, contactId, window, validated, plan } = input;
  const now = input.now ?? new Date();
  const db = await getDb();
  const batchId = await ensureRunNoteBatch(userId, runId);
  const result: ApplyResult = { remindersCreated: 0, actionItemsCreated: 0, factsAdded: 0, openThreadsAdded: plan.newOpenThreads };

  // 1. Action items (one per planned item), then their reminders.
  const batchAdd: Pick<NoteBatchResult, "reminders" | "actionItems"> = { reminders: [], actionItems: [] };
  if (plan.actionItems.length) {
    const rows = plan.actionItems.map((a, i) => ({
      userId,
      contactId,
      interactionId: a.interactionId,
      text: a.text.slice(0, 500),
      position: i,
      status: "open" as const,
      itemHash: actionItemHash(a.interactionId, a.text),
      owedBy: a.owedBy,
    }));
    const inserted = await db
      .insert(actionItems)
      .values(rows)
      .onConflictDoNothing({ target: [actionItems.userId, actionItems.itemHash] })
      .returning();
    result.actionItemsCreated = inserted.length;
    const all = await db.query.actionItems.findMany({
      where: and(eq(actionItems.userId, userId), inArray(actionItems.itemHash, rows.map((r) => r.itemHash))),
    });
    const idByHash = new Map(all.map((a) => [a.itemHash, a.id]));

    const listId = await getInboxListId(userId);
    const reminderRows = plan.actionItems
      .map((a) => ({ a, id: idByHash.get(actionItemHash(a.interactionId, a.text))! }))
      .filter(({ a, id }) => a.reminder && id)
      .map(({ a, id }) => {
        const r = a.reminder!;
        return {
          userId,
          contactId,
          listId,
          title: r.title.slice(0, 300),
          description: null,
          dueDate: r.dueDate,
          status: "pending",
          reminderType: r.dateBasis === "window" ? "ai_suggested" : "extracted_date",
          actionKind: r.actionKind,
          createdBy: "ai",
          noteBatchId: batchId,
          sourceInteractionId: r.interactionId,
          sourceExcerpt: r.excerpt.slice(0, 500),
          rawDatePhrase: r.rawDatePhrase,
          dateBasis: r.dateBasis,
          actionItemId: id,
          origin: r.origin,
          confidenceScore: r.confidence,
          itemHash: buildSuggestionItemHash(`relationship:${r.interactionId}`, isoDay(r.dueDate), r.title),
        };
      });
    if (reminderRows.length) {
      const created = await db
        .insert(reminders)
        .values(reminderRows)
        .onConflictDoNothing({ target: [reminders.userId, reminders.itemHash] })
        .returning();
      result.remindersCreated = created.length;
      for (const r of created) {
        batchAdd.reminders.push({
          id: r.id, contactId: r.contactId, title: r.title, dueIso: isoDay(new Date(r.dueDate!)),
          dateBasis: r.dateBasis ?? "window", rawDatePhrase: r.rawDatePhrase, sourceExcerpt: r.sourceExcerpt,
        });
      }
    }
    // Link each action item to its reminder. Looked up by hash rather than taken from the
    // insert's RETURNING, so a retry after a crash between the two inserts still links an
    // item whose reminder already exists (the insert above would have skipped it).
    const reminderIdByHash = new Map<string, string>();
    if (reminderRows.length) {
      const found = await db.query.reminders.findMany({
        where: and(eq(reminders.userId, userId), inArray(reminders.itemHash, reminderRows.map((r) => r.itemHash))),
        columns: { id: true, itemHash: true },
      });
      for (const f of found) if (f.itemHash) reminderIdByHash.set(f.itemHash, f.id);
    }
    const linkedItem = new Map<string, string>();
    for (const row of reminderRows) {
      const rid = reminderIdByHash.get(row.itemHash);
      if (rid && !linkedItem.has(row.actionItemId)) {
        linkedItem.set(row.actionItemId, rid);
        await db
          .update(actionItems)
          .set({ reminderId: rid })
          .where(and(eq(actionItems.id, row.actionItemId), eq(actionItems.userId, userId), sql`${actionItems.reminderId} IS NULL`));
      }
    }
    // Every action item THIS pass created goes in the batch snapshot, reminder or not:
    // undo deletes exactly the items listed here, so an item with no due date must be listed too.
    for (const a of inserted) {
      batchAdd.actionItems.push({ id: a.id, contactId, text: a.text, reminderId: linkedItem.get(a.id) ?? null });
    }
  }
  await appendBatchResult(batchId, batchAdd);

  // 2. Close what the conversation says is done.
  if (plan.closeActionItemIds.length) {
    const done = await db
      .update(actionItems)
      .set({ status: "done", completedAt: now })
      .where(and(eq(actionItems.userId, userId), eq(actionItems.contactId, contactId), inArray(actionItems.id, plan.closeActionItemIds), eq(actionItems.status, "open")))
      .returning();
    const reminderIds = done.map((d) => d.reminderId).filter((id): id is string => Boolean(id));
    if (reminderIds.length) {
      await db
        .update(reminders)
        .set({ status: "done" })
        .where(and(eq(reminders.userId, userId), inArray(reminders.id, reminderIds), eq(reminders.status, "pending")));
    }
  }

  // 3. Contact fields: key facts, empty title/company, next follow-up.
  const contact = await db.query.contacts.findFirst({
    where: and(eq(contacts.id, contactId), eq(contacts.userId, userId)),
    columns: { keyFacts: true, title: true, company: true, nextFollowUpAt: true },
  });
  if (contact) {
    const have = new Set((contact.keyFacts ?? []).map((f) => f.trim().toLowerCase()));
    const newFacts = plan.facts.filter((f) => {
      const k = f.trim().toLowerCase();
      if (!k || have.has(k)) return false;
      have.add(k);
      return true;
    });
    result.factsAdded = newFacts.length;
    const patch: Partial<typeof contacts.$inferInsert> = {};
    if (newFacts.length) patch.keyFacts = [...(contact.keyFacts ?? []), ...newFacts];
    const jc = validated.jobChange;
    const fresh = jc && now.getTime() - jc.messageAt.getTime() <= JOB_CHANGE_MAX_AGE_DAYS * 86_400_000;
    if (jc && fresh && !contact.company?.trim()) {
      patch.company = jc.company;
      if (!contact.title?.trim() && jc.title) patch.title = jc.title;
    }
    const earliest = plan.actionItems
      .map((a) => a.reminder?.dueDate)
      .filter((d): d is Date => Boolean(d))
      .sort((a, b) => a.getTime() - b.getTime())[0];
    if (earliest && (!contact.nextFollowUpAt || earliest < contact.nextFollowUpAt)) patch.nextFollowUpAt = earliest;
    if (Object.keys(patch).length) {
      await db.update(contacts).set({ ...patch, updatedAt: now }).where(eq(contacts.id, contactId));
    }
    // A move away from a company we already know goes through the job-change log.
    if (jc && fresh && contact.company?.trim()) {
      const baseline = await loadJobBaseline(userId, contactId, now);
      const changes = detectJobChanges(baseline, [
        {
          kind: "role", organization: jc.company, title: jc.title, fieldOfStudy: null, location: null, description: null,
          startYear: jc.messageAt.getUTCFullYear(), startMonth: jc.messageAt.getUTCMonth() + 1, endYear: null, endMonth: null, isCurrent: true,
        },
      ]);
      if (changes.length) await recordJobChanges(userId, contactId, changes, { source: "messages", now });
    }
  }

  // 4. Digest + watermark, last.
  const previous = await db.query.relationshipDigests.findFirst({ where: eq(relationshipDigests.contactId, contactId) });
  const topics = mergeTopics(previous?.topics ?? [], validated.topics, window.last.at);
  const sources = [...new Set([...(previous?.sources ?? []), ...window.sources])];
  const values = {
    contactId,
    userId,
    whatTheyDo: validated.whatTheyDo ?? previous?.whatTheyDo ?? null,
    workingOn: validated.workingOn ?? previous?.workingOn ?? null,
    summary: validated.summary || previous?.summary || null,
    topics,
    openThreads: plan.openThreads,
    messageCount: (previous?.messageCount ?? 0) + window.messages.length,
    sources,
    watermarkAt: window.last.at,
    watermarkInteractionId: window.last.interactionId,
    historyTruncatedBefore: window.truncatedBefore ?? previous?.historyTruncatedBefore ?? null,
    attempts: 0,
    lastError: null,
    batchJobId: null,
    batchPendingUntil: null,
    runId,
    updatedAt: now,
  };
  await db.insert(relationshipDigests).values(values).onConflictDoUpdate({ target: relationshipDigests.contactId, set: values });

  // 5. Run counters.
  await db
    .update(relationshipRuns)
    .set({
      processed: sql`${relationshipRuns.processed} + 1`,
      remindersCreated: sql`${relationshipRuns.remindersCreated} + ${result.remindersCreated}`,
      factsAdded: sql`${relationshipRuns.factsAdded} + ${result.factsAdded}`,
      openThreadsAdded: sql`${relationshipRuns.openThreadsAdded} + ${result.openThreadsAdded}`,
      flags: plan.flags.length
        ? sql`${relationshipRuns.flags} || ${JSON.stringify(plan.flags)}::jsonb`
        : relationshipRuns.flags,
    })
    .where(eq(relationshipRuns.id, runId));

  return result;
}

/** A trivial thread: nothing to learn, but the watermark must move or it stays pending forever. */
export async function advanceWatermarkOnly(userId: string, runId: string, window: MessageWindow): Promise<void> {
  const db = await getDb();
  const previous = await db.query.relationshipDigests.findFirst({ where: eq(relationshipDigests.contactId, window.contactId) });
  const values = {
    contactId: window.contactId,
    userId,
    messageCount: (previous?.messageCount ?? 0) + window.messages.length,
    sources: [...new Set([...(previous?.sources ?? []), ...window.sources])],
    watermarkAt: window.last.at,
    watermarkInteractionId: window.last.interactionId,
    attempts: 0,
    lastError: null,
    batchJobId: null,
    batchPendingUntil: null,
    runId,
    updatedAt: new Date(),
  };
  await db.insert(relationshipDigests).values(values).onConflictDoUpdate({ target: relationshipDigests.contactId, set: values });
  await db.update(relationshipRuns).set({ skipped: sql`${relationshipRuns.skipped} + 1` }).where(eq(relationshipRuns.id, runId));
}

export async function recordDigestFailure(userId: string, contactId: string, err: unknown): Promise<void> {
  const db = await getDb();
  const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
  await db
    .insert(relationshipDigests)
    .values({ contactId, userId, attempts: 1, lastError: message, batchJobId: null, batchPendingUntil: null })
    .onConflictDoUpdate({
      target: relationshipDigests.contactId,
      set: { attempts: sql`${relationshipDigests.attempts} + 1`, lastError: message, batchJobId: null, batchPendingUntil: null, updatedAt: new Date() },
    });
}

/**
 * Undo a run: capture's batch undo dismisses its pending reminders; the run's still-open
 * action items are deleted (they were never confirmed by a person). Digest text and appended
 * key facts stay — descriptive, not actionable — exactly as capture's undo leaves people
 * and interactions behind.
 */
export async function undoRelationshipRun(
  userId: string,
  runId: string
): Promise<{ remindersDismissed: number; actionItemsRemoved: number }> {
  const db = await getDb();
  const run = await db.query.relationshipRuns.findFirst({ where: and(eq(relationshipRuns.id, runId), eq(relationshipRuns.userId, userId)) });
  if (!run) throw new Error("Run not found");
  if (run.status === "undone" || !run.noteBatchId) {
    await db.update(relationshipRuns).set({ status: "undone" }).where(eq(relationshipRuns.id, runId));
    return { remindersDismissed: 0, actionItemsRemoved: 0 };
  }
  const batch = await db.query.noteBatches.findFirst({ where: eq(noteBatches.id, run.noteBatchId) });
  const { remindersDismissed } = await undoNoteBatchForUser(userId, run.noteBatchId);
  const ids = (batch?.result.actionItems ?? []).map((a) => a.id);
  let actionItemsRemoved = 0;
  if (ids.length) {
    const removed = await db
      .delete(actionItems)
      .where(and(eq(actionItems.userId, userId), inArray(actionItems.id, ids), eq(actionItems.status, "open")))
      .returning();
    actionItemsRemoved = removed.length;
  }
  await db.update(relationshipRuns).set({ status: "undone", finishedAt: new Date() }).where(eq(relationshipRuns.id, runId));
  return { remindersDismissed, actionItemsRemoved };
}

/** Exported for tests that need a run without the runner. */
export function newClaimToken(): string {
  return randomUUID();
}

/** Stable hash of a string — used by the runner for batch custom ids. */
export function shortHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 12);
}
