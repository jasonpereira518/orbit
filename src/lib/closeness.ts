import { daysAgo } from "@/lib/duplicates";

export type ClosenessContact = {
  relationshipScore?: number | null;
  lastInteractionAt?: Date | string | null;
  createdAt?: Date | string | null;
  company?: string | null;
  title?: string | null;
  industry?: string | null;
  howMet?: string | null;
  notes?: string | null;
  aiSummary?: string | null;
  keyFacts?: string[] | null;
  sharedInterests?: string[] | null;
  tags?: string[] | null;
};

/** The absolute, per-contact half of the score. Knows nothing about other contacts. */
export type RawClosenessBreakdown = {
  raw: number;
  strength: number;
  recency: number;
  cadence: number;
  goalRelevance: number;
};

export type ClosenessBreakdown = RawClosenessBreakdown & {
  closeness: number;
  /** Midrank position within the user's own orbit, 0–1. Equals `raw` when scored without a cohort. */
  percentile: number;
  /** 1–5 ring band for orbit placement */
  orbitScore: number;
  tier: "inner" | "mid" | "outer";
};

/**
 * A snapshot of one user's raw-score distribution. Built once per request and
 * shared by every contact so the same person cannot rank differently on two pages.
 */
export type ClosenessCohort = {
  n: number;
  /** ascending */
  sortedRaw: number[];
  relativeWeight: number;
};

/** Hyperbolic decay: 0.5 at 45d, 0.25 at 135d, 0.11 at a year, never quite zero. */
const RECENCY_HALFLIFE_DAYS = 45;

/** Touches beyond this in the trailing window stop adding to cadence. */
const CADENCE_SATURATION_TOUCHES = 12;
export const CADENCE_WINDOW_DAYS = 365;

/** Recency for a contact with no logged interaction. Low, not zero. */
export const NO_INTERACTION_RECENCY = 0.15;

const WEIGHTS = {
  strength: 0.3,
  recency: 0.3,
  cadence: 0.25,
  goalRelevance: 0.15,
} as const;

/** Rank has no meaning in a tiny orbit, so it fades in with network size. */
const RELATIVE_MIN_N = 8;
const RELATIVE_FULL_N = 40;
const RELATIVE_MAX_WEIGHT = 0.5;

/** Below this, ring/tier fall back to absolute cutoffs so a 3-person orbit has no "Core". */
const QUOTA_MIN_N = 5;

/** Share of the network per ring, from Core down. */
const RING_PERCENTILE_CUTOFFS: Array<{ ring: number; min: number }> = [
  { ring: 5, min: 0.92 }, // top 8% — Core orbit
  { ring: 4, min: 0.78 }, // next 14% — Inner orbit
  { ring: 3, min: 0.56 }, // next 22% — Mid orbit
  { ring: 2, min: 0.3 }, // next 26% — Outer orbit
]; // remainder — Deep space

const TIER_PERCENTILE_CUTOFFS = { inner: 0.78, mid: 0.44 } as const;

/**
 * Absolute cutoffs, used only when there is no cohort to rank against. Higher
 * than the pre-cohort thresholds because raw scores renormalize to reach 1.0
 * and the recency curve no longer collapses to near-zero.
 */
const ABSOLUTE_TIER_CUTOFFS = { inner: 0.6, mid: 0.4 } as const;
const ABSOLUTE_RING_CUTOFFS: Array<{ ring: number; min: number }> = [
  { ring: 5, min: 0.75 },
  { ring: 4, min: 0.6 },
  { ring: 3, min: 0.475 },
  { ring: 2, min: 0.35 },
];

function clamp01(n: number) {
  return Math.min(1, Math.max(0, n));
}

export function strengthComponent(relationshipScore?: number | null) {
  const s = Math.min(5, Math.max(1, relationshipScore || 2));
  return s / 5;
}

/**
 * Time decay on the last real touch.
 *
 * There is deliberately no `createdAt` fallback: a contact you have never
 * spoken to has *unknown* recency, not perfect recency. Falling back to
 * creation time meant a fresh two-thousand-row import scored as though every
 * one of those people had been contacted today, then decayed in lockstep —
 * which is what made cold orbits both flat and wrong. Unknown recency returns
 * the same low constant as a missing reference and lets the evidence layer
 * decide how much to trust the rest of the score.
 */
