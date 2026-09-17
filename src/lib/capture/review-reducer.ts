/**
 * Pure derivations over a capture job's result and decisions. Shared by the review UI
 * (which phase to show, which card is next, who is in the summary) and the runner (which
 * people to save). No React, no DB — `scripts/smoke-capture-review-reducer.ts` drives it.
 */
import type {
  BulkNotePersonPreview,
  CaptureDecision,
  CaptureDecisionKind,
  CaptureDecisions,
  CaptureJobResult,
  CaptureJobStatus,
} from "@/lib/capture/types";

export type CapturePhase =
  | "input"
  | "extracting"
  | "resume"
  | "review"
  | "summary"
  | "saving"
  | "saved";

export function peopleDecisions(decisions: CaptureDecisions | null | undefined): Record<string, CaptureDecision> {
  return decisions?.people ?? {};
}

/** Index of the first card without a decision, or -1 when every card is decided. */
export function firstPendingIndex(
  items: readonly Pick<BulkNotePersonPreview, "key">[],
  decisions: CaptureDecisions | null | undefined
): number {
  const people = peopleDecisions(decisions);
  for (let i = 0; i < items.length; i++) {
    if (!people[items[i]!.key]) return i;
  }
  return -1;
}

export type DecisionCounts = { accepted: number; rejected: number; skipped: number; pending: number };

export function countDecisions(
  items: readonly Pick<BulkNotePersonPreview, "key">[],
  decisions: CaptureDecisions | null | undefined
): DecisionCounts {
  const people = peopleDecisions(decisions);
  const counts: DecisionCounts = { accepted: 0, rejected: 0, skipped: 0, pending: 0 };
  for (const item of items) {
    const d = people[item.key]?.decision;
    if (d === "accept") counts.accepted += 1;
    else if (d === "reject") counts.rejected += 1;
    else if (d === "skip") counts.skipped += 1;
    else counts.pending += 1;
  }
  return counts;
}

/** The people a save will write, in card order, each with its decision. */
export function acceptedPeople(
  items: readonly BulkNotePersonPreview[],
  decisions: CaptureDecisions | null | undefined
): Array<{ item: BulkNotePersonPreview; decision: CaptureDecision; index: number }> {
  const people = peopleDecisions(decisions);
  const out: Array<{ item: BulkNotePersonPreview; decision: CaptureDecision; index: number }> = [];
  items.forEach((item, index) => {
    const decision = people[item.key];
    if (decision?.decision === "accept") out.push({ item, decision, index });
  });
  return out;
}

export function setAsidePeople(
  items: readonly BulkNotePersonPreview[],
  decisions: CaptureDecisions | null | undefined,
  kind?: Exclude<CaptureDecisionKind, "accept">
): Array<{ item: BulkNotePersonPreview; decision: CaptureDecision }> {
  const people = peopleDecisions(decisions);
  const out: Array<{ item: BulkNotePersonPreview; decision: CaptureDecision }> = [];
  for (const item of items) {
    const decision = people[item.key];
    if (!decision || decision.decision === "accept") continue;
    if (kind && decision.decision !== kind) continue;
    out.push({ item, decision });
  }
  return out;
}

/**
 * Which existing contact a card saves into by default. Any match the parse found wins —
 * "save to the same contact if the person is there already" — with the server's own
 * confident suggestion first, and a preferred contact (the profile the page was opened
 * from) above both.
 */
export function defaultMergeId(
  item: Pick<BulkNotePersonPreview, "duplicates" | "suggestedMergeId">,
  preferredContactId?: string | null
): string | null {
  if (preferredContactId && item.duplicates.some((d) => d.id === preferredContactId)) {
    return preferredContactId;
  }
  return item.suggestedMergeId ?? item.duplicates[0]?.id ?? null;
}

/**
 * Where the page opens for a job in a given state. `ready` means "extracted, untouched",
 * which gets the resume notice; `reviewing` means "at least one card decided", which goes
 * straight to the next pending card — or the summary when none is left.
 */
export function initialPhaseFor(
  job: { status: CaptureJobStatus; result: CaptureJobResult | null; decisions: CaptureDecisions | null } | null
): CapturePhase {
  if (!job) return "input";
  switch (job.status) {
    case "queued":
    case "extracting":
      return "extracting";
    case "ready":
      return job.result && job.result.items.length === 0 ? "summary" : "resume";
    case "reviewing": {
      const items = job.result?.items ?? [];
      return firstPendingIndex(items, job.decisions) === -1 ? "summary" : "review";
    }
    case "saving":
      return "saving";
    case "saved":
      return "saved";
    default:
      // ingesting / transcribed / failed / discarded all render the input UI, with the
      // transcript or the error shown inside it.
      return "input";
  }
}

/** The bar an EXPLICIT dated commitment clears to arrive pre-ticked, as the old panel did. */
export const EXPLICIT_AUTO_TICK_CONFIDENCE = 60;

/**
 * The bar an IMPLIED next step clears to arrive pre-ticked.
 *
 * Deliberately a separate, higher number. An implied item is Orbit's inference, and the
 * defining property of one is that there is no sentence to point at when the user asks why
 * it appeared — so a wrong pre-ticked inference costs more trust than a missed one costs
 * convenience. Everything between the extraction floor (60, in `implied-next-steps.ts`) and
 * this is still shown, just unticked: offered, never assumed.
 *
 * Do NOT collapse this into the explicit bar, and do NOT score implied items below 60 to
 * make them fall under it — that couples two unrelated meanings, and the next tweak to
 * confidence scoring would silently start auto-creating inferences.
 */
export const IMPLIED_AUTO_TICK_SCORE = 80;

/** Default ticks for the review list. */
export function defaultReminderKeys(
  suggestions: readonly { key: string; confidenceScore: number; origin?: "explicit" | "implied" }[]
): string[] {
  return suggestions
    .filter((s) =>
      // `origin` is optional so a `CaptureReminderChoices` written before implied steps
      // existed still reads as explicit rather than falling off the list.
      s.origin === "implied"
        ? s.confidenceScore >= IMPLIED_AUTO_TICK_SCORE
        : s.confidenceScore >= EXPLICIT_AUTO_TICK_CONFIDENCE
    )
    .map((s) => s.key);
}

/** Comma string ↔ list, the one place tags are split so the card and the dialog agree. */
export function parseTagNames(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(",")) {
    const t = raw.trim();
    const key = t.toLowerCase();
    if (!t || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}
