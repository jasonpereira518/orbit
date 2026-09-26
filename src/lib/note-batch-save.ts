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
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { actionItems, contacts, interactionMentions, noteBatches, reminders, type CaptureSourceKind, type NoteBatchMeeting, type NoteBatchResult, type ReminderActionKind, type ReminderOrigin } from "@/db/schema";
import type { ParsedNote } from "@/lib/ai";
import type { DatedCommitment } from "@/lib/date-commitment-extract";
import type { MentionMatchedBy } from "@/lib/mention-resolution";
import {
  createContactForUser,
  logNoteInteractionForUser,
  updateContactForUser,
  withExistingTagNames,
} from "@/lib/contact-writes";
import {
  DEFAULT_FOLLOW_UP_WINDOW_DAYS,
  dropSupersededWindowDrafts,
  emptyNoteBatchResult,
  noteInteractionExternalId,
  titlesCollide,
  windowDueDate,
} from "@/lib/note-batches";
import {
  buildOpportunityItemHash,
  dismissOpportunitiesForBatch,
  insertOpportunities,
  syncContactOpportunityMirrors,
} from "@/lib/contact-opportunities";
import type { ExtractedOpportunity } from "@/lib/opportunity-extract";
import { syncMemoryChunkMentions } from "@/lib/memory-chunks";
import { getInboxListId } from "@/lib/reminder-lists";
import { inferReminderActionKind } from "@/lib/reminder-action-kind";
import { buildSuggestionItemHash, isoDay, isoDayToLocalNoon } from "@/lib/suggested-reminder-utils";
import { reportAndContinue } from "@/lib/report-error";

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
  /**
   * Typed opportunities this person's card kept. Already validated and already filtered by
   * whatever the review UI left ticked — this module stores, it does not re-decide.
   */
  opportunities?: NoteBatchOpportunityInput[];
  /** A cadence the notes stated for this person, resolved to days. */
  cadenceDays?: number | null;
  cadencePhrase?: string | null;
};

export type NoteBatchOpportunityInput = Pick<
  ExtractedOpportunity,
  "kind" | "label" | "direction" | "sourceExcerpt" | "rawDatePhrase" | "confidenceScore"
> & {
  /** YYYY-MM-DD, so the date round-trips through the client without timezone drift. */
  dueDateIso?: string | null;
};

export type NoteBatchCommitmentInput = Omit<
  Pick<
    DatedCommitment,
    "title" | "description" | "rawDatePhrase" | "yearInferred" | "personName" | "actionKind" | "confidenceScore" | "sourceExcerpt" | "dateBasis" | "anchorIso"
  >,
  "rawDatePhrase"
> & {
  dueDateIso: string;
  contactId?: string | null;
  /**
   * Null for an implied next step, which travels this same path: nobody named a date, so
   * there is no phrase to quote back. `DatedCommitment` keeps it non-null because a dated
   * commitment by definition has one.
   */
  rawDatePhrase: string | null;
  /** Defaults to `"explicit"` — everything that reached here before implied steps existed was. */
  origin?: ReminderOrigin;
};

export type NoteBatchMentionInput = { text: string; context: string | null; nearPerson: string | null; contactId: string | null; confidence: number; matchedBy: MentionMatchedBy | null };

/**
 * A digest item from a recorded meeting that the user ticked "make a reminder" on: an
 * action item nobody's card carried, a blocker, or an open question.
 */
export type MeetingExtraReminderInput = {
  kind: "action" | "blocker" | "question";
  title: string;
  /** A participant's name, resolved to their contact when they are in this batch. */
  ownerName: string | null;
  sourceExcerpt: string | null;
};

export type SaveNoteBatchInput = {
  sourceText: string;
  sourceHash: string;
  anchorIso: string;
  anchorBasis: "note" | "hint" | "upload";
  entryPoint: "capture" | "profile";
  seedContactId?: string | null;
  participants: NoteBatchParticipantInput[];
  commitments: NoteBatchCommitmentInput[];
  mentions?: NoteBatchMentionInput[];
  skipped: { relative: number; unverifiable: number; past: number };
  /** How the notes arrived — see `noteBatches.inputSources`. Defaults to none recorded. */
  inputSources?: CaptureSourceKind[];
  /**
   * Set when the batch is a recorded meeting. Its summary is stored on the result, and a
   * meeting is saveable with no people and no dates — the summary is the point.
   */
  meeting?: { summary: NoteBatchMeeting; extraReminders: MeetingExtraReminderInput[] } | null;
};

