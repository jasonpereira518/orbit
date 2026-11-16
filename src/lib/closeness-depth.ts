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
  /** Distinct calendar years with an EXCHANGE_TYPES row. */
  exchangeYears: number;
  /** Rows whose external_id starts `li-export:recommendation` (either way). */
  recommendations: number;
};

/** Starting values; they sum to 1. Tune against scripts/smoke-closeness.ts. */
export const DEPTH_WEIGHTS = { reciprocal: 0.35, span: 0.35, recommendation: 0.3 } as const;

/** Years in touch at which the span term is full: one year says nothing, four says a lot. */
const SPAN_FULL_YEARS = 4;

export function depthComponent(s: DepthSignals): number {
  const reciprocal = s.inbound > 0 && s.outbound > 0 ? 1 : 0;
  const span = Math.min(1, Math.max(0, (s.exchangeYears - 1) / (SPAN_FULL_YEARS - 1)));
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
