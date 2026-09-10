import { BASE_PRIOR, SIGNAL_TRIGGER } from "./registry";
import { daysBetween } from "./time";
import type {
  ContactSnapshot,
  SignalCandidate,
  SignalKind,
} from "./types";

/** Below this many days since the last interaction, staleness signals are refuted. */
export const RECENT_CONTACT_DAYS = 7;
export const WEIGHT_MIN = 0.25;
export const WEIGHT_MAX = 2;
/** A kind's learned weight stays pinned at 1.0 until it has been shown this often. */
export const WEIGHT_MIN_SHOWN = 5;
export const SHORTLIST_SIZE = 12;
export const RECENCY_REFERENCE_DAYS = 90;

export type WeightRow = {
  kind: string;
  weight: number;
  shown: number;
  accepted: number;
  dismissed: number;
};

export type Suppression = {
  /** Null means every contact. */
  contactId: string | null;
  /** Null means every kind. */
  kind: string | null;
  /** Null means permanent — an explicit mute. */
  until: Date | null;
};

export type ScoredSuggestion = {
  contactId: string;
  primaryKind: SignalKind;
  score: number;
  signals: { kind: SignalKind; score: number; evidence: string }[];
  dueOn: Date;
};

function clamp(x: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, x));
}

/** 0.8 – 1.4, from closeness tier and explicit priority. */
export function contactWeight(c: ContactSnapshot): number {
  const tier = c.closenessTier === "inner" ? 0.3 : c.closenessTier === "mid" ? 0.15 : 0;
  const priority = 0.1 * Math.min(Math.max(c.priorityLevel ?? 0, 0), 3);
  return 0.8 + tier + priority;
}

/**
 * Saturating: a contact idle 400 days is not meaningfully more urgent than one idle
 * 180. Date-triggered kinds ignore idleness entirely — a birthday is not more of a
 * birthday because you have not spoken.
 */
export function recencyFit(kind: SignalKind, idleDays: number | null): number {
  if (SIGNAL_TRIGGER[kind] === "date") return 1;
  if (idleDays === null) return 1;
  const saturate = Math.min(Math.max(idleDays, 0) / RECENCY_REFERENCE_DAYS, 2);
  return 0.7 + 0.25 * saturate;
}

/**
 * The learned multiplier.
 *
 * Pinned at 1.0 below WEIGHT_MIN_SHOWN observations: without the pin, one early
 * dismissal permanently kills a signal type for that user. Laplace smoothing keeps a
 * 0-for-5 kind from collapsing to zero.
 */
export function userWeight(
  row: WeightRow | undefined,
  userMeanAcceptRate: number
): number {
  if (!row || row.shown < WEIGHT_MIN_SHOWN) return 1;
  const rate = (row.accepted + 1) / (row.shown + 2);
  const mean = Math.max(0.01, userMeanAcceptRate);
  return clamp(rate / mean, WEIGHT_MIN, WEIGHT_MAX);
}

/** A suppression matches when both its contact and kind constraints match (null = wildcard). */
export function isSuppressed(
  kind: SignalKind,
  contactId: string,
  suppressions: Suppression[],
  now: Date
): boolean {
  return suppressions.some((s) => {
    if (s.until !== null && s.until <= now) return false;
    if (s.contactId !== null && s.contactId !== contactId) return false;
    if (s.kind !== null && s.kind !== kind) return false;
    return true;
  });
}

/**
 * THE most important rule in the engine.
 *
 * "Reach out to Priya, she has gone quiet" the morning after coffee with her is what
 * makes a user disable this feature permanently. Staleness-triggered signals treat the
 * ABSENCE of contact as their evidence, so recent contact refutes them outright.
 * Date-triggered signals are unaffected: talking yesterday does not make it any less
 * their birthday.
 */
export function refutedByRecentContact(
  kind: SignalKind,
  idleDays: number | null
): boolean {
  if (SIGNAL_TRIGGER[kind] === "date") return false;
  return idleDays !== null && idleDays < RECENT_CONTACT_DAYS;
}

export type ScoreInput = {
  now: Date;
  candidates: SignalCandidate[];
  contactsById: Map<string, ContactSnapshot>;
  suppressions: Suppression[];
  weightsByKind: Map<string, WeightRow>;
  contactsWithPendingReminder: Set<string>;
  contactsWithPendingSuggestion: Set<string>;
  shortlistSize?: number;
};

/**
 * Filter, score, fuse per contact, sort, and cut to the shortlist.
 *
 * Returns at most one row per contact: two reasons to message the same person is one
 * card with two reasons, never two cards.
 */
export function scoreCandidates(input: ScoreInput): ScoredSuggestion[] {
  const mean = meanAcceptRate(input.weightsByKind);
  const byContact = new Map<string, ScoredSuggestion>();

  for (const candidate of input.candidates) {
    const contact = input.contactsById.get(candidate.contactId);
    if (!contact) continue;

    // Filter 3 — someone pinned off their own constellation has been explicitly
    // removed from view. This is the one place that pin reaches beyond /graph.
    if (contact.constellationPin === "out") continue;
    // Filters 4 and 5 — never stack a suggestion on an existing one, or on a
    // reminder the user already has for this person.
    if (input.contactsWithPendingSuggestion.has(candidate.contactId)) continue;
    if (input.contactsWithPendingReminder.has(candidate.contactId)) continue;

    const idle = daysBetween(contact.lastInteractionAt, input.now);
    // Filter 1.
    if (refutedByRecentContact(candidate.kind, idle)) continue;
    // Filter 2.
    if (isSuppressed(candidate.kind, candidate.contactId, input.suppressions, input.now)) {
      continue;
    }

    const score =
      BASE_PRIOR[candidate.kind] *
      contactWeight(contact) *
      recencyFit(candidate.kind, idle) *
      userWeight(input.weightsByKind.get(candidate.kind), mean);

    const entry = byContact.get(candidate.contactId);
    if (!entry) {
      byContact.set(candidate.contactId, {
        contactId: candidate.contactId,
        primaryKind: candidate.kind,
        score,
        signals: [{ kind: candidate.kind, score, evidence: candidate.evidence }],
        dueOn: candidate.dueOn,
      });
      continue;
    }

    entry.signals.push({ kind: candidate.kind, score, evidence: candidate.evidence });
    if (score > entry.signals.find((s) => s.kind === entry.primaryKind)!.score) {
      entry.primaryKind = candidate.kind;
      // The winning signal owns the surfacing date: a birthday three days out must
      // not be dragged to today by a dormancy signal riding along with it.
      entry.dueOn = candidate.dueOn;
    }
  }

  // Fusion: three converging reasons should beat one, but must not run away.
  for (const entry of byContact.values()) {
    entry.score = fuse(entry.signals.map((s) => s.score));
    entry.signals.sort((a, b) => b.score - a.score);
  }

  return [...byContact.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, input.shortlistSize ?? SHORTLIST_SIZE);
}

/** max + 15% of everything else, capped at 1.5x max. */
export function fuse(scores: number[]): number {
  if (scores.length === 0) return 0;
  const sorted = [...scores].sort((a, b) => b - a);
  const max = sorted[0];
  const rest = sorted.slice(1).reduce((a, b) => a + b, 0);
  return Math.min(max + 0.15 * rest, max * 1.5);
}

function meanAcceptRate(weights: Map<string, WeightRow>): number {
  const rows = [...weights.values()].filter((r) => r.shown >= WEIGHT_MIN_SHOWN);
  if (rows.length === 0) return 0.2;
  const total = rows.reduce((acc, r) => acc + (r.accepted + 1) / (r.shown + 2), 0);
  return total / rows.length;
}
