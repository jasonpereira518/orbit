"use server";

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import {
  contacts,
  reminders,
  suggestedReminders,
  type ReminderActionKind,
} from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import {
  fetchRawCommitments,
  validateCommitments,
  emptyCommitmentResult,
  type RejectedCounts,
} from "@/lib/date-commitment-extract";
import type { DateBasis } from "@/lib/relative-date";
import {
  buildSuggestionItemHash,
  hashSourceNote,
  isoDay,
  isoDayToLocalNoon,
} from "@/lib/suggested-reminder-utils";
import {
  parseMultiPersonNotesWithAI,
  type CaptureParseHints,
  type ParsedNote,
  type SharedNoteContext,
} from "@/lib/ai";
import {
  normalizeCaptureInput,
  normalizePastedCaptureText,
  type CaptureMediaFile,
} from "@/lib/capture-ingest";
import { findDuplicateCandidates } from "@/lib/duplicates";
import { createContact, logInteraction, updateContact } from "@/actions/contacts";
import { MISSING_AI_API_KEY_MESSAGE, toUserFacingError } from "@/lib/errors";

export type BulkNoteDuplicate = {
  id: string;
  fullName: string;
  company: string | null;
  title: string | null;
  reason: string;
  confidence: number;
};

export type BulkNotePersonPreview = {
  key: string;
  notes: string;
  parsed: ParsedNote;
  duplicates: BulkNoteDuplicate[];
  suggestedMergeId: string | null;
  /** Shared group/event notes folded into this person's save payload. */
  sharedNoteTexts: string[];
  interactionDate: string | null;
  interactionType: string | null;
};

/** A dated commitment awaiting the user's review, shaped for the client. */
export type SuggestedReminderPreview = {
  key: string;
  title: string;
  description: string | null;
  rawDatePhrase: string;
  /** YYYY-MM-DD, so the date input round-trips without timezone drift. */
  dueDateIso: string;
  yearInferred: boolean;
  personName: string | null;
  actionKind: ReminderActionKind;
  confidenceScore: number;
  sourceExcerpt: string;
  dateBasis: DateBasis;
  anchorIso: string;
};

/** What the client echoes back on save, plus any per-row edits. */
export type SuggestedReminderSubmission = SuggestedReminderPreview & {
  contactId?: string | null;
};

function namesMatch(a: string, b: string) {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}


function sharedNotesForPerson(
  personName: string | null,
  sharedNotes: SharedNoteContext[]
): SharedNoteContext[] {
  if (!personName?.trim()) return [];
  return sharedNotes.filter((s) =>
    s.person_names.some((n) => namesMatch(n, personName))
  );
}

/** Compose person-specific excerpt with any shared group context. */
function composePersonNotes(
  sourceExcerpt: string | null | undefined,
  sharedForPerson: SharedNoteContext[],
  fallbackNotes: string
): string {
  const personal = sourceExcerpt?.trim() || "";
  const sharedBlock = sharedForPerson
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join("\n\n");

  if (sharedBlock && personal) {
    return `${sharedBlock}\n\n---\n\n${personal}`;
  }
  return personal || sharedBlock || fallbackNotes;
}

function mergeTopics(
  personTopics: string[] | undefined,
  shared: SharedNoteContext[]
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of [
    ...(personTopics || []),
    ...shared.flatMap((s) => s.topics || []),
  ]) {
    const key = t.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(t.trim());
  }
  return out;
}

/**
 * Ingest voice / photos / calendar / email into normalized capture text.
 * Media is processed ephemerally and not stored.
 */
export async function ingestCaptureMedia(input: {
  text?: string;
  files?: CaptureMediaFile[];
}) {
  try {
    const userId = await requireUserId();
    const hasText = Boolean(input.text?.trim());
    const hasFiles = Boolean(input.files?.length);
    if (!hasText && !hasFiles) {
      return { ok: false as const, error: "Add notes or upload a file first" };
    }

    const normalized = await normalizeCaptureInput(userId, {
      text: input.text,
      files: input.files,
    });

    return {
      ok: true as const,
      text: normalized.text,
      hints: normalized.hints,
      sources: normalized.sources,
    };
  } catch (err) {
    return {
      ok: false as const,
      error: toUserFacingError(err, MISSING_AI_API_KEY_MESSAGE).message,
    };
  }
}

