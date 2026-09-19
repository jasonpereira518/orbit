/**
 * The capture parse, with no auth and no request-scope dependency: pasted or transcribed
 * notes in, reviewable people + dated commitments + mentions out.
 *
 * Two callers, one pipeline:
 *   - `parseBulkCaptureNotes` (src/actions/capture.ts) — the chat side sheet, the
 *     onboarding wizard and `log-interaction-sheet.tsx`, which parse inside a request.
 *   - `runCaptureJobById` (src/lib/capture-job-runner.ts) — the /capture page's durable
 *     job, which may run from `after()`, an internal kick, or the stall cron.
 *
 * Throws `UserFacingError` for the cases the person should read verbatim ("No people or
 * dates found…"); anything else is a real failure the callers word with `friendlyError`.
 */
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts } from "@/db/schema";
import {
  parseMultiPersonNotesWithAI,
  type ParseProgress,
  type CaptureParseHints,
  type ParsedNote,
  type SharedNoteContext,
} from "@/lib/ai";
import {
  fetchRawCommitments,
  validateCadences,
  validateCommitments,
  emptyCommitmentResult,
  type RejectedCounts,
} from "@/lib/date-commitment-extract";
import { normalizePastedCaptureText } from "@/lib/capture-ingest";
import { buildDuplicateIndex, findDuplicateCandidatesIndexed, type DuplicateSubject } from "@/lib/duplicates";
import { UserFacingError } from "@/lib/errors";
import { isSelf } from "@/lib/meeting-digest";
import { getMeetingTranscript, loadMeetingSelf } from "@/lib/meeting-sessions";
import { resolveMentionsWithPicks, type MentionCandidate } from "@/lib/mention-resolution";
import type { MentionPick } from "@/lib/mentions/mention-picks";
import type { PreviewMention } from "@/lib/note-batches";
import { hashSourceNote, isoDay, isoDayToLocalNoon } from "@/lib/suggested-reminder-utils";
import { emptyOpportunityResult, validateOpportunities } from "@/lib/opportunity-extract";
import { emptyImpliedResult, validateImpliedNextSteps } from "@/lib/implied-next-steps";
import { inferReminderActionKind } from "@/lib/reminder-action-kind";
import { DEFAULT_FOLLOW_UP_WINDOW_DAYS, windowDueDate } from "@/lib/note-batches";
import { listActiveGoalTextsForUser } from "@/lib/user-goals";
import type {
  BulkNotePersonPreview,
  CaptureParseResult,
  MentionedOnlyPerson,
  SuggestedReminderPreview,
} from "@/lib/capture/types";

export type { CaptureParseResult } from "@/lib/capture/types";

export type CaptureParseOptions = {
  /**
   * Set when the notes are a recorded meeting's corpus (`analyzeMeetingSession`). Three
   * things change: dated commitments are verified against the meeting's stored transcript
   * rather than the AI-written corpus, the user is never offered as a person, and a
   * meeting with no people and no dates is still a valid result — its summary, blockers
   * and questions are worth saving on their own.
   */
  meetingSessionId?: string | null;
  /** The user's active goals for `relevance` scoring. Loaded from `user_goals` when omitted. */
  goals?: string[];
  /**
   * Contacts named with `@` in the composer.
   *
   * Sanitised by the boundary that took them from the browser (`sanitizeMentionPicks`) and
   * checked against the user's own contacts by `resolveMentionsWithPicks`, which is the
   * only thing here that knows what the user owns.
   */
  mentionPicks?: readonly MentionPick[];
  /** Injectable clock, for the smoke suite. */
  now?: Date;
  /**
   * Called after each model call of the people parse. The capture runner heartbeats its
   * claim here so a long multi-call parse is never mistaken for a dead one and run twice.
   */
  onProgress?: ParseProgress;
};

export const NO_PEOPLE_OR_DATES_MESSAGE = "No people or dates found in those notes";

