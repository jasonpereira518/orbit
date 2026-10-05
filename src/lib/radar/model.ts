/**
 * What one account has taught Radar, and how much it may bend the ranking.
 *
 * Every card a person accepts, dismisses or ignores is a vote about its KIND ("reach out to
 * people who wrote to me") and about each REASON on it ("one of your closest", "your
 * LinkedIn thread went quiet"). This turns those votes into bounded multipliers:
 *
 *     m = clamp(0.7, 1.3, ((a + 3) / (a + d + 6)) / 0.5)
 *
 * `a` counts accepts (a conversion counts double), `d` counts dismissals (an ignored card
 * counts half). The prior of 6 pulls every multiplier toward 1 until there is real evidence:
 * two dismissals move a kind to 0.75, not to zero. The scorer scales each signal reason by
 * the geometric mean of its kind's multiplier and its own (the two are mostly the same
 * votes), so a card's signal points stay within ×0.7–1.3. Learning can reorder within a
 * bucket and nudge across one, never silence a kind or invent a card.
 *
 * Context reasons (tier, priority, goals, target list) describe the PERSON, not the signal,
 * so they are never learned: disliking a card about a close friend is not evidence against
 * close friends. Penalties are never learned either. `also:` lines carry no points.
 *
 * Pure: the tallies come from one grouped statement in `store.ts` (`loadModelTallies`).
 */
import type { RadarModel, RadarModelTally, RecommendationKind } from "@/lib/radar/types";
import { CONTEXT_CODES, RECOMMENDATION_KINDS } from "@/lib/radar/types";

export const RADAR_MODEL_BOUNDS = { min: 0.7, max: 1.3 } as const;
/** Pseudo-votes, half each way, that every multiplier starts from. */
export const RADAR_MODEL_PRIOR = 6;
/** Accept, conversion and dismissal weights, and an ignored card's (half a dismissal). */
export const RADAR_MODEL_VOTES = { accepted: 1, converted: 2, dismissed: 1, ignored: 0.5 } as const;
/** How far back a vote still counts. */
export const RADAR_MODEL_HISTORY_DAYS = 90;

/** No history: every multiplier is exactly 1, and scores are the scorer's own. */
export const NEUTRAL_RADAR_MODEL: RadarModel = { kinds: {}, reasons: {}, updatedAt: new Date(0).toISOString() };

export function multiplierFrom(tally: RadarModelTally | undefined): number {
  if (!tally) return 1;
  const half = RADAR_MODEL_PRIOR / 2;
  const raw = (tally.a + half) / (tally.a + tally.d + RADAR_MODEL_PRIOR) / 0.5;
  return Math.min(RADAR_MODEL_BOUNDS.max, Math.max(RADAR_MODEL_BOUNDS.min, raw));
}

export function kindMultiplier(model: RadarModel | null | undefined, kind: RecommendationKind): number {
  return multiplierFrom(model?.kinds[kind]);
}

/** 1 for context codes and anything not learnable; the learned multiplier otherwise. */
export function reasonMultiplier(model: RadarModel | null | undefined, code: string): number {
  if (!isLearnableReason(code)) return 1;
  return multiplierFrom(model?.reasons[code]);
}

export function isLearnableReason(code: string): boolean {
  return !CONTEXT_CODES.has(code) && !code.startsWith("also:");
}

/** One grouped row: a kind's or a reason code's summed votes. */
export type RadarModelTallyRow = { scope: "kind" | "reason"; key: string; a: number; d: number };

/** Build the model from grouped tallies. Unknown kinds and unlearnable codes are dropped. */
export function buildRadarModel(rows: readonly RadarModelTallyRow[], now: Date): RadarModel {
  const kinds: RadarModel["kinds"] = {};
  const reasons: RadarModel["reasons"] = {};
  const knownKinds = new Set<string>(RECOMMENDATION_KINDS);
  for (const row of rows) {
    const tally = { a: round2(row.a), d: round2(row.d) };
    if (tally.a === 0 && tally.d === 0) continue;
    if (row.scope === "kind" && knownKinds.has(row.key)) kinds[row.key as RecommendationKind] = tally;
    else if (row.scope === "reason" && isLearnableReason(row.key)) reasons[row.key] = tally;
  }
  return { kinds, reasons, updatedAt: now.toISOString() };
}

function round2(n: number) {
  return Math.round(Number(n) * 100) / 100;
}
