import { daysAgo } from "@/lib/duplicates";
import {
  computeEvidence,
  computePrior,
  EVIDENCE_FLOOR,
  MAX_RING_WITHOUT_EVIDENCE,
} from "@/lib/closeness-evidence";

export type ClosenessContact = {
  relationshipScore?: number | null;
  /** 1–5 if the user rated them; null means never rated. See closeness-evidence.ts. */
  statedCloseness?: number | null;
  lastInteractionAt?: Date | string | null;
  /**
   * Whether an `interactions` row exists for this contact at all. Supplied by
   * the cohort builder from the interactions table — never inferred from
   * `lastInteractionAt`, which `contactInsertValues` stamps on every create
   * (`metAt ?? now`) and which is therefore non-null for every import.
   *
   * When false, recency and cadence are treated as *unknown* rather than
   * measured, and their weight is redistributed to the prior.
   */
  hasLoggedInteraction?: boolean;
  firstInteractionAt?: Date | string | null;
  dateMet?: Date | string | null;
  createdAt?: Date | string | null;
  /** Orbit-relative affinity signals, supplied by the cohort builder. */
  emailDomainMatchesUser?: boolean;
  companyConcentration?: number;
  schoolConcentration?: number;
  coveredByConnectedSource?: boolean;
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
  /** How much we know, 0–1. See closeness-evidence.ts. */
  evidence: number;
  /** The compressed weak-signal estimate. */
  prior: number;
  /**
   * The score over the components we actually measured, normalised against
   * their own weight. Equals `raw` when every component is known; falls back
   * to `prior` when none is.
   */
  evidenced: number;
  /**
   * Share of the scoring weight backed by a real measurement, 0–1. `raw` is
   * `evidenced` and `prior` mixed in exactly this proportion.
   */
  knownWeightShare: number;
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
  /** Total contacts scored. */
  n: number;
  /** Contacts whose evidence clears the floor — the ones the distribution is built from. */
  evidencedN: number;
  /** evidencedN / n. The axis relative weighting fades in on. */
  coverage: number;
  /** ascending, evidenced contacts only */
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

/**
 * Display value for a contact nobody has assessed. Deliberately the midpoint,
 * not the old 2/5 default — asserting "somewhat distant" about someone nobody
 * has assessed is exactly the bias this constant removes.
 *
 * It is a *display* value only: `computeRawCloseness` never scores it, because
 * an unrated contact's strength weight is redistributed to the prior rather
 * than filled in with a guess. Anything that renders a breakdown's `strength`
 * for an unrated contact shows this.
 */
export const NEUTRAL_STRENGTH = 0.5;

/**
 * The value `contacts.relationship_score` carries when nobody has rated the
 * contact. The column is `.default(2).notNull()` and every create path
 * coalesces `input.relationshipScore ?? 2`, so a 2 is indistinguishable from
 * silence and must never be read as an assessment.
 */
export const IMPORT_DEFAULT_RELATIONSHIP_SCORE = 2;

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

/** Coverage below this makes rank meaningless; above RELATIVE_FULL_COVERAGE it is fully trusted. */
const RELATIVE_MIN_COVERAGE = 0.1;
const RELATIVE_FULL_COVERAGE = 0.6;

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

/**
 * The user's own assessment as a 0–1 term, or `null` when nobody has made one.
 *
 * `statedCloseness` is the real signal. `relationshipScore` is consulted only
 * as a back-compat fallback for rows written before `stated_closeness` existed
 * and not yet touched by `scripts/migrate-stated-closeness.ts` — and only when
 * it differs from `IMPORT_DEFAULT_RELATIONSHIP_SCORE`, since a 2 is what every
 * importer writes. That is the same heuristic the backfill uses, deliberately:
 * a value other than the default is the only trace a human left.
 *
 * Returning `null` rather than a neutral number is the point. It is what lets
 * `computeRawCloseness` redistribute the unrated contact's strength weight
 * instead of asserting a middling closeness nobody claimed.
 */
export function resolveStatedStrength(
  statedCloseness?: number | null,
  relationshipScore?: number | null
): number | null {
  if (statedCloseness != null) {
    return Math.min(5, Math.max(1, statedCloseness)) / 5;
  }
  if (
    relationshipScore != null &&
    relationshipScore !== IMPORT_DEFAULT_RELATIONSHIP_SCORE
  ) {
    return Math.min(5, Math.max(1, relationshipScore)) / 5;
  }
  return null;
}

/**
 * Stated closeness, 1–5, as a 0–1 term, with `NEUTRAL_STRENGTH` standing in
 * for an unrated contact. For display; the blend uses
 * `resolveStatedStrength` so it can tell "unrated" from "rated middling".
 */
export function strengthComponent(
  statedCloseness?: number | null,
  relationshipScore?: number | null
) {
  return resolveStatedStrength(statedCloseness, relationshipScore) ?? NEUTRAL_STRENGTH;
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
 * **Unknown components do not score zero, and they do not score a guess
 * either — their weight is redistributed.** The existing `hasGoals` branch has
 * always done this for goal relevance (scoring 0 there would silently dock
 * every contact 15 points when no goals are set, and the scale could never
 * reach 1). Strength, recency and cadence now work the same way, and the
 * *prior* is what the redistributed weight buys:
 *
 *     raw = (knownWeight * evidenced + unknownWeight * prior) / applicableWeight
 *
 * That is the blend the design calls for, expressed so the prior and the
 * evidenced score are commensurate by construction rather than by two
 * hand-tuned ranges kept in sync. It gives, for free, the two properties the
 * feature rests on:
 *
 *   - Everything known  → `unknownWeight` is 0 → `raw === evidenced` exactly,
 *     so this whole change is a no-op for an established orbit.
 *   - Nothing known     → `knownWeight` is 0 → `raw === prior` exactly.
 *
 * And it removes the perverse gradient the earlier `(1 - evidence) * prior +
 * evidence * evidenced` form had: because `evidenced` at zero behavioural data
 * lived *below* the prior's band, every increment of evidence that was not a
 * real touch — a user rating, a connected mailbox — pushed the contact *down*.
 * Rating a long-standing connection 5/5 demoted them. Here, acquiring a
 * measurement can only replace the prior's share with that measurement, so a
 * high rating raises and a low rating lowers, which is what the user meant.
 *
 * `evidence` (see closeness-evidence.ts) is still computed and returned: it
 * gates the ring ceiling and the cohort's evidenced-only distribution. It is
 * simply no longer the mixing coefficient.
 */
export function computeRawCloseness(
  contact: ClosenessContact,
  activeGoals: string[] = [],
  touchCount?: number | null
): RawClosenessBreakdown {
  const goals = activeGoals.map((g) => g.trim()).filter(Boolean);
  const hasGoals = goals.length > 0;

  const stated = resolveStatedStrength(
    contact.statedCloseness,
    contact.relationshipScore
  );
  const hasStated = stated !== null;
  const strength = stated ?? NEUTRAL_STRENGTH;

  // A logged interaction is what makes recency and cadence measurements rather
  // than artifacts. Without one, `lastInteractionAt` is just the import's
  // timestamp and `touchCount` is zero because nothing was ever recorded — not
  // because the relationship went quiet.
  const knowsBehaviour =
    !!contact.hasLoggedInteraction && !!contact.lastInteractionAt;
  const recency = knowsBehaviour
    ? recencyComponent(contact.lastInteractionAt)
    : NO_INTERACTION_RECENCY;
  const cadence = knowsBehaviour ? cadenceComponent(touchCount) : 0;
  const goalRelevance = hasGoals ? goalRelevanceComponent(contact, goals) : 0;

  const knownWeighted =
    (hasStated ? WEIGHTS.strength * strength : 0) +
    (knowsBehaviour ? WEIGHTS.recency * recency + WEIGHTS.cadence * cadence : 0) +
    (hasGoals ? WEIGHTS.goalRelevance * goalRelevance : 0);

  const knownWeight =
    (hasStated ? WEIGHTS.strength : 0) +
    (knowsBehaviour ? WEIGHTS.recency + WEIGHTS.cadence : 0) +
    (hasGoals ? WEIGHTS.goalRelevance : 0);

  // Goal relevance drops out of the denominator entirely when no goals are
  // set — it is not unknown, it is not applicable, so the prior must not be
  // paid for it either.
  const applicableWeight =
    WEIGHTS.strength +
    WEIGHTS.recency +
    WEIGHTS.cadence +
    (hasGoals ? WEIGHTS.goalRelevance : 0);

  const evidence = computeEvidence({
    hasStatedCloseness: hasStated,
    touchCount,
    hasLoggedInteraction: !!contact.hasLoggedInteraction,
    coveredByConnectedSource: contact.coveredByConnectedSource,
  });

  const prior = computePrior({
    firstInteractionAt: contact.firstInteractionAt,
    dateMet: contact.dateMet,
    createdAt: contact.createdAt,
    emailDomainMatchesUser: contact.emailDomainMatchesUser,
    companyConcentration: contact.companyConcentration,
    schoolConcentration: contact.schoolConcentration,
    goalRelevance,
  });

  // Nothing measured: there is no evidenced score to report, and the prior is
  // the whole answer.
  const evidenced =
    knownWeight > 0 ? clamp01(knownWeighted / knownWeight) : prior;

  const knownWeightShare = knownWeight / applicableWeight;
  const raw = clamp01(
    knownWeightShare * evidenced + (1 - knownWeightShare) * prior
  );

  return {
    raw,
    strength,
    recency,
    cadence,
    goalRelevance,
    evidence,
    prior,
    evidenced,
    knownWeightShare,
  };
}

/**
 * Build the distribution contacts are ranked against.
 *
 * Only evidenced contacts contribute. Ranking someone against a tied mass of
 * people we know nothing about tells us nothing — and worse, it lets a large
 * import of strangers push a genuinely close friend down the percentile scale
 * purely by arriving.
 *
 * The fade is on coverage rather than headcount for the same reason: 2,000
 * contacts of whom 12 are known is a *less* reliable ranking than 30 contacts
 * of whom 25 are known, though the old count-based fade rated it higher.
 */
export function buildClosenessCohort(
  raws: RawClosenessBreakdown[]
): ClosenessCohort {
  const n = raws.length;
  const evidenced = raws.filter((r) => r.evidence >= EVIDENCE_FLOOR);
  const sortedRaw = evidenced.map((r) => r.raw).sort((a, b) => a - b);
  const evidencedN = sortedRaw.length;
  const coverage = n === 0 ? 0 : evidencedN / n;

  // Rank still needs a floor of absolute headcount: five known people do not
  // make a distribution however complete their coverage.
  const countGate = clamp01(
    (evidencedN - RELATIVE_MIN_N) / (RELATIVE_FULL_N - RELATIVE_MIN_N)
  );
  const coverageGate = clamp01(
    (coverage - RELATIVE_MIN_COVERAGE) /
      (RELATIVE_FULL_COVERAGE - RELATIVE_MIN_COVERAGE)
  );

  return {
    n,
    evidencedN,
    coverage,
    sortedRaw,
    relativeWeight: RELATIVE_MAX_WEIGHT * Math.min(countGate, coverageGate),
  };
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
  if (cohort.sortedRaw.length === 0) return 0.5;
  const below = lowerBound(cohort.sortedRaw, raw);
  const equal = upperBound(cohort.sortedRaw, raw) - below;
  return (below + 0.5 * equal) / cohort.sortedRaw.length;
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
 * poorly-covered network gets: `relativeWeight` is 0 below `RELATIVE_MIN_N`
 * *evidenced* contacts (8), or below `RELATIVE_MIN_COVERAGE` of the orbit.
 */
export function applyClosenessCohort(
  raw: RawClosenessBreakdown,
  cohort?: ClosenessCohort
): ClosenessBreakdown {
  // No cohort: the raw score is its own ranking value.
  const percentile = cohort ? cohortPercentile(raw.raw, cohort) : raw.raw;
  const w = cohort ? cohort.relativeWeight : 0;
  const closeness = clamp01((1 - w) * raw.raw + w * percentile);
  const useQuota = !!cohort && cohort.evidencedN >= QUOTA_MIN_N;

  const assignedRing = useQuota
    ? orbitScoreFromPercentile(percentile)
    : closenessToOrbitScore(closeness);

  // Quotas always fill, so without this a cold orbit would hand out a Core ring
  // to whoever happened to sort highest among equally unknown people. Inner and
  // Core are claims about the relationship, and they have to be earned.
  const orbitScore =
    raw.evidence < EVIDENCE_FLOOR
      ? Math.min(assignedRing, MAX_RING_WITHOUT_EVIDENCE)
      : assignedRing;

  const assignedTier = useQuota
    ? tierFromPercentile(percentile)
    : closenessTier(closeness);
  const tier =
    raw.evidence < EVIDENCE_FLOOR && assignedTier === "inner"
      ? "mid"
      : assignedTier;

  return { ...raw, closeness, percentile, orbitScore, tier };
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
  const cohort = buildClosenessCohort(raws);

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