export async function parseBulkCaptureNotes(
  notes: string,
  hints?: CaptureParseHints | null
) {
  try {
    const userId = await requireUserId();
    if (!notes.trim()) {
      return { ok: false as const, error: "Notes are required" };
    }

    // Auto-detect pasted ICS / email forwards when caller didn't supply hints.
    const detected = normalizePastedCaptureText(notes);
    const seedPeople = [
      ...(hints?.seedPeople || []),
      ...(detected.hints.seedPeople || []),
    ];
    const mergedHints: CaptureParseHints = {
      eventDate: hints?.eventDate || detected.hints.eventDate || null,
      seedPeople: seedPeople.length ? seedPeople : undefined,
      interactionType:
        hints?.interactionType || detected.hints.interactionType || null,
    };

    const corpus =
      detected.sources.includes("calendar") ||
      detected.sources.includes("email")
        ? detected.text
        : notes;

    // Run both extractions concurrently. The commitment pass is failure-isolated:
    // contact extraction is the core value and must survive a bad dates response.
    const today = new Date();
    const [personParse, rawCommitments] = await Promise.all([
      parseMultiPersonNotesWithAI(userId, corpus, mergedHints),
      fetchRawCommitments(userId, corpus, {
        today,
        knownPeople: seedPeople.map((p) => p.name).filter(Boolean) as string[],
      }).catch(() => [] as Awaited<ReturnType<typeof fetchRawCommitments>>),
    ]);

    const { people, shared_notes, interaction_date } = personParse;
    // The anchor is the date the notes are ABOUT: what the people pass found, else the
    // calendar/email hint, else the upload moment. Relative phrases count from it.
    const anchorSource = interaction_date || mergedHints.eventDate || null;
    const anchor = anchorSource ? isoDayToLocalNoon(anchorSource) : today;
    const anchorBasis: "note" | "hint" | "upload" = interaction_date
      ? "note"
      : mergedHints.eventDate
        ? "hint"
        : "upload";
    const commitmentResult = (() => {
      try {
        return validateCommitments(rawCommitments, corpus, { today, anchor });
      } catch {
        return emptyCommitmentResult();
      }
    })();
    // A note can legitimately carry dates but no people ("Board review 15th of October"),
    // so only fail when both extractions came back empty.
    if (!people.length && !commitmentResult.commitments.length) {
      return {
        ok: false as const,
        error: "No people or dates found in those notes",
      };
    }

    const db = await getDb();
    const existing = await db.query.contacts.findMany({
      where: eq(contacts.userId, userId),
    });

    const defaultDate = interaction_date || mergedHints.eventDate || null;
    const interactionType = mergedHints.interactionType || "meeting_note";

    const items: BulkNotePersonPreview[] = people.map((person, index) => {
      const { source_excerpt, ...parsedBase } = person;
      const sharedForPerson = sharedNotesForPerson(
        parsedBase.name,
        shared_notes
      );

      const parsed: ParsedNote = {
        ...parsedBase,
        met_at:
          parsedBase.met_at ||
          sharedForPerson.find((s) => s.met_at)?.met_at ||
          null,
        topics: mergeTopics(parsedBase.topics, sharedForPerson),
        interaction_date: parsedBase.interaction_date || defaultDate,
      };

      const duplicates = findDuplicateCandidates(existing, {
        fullName: parsed.name,
        email: parsed.email,
        linkedinUrl: parsed.linkedin_url,
        company: parsed.company,
        title: parsed.role,
      }).slice(0, 5);

      const top = duplicates[0];
      const suggestedMergeId =
        top && top.confidence >= 0.85 ? top.contact.id : null;

      return {
        key: `${index}-${parsed.name || "person"}`,
        notes: composePersonNotes(source_excerpt, sharedForPerson, corpus),
        parsed,
        duplicates: duplicates.map((d) => ({
          id: d.contact.id,
          fullName: d.contact.fullName,
          company: d.contact.company,
          title: d.contact.title,
          reason: d.reason,
          confidence: d.confidence,
        })),
        suggestedMergeId,
        sharedNoteTexts: sharedForPerson.map((s) => s.text),
        interactionDate: parsed.interaction_date,
        interactionType,
      };
    });

    const sourceHash = hashSourceNote(corpus);
    const suggestedRemindersPreview: SuggestedReminderPreview[] =
      commitmentResult.commitments.map((c, index) => ({
        key: `${index}-${c.rawDatePhrase}`,
        title: c.title,
        description: c.description,
        rawDatePhrase: c.rawDatePhrase,
        dueDateIso: isoDay(c.dueDate),
        yearInferred: c.yearInferred,
        personName: c.personName,
        actionKind: c.actionKind,
        confidenceScore: c.confidenceScore,
        sourceExcerpt: c.sourceExcerpt,
        dateBasis: c.dateBasis,
        anchorIso: c.anchorIso,
      }));

    return {
      ok: true as const,
      items,
      sharedNotes: shared_notes,
      interactionDate: defaultDate,
      interactionType,
      anchorIso: isoDay(anchor),
      anchorBasis,
      hints: mergedHints,
      // Computed server-side and echoed back on save, so the client can't forge them
      // into a hash that would collide with (or evade) another note's dedupe key.
      captureBatchId: randomUUID(),
      sourceHash,
      suggestedReminders: suggestedRemindersPreview,
      suggestionsSkipped: commitmentResult.rejected as RejectedCounts,
    };
  } catch (err) {
    const { toUserFacingError } = await import("@/lib/errors");
    return {
      ok: false as const,
      error: toUserFacingError(err, MISSING_AI_API_KEY_MESSAGE).message,
    };
  }
}

