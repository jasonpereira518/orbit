/**
 * Runs one capture job through whichever phase it is waiting on: `queued` → extraction,
 * `ready | reviewing` (after Save) → the contact write.
 *
 * Called from `after()` in the actions, from the internal run route, from a reader that
 * notices a stuck job, and from the stall cron — so it must assume nothing about request
 * scope: no `after()`, no `revalidatePath()`, no `requireUserId()`. It is also the only
 * writer of a job's outcome, and only while it holds the claim token.
 *
 * Idempotency of the save phase matters most. A crash between `saveNoteBatch`'s batch
 * insert and the job's `saved` stamp would re-run the save; `saveNoteBatch` dedupes
 * interactions and reminders by hash but creates contacts freely, so before saving the
 * runner (a) adopts a batch that already exists for this corpus and (b) re-runs duplicate
 * detection so a person created by the previous attempt is now an update, not a second row.
 */
import { and, desc, eq, gte } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts, noteBatches } from "@/db/schema";
import { runCaptureParse } from "@/lib/capture-parse";
import {
  claimCaptureJob,
  getCaptureJobById,
  heartbeatCaptureJob,
  settleCaptureJob,
  type CaptureJobRow,
} from "@/lib/capture-jobs";
import { acceptedPeople, defaultReminderKeys, setAsidePeople } from "@/lib/capture/review-reducer";
import { clampCloseness } from "@/lib/capture/closeness";
import type { CaptureJobResult, CaptureSavedSummary } from "@/lib/capture/types";
import { generateAndStoreContactBrief } from "@/lib/contact-brief";
import { buildDuplicateIndex, findDuplicateCandidatesIndexed, DUPLICATE_MERGE_CONFIDENCE } from "@/lib/duplicates";
import { kickEmbeddingBackfill } from "@/lib/embedding-backfill";
import { friendlyError } from "@/lib/errors";
import { upsertIgnoredPeople, type IgnoredPersonInput } from "@/lib/ignored-people";
import { getMeetingSession, getNoteBatchForUser, markMeetingSessionSaved, toNoteBatchMeeting } from "@/lib/meeting-sessions";
import { followUpDaysFor, shouldCreateFollowUp } from "@/lib/note-batches";
import {
  saveNoteBatch,
  type MeetingExtraReminderInput,
  type NoteBatchCommitmentInput,
  type NoteBatchParticipantInput,
  type SaveNoteBatchInput,
  type SaveNoteBatchOutput,
} from "@/lib/note-batch-save";
import { hashSourceNote } from "@/lib/suggested-reminder-utils";
import { TOAST_COPY } from "@/lib/toast-copy";

export type CaptureRunnerDeps = {
  parse?: typeof runCaptureParse;
  save?: (userId: string, input: SaveNoteBatchInput) => Promise<SaveNoteBatchOutput>;
  /** Post-save enrichment (embeddings, briefs). Off in the smoke suite. */
  enrich?: boolean;
  now?: Date;
};

const CORPUS_SEPARATOR = "\n\n---\n\n";

/** The text the model reads: what was typed, then every transcribed block in order. */
export function assembleCaptureCorpus(row: Pick<CaptureJobRow, "inputText" | "ingestedBlocks">): string {
  return [row.inputText?.trim(), ...(row.ingestedBlocks ?? []).map((b) => b.text.trim())]
    .filter((t): t is string => Boolean(t))
    .join(CORPUS_SEPARATOR);
}

export async function runCaptureJobById(id: string, deps: CaptureRunnerDeps = {}): Promise<CaptureJobRow | null> {
  const row = await getCaptureJobById(id);
  if (!row) return null;
  switch (row.status) {
    case "queued":
    case "extracting":
      return runExtraction(id, deps);
    case "saving":
      return runSave(id, deps);
    default:
      // ready/reviewing wait on the person; terminal rows are done. `saveCaptureJob`
      // moves a row to `saving` before kicking, so this never has to guess.
      return row;
  }
}

async function runExtraction(id: string, deps: CaptureRunnerDeps): Promise<CaptureJobRow | null> {
  const claim = await claimCaptureJob(id, "extracting", { now: deps.now });
  if (!claim) return getCaptureJobById(id);
  const { row, token } = claim;
  const parse = deps.parse ?? runCaptureParse;

  try {
    const corpus = assembleCaptureCorpus(row);
    if (!corpus) throw new Error("Nothing to read yet");
    const parsed = await parse(row.userId, corpus, row.inputHints, {
      meetingSessionId: row.meetingSessionId,
      now: deps.now,
    });
    await heartbeatCaptureJob(id, token);
    const { sourceText, sourceHash, ...rest } = parsed;
    const result: CaptureJobResult = { ...rest, meetingExtras: row.result?.meetingExtras };
    await settleCaptureJob(id, token, { status: "ready", result, sourceText, sourceHash, error: null });
  } catch (err) {
    await settleCaptureJob(id, token, {
      status: "failed",
      error: friendlyError(err, TOAST_COPY.notesReadFailed),
    });
  }
  return getCaptureJobById(id);
}

