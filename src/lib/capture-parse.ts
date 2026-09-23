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
import { contacts, tags } from "@/db/schema";
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
import { resolvePastedLinkedInProfiles } from "@/lib/linkedin-capture";
import {
  extractLinkedInProfileRefs,
  isLinkedInOnlyPaste,
  linkedInFactsBlock,
  linkedInOnlyNoteText,
  parsedNoteFromLinkedInPerson,
  type LinkedInProfileRef,
} from "@/lib/linkedin-paste";
import { isSelf } from "@/lib/meeting-digest";
import { getMeetingTranscript, loadMeetingSelf } from "@/lib/meeting-sessions";
import { openEngines, type Engines } from "@/lib/decisions/engine";
import { decideCaptureChecks, decideMentions, decideMergeTargets } from "@/lib/decisions/capture";
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
   * The account's decision engines — who a mention means, and a card's default save target
   * (decisions/capture.ts). Opened here when absent; pass `NO_ENGINES` for the rules alone.
   */
  engines?: Engines;
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

  const profileRefs = extractLinkedInProfileRefs(notes);

  // Paste a profile URL and nothing else and there is no prose to read — the model pass
  // would be a round-trip and a charge to learn nothing the URL doesn't already say. It
  // also means this works with no AI key at all, which is the only reason "paste a
  // LinkedIn URL" is a dependable way in rather than one more thing gated on setup.
  // Never for a meeting: that corpus is a transcript, and its own rules apply.
  if (!meeting && profileRefs.length && isLinkedInOnlyPaste(notes)) {
    return parsePastedLinkedInProfiles(userId, profileRefs, opts.now ?? new Date());
  }

  // Auto-detect pasted ICS / email forwards when caller didn't supply hints.
  const detected = normalizePastedCaptureText(notes);

  // URLs sitting inside real notes: resolve them first so the model attaches a role and
  // company to the right person instead of guessing from a slug, or leaving the URL as
  // the only thing it knows about them.
  const linkedin = profileRefs.length
    ? await resolvePastedLinkedInProfiles(userId, profileRefs)
    : null;

  /**
   * Only profiles that actually resolved may speak into a note.
   *
   * A slug-derived name is a reading of a URL, and the notes already name the person in
   * their own words — asserting "Name: Sfounder" next to "met Marcus at the summit"
   * invites the model to split one person into two. The URL itself is in the prose
   * verbatim either way, so nothing is lost by staying quiet.
   */
  const resolvedProfiles = (linkedin?.people || []).filter((p) => p.source === "apollo");

  const seedPeople = mergeSeedPeople([
    ...(hints?.seedPeople || []),
    ...(detected.hints.seedPeople || []),
    ...resolvedProfiles.map((p) => ({
      name: p.name,
      email: p.email,
      linkedinUrl: p.url,
      title: p.title,
      company: p.company,
    })),
  ]);
  const mergedHints: CaptureParseHints = {
    eventDate: hints?.eventDate || detected.hints.eventDate || null,
    seedPeople: seedPeople.length ? seedPeople : undefined,
    interactionType: hints?.interactionType || detected.hints.interactionType || null,
    goals: goals.length ? goals : undefined,
  };

  const baseCorpus =
    detected.sources.includes("calendar") || detected.sources.includes("email")
      ? detected.text
      : notes;

  // Folded into the corpus, not just the hints: the facts end up on the saved note too,
  // which is where the provenance of a role nobody typed belongs.
  const factsBlock = linkedInFactsBlock(resolvedProfiles);
  const corpus = factsBlock ? `${baseCorpus}\n\n---\n\n${factsBlock}` : baseCorpus;

  // Run all three concurrently. The commitment pass is failure-isolated: contact
  // extraction is the core value and must survive a bad dates response. The duplicate
  // lookup only depends on userId, so it doesn't need to wait on either AI call.
  const today = opts.now ?? new Date();
  // Opened here rather than at its first use below: the dates pass is gated on a decision
  // model, and it starts inside this same Promise.all.
  const enginesP = opts.engines ? Promise.resolve(opts.engines) : openEngines(userId, { llm: true });
  const [personParse, rawCommitments, existing] = await Promise.all([
    parseMultiPersonNotesWithAI(userId, corpus, mergedHints, { onProgress: opts.onProgress }),
    fetchRawCommitments(userId, corpus, {
      today,
      knownPeople: seedPeople.map((p) => p.name).filter(Boolean) as string[],
      engines: enginesP,
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
        ...(o.overriddenKind ? { overriddenKind: o.overriddenKind } : {}),
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
  const engines = await enginesP;

  // A card's default target, where the rules only have a sub-0.85 name match to offer. Done
  // before mentions, which exclude whoever a card already saves into.
  const targets = await decideMergeTargets(
    engines,
    items.map((item) => ({
      person: { name: item.parsed.name, company: item.parsed.company ?? null, role: item.parsed.role ?? null, excerpt: item.notes },
      duplicates: item.duplicates,
    }))
  ).catch(() => items.map(() => null));
  items.forEach((item, i) => {
    const target = targets[i];
    if (!target || item.suggestedMergeId) return;
    if (target === "new") item.suggestedNew = true;
    else item.suggestedMergeId = target;
  });

  // Referral overrides, tags and invented people, read against the note (Jev only).
  if (engines.jev) {
    const existingTags = await (async () => {
      const db = await getDb();
      const rows = await db.select({ name: tags.name }).from(tags).where(eq(tags.userId, userId));
      return rows.map((r) => r.name);
    })().catch(() => [] as string[]);
    await decideCaptureChecks(engines, { items, corpus, existingTags }).catch(() => null);
  }

  const subjects = existing.map((c) => ({ id: c.id, fullName: c.fullName, email: c.email, linkedinUrl: c.linkedinUrl, xHandle: c.xHandle, company: c.company, title: c.title }));
  const ruled = resolveMentionsWithPicks(
    subjects,
    candidates,
    opts.mentionPicks ?? [],
    { excludeContactIds: items.map((i) => i.suggestedMergeId).filter((id): id is string => Boolean(id)) }
  );
  // The rules' blind first-name guesses and unsettled names, read against their sentence.
  const excluded = new Set(items.map((i) => i.suggestedMergeId).filter((id): id is string => Boolean(id)));
  const { resolved, unresolved } = await decideMentions(engines, {
    ...ruled,
    subjects: subjects.filter((s) => !excluded.has(s.id)),
    corpus,
  }).catch(() => ruled);
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
    linkedinLookup: linkedin
      ? {
          found: linkedin.people.length,
          resolved: resolvedProfiles.length,
          // Nothing is guessed on this path: an unresolved URL contributes no fields,
          // because the notes themselves already say who the person is.
          guessed: 0,
          degraded: linkedin.degraded,
          dropped: linkedin.dropped,
        }
      : null,
  };
}

/**
 * Collapse seed people from every source (calendar, email, the locked profile, pasted
 * LinkedIn URLs) into one entry per person, keeping the first non-empty value of each
 * field. A plain concat would hand the model the same attendee twice, once with a role and
 * once without; a plain de-dupe would drop whichever copy carried the profile fields.
 */
function mergeSeedPeople(
  seeds: NonNullable<CaptureParseHints["seedPeople"]>
): NonNullable<CaptureParseHints["seedPeople"]> {
  const byKey = new Map<string, (typeof seeds)[number]>();
  for (const seed of seeds) {
    const name = seed.name?.trim() || "";
    const email = seed.email?.trim() || "";
    if (!name && !email) continue;
    // Email identifies a person outright; a bare name only matches another bare name.
    const key = email ? `email:${email.toLowerCase()}` : `name:${name.toLowerCase()}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...seed });
      continue;
    }
    byKey.set(key, {
      name: existing.name?.trim() || seed.name || null,
      email: existing.email?.trim() || seed.email || null,
      linkedinUrl: existing.linkedinUrl?.trim() || seed.linkedinUrl || null,
      title: existing.title?.trim() || seed.title || null,
      company: existing.company?.trim() || seed.company || null,
    });
  }
  return [...byKey.values()];
}

/**
 * The no-model path: pasted profile URLs straight to review cards.
 *
 * Returns the same `CaptureParseResult` the parsed path does — same items, same hash
 * contract — so a URL-logged person goes through review, dedupe and saving exactly like a
 * person the model found, on both the in-request and the durable-job caller. The only
 * thing skipped is the reading.
 */
async function parsePastedLinkedInProfiles(
  userId: string,
  refs: LinkedInProfileRef[],
  today: Date
): Promise<CaptureParseResult> {
  const { people, degraded, dropped } = await resolvePastedLinkedInProfiles(userId, refs);
  const named = people.filter((p) => p.name?.trim());
  if (!named.length) {
    throw new UserFacingError(
      "Couldn’t read a name from that LinkedIn URL — add their name to the notes and try again"
    );
  }

  const db = await getDb();
  const existing = await db.query.contacts.findMany({
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
  });
  const duplicateIndex = buildDuplicateIndex(existing);

  const items: BulkNotePersonPreview[] = named.map((person, index) => {
    const parsed = parsedNoteFromLinkedInPerson(person);
    const duplicates = findDuplicateCandidatesIndexed(duplicateIndex, {
      fullName: parsed.name,
      email: parsed.email,
      linkedinUrl: parsed.linkedin_url,
      company: parsed.company,
      title: parsed.role,
    }).slice(0, 5);
    const top = duplicates[0];
    return {
      key: `${index}-${person.slug}`,
      notes: linkedInOnlyNoteText(person),
      parsed,
      // A URL states who someone is; it does not discuss anything. Nothing here was said,
      // so there is nothing to offer as an opportunity, a next step or a cadence.
      opportunities: [],
      impliedSteps: [],
      cadence: null,
      duplicates: duplicates.map((d) => ({
        id: d.contact.id,
        fullName: d.contact.fullName,
        company: d.contact.company,
        title: d.contact.title,
        reason: d.reason,
        confidence: d.confidence,
      })),
      suggestedMergeId: top && top.confidence >= 0.85 ? top.contact.id : null,
      sharedNoteTexts: [],
      interactionDate: null,
      interactionType: "note",
    };
  });

  // One canonical corpus per set of URLs, so the same profile pasted twice — in any
  // formatting — hashes the same and does not log a second interaction.
  const sourceText = named.map((person) => linkedInOnlyNoteText(person)).join("\n\n---\n\n");

  return {
    items,
    sharedNotes: [],
    interactionDate: null,
    interactionType: "note",
    anchorIso: isoDay(today),
    anchorBasis: "upload",
    hints: {
      seedPeople: named.map((p) => ({
        name: p.name,
        email: p.email,
        linkedinUrl: p.url,
        title: p.title,
        company: p.company,
      })),
    },
    sourceText,
    sourceHash: hashSourceNote(sourceText),
    suggestedReminders: [],
    suggestionsSkipped: emptyCommitmentResult().rejected as RejectedCounts,
    mentions: [],
    mentionedOnly: [],
    linkedinLookup: {
      found: named.length,
      resolved: named.filter((p) => p.source === "apollo").length,
      guessed: named.filter((p) => p.source === "url").length,
      degraded,
      dropped,
    },
  };
}
