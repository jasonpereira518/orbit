/**
 * What a LinkedIn export proves about a relationship, as closeness inputs (LinkedIn deep read,
 * PR 3). Pure: the cohort builder and the single-contact rescore both feed it the same numbers,
 * so one contact cannot score two ways.
 *
 *   - depth: both sides wrote, over how many years, and a recommendation either way. A
 *     measured component, read only for contacts with logged behaviour (closeness.ts).
 *   - overlap: where the user's own jobs and schools meet the contact's. It replaces the
 *     orbit-relative company/school guess in the prior when the user's history is known.
 */
import type { HistoryOverlap } from "@/lib/history-overlap";

/** Per contact, all time, from rows that count as a touch (`countsAsTouch`). */
export type DepthSignals = {
  /** EXCHANGE_TYPES rows with direction 'in'. */
  inbound: number;
  /** EXCHANGE_TYPES rows with direction 'out'. */
  outbound: number;
  /** Calendar years in which BOTH of you wrote (an 'in' and an 'out' EXCHANGE_TYPES row). */
  reciprocalYears: number;
  /** Rows whose external_id starts `li-export:recommendation` (either way). */
  recommendations: number;
};

/**
 * Two-way exchange alone reaches 1 (four years of it); a recommendation is a bonus, so nobody
 * needs one to rank (the spec: closeness must not depend on recommendations). Starting values;
 * tune against scripts/smoke-closeness.ts.
 */
export const DEPTH_WEIGHTS = { reciprocal: 0.5, span: 0.5, recommendation: 0.3 } as const;

/** Two-way years at which the span term is full: one year says nothing, four says a lot. */
const SPAN_FULL_YEARS = 4;

/**
 * Whether there is anything to measure: a directed message either way, or a recommendation.
 * Someone you only meet in person, a bare invitation note, or messages imported before
 * direction was recorded leave depth unmeasured (null), so the deep read never lowers them.
 */
export function depthMeasured(s: DepthSignals): boolean {
  return s.inbound > 0 || s.outbound > 0 || s.recommendations > 0;
}

export function depthComponent(s: DepthSignals): number {
  const reciprocal = s.inbound > 0 && s.outbound > 0 ? 1 : 0;
  // Years count only when both of you wrote in them: a decade of unanswered mail is not depth.
  const span = Math.min(1, Math.max(0, (s.reciprocalYears - 1) / (SPAN_FULL_YEARS - 1)));
  const recommended = s.recommendations > 0 ? 1 : 0;
  return Math.min(
    1,
    DEPTH_WEIGHTS.reciprocal * reciprocal + DEPTH_WEIGHTS.span * span + DEPTH_WEIGHTS.recommendation * recommended
  );
}

/** Shared years together count fully; the same place at other (or unknown) times counts half. */
export function overlapAffinity(overlaps: readonly HistoryOverlap[]): { work: number; school: number } {
  const out = { work: 0, school: 0 };
  for (const o of overlaps) out[o.kind] = Math.max(out[o.kind], o.together ? 1 : 0.5);
  return out;
}
