/**
 * Who earns a star on the constellation.
 *
 * The star chart draws every contact a user owns, which for a network built from a bulk
 * LinkedIn connections import means thousands of people they have never spoken to. This is
 * the rule that decides who is actually *in* the relationship: someone written about, met,
 * genuinely talked with, or explicitly marked as mattering.
 *
 * Deliberately pure — no database imports. The tallies come from an aggregate the closeness
 * cohort already runs (see `constellationSignalAggregates` in `closeness-cohort.ts`), and the
 * contact fields come from scans the graph and dashboard already do. Keeping the decision
 * itself free of I/O is what lets one truth table cover it and stops the two payload paths
 * growing two subtly different copies of the rule.
 */

/** How much LinkedIn back-and-forth counts as a real exchange. Operator-tunable. */
export type ConstellationThresholds = {
  minInbound: number;
  minOutbound: number;
};

export const DEFAULT_CONSTELLATION_THRESHOLDS: ConstellationThresholds = {
  minInbound: 3,
  minOutbound: 3,
};

/**
 * Zero would qualify every contact who has never exchanged a single message, quietly
 * turning the filter off while it still reads as on; the ceiling just keeps a typo from
 * emptying somebody's sky.
 */
export const MIN_MESSAGE_THRESHOLD = 1;
export const MAX_MESSAGE_THRESHOLD = 50;

export function clampThresholds(
  input: Partial<ConstellationThresholds> | null | undefined
): ConstellationThresholds {
  const clamp = (value: number | undefined, fallback: number) => {
    if (value == null || !Number.isFinite(value)) return fallback;
    return Math.min(MAX_MESSAGE_THRESHOLD, Math.max(MIN_MESSAGE_THRESHOLD, Math.round(value)));
  };
  return {
    minInbound: clamp(input?.minInbound, DEFAULT_CONSTELLATION_THRESHOLDS.minInbound),
    minOutbound: clamp(input?.minOutbound, DEFAULT_CONSTELLATION_THRESHOLDS.minOutbound),
  };
}

/**
 * Per-contact interaction tallies.
 *
 * `noteInteractions` counts only rows typed as notes. It must never be "any row carrying
 * `raw_notes`": the LinkedIn adapter stores each message body there, so that test would mark
 * every messaged contact as written-about and turn the whole filter into a no-op.
 */
export type ContactSignalCounts = {
  noteInteractions: number;
  /** `meeting` (calendar sync) and `in_person` (derived by the LinkedIn event extractor). */
  meetingInteractions: number;
  linkedInInbound: number;
  linkedInOutbound: number;
  /** Message rows whose sender was never recorded — imported before `direction` existed. */
  linkedInUndirected: number;
};

export const EMPTY_SIGNAL_COUNTS: ContactSignalCounts = {
  noteInteractions: 0,
  meetingInteractions: 0,
  linkedInInbound: 0,
  linkedInOutbound: 0,
  linkedInUndirected: 0,
};

/** The contact-row half of the decision, all of it already on both payload scans. */
export type ConstellationContactFields = {
  pin: "in" | "out" | null;
  /** `contacts.notes` non-empty, as a computed boolean — the column is too heavy to select. */
  hasNotesText: boolean;
  /**
   * Signals that the user said this person matters, as opposed to evidence that they
   * interacted. Without these the rule contradicts the user to their face: `rateContacts`
   * writes only `relationship_score` and logs no interaction, so someone rated 5/5 "closest"
   * in the setup wizard's triage step would be hidden from their own constellation.
   */
  statedCloseness: number | null;
  priorityLevel: number;
  nextFollowUpAt: Date | string | null;
  tagCount: number;
};

export type EligibilityReason =
  | "pinned_in"
  | "pinned_out"
  | "notes"
  | "meeting"
  | "linkedin_exchange"
  | "linkedin_volume_fallback"
  | "intent"
  | "none";

export type EligibilityVerdict = {
  eligible: boolean;
  reason: EligibilityReason;
};