async function runSave(id: string, deps: CaptureRunnerDeps): Promise<CaptureJobRow | null> {
  // `saveCaptureJob` already moved the row to `saving`; the claim here is what makes a
  // second runner (a re-kick, the sweep) a no-op unless the first went quiet.
  const claim = await claimCaptureJob(id, "saving", { now: deps.now });
  if (!claim) return getCaptureJobById(id);
  const { row, token } = claim;
  const save = deps.save ?? saveNoteBatch;

  try {
    if (!row.result || !row.sourceText || !row.sourceHash) throw new Error("Extract people before saving");
    const userId = row.userId;

    // (a) A batch this corpus already produced — the previous attempt got that far. The
    //     window is the job's whole life, not the current claim: the batch predates the
    //     re-claim by definition.
    const existing = row.noteBatchId
      ? await getNoteBatchForUser(userId, row.noteBatchId)
      : await findBatchForCorpus(userId, row.sourceHash, row.createdAt);

    let out: SaveNoteBatchOutput;
    if (existing) {
      out = summarizeExistingBatch(existing);
    } else {
      const input = await buildSaveInput(row);
      out = await save(userId, input);
    }

    const saved = savedSummary(row, out);
    const result: CaptureJobResult = { ...row.result, saved };
    await settleCaptureJob(id, token, { status: "saved", noteBatchId: out.batchId, result, error: null });

    if (row.meetingSessionId) {
      await markMeetingSessionSaved(userId, row.meetingSessionId, out.batchId).catch(() => null);
    }

    await upsertIgnoredPeople(userId, ignoredRowsFor(row, out)).catch(() => null);

    if (deps.enrich !== false) {
      await kickEmbeddingBackfill(userId).catch(() => null);
      for (const contactId of out.contactIds) {
        await generateAndStoreContactBrief(userId, contactId).catch(() => null);
      }
    }
  } catch (err) {
    await settleCaptureJob(id, token, {
      status: "failed",
      error: friendlyError(err, "Couldn’t save those people — try again?"),
    });
  }
  return getCaptureJobById(id);
}

/** A saved batch for this exact corpus, created since this job began. */
async function findBatchForCorpus(userId: string, sourceHash: string, since: Date) {
  const db = await getDb();
  const row = await db.query.noteBatches.findFirst({
    where: and(
      eq(noteBatches.userId, userId),
      eq(noteBatches.sourceHash, sourceHash),
      eq(noteBatches.status, "saved"),
      gte(noteBatches.createdAt, since)
    ),
    orderBy: [desc(noteBatches.createdAt)],
  });
  return row ?? null;
}

function summarizeExistingBatch(batch: NonNullable<Awaited<ReturnType<typeof getNoteBatchForUser>>>): SaveNoteBatchOutput {
  const result = batch.result;
  const participants = result?.participants ?? [];
  return {
    batchId: batch.id,
    created: participants.filter((p) => p.created).length,
    updated: participants.filter((p) => !p.created).length,
    contactIds: participants.map((p) => p.contactId),
    remindersCreated: result?.reminders.length ?? 0,
    result: result!,
  };
}

/**
 * Decisions → what `saveNoteBatch` writes. Follow-up days and whether to remind come from
 * closeness and relevance here, never from the card.
 */
