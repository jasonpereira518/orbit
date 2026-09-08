/**
 * The capture parse pipeline: notes in, review items out.
 *
 * Lifted out of `parseBulkCaptureNotes` so two callers can share it without drifting — the
 * server action (which awaits the whole thing and returns one object) and
 * `/api/capture/parse` (which streams progress as it goes). This is the same arrangement
 * `askNetwork` and `/api/chat` use, and for the same reason: the action still has a real
 * consumer in `log-interaction-sheet.tsx`, which has no review step and nothing to stream
 * to, so deleting it in favour of the route would be a regression.
 *
 * Everything the route reports is optional. With no `onEvent` this behaves exactly as the
 * action always did.
 */

import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts } from "@/db/schema";
import {
  parseMultiPersonNotesWithAI,
  type CaptureParseHints,
  type ParsedNote,
  type ParsedPersonNote,
  type SharedNoteContext,
} from "@/lib/ai";
import { normalizePastedCaptureText } from "@/lib/capture-ingest";
import {
  personPreviewKey,
  type BulkNotePersonPreview,
  type SuggestedReminderPreview,
} from "@/lib/capture-preview";
import type {
  CaptureStreamEvent,
  CaptureStreamResult,
} from "@/lib/capture-stream-protocol";
import {
  fetchRawCommitments,
  validateCommitments,
  emptyCommitmentResult,
  type RejectedCounts,
} from "@/lib/date-commitment-extract";
import {
  buildDuplicateIndex,
  findDuplicateCandidatesIndexed,
  DUPLICATE_MERGE_CONFIDENCE,
  type DuplicateSubject,
} from "@/lib/duplicates";
import { resolveMentions, type MentionCandidate } from "@/lib/mention-resolution";
import type { PreviewMention } from "@/lib/note-batches";
import { getSelfIdentity, isSelf } from "@/lib/self-identity";
import { hashSourceNote, isoDay, isoDayToLocalNoon } from "@/lib/suggested-reminder-utils";

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

export type CaptureParseSuccess = CaptureStreamResult & {
  ok: true;
  items: BulkNotePersonPreview[];
  hints: CaptureParseHints;
};

export type CaptureParseFailure = { ok: false; error: string };

export type CaptureParseOutcome = CaptureParseSuccess | CaptureParseFailure;

/**
 * Run the parse, optionally reporting progress.
 *
 * Throws rather than returning `{ ok: false }` for unexpected failures — both callers wrap
 * this, and they need the original error to run it through `toUserFacingError` (the missing
 * API key case in particular has to reach the panel intact so it can offer the key prompt).
 * A `{ ok: false }` here is only ever a user-facing "nothing usable in these notes".
 */