export async function confirmBulkCapture(
  items: Array<{
    notes: string;
    parsed: ParsedNote;
    mergeContactId?: string | null;
    createReminder: boolean;
    relationshipScore: number;
    tagNames: string[];
    followUpDays?: number | null;
    interactionDate?: string | null;
    interactionType?: string | null;
  }>,
  suggestions?: {
    captureBatchId: string;
    sourceHash: string;
    items: SuggestedReminderSubmission[];
  }
) {
  const userId = await requireUserId();
  const suggestionItems = suggestions?.items || [];
  // A dates-only save is legitimate when the note named no people.
  if (!items.length && !suggestionItems.length) {
    throw new Error("Nothing to save");
  }

  // An absolute date the user actually wrote down beats a follow-up interval the model
  // guessed at. When both land on roughly the same day for the same person, keep the
  // dated one and suppress the generated nudge so the user isn't handed two reminders
  // for one commitment.
  const COLLISION_WINDOW_MS = 3 * 86_400_000;
  const now = Date.now();
  const suppressFollowUp = items.map((item) => {
    const days = item.followUpDays || item.parsed.follow_up_days;
    if (!item.createReminder || !days || !item.parsed.name) return false;
    const projected = now + days * 86_400_000;
    return suggestionItems.some((s) => {
      if (!s.personName || !namesMatch(s.personName, item.parsed.name!)) return false;
      const due = isoDayToLocalNoon(s.dueDateIso).getTime();
      return Math.abs(due - projected) <= COLLISION_WINDOW_MS;
    });
  });

  let created = 0;
  let updated = 0;
  const contactIds: string[] = [];

  for (const [index, item] of items.entries()) {
    const res = await confirmCapture({
      ...item,
      suppressFollowUpReminder: suppressFollowUp[index],
    });
    contactIds.push(res.contactId);
    if (item.mergeContactId) updated += 1;
    else created += 1;
  }

  // Contacts only exist now, so this is the first point a suggestion can be linked.
  const contactIdByName = new Map<string, string>();
  items.forEach((item, index) => {
    const name = item.parsed.name?.trim().toLowerCase();
    if (name && contactIds[index]) contactIdByName.set(name, contactIds[index]);
  });

  let suggestionsStaged = 0;
  if (suggestions && suggestionItems.length) {
    const db = await getDb();
    const rows = suggestionItems.map((s) => {
      const contactId =
        s.contactId ??
        (s.personName
          ? contactIdByName.get(s.personName.trim().toLowerCase()) ?? null
          : null);
      return {
        userId,
        contactId,
        captureBatchId: suggestions.captureBatchId,
        title: s.title,
        description: s.description,
        rawDatePhrase: s.rawDatePhrase,
        dueDate: isoDayToLocalNoon(s.dueDateIso),
        yearInferred: s.yearInferred ? 1 : 0,
        sourceExcerpt: s.sourceExcerpt,
        sourceHash: suggestions.sourceHash,
        itemHash: buildSuggestionItemHash(
          suggestions.sourceHash,
          s.dueDateIso,
          s.title
        ),
        actionKind: s.actionKind,
        confidenceScore: s.confidenceScore,
        status: "pending" as const,
      };
    });

    // Re-pasting the same note must not restage what the user already resolved.
    const inserted = await db
      .insert(suggestedReminders)
      .values(rows)
      .onConflictDoNothing({
        target: [suggestedReminders.userId, suggestedReminders.itemHash],
      })
      .returning();
    suggestionsStaged = inserted.length;
  }

  revalidatePath("/chat");
  revalidatePath("/contacts");
  revalidatePath("/capture");
  if (suggestionsStaged) {
    revalidatePath("/");
    revalidatePath("/dashboard");
    revalidatePath("/reminders");
  }

  return { created, updated, contactIds, suggestionsStaged };
}