export async function buildSaveInput(row: CaptureJobRow): Promise<SaveNoteBatchInput> {
  const result = row.result!;
  const decisions = row.decisions ?? {};
  const accepted = acceptedPeople(result.items, decisions);

  // (b) Re-run duplicate detection for anyone still marked "create": a previous attempt
  // may have created them, and the contact list has moved on since the parse anyway.
  const needsCheck = accepted.filter((a) => !a.decision.mergeContactId);
  let index: ReturnType<typeof buildDuplicateIndex> | null = null;
  if (needsCheck.length) {
    const db = await getDb();
    const existing = await db.query.contacts.findMany({
      where: eq(contacts.userId, row.userId),
      columns: { id: true, fullName: true, email: true, linkedinUrl: true, xHandle: true, company: true, title: true },
    });
    index = buildDuplicateIndex(existing);
  }

  const participants: NoteBatchParticipantInput[] = accepted.map(({ item, decision }) => {
    const edits = decision.edits ?? {};
    const parsed = {
      ...item.parsed,
      name: edits.name?.trim() || item.parsed.name,
      company: edits.company === undefined ? item.parsed.company : edits.company?.trim() || null,
      role: edits.role === undefined ? item.parsed.role : edits.role?.trim() || null,
      met_at: edits.metAt === undefined ? item.parsed.met_at : edits.metAt?.trim() || null,
      summary: edits.summary === undefined ? item.parsed.summary : edits.summary?.trim() || null,
    };
    let mergeContactId = decision.mergeContactId;
    if (!mergeContactId && index) {
      const top = findDuplicateCandidatesIndexed(index, {
        fullName: parsed.name,
        email: parsed.email,
        linkedinUrl: parsed.linkedin_url,
        company: parsed.company,
        title: parsed.role,
      })[0];
      if (top && top.confidence >= DUPLICATE_MERGE_CONFIDENCE) mergeContactId = top.contact.id;
    }
    const closeness = clampCloseness(decision.relationshipScore, clampCloseness(parsed.relationship_score_suggestion));
    return {
      notes: item.notes,
      parsed,
      mergeContactId,
      createReminder: shouldCreateFollowUp(closeness, parsed.relevance, Boolean(parsed.follow_up_recommendation)),
      relationshipScore: closeness,
      tagNames: decision.tagNames?.length ? decision.tagNames : parsed.tags,
      followUpDays: followUpDaysFor(closeness, parsed.follow_up_days),
      interactionDate: item.interactionDate,
      interactionType: item.interactionType,
    };
  });

  const checked = new Set(decisions.reminders?.checked ?? defaultReminderKeys(result.suggestedReminders));
  const overrides = decisions.reminders?.overrides ?? {};
  const commitments: NoteBatchCommitmentInput[] = result.suggestedReminders
    .filter((s) => checked.has(s.key))
    .map((s) => {
      const o = overrides[s.key] ?? {};
      return {
        title: s.title,
        description: s.description,
        rawDatePhrase: s.rawDatePhrase,
        yearInferred: s.yearInferred,
        personName: o.personName === undefined ? s.personName : o.personName,
        actionKind: s.actionKind,
        confidenceScore: s.confidenceScore,
        sourceExcerpt: s.sourceExcerpt,
        dateBasis: s.dateBasis,
        anchorIso: s.anchorIso,
        dueDateIso: o.dueDateIso ?? s.dueDateIso,
      };
    });

  let meeting: SaveNoteBatchInput["meeting"] = null;
  if (row.meetingSessionId) {
    const session = await getMeetingSession(row.userId, row.meetingSessionId);
    if (!session) throw new Error("That meeting no longer exists");
    const summary = toNoteBatchMeeting(session);
    const extras = result.meetingExtras ?? [];
    const keys = new Set(decisions.meeting?.extraReminderKeys ?? extras.filter((e) => e.checkedByDefault).map((e) => e.key));
    const extraReminders: MeetingExtraReminderInput[] = extras
      .filter((e) => keys.has(e.key))
      .slice(0, 40)
      .map((e) => ({ kind: e.kind, title: e.title, ownerName: e.ownerName, sourceExcerpt: e.sourceExcerpt }));
    meeting = { summary, extraReminders };
  }

  return {
    sourceText: row.sourceText!,
    sourceHash: row.sourceHash ?? hashSourceNote(row.sourceText!),
    anchorIso: result.anchorIso,
    anchorBasis: result.anchorBasis,
    entryPoint: row.entryPoint,
    seedContactId: row.seedContactId,
    participants,
    commitments,
    mentions: result.mentions.map((m) => ({
      text: m.text,
      context: m.context,
      nearPerson: m.nearPerson,
      contactId: m.contactId,
      confidence: m.confidence,
      matchedBy: m.matchedBy,
    })),
    skipped: result.suggestionsSkipped,
    meeting,
  };
}

function savedSummary(row: CaptureJobRow, out: SaveNoteBatchOutput): CaptureSavedSummary {
  // Map card → contact by name: `saveNoteBatch` reports participants in the order it
  // wrote them, which is the accepted-card order.
  const accepted = acceptedPeople(row.result!.items, row.decisions);
  const contactIdByKey: Record<string, string> = {};
  out.result.participants.forEach((p, i) => {
    const card = accepted[i];
    if (card) contactIdByKey[card.item.key] = p.contactId;
  });
  return {
    batchId: out.batchId,
    created: out.created,
    updated: out.updated,
    remindersCreated: out.remindersCreated,
    contactIds: out.contactIds,
    contactIdByKey,
  };
}

/** Rejected and skipped cards, the mentioned-only names, and whatever the save could not resolve. */
export function ignoredRowsFor(row: CaptureJobRow, out: SaveNoteBatchOutput): IgnoredPersonInput[] {
  const result = row.result!;
  const rows: IgnoredPersonInput[] = [];
  for (const { item, decision } of setAsidePeople(result.items, row.decisions)) {
    const name = decision.edits?.name?.trim() || item.parsed.name?.trim();
    if (!name) continue;
    rows.push({
      displayName: name,
      reason: decision.decision === "skip" ? "skipped" : "rejected",
      context: item.parsed.summary || item.notes,
      company: item.parsed.company,
      captureJobId: row.id,
      noteBatchId: out.batchId,
    });
  }
  for (const m of result.mentionedOnly ?? []) {
    rows.push({ displayName: m.name, reason: "mentioned", context: m.context, company: m.company, captureJobId: row.id, noteBatchId: out.batchId });
  }
  for (const m of out.result.unresolvedMentions) {
    rows.push({ displayName: m.text, reason: "mentioned", context: m.context, captureJobId: row.id, noteBatchId: out.batchId });
  }
  // Someone who was saved as a participant is not ignored, whatever else said their name.
  const savedNames = new Set(out.result.participants.map((p) => p.name.trim().toLowerCase()));
  return rows.filter((r) => !savedNames.has(r.displayName.trim().toLowerCase()));
}
