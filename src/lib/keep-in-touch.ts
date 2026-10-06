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

export type CadenceContact = {
  contactId: string;
  keepInTouchDays: number | null;
  lastInteractionAt: Date | string | null;
};

export type CadenceDue = {
  contactId: string;
  /** The interval the user chose, echoed back so callers need not re-read the row. */
  cadenceDays: number;
  /** Whole days since the last recorded touch. Always >= `cadenceDays`. */
  daysSince: number;
};

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

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}

function asDate(value: Date | string | null): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Which contacts are past the interval their user set for them.
 *
 * Sorted by how far past, longest first — the same ordering the rest of the queue uses, so
 * the person most overdue is the one the user sees.
 *
 * `lastInteractionAt` is the clock. It is stamped when a contact is created, so a contact
 * with no logged interaction is measured from when they were added rather than skipped:
 * "you added them three months ago and have never spoken" is exactly the case a cadence is
 * meant to catch. A row with no timestamp at all is skipped, because there is nothing to
 * subtract from.
 */
export function keepInTouchDue(
  rows: CadenceContact[],
  now: Date = new Date()
): CadenceDue[] {
  const due: CadenceDue[] = [];
  for (const row of rows) {
    const cadenceDays = normalizeCadence(row.keepInTouchDays);
    if (cadenceDays === null) continue;
    const last = asDate(row.lastInteractionAt);
    if (!last) continue;
    const daysSince = daysBetween(last, now);
    // A future timestamp means clock skew or bad import data, never a real touch. Treating
    // the negative as "0 days since" is right either way: not overdue.
    if (daysSince < cadenceDays) continue;
    due.push({ contactId: row.contactId, cadenceDays, daysSince });
  }
  return due.sort((a, b) => b.daysSince - a.daysSince);
}

/** "Quarterly" for a preset, "Every 45 days" for anything else. */
export function cadenceLabel(days: number): string {
  const preset = KEEP_IN_TOUCH_PRESETS.find((p) => p.days === days);
  return preset ? preset.label : `Every ${days} days`;
}

/**
 * Says what is true — the interval the user chose, and how long it has actually been —
 * and does not editorialize about the relationship. The user set this cadence; they do not
 * need to be told the contact has "gone quiet".
 */
export function keepInTouchDescription(cadenceDays: number, daysSince: number): string {
  return `${cadenceLabel(cadenceDays)} check-in — last touch ${daysSince} day${
    daysSince === 1 ? "" : "s"
  } ago`;
}
