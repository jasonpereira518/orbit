/**
 * Everything a confirmed note paste writes, in one place and with no auth dependency, so
 * `scripts/smoke-note-batch.ts` can drive it against PGlite. `src/actions/capture.ts` is a
 * thin `"use server"` wrapper.
 *
 * Idempotency, per row type:
 *   interactions  — `externalId = notes:<sourceHash>:<contactId>` (unique per user)
 *   reminders     — `itemHash = sha256(sourceHash|dueIso|title)` (unique per user, NULLs allowed)
 *   undo          — marks reminders `dismissed`, never deletes, so the hash keeps blocking
 */
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts, interactionMentions, noteBatches, reminders, type NoteBatchResult, type ReminderActionKind } from "@/db/schema";
import type { ParsedNote } from "@/lib/ai";
import type { DatedCommitment } from "@/lib/date-commitment-extract";
import {
  createContactForUser,
  logNoteInteractionForUser,
  updateContactForUser,
} from "@/lib/contact-writes";
import {
  DEFAULT_FOLLOW_UP_WINDOW_DAYS,
  emptyNoteBatchResult,
  noteInteractionExternalId,
  titlesCollide,
  windowDueDate,
  withinCollisionWindow,
} from "@/lib/note-batches";
import { getInboxListId } from "@/lib/reminder-lists";
import { inferReminderActionKind } from "@/lib/reminder-action-kind";
import { buildSuggestionItemHash, isoDay, isoDayToLocalNoon } from "@/lib/suggested-reminder-utils";

export type NoteBatchParticipantInput = {
  notes: string;
  parsed: ParsedNote;
  mergeContactId?: string | null;
  createReminder: boolean;
  relationshipScore: number;
  tagNames: string[];
  followUpDays?: number | null;
  interactionDate?: string | null;
  interactionType?: string | null;
};

export type NoteBatchCommitmentInput = Pick<
  DatedCommitment,
  "title" | "description" | "rawDatePhrase" | "yearInferred" | "personName" | "actionKind" | "confidenceScore" | "sourceExcerpt" | "dateBasis" | "anchorIso"
> & { dueDateIso: string; contactId?: string | null };

export type SaveNoteBatchInput = {
  sourceText: string;
  sourceHash: string;
  anchorIso: string;
  anchorBasis: "note" | "hint" | "upload";
  entryPoint: "capture" | "profile";
  seedContactId?: string | null;
  participants: NoteBatchParticipantInput[];
  commitments: NoteBatchCommitmentInput[];
  skipped: { relative: number; unverifiable: number; past: number };
};

export type SaveNoteBatchOutput = {
  batchId: string;
  created: number;
  updated: number;
  contactIds: string[];
  remindersCreated: number;
  result: NoteBatchResult;
};

/**
 * No `after()`, no embedding API call, no summary regeneration from inside this module:
 * `after()` throws outside a request scope and the embedding call needs a live key, and this
 * runs from smoke scripts. Touched contacts are stamped `embeddingStaleAt` instead; the
 * server action that wraps this kicks the backfill and the brief regeneration in `after()`.
 */
const WRITE_OPTS = { skipRevalidate: true, skipEmbedding: true, skipSummary: true } as const;

type ReminderDraft = {
  contactId: string | null;
  sourceInteractionId: string | null;
  title: string;
  description: string | null;
  dueDate: Date;
  reminderType: "extracted_date" | "ai_suggested";
  actionKind: ReminderActionKind;
  dateBasis: NoteBatchResult["reminders"][number]["dateBasis"];
  rawDatePhrase: string | null;
  sourceExcerpt: string | null;
};