/**
 * Does this contact's LinkedIn history look like a conversation rather than a broadcast?
 *
 * Two rules, and which applies is per contact rather than a global mode. Where any direction
 * is known, a real exchange means both sides showed up — that is the whole point, and it is
 * what separates a conversation from nine unanswered recruiter InMails.
 *
 * Where every row is undirected, the contact was imported before `direction` was persisted.
 * The sender is unrecoverable from stored rows, so a strict two-sided test would be false for
 * every thread imported to date, and the LinkedIn half of the filter would do nothing on the
 * day it shipped. Volume alone stands in until the user re-uploads their export — at which
 * point that contact's rows gain directions and the strict rule takes over on its own, with
 * no migration and no flag to flip.
 */
function messagesQualify(
  counts: ContactSignalCounts,
  thresholds: ConstellationThresholds
): EligibilityReason | null {
  const directedKnown = counts.linkedInInbound > 0 || counts.linkedInOutbound > 0;
  if (directedKnown) {
    return counts.linkedInInbound >= thresholds.minInbound &&
      counts.linkedInOutbound >= thresholds.minOutbound
      ? "linkedin_exchange"
      : null;
  }
  if (counts.linkedInUndirected === 0) return null;
  const bar = thresholds.minInbound + thresholds.minOutbound;
  return counts.linkedInUndirected >= bar ? "linkedin_volume_fallback" : null;
}

/** True when the user has said, in some way, that this person matters. */
function hasIntentSignal(fields: ConstellationContactFields): boolean {
  return (
    fields.statedCloseness != null ||
    fields.priorityLevel >= 1 ||
    fields.nextFollowUpAt != null ||
    fields.tagCount > 0
  );
}

/**
 * The rule, and why a contact landed where it did.
 *
 * The reason is not decoration: a chart that hides two thirds of somebody's network needs to
 * be able to answer "why is this person missing", and a bare boolean cannot.
 */
export function constellationEligibility(
  counts: ContactSignalCounts | undefined,
  fields: ConstellationContactFields,
  thresholds: ConstellationThresholds
): EligibilityVerdict {
  // The manual pin wins over everything, in both directions. It is the escape hatch for a
  // rule that is wrong about one person, which any rule occasionally is.
  if (fields.pin === "out") return { eligible: false, reason: "pinned_out" };
  if (fields.pin === "in") return { eligible: true, reason: "pinned_in" };

  const c = counts ?? EMPTY_SIGNAL_COUNTS;

  if (fields.hasNotesText || c.noteInteractions > 0) {
    return { eligible: true, reason: "notes" };
  }
  // A logged meeting qualifies on its own, whatever the message volume: two messages that
  // read "great to finally meet you" is exactly the relationship the chart is for.
  if (c.meetingInteractions > 0) return { eligible: true, reason: "meeting" };

  const messageReason = messagesQualify(c, thresholds);
  if (messageReason) return { eligible: true, reason: messageReason };

  if (hasIntentSignal(fields)) return { eligible: true, reason: "intent" };

  return { eligible: false, reason: "none" };
}

export function isConstellationEligible(
  counts: ContactSignalCounts | undefined,
  fields: ConstellationContactFields,
  thresholds: ConstellationThresholds
): boolean {
  return constellationEligibility(counts, fields, thresholds).eligible;
}

/**
 * Below this much of a network qualifying, the filter switches itself off for that user.
 *
 * This is the difference between a feature and an outage. The LinkedIn *connections* adapter
 * logs no interactions at all, so a user whose network came from that import — which the
 * setup wizard leads with — qualifies nobody. Without a floor they open `/graph` to an empty
 * sky and a card inviting them to add contacts they already have.
 *
 * A ratio alone is not enough (20% of 5 people is one star), and a count alone is not enough
 * (15 qualifying out of 4,000 is still an empty-looking sky), so both must clear.
 */
export const CONSTELLATION_FLOOR_MIN_ELIGIBLE = 15;
export const CONSTELLATION_FLOOR_MIN_SHARE = 0.2;

export function meetsConstellationFloor(
  eligibleCount: number,
  totalContacts: number
): boolean {
  if (totalContacts === 0) return false;
  if (eligibleCount < CONSTELLATION_FLOOR_MIN_ELIGIBLE) return false;
  return eligibleCount / totalContacts >= CONSTELLATION_FLOOR_MIN_SHARE;
}