const MEETING_REMINDER_PREFIX: Record<MeetingExtraReminderInput["kind"], string> = {
  action: "",
  blocker: "Unblock: ",
  question: "Answer: ",
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
  actionItemId: string | null;
  origin: ReminderOrigin;
  confidenceScore: number | null;
};

export async function saveNoteBatch(userId: string, input: SaveNoteBatchInput): Promise<SaveNoteBatchOutput> {
  if (!input.meeting && !input.participants.length && !input.commitments.length) {
    throw new Error("Nothing to save");
  }
  const db = await getDb();
  const result = emptyNoteBatchResult();
  // Counts only. The phrase list is review-screen copy that comes back from the client with
  // the save; the batch result has no use for it and should not store client strings.
  result.skipped = {
    relative: input.skipped.relative,
    unverifiable: input.skipped.unverifiable,
    past: input.skipped.past,
    duplicate: 0,
  };
  if (input.meeting) result.meeting = input.meeting.summary;
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
      inputSources: input.inputSources ?? [],
    })
    .returning();
  const batchId = batch.id;

  let created = 0;
  let updated = 0;
  let remindersCreated = 0;
  const contactIds: string[] = [];
  const interactionIdByContact = new Map<string, string>();
  const contactIdByName = new Map<string, string>();

  const drafts: ReminderDraft[] = [];

  try {
    // 1. Participants → contacts + interactions.
    for (const p of input.participants) {
      const { parsed } = p;
      let contactId = p.mergeContactId || null;
      let wasCreated = false;
      // Spec §3: a capture that asks for a reminder also moves the contact's own
      // follow-up stamp, on create AND on merge — the profile's "next follow-up" and
      // the follow-up queue read this column, not the reminder rows.
      const followUpDate = p.createReminder
        ? windowDueDate(anchor, p.followUpDays || p.parsed.follow_up_days || DEFAULT_FOLLOW_UP_WINDOW_DAYS)
        : null;
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
        // `opportunities` is deliberately NOT written here any more.
        //
        // It used to be, on both the create and the merge branch — and
        // `updateContactForUser` overwrites the column outright, so a second note about the
        // same person silently deleted the first note's opportunities. The typed rows in
        // `contact_opportunities` are the record now, and `contacts.opportunities` is a
        // mirror DERIVED from them by `syncContactOpportunityMirror` (step 1d below), which
        // is the only writer left.
        relationshipScore: p.relationshipScore,
        statedCloseness: p.relationshipScore,
        tagNames: p.tagNames,
        // A rhythm the notes stated, e.g. "check in monthly". Written on create AND merge:
        // the newest note is the most recent thing the person said about how often they want
        // to hear from you, so it supersedes an older one rather than racing it.
        ...(p.cadenceDays
          ? {
              cadenceDays: p.cadenceDays,
              cadencePhrase: p.cadencePhrase ?? null,
              cadenceSource: "note" as const,
              cadenceSetAt: new Date(),
            }
          : {}),
        ...(followUpDate ? { nextFollowUpAt: followUpDate.toISOString() } : {}),
      };
      if (contactId) {
        // Merge: never overwrite contacts.notes — the new material lives on the timeline.
        // Tags are ADDED to the contact's own, never a replacement list: `updateContactForUser`
        // sets the full list, and the note's tags alone would delete the rest (an empty list
        // deleted them all).
        const { tagNames, ...rest } = fields;
        await updateContactForUser(
          userId,
          contactId,
          {
            fullName: parsed.name || undefined,
            ...rest,
            ...(tagNames?.length ? { tagNames: await withExistingTagNames(userId, contactId, tagNames) } : {}),
          },
          WRITE_OPTS
        );
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

      // 1c. Typed opportunities. After the interaction, so `source_interaction_id` can point
      //     at it. Hashed on (sourceHash, contactId, kind, label) so a re-paste creates
      //     nothing — the same idempotency contract as the reminders below, and for the same
      //     reason: people re-paste a note to fix a typo, not to duplicate their pipeline.
      if (p.opportunities?.length) {
        const inserted = await insertOpportunities(
          userId,
          p.opportunities.map((o) => ({
            contactId: contactId!,
            kind: o.kind,
            label: o.label,
            direction: o.direction,
            sourceInteractionId: row.id,
            noteBatchId: batchId,
            sourceExcerpt: o.sourceExcerpt,
            dueDate: o.dueDateIso ? isoDayToLocalNoon(o.dueDateIso) : null,
            rawDatePhrase: o.rawDatePhrase,
            confidenceScore: o.confidenceScore,
            createdBy: "ai" as const,
            itemHash: buildOpportunityItemHash(input.sourceHash, contactId!, o.kind, o.label),
          }))
        );
        // `emptyNoteBatchResult` always seeds this, but the field is optional on the type so
        // that batches saved before it existed still parse — hence the local narrowing.
        const opportunityResults = (result.opportunities ??= []);
        for (const r of inserted) {
          opportunityResults.push({
            id: r.id,
            contactId: contactId!,
            kind: r.kind,
            label: r.label,
            dueIso: r.dueDate ? isoDay(new Date(r.dueDate)) : null,
          });
        }
      }

      // 1a. Each new open action item gets its own window reminder draft (skip items that
      // already carry a reminderId — e.g. a re-sync that didn't touch this item).
      if (interactionCreated && parsed.action_items.length) {
        const openItems = await db
          .select({ id: actionItems.id, text: actionItems.text, reminderId: actionItems.reminderId })
          .from(actionItems)
          .where(and(eq(actionItems.userId, userId), eq(actionItems.interactionId, row.id)));
        for (const item of openItems) {
          if (item.reminderId) continue;
          drafts.push({
            contactId, sourceInteractionId: row.id, title: item.text, description: null,
            dueDate: windowDueDate(anchor), reminderType: "ai_suggested",
            actionKind: inferReminderActionKind({ title: item.text, description: null, reminderType: "ai_suggested", contactId }),
            dateBasis: "window", rawDatePhrase: null, sourceExcerpt: null, actionItemId: item.id,
            // An action item is something the note SAID somebody would do.
            origin: "explicit", confidenceScore: null,
          });
          result.actionItems.push({ id: item.id, contactId, text: item.text, reminderId: null });
        }
      }
    }

    // 1b. Mentions → links on the nearest participant's interaction. A dates-only batch has
    //     no interaction to hang them on, so they stay in the result as unresolved.
    const participantIds = new Set(contactIds);
    const firstInteraction = result.participants[0]?.interactionId ?? null;
    // Every mention's contact id is confirmed to be this user's before anything is written.
    // The ids reach here from a browser — `confirmBulkCapture` takes them straight off the
    // request — so without this, a forged id writes a row into `interaction_mentions`
    // pointing at somebody else's contact. It also covers the honest case: a contact deleted
    // between the parse and the save, which reads here as exactly what it is, a name in the
    // note that no longer links to anyone.
    // Commitments carry browser-supplied contact ids too (they become reminders below).
    const claimedIds = [
      ...new Set(
        [...(input.mentions ?? []), ...input.commitments]
          .map((m) => m.contactId)
          .filter((id): id is string => Boolean(id))
      ),
    ];
    const ownedIds = new Set<string>(
      claimedIds.length
        ? (await db
            .select({ id: contacts.id })
            .from(contacts)
            .where(and(eq(contacts.userId, userId), inArray(contacts.id, claimedIds)))
          ).map((r) => r.id)
        : []
    );
    const mentionRows: (typeof interactionMentions.$inferInsert)[] = [];
    for (const m of input.mentions ?? []) {
      // A mention that resolved to somebody already IN this batch is not unresolved — the
      // person is right there on the results page as a participant. Drop it silently
      // rather than offering "add as a contact" for someone just created.
      if (m.contactId && participantIds.has(m.contactId)) continue;
      if (!m.contactId || !ownedIds.has(m.contactId)) {
        result.unresolvedMentions.push({ text: m.text, context: m.context });
        continue;
      }
      const nearId = m.nearPerson ? contactIdByName.get(m.nearPerson.trim().toLowerCase()) : undefined;
      const interactionId = (nearId && interactionIdByContact.get(nearId)) || firstInteraction;
      if (!interactionId) { result.unresolvedMentions.push({ text: m.text, context: m.context }); continue; }
      mentionRows.push({ userId, interactionId, contactId: m.contactId, mentionText: m.text, confidence: m.confidence, matchedBy: m.matchedBy ?? "user_pick" });
      result.mentions.push({ interactionId, contactId: m.contactId, text: m.text, confidence: m.confidence, matchedBy: m.matchedBy ?? "user_pick" });
    }
    if (mentionRows.length) {
      await db.insert(interactionMentions).values(mentionRows).onConflictDoNothing({ target: [interactionMentions.interactionId, interactionMentions.contactId] });
      // The passages of these interactions, if any exist yet, were chunked before these rows
      // existed and so name only the person the note was filed under. Batch writes set
      // `skipEmbedding`, so usually there are none and the sweep picks the mentions up itself
      // — this is for the re-paste onto an interaction that has already been indexed, which
      // the sweep will never revisit (it claims only interactions with no passages at all).
      // Never fatal: failing to widen the index must not fail saving the batch.
      await syncMemoryChunkMentions(userId, mentionRows.map((m) => m.interactionId)).catch(
        (err) => console.warn("[memory-chunks] could not apply mentions", err)
      );
    }

    // 2. Dated commitments → reminder drafts.
    for (const c of input.commitments) {
      // A claimed id counts only if it is this user's (checked above) or was created by this
      // batch; otherwise fall back to the name, exactly as if no id had been sent.
      const claimed =
        c.contactId && (ownedIds.has(c.contactId) || participantIds.has(c.contactId))
          ? c.contactId
          : null;
      const contactId = claimed ?? (c.personName ? contactIdByName.get(c.personName.trim().toLowerCase()) ?? null : null);
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
        actionItemId: null,
        origin: c.origin ?? "explicit",
        confidenceScore: c.confidenceScore,
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
        actionItemId: null,
        origin: "explicit",
        confidenceScore: null,
      });
    }

    // 3b. Meeting digest items the user ticked. Due on the default window, like an action
    //     item. Skipped when a draft above already says the same thing — the per-person
    //     parse and the call-level digest read the same meeting and often agree.
    for (const extra of input.meeting?.extraReminders ?? []) {
      const text = extra.title.replace(/\s+/g, " ").trim().slice(0, 300);
      if (!text) continue;
      const prefix = MEETING_REMINDER_PREFIX[extra.kind];
      const title = prefix && !text.toLowerCase().startsWith(prefix.trim().toLowerCase()) ? `${prefix}${text}` : text;
      if (drafts.some((d) => titlesCollide(d.title, text) || titlesCollide(d.title, title))) continue;
      const contactId = extra.ownerName ? contactIdByName.get(extra.ownerName.trim().toLowerCase()) ?? null : null;
      drafts.push({
        contactId,
        sourceInteractionId: contactId ? interactionIdByContact.get(contactId) ?? null : null,
        title,
        description: input.meeting!.summary.title ? `From the meeting "${input.meeting!.summary.title}"` : null,
        dueDate: windowDueDate(anchor),
        reminderType: "ai_suggested",
        actionKind:
          extra.kind === "action"
            ? inferReminderActionKind({ title, description: null, reminderType: "ai_suggested", contactId })
            : "task",
        dateBasis: "window",
        rawDatePhrase: null,
        sourceExcerpt: extra.sourceExcerpt?.slice(0, 500) ?? null,
        actionItemId: null,
        // A digest item is something the call produced, not something Orbit inferred.
        origin: "explicit",
        confidenceScore: null,
      });
    }

    // 4. Collision rule. Action-item and fallback drafts carry a `window` date Orbit chose;
    //    one yields to a dated commitment for the same contact that says the same thing
    //    (see `dropSupersededWindowDrafts`), so one follow-up never becomes two reminders.
    //    The review's Save button counts with the same function (`planReminders`).
    const kept = dropSupersededWindowDrafts(drafts, (d) => d.contactId);

    // 5. Insert reminders, idempotent through itemHash. An action-item draft hashes its
    //    own item id rather than its title: two participants in one batch can share the
    //    same action-item text and the same window due date, and hashing the title would
    //    collide them under the (userId, itemHash) unique index, silently dropping the
    //    second reminder. The item id is unique per row, so this stays collision-free while
    //    remaining idempotent across re-pastes — `action_items` rows are keyed by
    //    (interactionId, text) and the interaction by externalId, so a re-paste resolves to
    //    the same item id and therefore the same hash.
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
            actionItemId: d.actionItemId,
            origin: d.origin,
            confidenceScore: d.confidenceScore,
            itemHash: d.actionItemId
              ? buildSuggestionItemHash(input.sourceHash, isoDay(d.dueDate), `action-item:${d.actionItemId}`)
              : buildSuggestionItemHash(input.sourceHash, isoDay(d.dueDate), d.title),
          }))
        )
        .onConflictDoNothing({ target: [reminders.userId, reminders.itemHash] })
        .returning();
      remindersCreated = inserted.length;
      const reminderByActionItem = new Map<string, string>();
      for (const r of inserted) {
        result.reminders.push({
          id: r.id, contactId: r.contactId, title: r.title, dueIso: isoDay(new Date(r.dueDate!)),
          dateBasis: (r.dateBasis ?? "window") as NoteBatchResult["reminders"][number]["dateBasis"],
          rawDatePhrase: r.rawDatePhrase, sourceExcerpt: r.sourceExcerpt,
        });
        if (r.actionItemId) {
          reminderByActionItem.set(r.actionItemId, r.id);
          const entry = result.actionItems.find((a) => a.id === r.actionItemId);
          if (entry) entry.reminderId = r.id;
        }
      }
      // Back-link every action item to its reminder in one statement rather than one per
      // reminder. Keyed by item id (last reminder wins, as the per-row updates left it):
      // UPDATE ... FROM would pick an arbitrary match if an id appeared twice.
      if (reminderByActionItem.size) {
        const links = [...reminderByActionItem].map(
          ([actionItemId, reminderId]) => sql`(${actionItemId}::uuid, ${reminderId}::uuid)`
        );
        await db.execute(sql`
          UPDATE action_items AS a
             SET reminder_id = v.reminder_id
            FROM (VALUES ${sql.join(links, sql`, `)}) AS v(id, reminder_id)
           WHERE a.id = v.id AND a.user_id = ${userId}
        `);
      }
    }
  } catch (err) {
    // Persist what was written so the results page and undo can still see it.
    await db
      .update(noteBatches)
      .set({ result })
      .where(eq(noteBatches.id, batchId))
      .catch(reportAndContinue({ where: "job.note-batch.persist-partial", userId, extra: { batchId } }, null));
    throw err;
  }

  // 6. Re-derive `contacts.opportunities` from the rows just written. Once per contact,
  //    after the loop rather than inside it: a contact with three new opportunities would
  //    otherwise have the same column rewritten three times. This also stamps
  //    `embeddingStaleAt`, which is why the blanket stamp below skips the touched ones.
  const opportunityContactIds = [...new Set((result.opportunities ?? []).map((o) => o.contactId))];
  if (opportunityContactIds.length) {
    await syncContactOpportunityMirrors(userId, opportunityContactIds);
  }

  const needStamp = contactIds.filter((id) => !opportunityContactIds.includes(id));
  if (needStamp.length) {
    await db.update(contacts).set({ embeddingStaleAt: new Date() }).where(and(eq(contacts.userId, userId), inArray(contacts.id, needStamp)));
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
  if (batch.status === "undone") return { remindersDismissed: 0, mentionsRemoved: 0, opportunitiesDismissed: 0 };

  const dismissed = await db
    .update(reminders)
    .set({ status: "dismissed" })
    .where(and(eq(reminders.userId, userId), eq(reminders.noteBatchId, batchId), eq(reminders.status, "pending")))
    .returning();

  // Only the exact (interaction, contact) links THIS batch wrote. Deleting every mention
  // on the batch's interactions would also wipe links written by an earlier paste, a
  // later paste, or by hand — undo owns its own rows and nothing else.
  const pairs = batch.result.mentions
    .filter((m) => m.interactionId && m.contactId)
    .map((m) => and(eq(interactionMentions.interactionId, m.interactionId), eq(interactionMentions.contactId, m.contactId)));
  let mentionsRemoved = 0;
  if (pairs.length) {
    const removed = await db
      .delete(interactionMentions)
      .where(and(eq(interactionMentions.userId, userId), or(...pairs)))
      .returning();
    mentionsRemoved = removed.length;
  }

  // Opportunities this batch opened are dismissed, never deleted — the `item_hash` has to
  // keep blocking, or re-pasting the same note would recreate everything just undone. An
  // opportunity the person has since marked `landed` is a decision they made after the save,
  // so `dismissOpportunitiesForBatch` leaves it alone.
  const dismissedOpportunities = await dismissOpportunitiesForBatch(userId, batchId);
  if (dismissedOpportunities.length) {
    await syncContactOpportunityMirrors(
      userId,
      dismissedOpportunities.map((o) => o.contactId)
    );
  }

  await db.update(noteBatches).set({ status: "undone", undoneAt: new Date() }).where(eq(noteBatches.id, batchId));
  return {
    remindersDismissed: dismissed.length,
    mentionsRemoved,
    opportunitiesDismissed: dismissedOpportunities.length,
  };
}

export async function dismissNoteReminderForUser(userId: string, reminderId: string) {
  const db = await getDb();
  await db
    .update(reminders)
    .set({ status: "dismissed" })
    .where(and(eq(reminders.id, reminderId), eq(reminders.userId, userId), eq(reminders.status, "pending")));
}