export async function saveNoteBatch(userId: string, input: SaveNoteBatchInput): Promise<SaveNoteBatchOutput> {
  if (!input.participants.length && !input.commitments.length) {
    throw new Error("Nothing to save");
  }
  const db = await getDb();
  const result = emptyNoteBatchResult();
  result.skipped = { ...input.skipped, duplicate: 0 };
  const anchor = isoDayToLocalNoon(input.anchorIso);
  const [batch] = await db
    .insert(noteBatches)
    .values({
      userId,
      sourceHash: input.sourceHash,
      sourceText: input.sourceText,
      entryPoint: input.entryPoint,
      seedContactId: input.seedContactId ?? null,
      anchorDate: anchor,
      anchorBasis: input.anchorBasis,
      status: "saved",
      result,
    })
    .returning();
  const batchId = batch.id;

  let created = 0;
  let updated = 0;
  const contactIds: string[] = [];
  const interactionIdByContact = new Map<string, string>();
  const contactIdByName = new Map<string, string>();

  // 1. Participants → contacts + interactions.
  for (const p of input.participants) {
    const { parsed } = p;
    let contactId = p.mergeContactId || null;
    let wasCreated = false;
    const fields = {
      company: parsed.company || undefined,
      title: parsed.role || undefined,
      location: parsed.location || undefined,
      email: parsed.email || undefined,
      linkedinUrl: parsed.linkedin_url || undefined,
      howMet: parsed.met_at || undefined,
      aiSummary: parsed.summary || undefined,
      keyFacts: parsed.key_facts,
      sharedInterests: parsed.shared_interests,
      opportunities: parsed.opportunities,
      relationshipScore: p.relationshipScore,
      statedCloseness: p.relationshipScore,
      tagNames: p.tagNames,
    };
    if (contactId) {
      // Merge: never overwrite contacts.notes — the new material lives on the timeline.
      await updateContactForUser(userId, contactId, { fullName: parsed.name || undefined, ...fields }, WRITE_OPTS);
      updated += 1;
    } else {
      if (!parsed.name) throw new Error("A name is required to create a contact");
      const row = await createContactForUser(
        userId,
        { fullName: parsed.name, ...fields, source: "ai_capture", notes: p.notes },
        WRITE_OPTS
      );
      contactId = row.id;
      created += 1;
      wasCreated = true;
    }
    contactIds.push(contactId);
    if (parsed.name) contactIdByName.set(parsed.name.trim().toLowerCase(), contactId);

    const interactionDate = p.interactionDate?.trim() || parsed.interaction_date?.trim() || input.anchorIso;
    const { row, created: interactionCreated } = await logNoteInteractionForUser(
      userId,
      {
        contactId,
        rawNotes: p.notes,
        aiSummary: parsed.summary || undefined,
        topics: parsed.topics,
        actionItems: parsed.action_items,
        interactionType: p.interactionType || "meeting_note",
        source: "capture",
        interactionDate,
        externalId: noteInteractionExternalId(input.sourceHash, contactId),
        noteBatchId: batchId,
      },
      WRITE_OPTS
    );
    interactionIdByContact.set(contactId, row.id);
    if (!interactionCreated) result.skipped.duplicate += 1;
    result.participants.push({ contactId, interactionId: row.id, name: parsed.name || "Unnamed", created: wasCreated, duplicate: !interactionCreated });
  }

  // 2. Dated commitments → reminder drafts.
  const drafts: ReminderDraft[] = [];
  for (const c of input.commitments) {
    const contactId = c.contactId ?? (c.personName ? contactIdByName.get(c.personName.trim().toLowerCase()) ?? null : null);
    drafts.push({
      contactId,
      sourceInteractionId: contactId ? interactionIdByContact.get(contactId) ?? null : null,
      title: c.title,
      description: c.description,
      dueDate: isoDayToLocalNoon(c.dueDateIso),
      reminderType: c.dateBasis === "vague" ? "ai_suggested" : "extracted_date",
      actionKind: c.actionKind,
      dateBasis: c.dateBasis,
      rawDatePhrase: c.rawDatePhrase,
      sourceExcerpt: c.sourceExcerpt,
    });
  }

  // 3. Fallback follow-up per participant — only when the note gave them nothing else.
  for (const p of input.participants) {
    if (!p.createReminder || !p.parsed.name) continue;
    const contactId = contactIdByName.get(p.parsed.name.trim().toLowerCase());
    if (!contactId) continue;
    if (drafts.some((d) => d.contactId === contactId)) continue;
    const days = p.followUpDays || p.parsed.follow_up_days || DEFAULT_FOLLOW_UP_WINDOW_DAYS;
    const title = p.parsed.follow_up_recommendation || `Follow up with ${p.parsed.name}`;
    drafts.push({
      contactId,
      sourceInteractionId: interactionIdByContact.get(contactId) ?? null,
      title,
      description: p.parsed.suggested_next_message || null,
      dueDate: windowDueDate(anchor, days),
      reminderType: "ai_suggested",
      actionKind: inferReminderActionKind({ title, description: p.parsed.suggested_next_message, reminderType: "ai_suggested", contactId }),
      dateBasis: "window",
      rawDatePhrase: null,
      sourceExcerpt: null,
    });
  }

  // 4. Collision rule: a dated commitment beats a window reminder with the same title
  //    within 3 days for the same person.
  const kept = drafts.filter((d) => {
    if (d.dateBasis !== "window") return true;
    return !drafts.some(
      (other) => other !== d && other.dateBasis !== "window" && other.contactId === d.contactId &&
        titlesCollide(other.title, d.title) && withinCollisionWindow(other.dueDate, d.dueDate)
    );
  });

  // 5. Insert reminders, idempotent through itemHash.
  let remindersCreated = 0;
  if (kept.length) {
    const listId = await getInboxListId(userId);
    const inserted = await db
      .insert(reminders)
      .values(
        kept.map((d) => ({
          userId,
          contactId: d.contactId,
          listId,
          title: d.title,
          description: d.description,
          dueDate: d.dueDate,
          status: "pending",
          reminderType: d.reminderType,
          actionKind: d.actionKind,
          createdBy: "ai",
          noteBatchId: batchId,
          sourceInteractionId: d.sourceInteractionId,
          sourceExcerpt: d.sourceExcerpt,
          rawDatePhrase: d.rawDatePhrase,
          dateBasis: d.dateBasis,
          itemHash: buildSuggestionItemHash(input.sourceHash, isoDay(d.dueDate), d.title),
        }))
      )
      .onConflictDoNothing({ target: [reminders.userId, reminders.itemHash] })
      .returning();
    remindersCreated = inserted.length;
    for (const r of inserted) {
      result.reminders.push({
        id: r.id, contactId: r.contactId, title: r.title, dueIso: isoDay(new Date(r.dueDate!)),
        dateBasis: (r.dateBasis ?? "window") as NoteBatchResult["reminders"][number]["dateBasis"],
        rawDatePhrase: r.rawDatePhrase, sourceExcerpt: r.sourceExcerpt,
      });
    }
  }

  if (contactIds.length) {
    await db.update(contacts).set({ embeddingStaleAt: new Date() }).where(and(eq(contacts.userId, userId), inArray(contacts.id, contactIds)));
  }
  await db.update(noteBatches).set({ result }).where(eq(noteBatches.id, batchId));
  return { batchId, created, updated, contactIds, remindersCreated, result };
}

