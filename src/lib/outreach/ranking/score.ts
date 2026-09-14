import type {
  OutreachConfidence,
  OutreachCriteria,
  OutreachCriterionVerdict,
  OutreachRankTier,
  OutreachVerdict,
} from "@/lib/outreach/types";

/**
 * The score is computed HERE, from verdicts, not asked of the model (spec §7.4): it is then
 * deterministic, explainable per criterion, and tunable against fixtures. `unknown` lowers
 * confidence and never the score — missing information is not a mismatch.
 */
export type RankResult = {
  score: number;
  tier: OutreachRankTier;
  confidence: OutreachConfidence;
  filteredReason: string | null;
};

/**
 * `mismatch` is evidence-backed, so it is KNOWN and worth 0: on a preferred criterion it lowers
 * the fit; on a required one it filters the person before the fit matters. Only `unknown` is
 * excluded from the averages.
 */
const VALUE: Partial<Record<OutreachVerdict, number>> = { match: 1, partial: 0.5, conflicting: 0.5, mismatch: 0 };
const isKnown = (verdict: OutreachVerdict) => VALUE[verdict] !== undefined;

function mean(values: number[], fallback: number) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : fallback;
}

export function computeRank(
  criteria: OutreachCriteria,
  verdicts: OutreachCriterionVerdict[]
): RankResult {
  const byId = new Map(verdicts.map((v) => [v.criterionId, v.verdict]));
  const verdictOf = (id: string): OutreachVerdict => byId.get(id) ?? "unknown";

  const required = criteria.required.map((c) => ({ c, v: verdictOf(c.id) }));
  const preferred = criteria.preferred.map((c) => ({ c, v: verdictOf(c.id) }));
  const requiredKnown = required.filter((r) => isKnown(r.v));
  const preferredKnown = preferred.filter((p) => isKnown(p.v));

  const requiredFit = mean(requiredKnown.map((r) => VALUE[r.v]!), 0.5);
  const weights = preferredKnown.map((p) => 1 / (1 + Math.max(0, p.c.priority)));
  const weightSum = weights.reduce((a, b) => a + b, 0);
  const preferredFit = weightSum
    ? preferredKnown.reduce((sum, p, i) => sum + VALUE[p.v]! * weights[i], 0) / weightSum
    : 0.5;
  const score = Math.round((0.7 * requiredFit + 0.3 * preferredFit) * 1000) / 1000;

  const basis = required.length ? required : preferred;
  const knownShare = basis.length ? basis.filter((b) => isKnown(b.v)).length / basis.length : 0;
  const confidence: OutreachConfidence = knownShare >= 0.8 ? "high" : knownShare >= 0.5 ? "medium" : "low";

  const failedRequirement = required.find((r) => r.v === "mismatch");
  if (failedRequirement) {
    return { score, tier: "filtered", confidence, filteredReason: `Doesn’t meet “${failedRequirement.c.label}”` };
  }
  const exclusion = criteria.exclusions.find((c) => verdictOf(c.id) === "match");
  if (exclusion) {
    return { score, tier: "filtered", confidence, filteredReason: `Excluded by “${exclusion.label}”` };
  }

  let tier: OutreachRankTier;
  if (required.length) {
    if (required.every((r) => r.v === "match") && confidence === "high") tier = "strong";
    else if (requiredKnown.length > 0 && requiredFit >= 0.5) tier = "possible";
    else tier = "weak";
  } else if (preferredKnown.length > 0 && preferredFit >= 0.75 && confidence === "high") {
    tier = "strong";
  } else if (preferredKnown.length > 0 && preferredFit >= 0.5) {
    tier = "possible";
  } else {
    tier = "weak";
  }
  return { score, tier, confidence, filteredReason: null };
}

export type RankSortable = {
  rankTier: OutreachRankTier | null;
  rankScore: number | null;
  researchConfidence: OutreachConfidence | null;
};

const TIER_ORDER: Record<OutreachRankTier, number> = { strong: 0, possible: 1, weak: 2, filtered: 3 };
const CONFIDENCE_ORDER: Record<OutreachConfidence, number> = { high: 0, medium: 1, low: 2 };

export function compareRank(a: RankSortable, b: RankSortable): number {
  const tier = (a.rankTier ? TIER_ORDER[a.rankTier] : 4) - (b.rankTier ? TIER_ORDER[b.rankTier] : 4);
  if (tier !== 0) return tier;
  const score = (b.rankScore ?? -1) - (a.rankScore ?? -1);
  if (score !== 0) return score;
  return (
    (a.researchConfidence ? CONFIDENCE_ORDER[a.researchConfidence] : 3) -
    (b.researchConfidence ? CONFIDENCE_ORDER[b.researchConfidence] : 3)
  );
}