function namesMatch(a: string, b: string) {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function sharedNotesForPerson(
  personName: string | null,
  sharedNotes: SharedNoteContext[]
): SharedNoteContext[] {
  if (!personName?.trim()) return [];
  return sharedNotes.filter((s) => s.person_names.some((n) => namesMatch(n, personName)));
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

function mergeTopics(personTopics: string[] | undefined, shared: SharedNoteContext[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of [...(personTopics || []), ...shared.flatMap((s) => s.topics || [])]) {
    const key = t.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(t.trim());
  }
  return out;
}

export async function runCaptureParse(
  userId: string,
  notes: string,
  hints: CaptureParseHints | null | undefined,
  opts: CaptureParseOptions = {}
): Promise<CaptureParseResult> {
  if (!notes.trim()) throw new UserFacingError("Notes are required");

  const meeting = opts.meetingSessionId
    ? await getMeetingTranscript(userId, opts.meetingSessionId)
    : null;
  if (opts.meetingSessionId && !meeting) {
    throw new UserFacingError("That meeting no longer exists");
  }
  const self = meeting ? await loadMeetingSelf(userId) : null;
  const goals = opts.goals ?? (await listActiveGoalTextsForUser(userId).catch(() => [] as string[]));

  // Auto-detect pasted ICS / email forwards when caller didn't supply hints.
  const detected = normalizePastedCaptureText(notes);
  const seedPeople = [...(hints?.seedPeople || []), ...(detected.hints.seedPeople || [])];
  const mergedHints: CaptureParseHints = {
    eventDate: hints?.eventDate || detected.hints.eventDate || null,
    seedPeople: seedPeople.length ? seedPeople : undefined,
    interactionType: hints?.interactionType || detected.hints.interactionType || null,
    goals: goals.length ? goals : undefined,
  };

  const corpus =
    detected.sources.includes("calendar") || detected.sources.includes("email")
      ? detected.text
      : notes;

  // Run all three concurrently. The commitment pass is failure-isolated: contact
  // extraction is the core value and must survive a bad dates response. The duplicate
  // lookup only depends on userId, so it doesn't need to wait on either AI call.
  const today = opts.now ?? new Date();
  const [personParse, rawCommitments, existing] = await Promise.all([
    parseMultiPersonNotesWithAI(userId, corpus, mergedHints, { onProgress: opts.onProgress }),
    fetchRawCommitments(userId, corpus, {
      today,
      knownPeople: seedPeople.map((p) => p.name).filter(Boolean) as string[],
    }).catch(
      () => ({ commitments: [], cadences: [] }) as Awaited<ReturnType<typeof fetchRawCommitments>>
    ),
    getDb().then((db) =>
      db.query.contacts.findMany({
        where: eq(contacts.userId, userId),
        columns: {
          id: true,
          fullName: true,
          email: true,
          linkedinUrl: true,
          xHandle: true,
          company: true,
          title: true,
        } satisfies Record<keyof DuplicateSubject, true>,
      })
    ),
  ]);

  const { shared_notes, interaction_date } = personParse;
  // The person recording a meeting is on every call they record, and the corpus says
  // "I am <name>" — which a parser reads as one more participant. Never a contact.
  const people = self
    ? personParse.people.filter((p) => !p.name || !isSelf(p.name, self))
    : personParse.people;
  // people[] mixes two roles: participants (actually talked to) and mentions demoted into
  // people[] because the note gave them real profile detail. Only participants get a
  // review card; demoted mentions fold into mention resolution below, and are also
  // surfaced as `mentionedOnly` so the job path can file them as ignored people.
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
      // For a meeting, the corpus is AI-written, so "the phrase appears in the note"
      // would only prove the digest wrote it. The transcript is what was actually said.
      return validateCommitments(rawCommitments.commitments, meeting ? meeting.text : corpus, { today, anchor });
    } catch {
      return emptyCommitmentResult();
    }
  })();

  // Cadences ride the same pass. They are not reminders: a stated rhythm changes how long
  // this person may go quiet before Orbit says anything, which is a property of the contact.
  const cadences = (() => {
    try {
      return validateCadences(rawCommitments.cadences, meeting ? meeting.text : corpus, { today, anchor });
    } catch {
      return [];
    }
  })();
  const cadenceByName = new Map(
    cadences
      .filter((c) => c.personName)
      .map((c) => [c.personName!.trim().toLowerCase(), c])
  );
  // A cadence stated with nobody named belongs to the only person in the note; with several
  // people it is ambiguous, and guessing would retune the wrong relationship.
  const unnamedCadence = cadences.find((c) => !c.personName) ?? null;

  const defaultDate = interaction_date || mergedHints.eventDate || null;
  const interactionType = mergedHints.interactionType || "meeting_note";

  // One index for every person in the note, rather than a fresh scan of the whole
  // contact list per person.
  const duplicateIndex = buildDuplicateIndex(existing);

  /**
   * Picked contacts, by every name they could be written under in the note.
   *
   * `@Sarah` is the user answering the question the duplicate matcher is about to guess at,
   * so where they agree this changes nothing and where they disagree the user wins. The
   * case it exists for is the one the matcher cannot do anything about: a contact filed as
   * "Sarah Chen-Alvarez" and a note that says Sarah.
   */
  const ownedById = new Map(existing.map((c) => [c.id, c]));
  const pickedByName = new Map<string, string>();
  for (const pick of opts.mentionPicks ?? []) {
    // Not the caller's contact — forged, or deleted since the pick. Same check, and same
    // reasoning, as `resolveMentionsWithPicks`.
    const contact = ownedById.get(pick.id);
    if (!contact) continue;
    for (const name of [pick.name, contact.fullName]) {
      const key = name?.trim().toLowerCase();
      // First pick wins, so two people cannot fight over one spelling.
      if (key && !pickedByName.has(key)) pickedByName.set(key, pick.id);
    }
  }

  const items: BulkNotePersonPreview[] = participants.map((person, index) => {
    const { source_excerpt, ...parsedBase } = person;
    const sharedForPerson = sharedNotesForPerson(parsedBase.name, shared_notes);

    const parsed: ParsedNote = {
      ...parsedBase,
      met_at: parsedBase.met_at || sharedForPerson.find((s) => s.met_at)?.met_at || null,
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
      pickedByName.get(parsed.name?.trim().toLowerCase() ?? "") ??
      (top && top.confidence >= 0.85 ? top.contact.id : null);

    // Same haystack choice the commitments pass makes above, for the same reason: a
    // meeting's corpus is AI-written, so containment in it would only prove the digest
    // wrote it. The transcript is what was actually said.
    const haystack = meeting ? meeting.text : corpus;
    const opportunityResult = (() => {
      try {
        return validateOpportunities(parsed.opportunities, haystack, { today, anchor });
      } catch {
        return emptyOpportunityResult();
      }
    })();
    const impliedResult = (() => {
      try {
        return validateImpliedNextSteps(parsed.implied_next_steps, haystack, {
          explicitActionItems: parsed.action_items,
          // Collides against every dated commitment in the note, not just this person's:
          // the commitments pass does not always attribute one, and an inference that
          // duplicates an unattributed commitment is just as redundant.
          commitmentTitles: commitmentResult.commitments.map((c) => c.title),
        });
      } catch {
        return emptyImpliedResult();
      }
    })();

    return {
      key: `${index}-${parsed.name || "person"}`,
      notes: composePersonNotes(source_excerpt, sharedForPerson, corpus),
      parsed,
      opportunities: opportunityResult.opportunities.map((o) => ({
        kind: o.kind,
        label: o.label,
        direction: o.direction,
        sourceExcerpt: o.sourceExcerpt,
        rawDatePhrase: o.rawDatePhrase,
        confidenceScore: o.confidenceScore,
        dueDateIso: o.dueDate ? isoDay(o.dueDate) : null,
      })),
      impliedSteps: impliedResult.steps,
      cadence: (() => {
        const named = parsed.name ? cadenceByName.get(parsed.name.trim().toLowerCase()) : undefined;
        const c = named ?? (participants.length === 1 ? unnamedCadence : null);
        return c ? { days: c.days, phrase: c.rawPhrase, sourceExcerpt: c.sourceExcerpt } : null;
      })(),
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

  const mentionedOnly: MentionedOnlyPerson[] = demoted
    .filter((p) => p.name?.trim())
    .map((p) => ({ name: p.name!.trim(), context: p.summary ?? null, company: p.company ?? null }));

  const candidates: MentionCandidate[] = [
    ...personParse.mentions.map((m) => ({ name: m.name, context: m.context, nearPerson: m.near_person })),
    // A demoted mention with no usable name has nothing to resolve against — the
    // non-null assertion above would otherwise hand `resolveMentions` a null name.
    ...mentionedOnly.map((p) => ({ name: p.name, context: p.context, company: p.company, nearPerson: null })),
  ];
  const { resolved, unresolved } = resolveMentionsWithPicks(
    existing.map((c) => ({ id: c.id, fullName: c.fullName, email: c.email, linkedinUrl: c.linkedinUrl, xHandle: c.xHandle, company: c.company, title: c.title })),
    candidates,
    opts.mentionPicks ?? [],
    { excludeContactIds: items.map((i) => i.suggestedMergeId).filter((id): id is string => Boolean(id)) }
  );
  const mentions: PreviewMention[] = [
    ...resolved.map((m) => ({ text: m.text, context: m.context, nearPerson: m.nearPerson, contactId: m.contactId, confidence: m.confidence, matchedBy: m.matchedBy })),
    ...unresolved.map((m) => ({ text: m.text, context: m.context, nearPerson: m.nearPerson, contactId: null, confidence: 0, matchedBy: null })),
  ];

  // A note can legitimately carry dates but no people ("Board review 15th of October"),
  // so only fail when both extractions came back empty.
  // Mentions alone are not saveable: they hang on a participant's interaction.
  if (!meeting && !participants.length && !commitmentResult.commitments.length) {
    throw new UserFacingError(NO_PEOPLE_OR_DATES_MESSAGE);
  }

  const sourceHash = hashSourceNote(corpus);
  const suggestedReminders: SuggestedReminderPreview[] = commitmentResult.commitments.map(
    (c, index) => ({
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
      origin: "explicit" as const,
      rationale: null,
    })
  );

  // Implied next steps ride the same review list as dated commitments, because they end up
  // as the same kind of row — but they carry `origin: "implied"` and a rationale instead of
  // a date phrase, and `defaultReminderKeys` only pre-ticks the ones above the auto-tick bar.
  const impliedReminders: SuggestedReminderPreview[] = items.flatMap((item, personIndex) =>
    item.impliedSteps.map((step, stepIndex) => ({
      key: `implied-${personIndex}-${stepIndex}`,
      title: step.text,
      description: step.rationale,
      // No date was said, so there is no phrase to quote. The review UI shows the rationale
      // in this slot instead — see `SourceLine`.
      rawDatePhrase: null,
      dueDateIso: isoDay(windowDueDate(anchor, DEFAULT_FOLLOW_UP_WINDOW_DAYS)),
      yearInferred: false,
      personName: item.parsed.name,
      actionKind: inferReminderActionKind({
        title: step.text,
        description: step.rationale,
        reminderType: "ai_suggested",
        contactId: item.suggestedMergeId,
      }),
      confidenceScore: step.confidenceScore,
      sourceExcerpt: step.sourceExcerpt,
      dateBasis: "vague" as const,
      anchorIso: isoDay(anchor),
      origin: "implied" as const,
      rationale: step.rationale,
    }))
  );

  return {
    items,
    sharedNotes: shared_notes,
    interactionDate: defaultDate,
    interactionType,
    anchorIso: isoDay(anchor),
    anchorBasis,
    hints: mergedHints,
    sourceText: corpus,
    sourceHash,
    suggestedReminders: [...suggestedReminders, ...impliedReminders],
    suggestionsSkipped: commitmentResult.rejected as RejectedCounts,
    mentions,
    mentionedOnly,
  };
}