export async function runCaptureParse(
  userId: string,
  notes: string,
  hints?: CaptureParseHints | null,
  onEvent?: (event: CaptureStreamEvent) => void
): Promise<CaptureParseOutcome> {
  const emit = (event: CaptureStreamEvent) => onEvent?.(event);

  emit({ type: "stage", stage: "reading" });

  // Auto-detect pasted ICS / email forwards when caller didn't supply hints.
  const detected = normalizePastedCaptureText(notes);
  const self = await getSelfIdentity(userId);
  const rawSeedPeople = [
    ...(hints?.seedPeople || []),
    ...(detected.hints.seedPeople || []),
  ];
  // The root of the self-contact bug. A pasted invite seeds the organizer and every
  // attendee, and a forwarded email seeds From/To/Cc — the user is in one of those every
  // time. `parseMultiPersonTwoPass` then force-adds any seed the model didn't return, so
  // an unfiltered seed becomes a participant even when the model correctly omitted them.
  const seedPeople = rawSeedPeople.filter((p) => !isSelf(p, self));
  let selfFiltered = seedPeople.length < rawSeedPeople.length;
  const mergedHints: CaptureParseHints = {
    eventDate: hints?.eventDate || detected.hints.eventDate || null,
    seedPeople: seedPeople.length ? seedPeople : undefined,
    interactionType:
      hints?.interactionType || detected.hints.interactionType || null,
    self:
      self.name || self.emails.size
        ? { name: self.name, email: [...self.emails][0] ?? null }
        : null,
  };

  const corpus =
    detected.sources.includes("calendar") || detected.sources.includes("email")
      ? detected.text
      : notes;

  const db = await getDb();
  // Started before the model calls rather than after them. Nothing about the contact list
  // depends on the parse, and the streaming path needs the duplicate index in hand by the
  // time the first detail batch lands so a person row can carry its New/Update badge on
  // arrival.
  const existingPromise = db.query.contacts.findMany({
    where: eq(contacts.userId, userId),
  });

  const today = new Date();
  const interactionType = mergedHints.interactionType || "meeting_note";

  /* ---------------------------------------------------------------------------------- */
  /* Progressive item construction                                                       */
  /* ---------------------------------------------------------------------------------- */

  let duplicateIndex: ReturnType<typeof buildDuplicateIndex> | null = null;
  let rosterContext: {
    sharedNotes: SharedNoteContext[];
    interactionDate: string | null;
  } | null = null;
  const emitted = new Set<string>();
  // A person can be detailed before the contact query resolves. Rather than make the
  // callback async (ai.ts calls it synchronously), park them and drain once the index
  // exists. In practice the query wins the race by a whole model call; the buffer is here
  // so correctness does not depend on that.
  const parked: ParsedPersonNote[] = [];
  let participantCount = 0;

  const buildItem = (
    person: ParsedPersonNote,
    index: number,
    sharedNotes: SharedNoteContext[],
    defaultDate: string | null,
    dupIndex: ReturnType<typeof buildDuplicateIndex>
  ): BulkNotePersonPreview => {
    const { source_excerpt, ...parsedBase } = person;
    const sharedForPerson = sharedNotesForPerson(parsedBase.name, sharedNotes);

    const parsed: ParsedNote = {
      ...parsedBase,
      met_at:
        parsedBase.met_at || sharedForPerson.find((s) => s.met_at)?.met_at || null,
      topics: mergeTopics(parsedBase.topics, sharedForPerson),
      interaction_date: parsedBase.interaction_date || defaultDate,
    };

    const duplicates = findDuplicateCandidatesIndexed(dupIndex, {
      fullName: parsed.name,
      email: parsed.email,
      linkedinUrl: parsed.linkedin_url,
      company: parsed.company,
      title: parsed.role,
    }).slice(0, 5);

    const top = duplicates[0];

    return {
      key: personPreviewKey(index, parsed.name),
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
      suggestedMergeId:
        top && top.confidence >= DUPLICATE_MERGE_CONFIDENCE ? top.contact.id : null,
      sharedNoteTexts: sharedForPerson.map((s) => s.text),
      interactionDate: parsed.interaction_date,
      interactionType,
    };
  };

  const drain = () => {
    if (!duplicateIndex || !onEvent) return;
    while (parked.length) {
      const person = parked.shift()!;
      const item = buildItem(
        person,
        participantCount,
        rosterContext?.sharedNotes ?? [],
        rosterContext?.interactionDate ?? mergedHints.eventDate ?? null,
        duplicateIndex
      );
      participantCount += 1;
      emitted.add(item.key);
      emit({ type: "person", item });
    }
  };

  void existingPromise.then((rows) => {
    duplicateIndex = buildDuplicateIndex(rows);
    drain();
  });

  /* ---------------------------------------------------------------------------------- */
  /* The model calls                                                                     */
  /* ---------------------------------------------------------------------------------- */

  emit({ type: "stage", stage: "identifying" });

  // Run both extractions concurrently. The commitment pass is failure-isolated:
  // contact extraction is the core value and must survive a bad dates response.
  const [personParse, rawCommitments] = await Promise.all([
    parseMultiPersonNotesWithAI(userId, corpus, mergedHints, {
      onRoster: (people, context) => {
        rosterContext = context;
        // Filtered the same way `participants` is below, so a roster row and the `person`
        // event that fills it in agree on their index — and therefore on their key.
        const shown = people.filter(
          (p) =>
            p.presence !== "mentioned" &&
            !isSelf({ name: p.name, email: p.email }, self)
        );
        emit({
          type: "roster",
          people: shown.map((p, index) => ({
            key: personPreviewKey(index, p.name),
            name: p.name,
            company: p.company ?? null,
            role: p.role ?? null,
          })),
        });
        emit({ type: "stage", stage: "detailing", done: 0, total: shown.length });
      },
      onDetailBatch: (done, total) => {
        emit({ type: "stage", stage: "detailing", done, total });
      },
      onPerson: (person) => {
        if (!onEvent) return;
        if (person.presence === "mentioned") return;
        if (isSelf({ name: person.name, email: person.email, linkedinUrl: person.linkedin_url }, self)) {
          return;
        }
        parked.push(person);
        drain();
      },
    }),
    fetchRawCommitments(userId, corpus, {
      today,
      knownPeople: seedPeople.map((p) => p.name).filter(Boolean) as string[],
    }).catch(() => [] as Awaited<ReturnType<typeof fetchRawCommitments>>),
  ]);

  const { people, shared_notes, interaction_date } = personParse;

  /* ---------------------------------------------------------------------------------- */
  /* Assembly                                                                            */
  /* ---------------------------------------------------------------------------------- */

  emit({ type: "stage", stage: "dating" });

  // Backstop the seed filter and the prompt instruction: the model can still name the
  // author from the note body itself ("Jason walked me through the roadmap").
  const notSelf = people.filter(
    (p) => !isSelf({ name: p.name, email: p.email, linkedinUrl: p.linkedin_url }, self)
  );
  if (notSelf.length < people.length) selfFiltered = true;
  // people[] mixes two roles: participants (actually talked to) and mentions demoted into
  // people[] because the note gave them real profile detail. Only participants get a
  // review card; demoted mentions fold into mention resolution below.
  const participants = notSelf.filter((p) => p.presence !== "mentioned");
  const demoted = notSelf.filter((p) => p.presence === "mentioned");

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

  emit({ type: "stage", stage: "matching" });

  const existing = await existingPromise;
  const defaultDate = interaction_date || mergedHints.eventDate || null;

  // One index for every person in the note, rather than a fresh scan of the whole
  // contact list per person.
  const index = duplicateIndex ?? buildDuplicateIndex(existing);

  const items: BulkNotePersonPreview[] = participants.map((person, i) =>
    buildItem(person, i, shared_notes, defaultDate, index)
  );

  // Anyone the stream never reached — the single-pass path, an aborted drain, a person the
  // roster filter and the final filter disagreed about — is sent now, so the client's list
  // is complete no matter which path ran.
  for (const item of items) {
    if (!emitted.has(item.key)) {
      emitted.add(item.key);
      emit({ type: "person", item });
    }
  }

  // Self has to be dropped here too, not just from participants: an unresolved mention
  // gets an "Add as contact" button on the results page, so leaving the owner in
  // mentions[] would only relocate the bug one screen later.
  const candidates: MentionCandidate[] = [
    ...personParse.mentions
      .filter((m) => !isSelf({ name: m.name }, self))
      .map((m) => ({ name: m.name, context: m.context, nearPerson: m.near_person })),
    // A demoted mention with no usable name has nothing to resolve against — the
    // non-null assertion below would otherwise hand `resolveMentions` a null name.
    ...demoted
      .filter((p) => p.name?.trim())
      .map((p) => ({ name: p.name!.trim(), context: p.summary, company: p.company, nearPerson: null })),
  ];
  const subjects: DuplicateSubject[] = existing.map((c) => ({
    id: c.id,
    fullName: c.fullName,
    email: c.email,
    linkedinUrl: c.linkedinUrl,
    xHandle: c.xHandle,
    company: c.company,
    title: c.title,
  }));
  const { resolved, unresolved } = resolveMentions(subjects, candidates, {
    excludeContactIds: items
      .map((i) => i.suggestedMergeId)
      .filter((id): id is string => Boolean(id)),
  });
  const mentions: PreviewMention[] = [
    ...resolved.map((m) => ({ text: m.text, context: m.context, nearPerson: m.nearPerson, contactId: m.contactId, confidence: m.confidence, matchedBy: m.matchedBy })),
    ...unresolved.map((m) => ({ text: m.text, context: m.context, nearPerson: m.nearPerson, contactId: null, confidence: 0, matchedBy: null })),
  ];

  // A note can legitimately carry dates but no people ("Board review 15th of October"),
  // so only fail when both extractions came back empty.
  // Mentions alone are not saveable: they hang on a participant's interaction.
  if (!participants.length && !commitmentResult.commitments.length) {
    return {
      ok: false,
      // "No people found" would be a lie when the only person in the note was the user.
      error: selfFiltered
        ? "The only person in those notes was you — nothing to add"
        : "No people or dates found in those notes",
    };
  }

  const suggestedReminders: SuggestedReminderPreview[] =
    commitmentResult.commitments.map((c, i) => ({
      key: `${i}-${c.rawDatePhrase}`,
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
    ok: true,
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
    sourceHash: hashSourceNote(corpus),
    suggestedReminders,
    suggestionsSkipped: commitmentResult.rejected as RejectedCounts,
    mentions,
  };
}
