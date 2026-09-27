/**
 * Reads a recurring rhythm out of a phrase somebody actually said — "check in monthly",
 * "ping me every two weeks", "quarterly" — and turns it into a number of days.
 *
 * Pure and deterministic, like `relative-date.ts` next door, so the grammar is checkable
 * without a model. The AI only copies the phrase verbatim; containment proves the phrase is
 * in the note, and this decides whether it means anything.
 *
 * Days, not an RRULE and not a unit+count pair, because every consumer already works in
 * days: `windowDueDate`, `followUpDaysFor`, and the idle thresholds in `src/lib/reminders.ts`.
 * "Every two weeks" and "biweekly" both collapse to 14 with no ambiguity. "Monthly" is 30,
 * which drifts about five days a year — acceptable for a nudge, and precisely why a stated
 * cadence schedules only the NEXT occurrence rather than a recurring series.
 *
 * Unknown phrasing returns null rather than a guess. A wrong cadence is worse than none: it
 * silently retunes the dormancy thresholds for that person.
 */
import { atLocalNoon } from "@/lib/interaction-date";
import { NUMBER_WORDS } from "@/lib/relative-date";

/**
 * Below three days is a reminder treadmill rather than a relationship cadence, and past a
 * year is indistinguishable from having no cadence at all — both resolve to null, so the
 * default behaviour applies instead of a nominal one.
 */
export const MIN_CADENCE_DAYS = 3;
export const MAX_CADENCE_DAYS = 365;

export type ParsedCadence = {
  days: number;
  /** The phrase as given, whitespace-collapsed. Stored so the UI can quote the person back. */
  phrase: string;
  /** Which rule fired. Surfaced nowhere; asserted by the smoke test. */
  rule: string;
};

const UNIT_DAYS: Record<string, number> = {
  day: 1,
  week: 7,
  month: 30,
  quarter: 91,
  year: 365,
};

/** "biweekly" is ambiguous in English; the common intent in a meeting note is fortnightly. */
const NAMED: Record<string, { days: number; rule: string }> = {
  daily: { days: 1, rule: "named" },
  weekly: { days: 7, rule: "named" },
  fortnightly: { days: 14, rule: "named" },
  biweekly: { days: 14, rule: "named" },
  "bi-weekly": { days: 14, rule: "named" },
  monthly: { days: 30, rule: "named" },
  bimonthly: { days: 60, rule: "named" },
  quarterly: { days: 91, rule: "named" },
  yearly: { days: 365, rule: "named" },
  annually: { days: 365, rule: "named" },
};

function norm(phrase: string) {
  return phrase.replace(/\s+/g, " ").trim().toLowerCase();
}

function parseCount(raw: string): number | null {
  const s = raw.trim();
  if (/^\d+$/.test(s)) return Number(s);
  return NUMBER_WORDS[s] ?? null;
}

function build(days: number, phrase: string, rule: string): ParsedCadence | null {
  if (!Number.isFinite(days)) return null;
  const rounded = Math.round(days);
  if (rounded < MIN_CADENCE_DAYS || rounded > MAX_CADENCE_DAYS) return null;
  return { days: rounded, phrase, rule };
}

