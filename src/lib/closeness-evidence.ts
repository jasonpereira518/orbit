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
  return Math.min(1, Math.max(0, n));
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
