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
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import {
  actionItems,
  contacts,
  interactions,
  noteBatches,
  relationshipDigests,
  relationshipRuns,
  reminders,
  type NoteBatchResult,
  type RelationshipKindRecord,
  type RelationshipOpenThread,
  type RelationshipOrigin,
  type RelationshipTopic,
} from "@/db/schema";
import { actionItemHash } from "@/lib/action-items";
import { stableHash } from "@/lib/linkedin-timeline-events";
import { AI_DERIVED_SOURCE } from "@/lib/touch-kinds";
import { HOW_MET_IMPORT_LABELS, type FieldSources } from "@/lib/contact-fields";
import { emptyNoteBatchResult } from "@/lib/note-batches";
import { ORIGIN_CHECKED, messageRowSql } from "@/lib/relationship-engine/pending";
import { undoNoteBatchForUser } from "@/lib/note-batch-save";
import { getInboxListId } from "@/lib/reminder-lists";
import { buildSuggestionItemHash, isoDay } from "@/lib/suggested-reminder-utils";
import type {
  DigestWritePlan,
  MessageWindow,
  PreviousDigest,
  ValidatedDigest,
} from "@/lib/relationship-engine/types";

export type ApplyInput = {
  userId: string;
  runId: string;
  contactId: string;
  window: MessageWindow;
  validated: ValidatedDigest;
  plan: DigestWritePlan;
  now?: Date;
  /** LinkedIn deep read: the pass read invitation/recommendation rows too, and writes origin, kind and events. */
  deepRead?: boolean;
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
  if (run?.noteBatchId) {
    const stored = await db.query.noteBatches.findFirst({
      where: and(eq(noteBatches.id, run.noteBatchId), eq(noteBatches.userId, userId)),
      columns: { status: true },
    });
    if (stored?.status === "saved") return run.noteBatchId;
    // Undone or deleted out from under the run: new writes need a live batch, or their
    // reminders would point at a record Undo no longer reaches.
  }
  const sourceHash = `relationship:${runId}`;
  const existing = await db.query.noteBatches.findFirst({
    where: and(eq(noteBatches.userId, userId), eq(noteBatches.sourceHash, sourceHash), eq(noteBatches.status, "saved")),
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
      // The 20 most recent: deterministic, and what new messages are most likely to close.
      orderBy: [desc(actionItems.createdAt), desc(actionItems.id)],
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

/**
 * Whether the deep read may write how you met over what a contact holds: only over a blank or
 * an importer's label (`HOW_MET_IMPORT_LABELS`), and never once the person set it themselves
 * (`field_sources.met`, stamped by `updateContactForUser`). Words a capture wrote are neither,
 * so they hold too.
 */
export function canReplaceMet(c: { howMet: string | null; fieldSources: FieldSources | null }): boolean {
  if (c.fieldSources?.met?.s === "user") return false;
  const howMet = c.howMet?.trim() ?? "";
  return !howMet || HOW_MET_IMPORT_LABELS.has(howMet);
}

/** Noon UTC, so no timezone shows the day before. */
const noonOf = (day: string) => new Date(`${day}T12:00:00Z`);
function endOfMonth(firstOfMonth: string): Date {
  const d = new Date(`${firstOfMonth}T00:00:00Z`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - 1);
}

/**
 * Deep read: the events the reader quoted, as `ai_derived` timeline rows, and on a contact's
 * first pass the old reader's rule-based first reach-out, under the very id the old reader wrote
 * (`li-event:<contactId>:reach_out:<hash>`), so nobody it already covered gets a second one.
 * The old reader's event ids hash its own wording, so a new event is also skipped when the
 * contact already has an ai_derived row of that type on that day.
 */
async function writeDeepReadTimeline(
  userId: string,
  contactId: string,
  events: NonNullable<ValidatedDigest["events"]>,
  firstPass: boolean
): Promise<void> {
  const db = await getDb();
  const rows: (typeof interactions.$inferInsert)[] = [];
  if (events.length) {
    const have = await db.query.interactions.findMany({
      where: and(eq(interactions.userId, userId), eq(interactions.contactId, contactId), eq(interactions.source, AI_DERIVED_SOURCE)),
      columns: { interactionType: true, interactionDate: true },
    });
    const seen = new Set(have.map((h) => `${h.interactionType}|${h.interactionDate.toISOString().slice(0, 10)}`));
    for (const e of events) {
      const key = `${e.type}|${e.day}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        userId,
        contactId,
        interactionType: e.type,
        interactionDate: noonOf(e.day),
        source: AI_DERIVED_SOURCE,
        externalId: `li-event:${contactId}:${e.type}:${e.day}`,
        rawNotes: e.excerpt.slice(0, 500),
        aiSummary: e.summary,
        topics: [],
      });
    }
  }
  if (firstPass) {
    const [first] = rowsOf<{ raw_notes: string; interaction_date: Date | string }>(
      await db.execute(sql`
        SELECT raw_notes, interaction_date FROM interactions
         WHERE user_id = ${userId} AND contact_id = ${contactId}::uuid
           AND interaction_type = 'linkedin_message' AND btrim(coalesce(raw_notes, '')) <> ''
         ORDER BY interaction_date ASC, id ASC
         LIMIT 1
      `)
    );
    const content = first?.raw_notes.trim();
    if (content) {
      rows.push({
        userId,
        contactId,
        interactionType: "reach_out",
        interactionDate: new Date(first.interaction_date),
        source: AI_DERIVED_SOURCE,
        externalId: `li-event:${contactId}:reach_out:${stableHash(content.slice(0, 80))}`,
        rawNotes: content,
        aiSummary: `Initial LinkedIn reach-out: ${content.slice(0, 140)}`,
        topics: [],
      });
    }
  }
  if (rows.length) await db.insert(interactions).values(rows).onConflictDoNothing();
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
  let passItemIds: string[] = [];
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
    passItemIds = all.map((a) => a.id);

    // An item gets a reminder once. The mandated hash includes the due DAY, and undated due
    // dates are clamped to "tomorrow", so a retry on another day would hash differently and
    // insert a second reminder (even over one the person dismissed). So: any reminder row
    // already pointing at the item, in any status, blocks a new one.
    const existingForItems = await db.query.reminders.findMany({
      where: and(eq(reminders.userId, userId), inArray(reminders.actionItemId, passItemIds)),
      columns: { id: true, actionItemId: true },
    });
    const hasReminder = new Set(existingForItems.map((r) => r.actionItemId));
    const reminderOfItem = new Map<string, string>();
    for (const r of existingForItems) if (r.actionItemId && !reminderOfItem.has(r.actionItemId)) reminderOfItem.set(r.actionItemId, r.id);
    for (const a of all) if (a.reminderId) hasReminder.add(a.id);

    const listId = await getInboxListId(userId);
    const reminderRows = plan.actionItems
      .map((a) => ({ a, id: idByHash.get(actionItemHash(a.interactionId, a.text))! }))
      .filter(({ a, id }) => a.reminder && id && !hasReminder.has(id))
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
    // Two planned items for one action item (same hash) would collide on the insert; first wins.
    const seenItem = new Set<string>();
    const uniqueRows = reminderRows.filter((r) => (seenItem.has(r.actionItemId) ? false : (seenItem.add(r.actionItemId), true)));
    if (uniqueRows.length) {
      const created = await db
        .insert(reminders)
        .values(uniqueRows)
        .onConflictDoNothing({ target: [reminders.userId, reminders.itemHash] })
        .returning();
      result.remindersCreated = created.length;
      for (const r of created) {
        if (r.actionItemId) reminderOfItem.set(r.actionItemId, r.id);
        batchAdd.reminders.push({
          id: r.id, contactId: r.contactId, title: r.title, dueIso: isoDay(new Date(r.dueDate!)),
          dateBasis: r.dateBasis ?? "window", rawDatePhrase: r.rawDatePhrase, sourceExcerpt: r.sourceExcerpt,
        });
      }
    }
    // Link items to their reminder (also repairs a crash between the two inserts).
    for (const a of all) {
      const rid = reminderOfItem.get(a.id);
      if (rid && !a.reminderId) {
        a.reminderId = rid;
        await db
          .update(actionItems)
          .set({ reminderId: rid })
          .where(and(eq(actionItems.id, a.id), eq(actionItems.userId, userId), sql`${actionItems.reminderId} IS NULL`));
      }
    }

  }

  // Sweep: snapshot every open, engine-anchored action item of this contact created since
  // the run started that the batch does not list yet. Contact-wide and independent of this
  // call's plan: after a crash between the insert and the snapshot, a retry whose regenerated
  // plan words items differently (or has none) would otherwise never see the orphan, and undo
  // would miss it. "Engine-anchored" = its interaction is a message row, so items a person or
  // capture made on a note/meeting during the run are never snapshotted (and never undo-deleted).
  const [runRow, batchRow] = await Promise.all([
    db.query.relationshipRuns.findFirst({ where: eq(relationshipRuns.id, runId), columns: { createdAt: true } }),
    db.query.noteBatches.findFirst({ where: eq(noteBatches.id, batchId), columns: { result: true } }),
  ]);
  if (runRow) {
    const listed = new Set((batchRow?.result.actionItems ?? []).map((x) => x.id));
    const swept = await db.execute(sql`
      SELECT a.id, a.text, a.reminder_id AS "reminderId"
        FROM action_items a
        JOIN interactions m ON m.id = a.interaction_id AND m.user_id = a.user_id
       WHERE a.user_id = ${userId}
         AND a.contact_id = ${contactId}::uuid
         AND a.status = 'open'
         AND a.created_at >= ${runRow.createdAt.toISOString()}::timestamptz
         AND ${messageRowSql({ deepRead: input.deepRead ?? false, signals: "trigger" })}
    `);
    const sweptRows = rowsOf<{ id: string; text: string; reminderId: string | null }>(swept);
    const have = new Set(batchAdd.actionItems.map((x) => x.id));
    for (const r of sweptRows) {
      if (listed.has(r.id) || have.has(r.id)) continue;
      batchAdd.actionItems.push({ id: r.id, contactId, text: r.text, reminderId: r.reminderId ?? null });
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
        // Dated like every other completion path; no `followup_completed` event, because a
        // note saying it was done is the engine inferring, not the person completing it.
        .set({ status: "done", completedAt: now })
        .where(and(eq(reminders.userId, userId), inArray(reminders.id, reminderIds), eq(reminders.status, "pending")));
    }
  }

  // 3. Contact fields: key facts and next follow-up.
  // Deferred in P1: no title/company write and no job-change log from messages, even when
  // validated.jobChange is set. Title/company are fingerprinted (identity matching) fields and
  // the spec contradicts itself on whether the engine may fill them; pending an owner decision.
  const contact = await db.query.contacts.findFirst({
    where: and(eq(contacts.id, contactId), eq(contacts.userId, userId)),
    columns: { keyFacts: true, nextFollowUpAt: true },
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
    // From reminders that actually exist for this pass's items, not from planned dates.
    const live = passItemIds.length
      ? await db.query.reminders.findMany({
          where: and(eq(reminders.userId, userId), inArray(reminders.actionItemId, passItemIds), eq(reminders.status, "pending")),
          columns: { dueDate: true },
        })
      : [];
    const earliest = live
      .map((r) => r.dueDate)
      .filter((d): d is Date => Boolean(d))
      .sort((a, b) => a.getTime() - b.getTime())[0];
    if (earliest && (!contact.nextFollowUpAt || earliest < contact.nextFollowUpAt)) patch.nextFollowUpAt = earliest;
    if (Object.keys(patch).length) {
      await db.update(contacts).set({ ...patch, updatedAt: now }).where(eq(contacts.id, contactId));
    }
  }

  // 3b. Deep read: how you met. The first origin found wins; the contact's met fields take it
  // only over an import label or a blank (`canReplaceMet`), and what they held is kept for Undo.
  const previous = await db.query.relationshipDigests.findFirst({ where: eq(relationshipDigests.contactId, contactId) });
  let origin: RelationshipOrigin | null = previous?.origin ?? null;
  let relationship: RelationshipKindRecord | null = previous?.relationship ?? null;
  if (input.deepRead) {
    const found = validated.origin ?? null;
    if (found && !origin) {
      const row = await db.query.contacts.findFirst({
        where: and(eq(contacts.id, contactId), eq(contacts.userId, userId)),
        columns: { howMet: true, dateMet: true, metContext: true, fieldSources: true, firstInteractionAt: true },
      });
      let replaced: RelationshipOrigin["replaced"] = null;
      if (row && canReplaceMet(row)) {
        replaced = { howMet: row.howMet ?? null, dateMet: row.dateMet?.toISOString() ?? null, metContext: row.metContext ?? null };
        const patch: Partial<typeof contacts.$inferInsert> = { howMet: found.text, updatedAt: now };
        // Over an import label the three were all the importer's; over a blank how-met, a date
        // or context already there was someone's own, so those only fill in.
        const imported = Boolean(row.howMet?.trim());
        if (found.context && (imported || !row.metContext)) patch.metContext = found.context;
        // A month or a year is not a day: date_met (shown as a day everywhere) takes days only.
        if (found.precision === "day" && found.date && (imported || !row.dateMet)) patch.dateMet = noonOf(found.date);
        const widen =
          found.date && found.precision === "day" ? noonOf(found.date) : found.date && found.precision === "month" ? endOfMonth(found.date) : null;
        if (widen && (!row.firstInteractionAt || widen < row.firstInteractionAt)) {
          patch.firstInteractionAt = widen;
          replaced.firstInteractionAt = row.firstInteractionAt?.toISOString() ?? null;
          replaced.widenedTo = widen.toISOString();
        }
        await db.update(contacts).set(patch).where(and(eq(contacts.id, contactId), eq(contacts.userId, userId)));
      }
      origin = { ...found, runId, replaced };
    }
    const kind = validated.relationship ?? null;
    if (kind && !relationship?.removed) relationship = { kind: kind.kind, excerpt: kind.excerpt, interactionId: kind.interactionId };
  }
  if (input.deepRead) await writeDeepReadTimeline(userId, contactId, validated.events ?? [], !previous?.watermarkAt);

  // 4. Digest + watermark, last.
  const topics = mergeTopics(previous?.topics ?? [], validated.topics, window.last.at);
  // Same newest message as the stored watermark: this window was already counted.
  const replay = previous?.watermarkInteractionId === window.last.interactionId;
  // A deep first pass read the opening and the signals, so the one-time origin pass owes nothing.
  const firstDeep = Boolean(input.deepRead) && !previous?.watermarkAt;
  const sources = [...new Set([...(previous?.sources ?? []), ...window.sources, ...(firstDeep ? [ORIGIN_CHECKED] : [])])];
  const values = {
    contactId,
    userId,
    whatTheyDo: validated.whatTheyDo ?? previous?.whatTheyDo ?? null,
    workingOn: validated.workingOn ?? previous?.workingOn ?? null,
    summary: validated.summary || previous?.summary || null,
    topics,
    openThreads: plan.openThreads,
    messageCount: replay ? (previous?.messageCount ?? 0) : (previous?.messageCount ?? 0) + window.messages.length,
    sources,
    watermarkAt: window.last.at,
    watermarkInteractionId: window.last.interactionId,
    historyTruncatedBefore: window.truncatedBefore ?? previous?.historyTruncatedBefore ?? null,
    attempts: 0,
    lastError: null,
    batchJobId: null,
    batchPendingUntil: null,
    runId,
    origin,
    relationship,
    updatedAt: now,
  };
  await saveDigest(values);

  // 5. Run counters (not again for a replayed window).
  if (!replay) await db
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

/**
 * The digest upsert. `values.relationship` comes from a row read earlier in the pass, so a
 * "Not right?" landing in between must not be written over: a removed kind already on the row stays.
 */
export async function saveDigest(values: typeof relationshipDigests.$inferInsert): Promise<void> {
  const db = await getDb();
  await db
    .insert(relationshipDigests)
    .values(values)
    .onConflictDoUpdate({
      target: relationshipDigests.contactId,
      set: {
        ...values,
        relationship: sql`CASE WHEN ${relationshipDigests.relationship}->>'removed' = 'true' THEN ${relationshipDigests.relationship} ELSE excluded.relationship END`,
      },
    });
}

/** A trivial thread: nothing to learn, but the watermark must move or it stays pending forever. */
export async function advanceWatermarkOnly(
  userId: string,
  runId: string,
  window: MessageWindow,
  opts: { deepRead?: boolean; firstPass?: boolean } = {}
): Promise<void> {
  const db = await getDb();
  const previous = await db.query.relationshipDigests.findFirst({ where: eq(relationshipDigests.contactId, window.contactId) });
  // Deep read: a one-message thread still gets its first reach-out, with no model call.
  if (opts.deepRead) await writeDeepReadTimeline(userId, window.contactId, [], opts.firstPass ?? !previous?.watermarkAt);
  const values = {
    contactId: window.contactId,
    userId,
    messageCount: (previous?.messageCount ?? 0) + window.messages.length,
    sources: [...new Set([...(previous?.sources ?? []), ...window.sources, ...(opts.deepRead && !previous?.watermarkAt ? [ORIGIN_CHECKED] : [])])],
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
    if (run.status !== "undone") await undoRunOrigins(userId, runId);
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
  await undoRunOrigins(userId, runId);
  await db.update(relationshipRuns).set({ status: "undone", finishedAt: new Date() }).where(eq(relationshipRuns.id, runId));
  return { remindersDismissed, actionItemsRemoved };
}

/**
 * Deep read: take back every origin this run wrote. A contact's met fields go back to what they
 * held, but only while how_met still reads what the run wrote: a later edit by the person wins.
 */
async function undoRunOrigins(userId: string, runId: string): Promise<void> {
  const db = await getDb();
  const rows = await db
    .select({ contactId: relationshipDigests.contactId, origin: relationshipDigests.origin })
    .from(relationshipDigests)
    .where(and(eq(relationshipDigests.userId, userId), sql`${relationshipDigests.origin}->>'runId' = ${runId}`));
  for (const r of rows) {
    const o = r.origin;
    const c = o?.replaced
      ? await db.query.contacts.findFirst({
          where: and(eq(contacts.id, r.contactId), eq(contacts.userId, userId)),
          columns: { howMet: true, fieldSources: true, firstInteractionAt: true },
        })
      : null;
    // Hands off once the person touched how you met after the run wrote it: any edit of the
    // three stamps `met`, and how_met no longer reading the run's text says the same.
    if (o?.replaced && c && c.howMet === o.text && c.fieldSources?.met?.s !== "user") {
      const back = o.replaced;
      await db
        .update(contacts)
        .set({
          howMet: back.howMet,
          metContext: back.metContext,
          dateMet: back.dateMet ? new Date(back.dateMet) : null,
          ...(back.widenedTo && c.firstInteractionAt?.toISOString() === back.widenedTo
            ? { firstInteractionAt: back.firstInteractionAt ? new Date(back.firstInteractionAt) : null }
            : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(contacts.id, r.contactId), eq(contacts.userId, userId)));
    }
    await db.update(relationshipDigests).set({ origin: null }).where(eq(relationshipDigests.contactId, r.contactId));
  }
}

/**
 * The person says the relationship kind is wrong ("Not right?" on the contact page). Marked
 * `removed`, not deleted: the deep read keeps a removed kind and never sets one again (see the
 * relationship rule in applyDigestPlan). False when this user has no kind on that contact.
 */
export async function removeRelationshipKind(userId: string, contactId: string): Promise<boolean> {
  const db = await getDb();
  const done = await db
    .update(relationshipDigests)
    .set({ relationship: sql`${relationshipDigests.relationship} || '{"removed": true}'::jsonb` })
    .where(
      and(
        eq(relationshipDigests.userId, userId),
        eq(relationshipDigests.contactId, contactId),
        sql`${relationshipDigests.relationship} IS NOT NULL`
      )
    )
    .returning();
  return done.length > 0;
}

/** Exported for tests that need a run without the runner. */
export function newClaimToken(): string {
  return randomUUID();
}
