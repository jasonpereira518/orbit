/**
 * How much Orbit actually knows about a contact, separate from how close they
 * are.
 *
 * The distinction exists because absent data is not a measurement. A fresh
 * LinkedIn import has no interactions, so every behavioural term reads the
 * same for everybody — and ranking people against each other on that produces
 * confident-looking noise. Worse, once one source is connected, whoever that
 * source happens to cover looks close purely by virtue of being covered.
 *
 * Evidence is derived on every request, never stored: it must move the instant
 * an interaction lands or a rating is set.
 */

import { daysAgo } from "@/lib/duplicates";

/** Contributions, summed then capped at 1. Starting values — tune against scripts/smoke-closeness.ts. */
export const EVIDENCE_WEIGHTS = {
  /** The user told us directly. The only signal that is about closeness rather than about our own reach. */
  stated: 0.6,
  /** Observed behaviour, saturating — the 20th logged touch teaches us little the 5th did not. */
  interactions: 0.4,
  /** A connected source could plausibly have seen this person. Weak by construction: being reachable is not being close. */
  coverage: 0.15,
} as const;

/** Below this a contact is barred from the top two rings — Inner and Core must be earned. */
export const EVIDENCE_FLOOR = 0.25;

/** Touch count at which interaction evidence is effectively saturated. */
const INTERACTION_SATURATION = 12;

export type EvidenceInput = {
  /** 1–5 if the user has rated this contact; null/undefined means never rated. */
  statedCloseness?: number | null;
  /** Interactions in the trailing cadence window. */
  touchCount?: number | null;
  /** Any logged interaction ever, including outside the cadence window. */
  hasLoggedInteraction?: boolean;
  /** e.g. contact has an email address and Gmail is connected. */
  coveredByConnectedSource?: boolean;
};

function clamp01(n: number) {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

export function computeEvidence(input: EvidenceInput): number {
  let evidence = 0;

  if (input.statedCloseness != null) {
    evidence += EVIDENCE_WEIGHTS.stated;
  }

  const touches = Math.max(0, Math.floor(input.touchCount ?? 0));
  if (touches > 0 || input.hasLoggedInteraction) {
    // Same log shape as cadenceComponent, so evidence and cadence agree about
    // what "a lot of contact" means.
    const saturation =
      Math.log1p(Math.max(touches, 1)) / Math.log1p(INTERACTION_SATURATION);
    evidence += EVIDENCE_WEIGHTS.interactions * Math.min(1, saturation);
  }

  if (input.coveredByConnectedSource) {
    evidence += EVIDENCE_WEIGHTS.coverage;
  }

  return clamp01(evidence);
}

/** Contacts below the floor may not be placed above this ring, whatever their percentile. */
export const MAX_RING_WITHOUT_EVIDENCE = 3;

/**
 * The prior is clamped into a narrow mid band on purpose. It exists to order
 * the long tail, not to make claims about it — a guess must never be able to
 * produce a Core-orbit placement, and a compressed range is what guarantees
 * that no matter how the weights are later tuned.
 */
export const PRIOR_MIN = 0.3;
export const PRIOR_MAX = 0.6;

/**
 * Contributions to the prior, normalised against their own total.
 *
 * `age` dominates on purpose: a bare import (the worst case — nothing known
 * but a connection date) has every other term at zero, so whatever share
 * `age` does not carry is simply never spent. At the old 0.3 share, a pure
 * cold import collapsed into a single ~9-point band of the already-narrow
 * PRIOR_MIN..PRIOR_MAX range — see scripts/smoke-closeness.ts §14's
 * histogram. Weighting age this heavily is what lets connection recency alone
 * spread a day-one orbit across rings 1-3 instead of piling everyone into one
 * bin.
 *
 * That comes at a real cost, though: raising `age` here necessarily lowers
 * `emailDomain` + `companyConcentration` + `schoolConcentration`, so a
 * genuinely evidence-poor contact who *does* carry real affinity (a same-
 * domain, same-company colleague added the day you started a job, before any
 * interaction is logged) gets less credit for it than before. §18 of the
 * harness pins a floor under that gap — a real colleague must still
 * meaningfully outrank a same-age stranger — precisely so a future retune of
 * `age` can't silently erode it further. If you raise `age` again, re-check
 * that section, not just the cold-orbit histogram.
 */
const PRIOR_WEIGHTS = {
  age: 0.7,
  emailDomain: 0.15,
  companyConcentration: 0.08,
  schoolConcentration: 0.04,
  goalRelevance: 0.03,
} as const;

/** Connection age at which the age term is effectively maxed, in days (~5 years). */
const AGE_SATURATION_DAYS = 1825;

const PUBLIC_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "ymail.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "gmx.com",
  "mail.com",
  "fastmail.com",
]);

/** True for consumer mailbox providers, where a shared domain means nothing. */
export function publicEmailDomain(domain: string): boolean {
  return PUBLIC_EMAIL_DOMAINS.has(domain.trim().toLowerCase());
}

export type PriorInput = {
  firstInteractionAt?: Date | string | null;
  dateMet?: Date | string | null;
  createdAt?: Date | string | null;
  /** Contact's email domain equals the user's, and neither is a public provider. */
  emailDomainMatchesUser?: boolean;
  /** Share of the user's orbit at this contact's company, 0–1. */
  companyConcentration?: number;
  /** Share of the user's orbit at this contact's school, 0–1. */
  schoolConcentration?: number;
  /** Reuse of the existing goal-relevance component, 0–1. */
  goalRelevance?: number;
};

/**
 * How long you have known someone, as a 0–1 term.
 *
 * A LinkedIn connection from 2014 that never became a conversation still means
 * more than one made last Tuesday — it survived. `firstInteractionAt` is
 * preferred, `dateMet` is the LinkedIn "Connected On" date, and `createdAt` is
 * a last resort that only orders import batches against each other.
 */
function ageComponent(input: PriorInput): number {
  const ref = input.firstInteractionAt || input.dateMet || input.createdAt;
  if (!ref) return 0;
  const days = daysAgo(ref);
  if (!Number.isFinite(days) || days <= 0) return 0;
  return Math.min(1, days / AGE_SATURATION_DAYS);
}

export function computePrior(input: PriorInput): number {
  const terms =
    PRIOR_WEIGHTS.age * ageComponent(input) +
    PRIOR_WEIGHTS.emailDomain * (input.emailDomainMatchesUser ? 1 : 0) +
    PRIOR_WEIGHTS.companyConcentration * clamp01(input.companyConcentration ?? 0) +
    PRIOR_WEIGHTS.schoolConcentration * clamp01(input.schoolConcentration ?? 0) +
    PRIOR_WEIGHTS.goalRelevance * clamp01(input.goalRelevance ?? 0);

  const totalWeight =
    PRIOR_WEIGHTS.age +
    PRIOR_WEIGHTS.emailDomain +
    PRIOR_WEIGHTS.companyConcentration +
    PRIOR_WEIGHTS.schoolConcentration +
    PRIOR_WEIGHTS.goalRelevance;

  const normalised = clamp01(terms / totalWeight);
  return PRIOR_MIN + normalised * (PRIOR_MAX - PRIOR_MIN);
}
