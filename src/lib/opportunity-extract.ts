/**
 * Turns the opportunities a model claimed to find in a note into rows we are willing to
 * store, or drops them.
 *
 * Same contract as `date-commitment-extract.ts`, and for the same reason: **the prompt is
 * only a filter.** Everything that actually guarantees correctness happens here, in
 * TypeScript, so the behaviour is identical across Gemini, OpenAI and Anthropic. In
 * particular the kind is always re-derived through `normalizeOpportunityKind` and never
 * trusted as written, and a date is always resolved from the phrase rather than read from
 * whatever the model computed.
 *
 * One rule differs deliberately from the commitments module. A commitment whose date cannot
 * be resolved is REJECTED, because a reminder with no date is not a reminder. An opportunity
 * whose date cannot be resolved is KEPT with `dueDate: null` — "she can refer me" is worth
 * recording whether or not anybody named a deadline, and discarding it because the deadline
 * was vague would throw away the useful half of the sentence.
 */
import type { ParsedOpportunity } from "@/lib/ai-opportunity-schema";
import { deriveMonthDay } from "@/lib/date-commitment-extract";
import { atLocalNoon } from "@/lib/interaction-date";
import {
  looksLikeReferral,
  normalizeOpportunityDirection,
  normalizeOpportunityKind,
  normalizeOpportunityLabel,
  type OpportunityDirection,
  type OpportunityKind,
} from "@/lib/opportunity-kinds";
import { resolveRelativeDate } from "@/lib/relative-date";
import { containsVerbatim, normalizeForMatch } from "@/lib/verbatim";

/**
 * Per PERSON, not per note. A single conversation that genuinely surfaced seven distinct
 * opportunities for one person is a transcript the model has started padding; capping is
 * cheaper to reason about than a second scoring pass.
 */
export const MAX_OPPORTUNITIES_PER_PERSON = 6;

export type ExtractedOpportunity = {
  kind: OpportunityKind;
  label: string;
  direction: OpportunityDirection | null;
  /** The sentence it came from, verbatim. Never empty — an item without one is dropped. */
  sourceExcerpt: string;
  rawDatePhrase: string | null;
  /** Resolved deadline pinned to local noon, or null when the note named none it could resolve. */
  dueDate: Date | null;
  /** 0-100. */
  confidenceScore: number;
  /**
   * The model's own kind, when the referral language test overrode it. Kept so the decision
   * model can veto an override the sentence does not support (decisions/capture.ts).
   */
  overriddenKind?: OpportunityKind;
};

export type OpportunityRejectedCounts = {
  /** The excerpt was not in the note. The one guard that matters. */
  unverifiable: number;
  /** No usable label left after normalising. */
  empty: number;
  /** Same kind and label as one already kept. */
  duplicate: number;
  /** Over `MAX_OPPORTUNITIES_PER_PERSON`. */
  capped: number;
};

export type OpportunityExtractResult = {
  opportunities: ExtractedOpportunity[];
  rejected: OpportunityRejectedCounts;
};

export function emptyOpportunityResult(): OpportunityExtractResult {
  return {
    opportunities: [],
    rejected: { unverifiable: 0, empty: 0, duplicate: 0, capped: 0 },
  };
}

function startOfDay(d: Date) {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

/**
 * A deadline from the phrase, or null.
 *
 * Absolute phrases go through `deriveMonthDay`, which yields month/day and any stated year;
 * a missing year resolves to the nearest FUTURE occurrence, because an application window
 * named without a year is always the next one. Relative phrases fall through to the shared
 * grammar. Anything neither can read returns null rather than a guess.
 *
 * A resolved date already in the past is discarded — but only the date. See the module
 * header: the opportunity survives its own stale deadline.
 */
function resolveDuePhrase(phrase: string, opts: { today: Date; anchor: Date }): Date | null {
  const md = deriveMonthDay(phrase);
  if (md) {
    if (md.month < 0 || md.month > 11 || md.day < 1 || md.day > 31) return null;
    const year = md.statedYear ?? opts.today.getFullYear();
    const d = new Date(year, md.month, md.day, 12, 0, 0, 0);
    if (Number.isNaN(d.getTime()) || d.getMonth() !== md.month) return null;
    if (md.statedYear == null && d < startOfDay(opts.today)) {
      d.setFullYear(year + 1);
    }
    return d < startOfDay(opts.today) ? null : atLocalNoon(d);
  }

  const relative = resolveRelativeDate(phrase, opts.anchor);
  if (!relative) return null;
  return relative.date < startOfDay(opts.today) ? null : atLocalNoon(relative.date);
}

/**
 * Exported apart from any network call so it can be exercised without an API key —
 * `scripts/smoke-opportunity-extract.ts` is the executable spec.
 *
 * `notes` must be the corpus the model actually read. Passing a summary instead would make
 * containment prove only that the summary contains it, which is not the claim being tested.
 */
export function validateOpportunities(
  raw: readonly ParsedOpportunity[],
  notes: string,
  opts: { today: Date; anchor: Date }
): OpportunityExtractResult {
  const result = emptyOpportunityResult();
  const haystack = normalizeForMatch(notes);
  const seen = new Set<string>();

  for (const item of raw) {
    const label = normalizeOpportunityLabel(item.label);
    if (!label) {
      result.rejected.empty += 1;
      continue;
    }

    // The load-bearing guard. A hallucinated internship rarely survives being asked to
    // point at the sentence that says so.
    if (!containsVerbatim(haystack, item.source_excerpt)) {
      result.rejected.unverifiable += 1;
      continue;
    }

    // A referral is decided HERE, not by the model.
    //
    // It is the single most valuable thing a conversation produces and the thing people go
    // looking for by name months later ("who can refer me?"), so it cannot depend on whether
    // this particular provider called it a referral, an introduction or a job. The language
    // test wins outright: "she'll find the hiring manager" is filed under referral even
    // though, read literally, it is an introduction.
    //
    // Nothing searchable is lost when this overrides. The label keeps the note's own words,
    // so an opportunity relabelled from `internship` to `referral` still matches a search for
    // "internship" — and both kinds are watched by the job feed either way.
    const modelKind = normalizeOpportunityKind(item.kind);
    const kind = looksLikeReferral(label, item.source_excerpt) ? "referral" : modelKind;
    const key = `${kind}|${label.toLowerCase()}`;
    if (seen.has(key)) {
      result.rejected.duplicate += 1;
      continue;
    }

    if (result.opportunities.length >= MAX_OPPORTUNITIES_PER_PERSON) {
      result.rejected.capped += 1;
      continue;
    }
    seen.add(key);

    const rawDatePhrase = item.due_phrase?.replace(/\s+/g, " ").trim() || null;
    const dueDate = rawDatePhrase ? resolveDuePhrase(rawDatePhrase, opts) : null;

    result.opportunities.push({
      kind,
      label,
      direction: normalizeOpportunityDirection(item.direction),
      // Stored, so a person can see what Orbit read. Capped at the same length as the
      // reminder excerpt it sits beside on screen.
      sourceExcerpt: item.source_excerpt.replace(/\s+/g, " ").trim().slice(0, 500),
      rawDatePhrase,
      dueDate,
      confidenceScore: Math.round(
        Math.min(1, Math.max(0, item.confidence ?? 0.5)) * 100
      ),
      ...(kind !== modelKind ? { overriddenKind: modelKind } : {}),
    });
  }

  return result;
}
