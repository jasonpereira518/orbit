/**
 * "Some people you just want to stay in touch with."
 *
 * Every other suggestion in the outreach queue is a guess Orbit makes on the user's behalf:
 * this person is high-value and has gone quiet, that LinkedIn thread stalled, you are waiting
 * on a reply. They are inferences, and they are all wrong for somebody — the mentor you speak
 * to once a year is "dormant" by any heuristic worth having, and nagging about them every
 * quarter is how a tool teaches its user to ignore it.
 *
 * A cadence is the opposite: the user states the interval themselves, per contact. It is the
 * one signal here that needs no inference at all, which is why it outranks every heuristic
 * and why setting one SUPPRESSES `dormant_high_value` for that contact (see
 * `buildOutreachSuggestions`). Having been asked "how often?" and been given an answer,
 * Orbit has no business also applying its own guess.
 *
 * Pure: no database. `buildOutreachSuggestions` does the query and passes rows here.
 */

/**
 * The intervals offered in the UI, in days.
 *
 * Months are approximated as 30 days and a year as 365 deliberately. The alternative —
 * true calendar arithmetic — buys nothing: nobody setting "roughly every quarter" means
 * "on the 12th". Fixed-length days keep the whole thing a subtraction, which is also what
 * makes the predicate below testable without a calendar library.
 */
export const KEEP_IN_TOUCH_PRESETS = [
  { days: 30, label: "Monthly" },
  { days: 90, label: "Quarterly" },
  { days: 180, label: "Twice a year" },
  { days: 365, label: "Yearly" },
] as const;

export type KeepInTouchCadence = (typeof KEEP_IN_TOUCH_PRESETS)[number]["days"];

/** Longest interval we will store. A cadence beyond this is indistinguishable from none. */
export const KEEP_IN_TOUCH_MAX_DAYS = 365;

/**
 * Normalize whatever a caller hands us into a cadence we are willing to store.
 *
 * Returns null for "no cadence", which is also what every invalid value collapses to — a
 * zero, a negative, a fraction, a NaN from a parsed form field. Storing any of those would
 * produce a contact that is permanently overdue and cannot be cleared from the UI.
 */
export function normalizeCadence(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  const days = Math.round(n);
  if (days < 1 || days > KEEP_IN_TOUCH_MAX_DAYS) return null;
  return days;
}

/**
 * How often to keep in touch when the person never said: closest people monthly, the middle
 * ring quarterly, everyone else not at all. Not a setting. A contact's own cadence always wins.
 */
export const TIER_DEFAULT_CADENCE = { inner: 30, mid: 90, outer: null } as const;

import { EVIDENCE_FLOOR } from "@/lib/closeness-evidence";

type Tier = "inner" | "mid" | "outer";
export type CadenceInput = {
  cadenceDays: number | null;
  closenessTier: Tier | null;
  /** The tier default applies only when the tier rests on evidence (>= EVIDENCE_FLOOR); a guessed tier is not a rhythm. */
  closenessEvidence?: number | null;
  lastInteractionAt: Date | string | null;
  dateMet?: Date | string | null;
  createdAt?: Date | string | null;
  nextFollowUpAt: Date | string | null;
};

const DAY_MS = 86_400_000;
const toDate = (v: Date | string | null | undefined): Date | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

export function effectiveCadenceDays(
  c: Pick<CadenceInput, "cadenceDays" | "closenessTier" | "closenessEvidence">
): number | null {
  if (c.cadenceDays && c.cadenceDays > 0) return c.cadenceDays;
  return c.closenessTier && (c.closenessEvidence ?? 0) >= EVIDENCE_FLOOR ? TIER_DEFAULT_CADENCE[c.closenessTier] : null;
}

export function isTierDefaultCadence(c: Pick<CadenceInput, "cadenceDays" | "closenessTier" | "closenessEvidence">): boolean {
  return !(c.cadenceDays && c.cadenceDays > 0) && effectiveCadenceDays(c) !== null;
}

/** When the cadence lapses: last touch (else date met, else creation) plus the cadence. */
export function cadenceDueAt(c: CadenceInput): Date | null {
  const days = effectiveCadenceDays(c);
  const anchor = toDate(c.lastInteractionAt) ?? toDate(c.dateMet) ?? toDate(c.createdAt);
  return days === null || !anchor ? null : new Date(anchor.getTime() + days * DAY_MS);
}

/** A booked follow-up always decides; the cadence speaks only when nothing is booked. */
export function followUpDueAt(c: CadenceInput): Date | null {
  return toDate(c.nextFollowUpAt) ?? cadenceDueAt(c);
}

export function isFollowUpDue(c: CadenceInput, now: Date): boolean {
  const at = followUpDueAt(c);
  return at !== null && at.getTime() <= now.getTime();
}

export function cadenceName(days: number): string {
  const preset = KEEP_IN_TOUCH_PRESETS.find((p) => p.days === days);
  if (preset) return preset.label;
  if (days === 7) return "Weekly";
  if (days === 14) return "Every 2 weeks";
  return `Every ${days} days`;
}