export async function confirmCapture(input: {
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
   * Set by `confirmBulkCapture` when an absolute dated commitment for this person
   * already covers the same window. Defaults to false so other callers are unaffected.
   */
  suppressFollowUpReminder?: boolean;
}) {
  const userId = await requireUserId();
  const { parsed } = input;

  const followUpDate =
    input.createReminder && (input.followUpDays || parsed.follow_up_days)
      ? (() => {
          const d = new Date();
          d.setDate(d.getDate() + (input.followUpDays || parsed.follow_up_days || 14));
          return d;
        })()
      : null;

  let contactId = input.mergeContactId || null;
  const interactionDate =
    input.interactionDate?.trim() ||
    parsed.interaction_date?.trim() ||
    null;

  if (contactId) {
    // Merge: update profile fields from extraction, but do NOT overwrite
    // contacts.notes — the new material lives on the interaction timeline.
    await updateContact(contactId, {
      fullName: parsed.name || undefined,
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
      relationshipScore: input.relationshipScore,
      statedCloseness: input.relationshipScore,
      tagNames: input.tagNames,
      nextFollowUpAt: followUpDate?.toISOString() ?? undefined,
    });
  } else {
    if (!parsed.name) throw new Error("A name is required to create a contact");
    const created = await createContact({
      fullName: parsed.name,
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
      relationshipScore: input.relationshipScore,
      // The user set this in the capture review UI's "Closeness" field
      // (bulk-notes-panel.tsx) — a real rating, unlike an importer default.
      statedCloseness: input.relationshipScore,
      tagNames: input.tagNames,
      source: "ai_capture",
      notes: input.notes,
      nextFollowUpAt: followUpDate?.toISOString() ?? null,
    });
    contactId = created.id;
  }

  await logInteraction({
    contactId,
    rawNotes: input.notes,
    aiSummary: parsed.summary || undefined,
    topics: parsed.topics,
    actionItems: parsed.action_items,
    interactionType: input.interactionType || "meeting_note",
    source: "capture",
    interactionDate: interactionDate || undefined,
    parseDateFromNotes: !interactionDate,
  });

  // Note: the contact's nextFollowUpAt above is deliberately still set even when
  // suppressed — that's relationship hygiene, a separate signal from this task row.
  if (input.createReminder && followUpDate && !input.suppressFollowUpReminder) {
    const db = await getDb();
    const title =
      parsed.follow_up_recommendation || `Follow up with ${parsed.name}`;
    const { inferReminderActionKind } = await import(
      "@/lib/reminder-action-kind"
    );
    await db.insert(reminders).values({
      userId,
      contactId,
      title,
      description: parsed.suggested_next_message || undefined,
      dueDate: followUpDate,
      status: "pending",
      reminderType: "ai_suggested",
      actionKind: inferReminderActionKind({
        title,
        description: parsed.suggested_next_message,
        reminderType: "ai_suggested",
        contactId,
      }),
      createdBy: "ai",
    });
  }

  revalidatePath("/");
  revalidatePath("/contacts");
  revalidatePath(`/contacts/${contactId}`);
  revalidatePath("/capture");

  return {
    contactId,
    suggestedNextMessage: parsed.suggested_next_message,
  };
}
