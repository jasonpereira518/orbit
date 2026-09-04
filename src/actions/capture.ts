"use server";

import { RATE_LIMITS, consumeBucket } from "@/lib/rate-limit";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { getDb } from "@/db";
import { contacts, type ReminderActionKind } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import {
  fetchRawCommitments,
  validateCommitments,
  emptyCommitmentResult,
  type RejectedCounts,
} from "@/lib/date-commitment-extract";
import type { DateBasis } from "@/lib/relative-date";
import { hashSourceNote, isoDay, isoDayToLocalNoon } from "@/lib/suggested-reminder-utils";
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
import {
  CAPTURE_MAX_UPLOAD_BYTES,
  formatUploadSize,
} from "@/lib/capture-limits";
import {
  buildDuplicateIndex,
  findDuplicateCandidatesIndexed,
} from "@/lib/duplicates";
import { MISSING_AI_API_KEY_MESSAGE, toUserFacingError } from "@/lib/errors";
import { kickEmbeddingBackfill } from "@/lib/embedding-backfill";
import { resolveMentions, type MentionCandidate } from "@/lib/mention-resolution";
import type { PreviewMention } from "@/lib/note-batches";
import {
  saveNoteBatch,
  type NoteBatchCommitmentInput,
  type NoteBatchMentionInput,
  type NoteBatchParticipantInput,
} from "@/lib/note-batch-save";
import { generateAndStoreContactBrief } from "@/lib/contact-brief";

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
    await consumeBucket("capture", userId, RATE_LIMITS.capture);
    const hasText = Boolean(input.text?.trim());
    const hasFiles = Boolean(input.files?.length);
    if (!hasText && !hasFiles) {
      return { ok: false as const, error: "Add notes or upload a file first" };
    }

    // The panel checks this before encoding, but a non-browser caller can reach the action
    // directly — and an oversized body is truncated in transit rather than refused, so the
    // only alternative to an explicit error is a mystery parse failure. Measured on the
    // decoded bytes so the number matches the file the caller actually sent.
    const uploadBytes = (input.files ?? []).reduce(
      (sum, file) => sum + Math.floor((file.base64.length * 3) / 4),
      0
    );
    if (uploadBytes > CAPTURE_MAX_UPLOAD_BYTES) {
      return {
        ok: false as const,
        error: `That upload is ${formatUploadSize(uploadBytes)} — the limit is ${formatUploadSize(CAPTURE_MAX_UPLOAD_BYTES)}. Try fewer or smaller files.`,
      };
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
    await consumeBucket("capture", userId, RATE_LIMITS.capture);
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
    // people[] mixes two roles: participants (actually talked to) and mentions demoted into
    // people[] because the note gave them real profile detail. Only participants get a
    // review card; demoted mentions fold into mention resolution below.
    const participants = people.filter((p) => p.presence !== "mentioned");
    const demoted = people.filter((p) => p.presence === "mentioned");
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

    const db = await getDb();
    const existing = await db.query.contacts.findMany({
      where: eq(contacts.userId, userId),
    });

    const defaultDate = interaction_date || mergedHints.eventDate || null;
    const interactionType = mergedHints.interactionType || "meeting_note";

    // One index for every person in the note, rather than a fresh scan of the whole
    // contact list per person.
    const duplicateIndex = buildDuplicateIndex(existing);

    const items: BulkNotePersonPreview[] = participants.map((person, index) => {
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

      const duplicates = findDuplicateCandidatesIndexed(duplicateIndex, {
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

    const candidates: MentionCandidate[] = [
      ...personParse.mentions.map((m) => ({ name: m.name, context: m.context, nearPerson: m.near_person })),
      // A demoted mention with no usable name has nothing to resolve against — the
      // non-null assertion below would otherwise hand `resolveMentions` a null name.
      ...demoted
        .filter((p) => p.name?.trim())
        .map((p) => ({ name: p.name!.trim(), context: p.summary, company: p.company, nearPerson: null })),
    ];
    const { resolved, unresolved } = resolveMentions(
      existing.map((c) => ({ id: c.id, fullName: c.fullName, email: c.email, linkedinUrl: c.linkedinUrl, xHandle: c.xHandle, company: c.company, title: c.title })),
      candidates,
      { excludeContactIds: items.map((i) => i.suggestedMergeId).filter((id): id is string => Boolean(id)) }
    );
    const mentions: PreviewMention[] = [
      ...resolved.map((m) => ({ text: m.text, context: m.context, nearPerson: m.nearPerson, contactId: m.contactId, confidence: m.confidence, matchedBy: m.matchedBy })),
      ...unresolved.map((m) => ({ text: m.text, context: m.context, nearPerson: m.nearPerson, contactId: null, confidence: 0, matchedBy: null })),
    ];

    // A note can legitimately carry dates but no people ("Board review 15th of October"),
    // so only fail when both extractions came back empty.
    // Mentions alone are not saveable: they hang on a participant's interaction.
    if (!participants.length && !commitmentResult.commitments.length) {
      return {
        ok: false as const,
        error: "No people or dates found in those notes",
      };
    }

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
      // Computed server-side and echoed back on save, so the client can't forge a hash
      // that would collide with (or evade) another note's dedupe key. sourceText is
      // echoed too: confirmBulkCapture recomputes the hash from it to detect tampering.
      sourceText: corpus,
      sourceHash,
      suggestedReminders: suggestedRemindersPreview,
      suggestionsSkipped: commitmentResult.rejected as RejectedCounts,
      mentions,
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
  items: NoteBatchParticipantInput[],
  batch: {
    sourceHash: string;
    sourceText: string;
    anchorIso: string;
    anchorBasis: "note" | "hint" | "upload";
    entryPoint?: "capture" | "profile";
    seedContactId?: string | null;
    commitments: NoteBatchCommitmentInput[];
    mentions?: NoteBatchMentionInput[];
    skipped: RejectedCounts;
  }
) {
  const userId = await requireUserId();
  await consumeBucket("capture", userId, RATE_LIMITS.capture);
  // The hash is recomputed server-side: the client echoes sourceText, and a forged hash
  // could collide with (or evade) another note's dedupe keys.
  const sourceHash = hashSourceNote(batch.sourceText);
  if (sourceHash !== batch.sourceHash) throw new Error("Note text changed since parsing; re-run extraction");

  const out = await saveNoteBatch(userId, {
    sourceText: batch.sourceText,
    sourceHash,
    anchorIso: batch.anchorIso,
    anchorBasis: batch.anchorBasis,
    entryPoint: batch.entryPoint ?? "capture",
    seedContactId: batch.seedContactId ?? null,
    participants: items,
    commitments: batch.commitments,
    mentions: batch.mentions ?? [],
    skipped: batch.skipped,
  });

  // The lib skipped embeddings and summaries (it must run outside a request scope for the
  // smoke suite); this is the request scope, so schedule them here.
  after(async () => {
    await kickEmbeddingBackfill(userId).catch(() => null);
    for (const id of out.contactIds) {
      await generateAndStoreContactBrief(userId, id).catch(() => null);
    }
  });

  revalidatePath("/");
  revalidatePath("/dashboard");
  revalidatePath("/contacts");
  revalidatePath("/capture");
  revalidatePath("/reminders");
  revalidatePath("/graph");
  for (const id of out.contactIds) revalidatePath(`/contacts/${id}`);
  return out;
}
