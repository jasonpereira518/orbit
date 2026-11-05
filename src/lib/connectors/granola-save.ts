/**
 * Saving a Granola note's people: the parts every path shares (the sync, a note picked in the
 * Notes library, the review job that follows it), so they can never log one meeting twice
 * or at noon instead of its real time.
 *
 * Kept apart from `granola.ts` so the capture job runner can use it without loading the MCP
 * client. It and the runner import each other (`saveInputFromParse` lives there); both only
 * call across at run time, which ES modules allow.
 */
import { saveInputFromParse } from "@/lib/capture-job-runner";
import { acceptUnattended } from "@/lib/drive-import-processor";
import { followUpStillAhead } from "@/lib/imports/drive-reminder-rules";
import { DEFAULT_FOLLOW_UP_WINDOW_DAYS } from "@/lib/note-batches";
import { saveNoteBatch, type SaveNoteBatchInput, type SaveNoteBatchOutput } from "@/lib/note-batch-save";
import type { CaptureDecisions, CaptureParseResult } from "@/lib/capture/types";
import { generateAndStoreContactBrief } from "@/lib/contact-brief";
import { reportError } from "@/lib/report-error";

export type GranolaNoteRef = { noteId: string; meetingAt: string };

/** The parts of a Granola note every save of it carries. */
export function granolaSaveFields(input: SaveNoteBatchInput, granola: GranolaNoteRef): SaveNoteBatchInput {
  return {
    ...input,
    interactionSource: "granola",
    // One id per note and person, whichever path logged it — so the sync, a direct save and
    // a reviewed save can never log the same meeting twice.
    externalIdBase: `granola:${granola.noteId}`,
    // The full timestamp, not the day: a day-only date is stored at noon.
    participants: input.participants.map((p) => ({ ...p, interactionDate: granola.meetingAt })),
  };
}

/**
 * Save the people `decisions` accepts with no review: the sync's whole save, and the
 * existing-contact half of a note picked by hand. Null when the decisions keep nobody.
 *
 * `sourceHash` names the batch. The hand-picked path passes one of its own, never the note
 * text's: the review job later saves the same text, and a saved batch with the job's hash
 * reads to `runSave` as "this job already saved" — it would skip the new people.
 */
export async function saveGranolaDirect(
  userId: string,
  args: {
    result: CaptureParseResult;
    decisions: CaptureDecisions;
    text: string;
    sourceHash: string;
    granola: GranolaNoteRef;
    now: Date;
    /** Regenerate each saved person's AI notes here. Off when the caller does it later. */
    briefs?: boolean;
  },
): Promise<SaveNoteBatchOutput | null> {
  const { now } = args;
  const base = await saveInputFromParse({
    userId,
    result: args.result,
    decisions: args.decisions,
    sourceText: args.text,
    sourceHash: args.sourceHash,
    entryPoint: "capture",
    seedContactId: null,
    inputSources: ["text"],
    meetingSessionId: null,
  });
  const input = granolaSaveFields(base, args.granola);
  // A backfilled note's generic follow-up can already be overdue — same rule as Drive.
  input.participants = input.participants.map((p) => ({
    ...p,
    createReminder:
      p.createReminder &&
      followUpStillAhead(input.anchorIso, p.followUpDays || p.parsed.follow_up_days || DEFAULT_FOLLOW_UP_WINDOW_DAYS, now),
  }));
  if (!input.participants.length && !input.commitments.length) return null;

  const out = await saveNoteBatch(userId, input);
  if (args.briefs === false) return out;
  // `saveNoteBatch` never regenerates summaries itself; refreshing them is the point here.
  for (const contactId of out.contactIds) {
    await generateAndStoreContactBrief(userId, contactId).catch((err) =>
      reportError(err, { where: "job.granola.brief", level: "warning" }),
    );
  }
  return out;
}


/**
 * A hand-picked note's people, split the way Jason asked: whoever the unattended rules would
 * confidently merge into an existing contact (`acceptUnattended`: named in the note, and a
 * rule-based match at merge confidence) is saved now; everyone else waits for review.
 *
 * Commitments and reminder suggestions are left for the review, never saved here, so the two
 * saves can't each create them. Returns the review's remaining items and whether anything is
 * left to review at all.
 */
export async function saveConfidentGranolaPeople(
  userId: string,
  args: { result: CaptureParseResult; text: string; granola: GranolaNoteRef; now: Date },
): Promise<{ remaining: CaptureParseResult["items"]; needsReview: boolean; saved: SaveNoteBatchOutput | null }> {
  const { result, now } = args;
  const decisions = acceptUnattended(result.items, [], now.toISOString(), args.text);
  const people = decisions.people ?? {};
  const isExisting = (key: string) => people[key]?.decision === "accept" && Boolean(people[key]?.mergeContactId);
  const direct: CaptureDecisions = {
    people: Object.fromEntries(
      Object.entries(people).map(([key, d]) => [key, isExisting(key) ? d : { ...d, decision: "skip" as const, mergeContactId: null }]),
    ),
    reminders: { checked: [], overrides: {} },
  };
  const saved = result.items.some((i) => isExisting(i.key))
    ? await saveGranolaDirect(userId, {
        // No reminders ticked and no mentions: both belong to the review, which saves them once.
        result: { ...result, mentions: [], mentionedOnly: [] },
        decisions: direct,
        text: args.text,
        // Its own hash: see `saveGranolaDirect`.
        sourceHash: `granola-direct:${args.granola.noteId}`,
        granola: args.granola,
        now,
        // The runner refreshes them once the job has settled: an AI call per person here
        // would hold the job's claim long enough for another runner to take it over.
        briefs: false,
      })
    : null;
  const remaining = result.items.filter((i) => !isExisting(i.key));
  return { remaining, needsReview: remaining.length > 0 || result.suggestedReminders.length > 0, saved };
}
