/**
 * Next steps a discussion calls for that nobody actually said.
 *
 * "She mentioned her team is hiring two backend engineers" implies sending her a referral;
 * no one committed to anything, and the note contains no action item. These are the most
 * valuable thing an assistant can notice and by far the easiest way to flood somebody with
 * nonsense, so every rule below exists to make the flood impossible rather than to make the
 * noticing clever.
 *
 * Five filters, in order, each with the failure it prevents:
 *
 *   1. verbatim containment  — the model must point at the sentence it inferred from
 *   2. confidence floor      — drops the "I suppose they might want..." tier
 *   3. collision             — the person pass and the commitments pass read the same note
 *                              and agree constantly; without this every explicit item
 *                              arrives a second time, once ticked and once not
 *   4. generic-filler        — "follow up", "stay in touch" is what the fallback follow-up
 *                              already creates; an "implied" item saying so is duplication
 *                              dressed as insight
 *   5. per-person cap        — a 20-person note dump producing 60 unticked checkboxes is
 *                              strictly worse than producing none
 *
 * Implied steps never become `action_items` rows. An action item is something that was said;
 * these were not. They exist only as reminder drafts, which keeps the "action items are the
 * source of truth for what was committed" contract intact.
 */
import type { ParsedImpliedStep } from "@/lib/ai-opportunity-schema";
import { titlesCollide } from "@/lib/note-batches";
import { containsVerbatim, normalizeForMatch } from "@/lib/verbatim";

/**
 * Below this the model is guessing at intent rather than reading it. Combined with
 * containment it is a genuine filter; on its own it would not be, which is why it is second
 * and not first.
 */
export const IMPLIED_MIN_CONFIDENCE = 0.6;

/**
 * Above this an implied step arrives pre-ticked in the capture review; between the floor and
 * here it is shown unticked.
 *
 * Deliberately a SEPARATE constant from the 60 that `defaultReminderKeys` applies to explicit
 * items. Reusing that number — or, worse, scoring implied items 59 so they slip under it —
 * would couple two unrelated meanings, and a later confidence tweak would silently start
 * auto-creating inferences.
 */
export const IMPLIED_AUTO_TICK_CONFIDENCE = 0.8;

/** Two is the most a single conversation plausibly implies about one person. */
export const MAX_IMPLIED_PER_PERSON = 2;

export type ImpliedNextStep = {
  text: string;
  /** One clause on what in the notes implies it. Shown where a date phrase would be. */
  rationale: string | null;
  sourceExcerpt: string;
  /** 0-100. */
  confidenceScore: number;
  /** Whether it clears `IMPLIED_AUTO_TICK_CONFIDENCE` and arrives pre-ticked. */
  autoTick: boolean;
};

export type ImpliedRejectedCounts = {
  unverifiable: number;
  lowConfidence: number;
  duplicate: number;
  generic: number;
  capped: number;
};

export type ImpliedExtractResult = {
  steps: ImpliedNextStep[];
  rejected: ImpliedRejectedCounts;
};

export function emptyImpliedResult(): ImpliedExtractResult {
  return {
    steps: [],
    rejected: { unverifiable: 0, lowConfidence: 0, duplicate: 0, generic: 0, capped: 0 },
  };
}

/**
 * Exactly the shapes `saveNoteBatch` step 3 already produces on its own. An inference that
 * lands on one of these has told the user nothing they were not already going to be told.
 *
 * The trailing "with <someone>" is bounded to three words, and that bound is the whole
 * subtlety here. An unbounded `( with .+)?` also matches "follow up with two backend
 * candidates for her team" — a genuinely specific next step — and silently deletes exactly
 * the inferences worth having. Three words covers a name ("with Maya Chen") and stops well
 * short of a real object.
 */
const NAME_TAIL = String.raw`(?:\s+(?:with|to)\s+[\w'’.-]+(?:\s+[\w'’.-]+){0,2})?`;
const GENERIC_RE = new RegExp(
  `^(?:` +
    [
      String.raw`follow[- ]?up${NAME_TAIL}`,
      String.raw`stay in touch${NAME_TAIL}`,
      String.raw`keep in touch${NAME_TAIL}`,
      String.raw`send (?:them |him |her )?a (?:message|note|mail|email)`,
      String.raw`reconnect${NAME_TAIL}`,
      String.raw`check in${NAME_TAIL}`,
      String.raw`touch base${NAME_TAIL}`,
      String.raw`reach out${NAME_TAIL}`,
      String.raw`keep them posted`,
      String.raw`stay connected`,
    ].join("|") +
    `)$`,
  "i"
);

const MAX_IMPLIED_TEXT_CHARS = 300;

export function validateImpliedNextSteps(
  raw: readonly ParsedImpliedStep[],
  notes: string,
  opts: {
    /** `parsed.action_items` for this person — things the note explicitly states. */
    explicitActionItems: readonly string[];
    /** Titles of dated commitments found in the same note, for the same collision check. */
    commitmentTitles: readonly string[];
  }
): ImpliedExtractResult {
  const result = emptyImpliedResult();
  const haystack = normalizeForMatch(notes);
  const known = [...opts.explicitActionItems, ...opts.commitmentTitles].filter(Boolean);

  // Ranked before the cap so the two that survive are the two most confident, not the two
  // the model happened to emit first.
  const ordered = [...raw].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  const seen = new Set<string>();

  for (const item of ordered) {
    const text = item.text.replace(/\s+/g, " ").trim().slice(0, MAX_IMPLIED_TEXT_CHARS);
    if (!text) continue;

    if (!containsVerbatim(haystack, item.source_excerpt)) {
      result.rejected.unverifiable += 1;
      continue;
    }
    if ((item.confidence ?? 0) < IMPLIED_MIN_CONFIDENCE) {
      result.rejected.lowConfidence += 1;
      continue;
    }
    if (GENERIC_RE.test(text)) {
      result.rejected.generic += 1;
      continue;
    }
    if (known.some((k) => titlesCollide(k, text))) {
      result.rejected.duplicate += 1;
      continue;
    }
    const key = text.toLowerCase();
    if (seen.has(key) || result.steps.some((s) => titlesCollide(s.text, text))) {
      result.rejected.duplicate += 1;
      continue;
    }
    if (result.steps.length >= MAX_IMPLIED_PER_PERSON) {
      result.rejected.capped += 1;
      continue;
    }
    seen.add(key);

    const confidence = item.confidence ?? 0;
    result.steps.push({
      text,
      rationale: item.rationale ? item.rationale.replace(/\s+/g, " ").trim().slice(0, 240) : null,
      sourceExcerpt: item.source_excerpt.replace(/\s+/g, " ").trim().slice(0, 500),
      confidenceScore: Math.round(confidence * 100),
      autoTick: confidence >= IMPLIED_AUTO_TICK_CONFIDENCE,
    });
  }

  return result;
}
