"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { contacts, reminders } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import {
  parseNotesWithAI,
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

export async function parseCaptureNotes(notes: string) {
  try {
    const userId = await requireUserId();
    if (!notes.trim()) {
      return { ok: false as const, error: "Notes are required" };
    }

    const parsed = await parseNotesWithAI(userId, notes);

    const db = await getDb();
    const existing = await db.query.contacts.findMany({
      where: eq(contacts.userId, userId),
    });

    const duplicates = findDuplicateCandidates(existing, {
      fullName: parsed.name,
      email: parsed.email,
      linkedinUrl: parsed.linkedin_url,
      company: parsed.company,
      title: parsed.role,
    }).slice(0, 5);

    return {
      ok: true as const,
      parsed,
      duplicates: duplicates.map((d) => ({
        id: d.contact.id,
        fullName: d.contact.fullName,
        company: d.contact.company,
        title: d.contact.title,
        reason: d.reason,
        confidence: d.confidence,
      })),
    };
  } catch (err) {
    const { toUserFacingError } = await import("@/lib/errors");
    return {
      ok: false as const,
      error: toUserFacingError(err, MISSING_AI_API_KEY_MESSAGE).message,
    };
  }
}

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

    const { people, shared_notes, interaction_date } =
      await parseMultiPersonNotesWithAI(userId, corpus, mergedHints);
    if (!people.length) {
      return { ok: false as const, error: "No people found in those notes" };
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

    return {
      ok: true as const,
      items,
      sharedNotes: shared_notes,
      interactionDate: defaultDate,
      interactionType,
      hints: mergedHints,
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
  }>
) {
  await requireUserId();
  if (!items.length) throw new Error("Nothing to save");

  let created = 0;
  let updated = 0;
  const contactIds: string[] = [];

  for (const item of items) {
    const res = await confirmCapture(item);
    contactIds.push(res.contactId);
    if (item.mergeContactId) updated += 1;
    else created += 1;
  }

  revalidatePath("/chat");
  revalidatePath("/contacts");
  revalidatePath("/capture");

  return { created, updated, contactIds };
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

  if (input.createReminder && followUpDate) {
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