export async function undoNoteBatchForUser(userId: string, batchId: string) {
  const db = await getDb();
  const batch = await db.query.noteBatches.findFirst({
    where: and(eq(noteBatches.id, batchId), eq(noteBatches.userId, userId)),
  });
  if (!batch) throw new Error("Batch not found");
  if (batch.status === "undone") return { remindersDismissed: 0, mentionsRemoved: 0 };

  const dismissed = await db
    .update(reminders)
    .set({ status: "dismissed" })
    .where(and(eq(reminders.userId, userId), eq(reminders.noteBatchId, batchId), eq(reminders.status, "pending")))
    .returning();

  const interactionIds = batch.result.participants.map((p) => p.interactionId).filter((id): id is string => Boolean(id));
  let mentionsRemoved = 0;
  if (interactionIds.length) {
    const removed = await db
      .delete(interactionMentions)
      .where(and(eq(interactionMentions.userId, userId), inArray(interactionMentions.interactionId, interactionIds)))
      .returning();
    mentionsRemoved = removed.length;
  }

  await db.update(noteBatches).set({ status: "undone", undoneAt: new Date() }).where(eq(noteBatches.id, batchId));
  return { remindersDismissed: dismissed.length, mentionsRemoved };
}

export async function dismissNoteReminderForUser(userId: string, reminderId: string) {
  const db = await getDb();
  await db
    .update(reminders)
    .set({ status: "dismissed" })
    .where(and(eq(reminders.id, reminderId), eq(reminders.userId, userId), eq(reminders.status, "pending")));
}