export function recencyComponent(lastInteractionAt?: Date | string | null) {
  if (!lastInteractionAt) return NO_INTERACTION_RECENCY;
  const days = daysAgo(lastInteractionAt);
  if (!Number.isFinite(days)) return 0;
  if (days <= 0) return 1;
  return 1 / (1 + days / RECENCY_HALFLIFE_DAYS);
}

/**
 * How regularly you actually talk, from touches in the trailing window.
 * Log-shaped so the 1st touch counts for much more than the 11th:
 * 1 -> 0.27, 3 -> 0.54, 6 -> 0.76, 12+ -> 1.
 */
export function cadenceComponent(touchCount?: number | null) {
  const n = Math.floor(touchCount ?? 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(1, Math.log1p(n) / Math.log1p(CADENCE_SATURATION_TOUCHES));
}

export function goalRelevanceComponent(
  contact: ClosenessContact,
  activeGoals: string[]
) {
  const goals = activeGoals.map((g) => g.trim()).filter(Boolean);
  if (!goals.length) return 0;

  const haystack = [
    contact.company,
    contact.title,
    contact.industry,
    contact.howMet,
    contact.notes,
    contact.aiSummary,
    ...(contact.keyFacts || []),
    ...(contact.sharedInterests || []),
    ...(contact.tags || []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (!haystack) return 0;

  let hits = 0;
  for (const goal of goals) {
    const tokens = goal
      .toLowerCase()
      .split(/[^a-z0-9+#.]+/i)
      .filter((t) => t.length > 2);
    if (tokens.length === 0) {
      if (haystack.includes(goal.toLowerCase())) hits++;
      continue;
    }
    if (tokens.some((t) => haystack.includes(t))) hits++;
  }

  return hits / goals.length;
}

/**
 * Absolute score: 30% strength, 30% recency, 25% cadence, 15% goal fit.
 *
 * With no active goals the goal weight is redistributed across the others
 * rather than scored as zero — otherwise having no goals silently docks every
 * contact 15 points and the scale can never reach 1.
 */
export function computeRawCloseness(
  contact: ClosenessContact,
  activeGoals: string[] = [],
  touchCount?: number | null
): RawClosenessBreakdown {
  const goals = activeGoals.map((g) => g.trim()).filter(Boolean);
  const hasGoals = goals.length > 0;

  const strength = strengthComponent(contact.relationshipScore);
  const recency = recencyComponent(contact.lastInteractionAt);
  const cadence = cadenceComponent(touchCount);
  const goalRelevance = hasGoals ? goalRelevanceComponent(contact, goals) : 0;

  const weighted =
    WEIGHTS.strength * strength +
    WEIGHTS.recency * recency +
    WEIGHTS.cadence * cadence +
    (hasGoals ? WEIGHTS.goalRelevance * goalRelevance : 0);

  const totalWeight =
    WEIGHTS.strength +
    WEIGHTS.recency +
    WEIGHTS.cadence +
    (hasGoals ? WEIGHTS.goalRelevance : 0);

  return {
    raw: clamp01(weighted / totalWeight),
    strength,
    recency,
    cadence,
    goalRelevance,
  };
}

export function buildClosenessCohort(rawScores: number[]): ClosenessCohort {
  const sortedRaw = [...rawScores].sort((a, b) => a - b);
  const n = sortedRaw.length;
  const relativeWeight =
    RELATIVE_MAX_WEIGHT *
    clamp01((n - RELATIVE_MIN_N) / (RELATIVE_FULL_N - RELATIVE_MIN_N));
  return { n, sortedRaw, relativeWeight };
}

/** First index whose value is >= target. */
function lowerBound(sorted: number[], target: number) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index whose value is > target. */
function upperBound(sorted: number[], target: number) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Midrank percentile: ties share one value, and nobody lands on an exact 0 or 1
 * (your closest contact being "100% close" would be meaningless).
 */
export function cohortPercentile(raw: number, cohort: ClosenessCohort) {
  if (cohort.n === 0) return 0.5;
  const below = lowerBound(cohort.sortedRaw, raw);
  const equal = upperBound(cohort.sortedRaw, raw) - below;
  return (below + 0.5 * equal) / cohort.n;
}

export function closenessTier(closeness: number): ClosenessBreakdown["tier"] {
  if (closeness >= ABSOLUTE_TIER_CUTOFFS.inner) return "inner";
  if (closeness >= ABSOLUTE_TIER_CUTOFFS.mid) return "mid";
  return "outer";
}

export function tierFromPercentile(
  percentile: number
): ClosenessBreakdown["tier"] {
  if (percentile >= TIER_PERCENTILE_CUTOFFS.inner) return "inner";
  if (percentile >= TIER_PERCENTILE_CUTOFFS.mid) return "mid";
  return "outer";
}

export function closenessTierChipClass(tier: ClosenessBreakdown["tier"]) {
  if (tier === "inner") {
    return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  }
  if (tier === "mid") {
    return "bg-sky-500/10 text-sky-700 dark:text-sky-300";
  }
  return "bg-amber-500/10 text-amber-700 dark:text-amber-300";
}

/**
 * Colour from the number alone. Prefer `closenessTierChipClass(tier)` wherever
 * the assigned tier is on hand — tiers are quota-assigned, so deriving one from
 * the percentage can disagree with the badge sitting next to it.
 */
export function closenessPercentChipClass(closeness: number) {
  return closenessTierChipClass(closenessTier(closeness));
}

/** Map continuous closeness onto the five constellation rings. Ring 4 ≈ Inner. */
export function closenessToOrbitScore(closeness: number) {
  for (const { ring, min } of ABSOLUTE_RING_CUTOFFS) {
    if (closeness >= min) return ring;
  }
  return 1;
}

/** Rings by quota, so the constellation stays populated however cold things get. */
export function orbitScoreFromPercentile(percentile: number) {
  for (const { ring, min } of RING_PERCENTILE_CUTOFFS) {
    if (percentile >= min) return ring;
  }
  return 1;
}

/**
 * Blend the absolute score with the contact's rank inside their own orbit.
 * Without a cohort this is pure absolute scoring, which is also what a
 * very small network gets (`relativeWeight` is 0 below 8 contacts).
 */
export function applyClosenessCohort(
  raw: RawClosenessBreakdown,
  cohort?: ClosenessCohort
): ClosenessBreakdown {
  // No cohort: the raw score is its own ranking value.
  const percentile = cohort ? cohortPercentile(raw.raw, cohort) : raw.raw;
  const w = cohort ? cohort.relativeWeight : 0;
  const closeness = clamp01((1 - w) * raw.raw + w * percentile);
  const useQuota = !!cohort && cohort.n >= QUOTA_MIN_N;

  return {
    ...raw,
    closeness,
    percentile,
    orbitScore: useQuota
      ? orbitScoreFromPercentile(percentile)
      : closenessToOrbitScore(closeness),
    tier: useQuota ? tierFromPercentile(percentile) : closenessTier(closeness),
  };
}

export function computeCloseness(
  contact: ClosenessContact,
  activeGoals: string[] = [],
  opts?: { cohort?: ClosenessCohort; touchCount?: number | null }
): ClosenessBreakdown {
  const raw = computeRawCloseness(contact, activeGoals, opts?.touchCount);
  return applyClosenessCohort(raw, opts?.cohort);
}

/**
 * Batch entry point: score every contact against the distribution they form.
 * Two passes — raw for all, build the cohort, then apply it.
 */
export function computeClosenessForAll<
  T extends { id: string } & ClosenessContact,
>(
  contacts: T[],
  activeGoals: string[] = [],
  touchCounts?: Map<string, number>
): Map<string, ClosenessBreakdown> {
  const raws = contacts.map((c) =>
    computeRawCloseness(c, activeGoals, touchCounts?.get(c.id) ?? 0)
  );
  const cohort = buildClosenessCohort(raws.map((r) => r.raw));

  const byId = new Map<string, ClosenessBreakdown>();
  contacts.forEach((c, i) => {
    byId.set(c.id, applyClosenessCohort(raws[i], cohort));
  });
  return byId;
}

const FREQUENCY_WINDOW_DAYS = 90;

/** Human-readable touch cadence from interactions in the last ~90 days. */
export function formatInteractionFrequency(
  interactionDates: Array<Date | string | null | undefined>
): string {
  const cutoff = Date.now() - FREQUENCY_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const recent = interactionDates.filter((d) => {
    if (!d) return false;
    const t = new Date(d).getTime();
    return Number.isFinite(t) && t >= cutoff;
  }).length;

  if (recent === 0) return "No touches in 90 days";
  if (recent === 1) return "1× in 90 days";

  const perMonth = (recent / FREQUENCY_WINDOW_DAYS) * 30;
  if (perMonth >= 3.5) return `~${Math.round(perMonth)}× / month`;
  if (perMonth >= 1.5) return `~${perMonth.toFixed(1)}× / month`;
  if (perMonth >= 0.75) return "~1× / month";
  return `~${recent}× in 90 days`;
}