export function parseCadencePhrase(phrase: string): ParsedCadence | null {
  const original = phrase.replace(/\s+/g, " ").trim();
  let p = norm(phrase);
  if (!p) return null;

  // Strip a leading verb so "check in monthly" and "monthly" reach the same rules.
  p = p
    .replace(
      /^(please\s+)?(check\s+in|checkin|touch\s+base|catch\s+up|ping|email|call|message|meet|sync|follow\s+up|reach\s+out)\s+(me\s+|us\s+|with\s+me\s+|with\s+us\s+)?/,
      ""
    )
    .replace(/^(about\s+|roughly\s+|around\s+|at\s+least\s+|maybe\s+)/, "")
    .trim();

  const named = NAMED[p] ?? NAMED[p.replace(/^every\s+/, "")];
  if (named) return build(named.days, original, named.rule);

  // "every other week", "every other month"
  const other = p.match(/^(?:every|each)\s+other\s+(day|week|month|quarter|year)s?$/);
  if (other) {
    const unit = UNIT_DAYS[other[1]];
    return unit ? build(unit * 2, original, "every-other") : null;
  }

  // "every two weeks", "every 3 months", "each quarter", "every week"
  const everyN = p.match(
    /^(?:every|each)\s+(?:([a-z]+(?:\s+[a-z]+){0,2}|\d+)\s+)?(day|week|month|quarter|year)s?$/
  );
  if (everyN) {
    const unit = UNIT_DAYS[everyN[2]];
    if (!unit) return null;
    const count = everyN[1] == null ? 1 : parseCount(everyN[1]);
    if (count == null || count <= 0) return null;
    return build(unit * count, original, "every-n-units");
  }

  // "once a month", "twice a year" — the only counts English lets you write without "times".
  const onceTwice = p.match(/^(once|twice)\s+(?:a|per|each)\s+(day|week|month|quarter|year)$/);
  if (onceTwice) {
    const unit = UNIT_DAYS[onceTwice[2]];
    if (!unit) return null;
    return build(unit / (onceTwice[1] === "twice" ? 2 : 1), original, "once-per-unit");
  }

  // "three times a year", "4 times a year". `times` is REQUIRED here: making it optional
  // would let a bare noun phrase ("a few a year") reach parseCount and resolve.
  const perPeriod = p.match(
    /^([a-z]+(?:\s+[a-z]+){0,2}|\d+)\s+times?\s+(?:a|per|each)\s+(day|week|month|quarter|year)$/
  );
  if (perPeriod) {
    const unit = UNIT_DAYS[perPeriod[2]];
    if (!unit) return null;
    const rawCount = perPeriod[1];
    // "a few times a year" is a vibe, not a commitment — parseCount happily returns 3, and
    // the caller would then schedule a 121-day reminder off a phrase nobody meant that way.
    if (/^(a few|few|several|some|a couple|a couple of|couple)$/.test(rawCount)) return null;
    const count = rawCount === "once" ? 1 : rawCount === "twice" ? 2 : parseCount(rawCount);
    if (count == null || count <= 0) return null;
    return build(unit / count, original, "n-times-per-unit");
  }

  return null;
}

function addDays(d: Date, n: number) {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return atLocalNoon(out);
}

/**
 * The next occurrence of a cadence, counted from the conversation it was agreed in.
 *
 * Rolled forward by whole periods until it is on or after today. This is the entire
 * "next occurrence only" decision made concrete: a note from three months ago saying
 * "monthly" must schedule the NEXT check-in, not one that was already overdue when it was
 * created — a reminder that arrives pre-overdue trains people to ignore the list.
 *
 * The number of whole periods is computed arithmetically rather than by stepping, so there
 * is no iteration cap to outgrow. An earlier version looped with a bound of 400, which a
 * ten-year-old weekly anchor (≈560 steps) silently exceeded — it then returned a date still
 * in the past, which is the one outcome this function exists to prevent.
 *
 * The step itself still goes through `setDate` rather than millisecond arithmetic: both ends
 * are pinned to local noon, so adding days this way survives a DST transition inside the
 * span without drifting onto the previous or next calendar day.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

export function nextCadenceOccurrence(anchor: Date, days: number, today: Date): Date {
  const base = atLocalNoon(anchor);
  const floor = atLocalNoon(today);
  const elapsedDays = (floor.getTime() - base.getTime()) / DAY_MS;
  // At least one period: the next occurrence is never the conversation itself.
  const periods = Math.max(1, Math.ceil(elapsedDays / days));
  let next = addDays(base, periods * days);
  // One corrective step covers any rounding at a DST edge; it is not a loop in disguise.
  if (next < floor) next = addDays(next, days);
  return next;
}
