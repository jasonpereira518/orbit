/**
 * Reads a reminder out of a typed sentence: "remind me to call Sam friday" → a reminder titled
 * "Call Sam", due that Friday. ⌘K offers it as a pre-filled New reminder, the way a sentence that
 * reads like a note is offered as "Capture this".
 *
 * Pure, with `now` passed in, so `scripts/smoke-reminder-phrase.ts` pins it. Deliberately modest:
 * it understands the few ways people actually say a date in a reminder, and when it does not
 * recognise one it leaves the words in the title rather than guess — a wrong due date is worse
 * than none, because the person sees the form before anything is saved.
 *
 * Dates, relative to `now` (all resolve to a calendar day, which is all a reminder holds):
 * - `today`, `tonight`, `tomorrow` (`tmrw`)
 * - `friday`: the coming one, strictly after today. `this friday`: the coming one, today counts.
 *   `next friday`: the one in NEXT week (Monday to Sunday), whatever day it is today.
 * - `next week` (that Monday), `next month` (the 1st), `in 3 days`, `in 2 weeks`, `in a month`
 * - `dec 3`, `december 3rd`, `3 dec` (the next time that date comes round), `11/20`, `2026-11-20`
 */
import { addDays, addMonths, addWeeks, format, isValid, startOfWeek } from "date-fns";

export type ReminderPhrase = {
  /** What to remind about, in the person's own words, sentence-cased. */
  title: string;
  /** `YYYY-MM-DD`, or null when the sentence names no day it understands. */
  due: string | null;
};

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
/** Short forms that are not also ordinary words ("sat", "sun" and "mon" are left out on purpose). */
const WEEKDAY_SHORT: Readonly<Record<string, number>> = { tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5 };
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"] as const;

/** How the sentence starts when it is a reminder. `keep`: the opening words are part of the title. */
const TRIGGERS: Array<{ re: RegExp; keep?: boolean }> = [
  { re: /^remind me(?:\s+(?:to|about|that))?\b\s*/i },
  { re: /^reminder\b\s*(?:to\b|about\b|:|-)?\s*/i },
  { re: /^remember to\b\s*/i },
  { re: /^don['’]?t forget(?:\s+to)?\b\s*/i },
  { re: /^to-?do\b\s*:?\s*/i },
  { re: /^follow up (?:with|on)\b/i, keep: true },
];

const WEEKDAY_RE = `(?:${WEEKDAYS.join("|")}|${Object.keys(WEEKDAY_SHORT).join("|")})`;
const MONTH_RE = `(?:${MONTHS.join("|")})[a-z]*\\.?`;
const NUM_WORDS: Readonly<Record<string, number>> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

/** A date phrase, as one alternation; the named groups say which kind matched. */
const DATE_RE = new RegExp(
  [
    `\\b(?<iso>\\d{4}-\\d{2}-\\d{2})\\b`,
    `\\b(?<slash>\\d{1,2}\\/\\d{1,2})(?:\\/\\d{2,4})?\\b`,
    `\\b(?<monthday>(?:${MONTH_RE})\\s+\\d{1,2}(?:st|nd|rd|th)?)\\b`,
    `\\b(?<daymonth>\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTH_RE}))\\b`,
    `\\bin\\s+(?<n>\\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\\s+(?<unit>day|week|month)s?\\b`,
    `\\b(?<mod>next|this)\\s+(?<modday>${WEEKDAY_RE})\\b`,
    `\\bnext\\s+(?<nextspan>week|month)\\b`,
    `\\b(?<rel>today|tonight|tomorrow|tmrw|tmr)\\b`,
    `\\b(?<day>${WEEKDAY_RE})\\b`,
  ].join("|"),
  "gi"
);

const iso = (d: Date) => format(d, "yyyy-MM-dd");
const weekdayIndex = (word: string) => {
  const w = word.toLowerCase();
  const i = WEEKDAYS.indexOf(w as (typeof WEEKDAYS)[number]);
  return i >= 0 ? i : (WEEKDAY_SHORT[w] ?? -1);
};
const monthIndex = (word: string) => MONTHS.indexOf(word.toLowerCase().slice(0, 3) as (typeof MONTHS)[number]);

/** The next `month`/`day` on or after `today`: a December date said in December means this year. */
function nextOccurrence(month: number, day: number, today: Date): Date | null {
  for (const year of [today.getFullYear(), today.getFullYear() + 1]) {
    const d = new Date(year, month, day);
    // `new Date(2026, 1, 31)` rolls over to March; a day that does not exist is not a date.
    if (!isValid(d) || d.getMonth() !== month || d.getDate() !== day) continue;
    if (d >= today) return d;
  }
  return null;
}

/** The day a matched phrase stands for, or null when it names none that exists. */
function resolve(g: Record<string, string | undefined>, today: Date): Date | null {
  if (g.iso) {
    const [y, m, d] = g.iso.split("-").map(Number) as [number, number, number];
    const date = new Date(y, m - 1, d);
    return date.getMonth() === m - 1 && date.getDate() === d ? date : null;
  }
  if (g.slash) {
    const [m, d] = g.slash.split("/").map(Number) as [number, number];
    return nextOccurrence(m - 1, d, today);
  }
  if (g.monthday) {
    const [mon, day] = g.monthday.split(/\s+/) as [string, string];
    return nextOccurrence(monthIndex(mon), parseInt(day, 10), today);
  }
  if (g.daymonth) {
    const [day, mon] = g.daymonth.split(/\s+/) as [string, string];
    return nextOccurrence(monthIndex(mon), parseInt(day, 10), today);
  }
  if (g.n && g.unit) {
    const n = /^\d+$/.test(g.n) ? parseInt(g.n, 10) : (NUM_WORDS[g.n.toLowerCase()] ?? 0);
    if (n < 1 || n > 52) return null;
    const unit = g.unit.toLowerCase();
    return unit === "day" ? addDays(today, n) : unit === "week" ? addWeeks(today, n) : addMonths(today, n);
  }
  if (g.rel) return /^(today|tonight)$/i.test(g.rel) ? today : addDays(today, 1);
  if (g.nextspan) {
    return g.nextspan.toLowerCase() === "week"
      ? startOfWeek(addWeeks(today, 1), { weekStartsOn: 1 })
      : new Date(today.getFullYear(), today.getMonth() + 1, 1);
  }
  const word = g.modday ?? g.day;
  if (word) {
    const target = weekdayIndex(word);
    if (target < 0) return null;
    const mod = g.mod?.toLowerCase();
    if (mod === "next") {
      // Monday-to-Sunday weeks: "next friday" is the Friday of the week after this one.
      const monday = startOfWeek(addWeeks(today, 1), { weekStartsOn: 1 });
      return addDays(monday, (target + 6) % 7);
    }
    // "friday" is the coming one, never today; "this friday" lets today count.
    const ahead = (target - today.getDay() + 7) % 7;
    return addDays(today, ahead === 0 && mod !== "this" ? 7 : ahead);
  }
  return null;
}

/** Words that join a date phrase to the rest ("call Sam on friday", "by the 20th") and go with it. */
const JOINERS = /(?:\s+(?:on|by|for|at|this|before|until|till))*\s*$/i;

function tidy(text: string): string {
  const t = text
    .replace(/\s+/g, " ")
    .replace(/^[\s,;:.\-–—]+|[\s,;:.\-–—!?]+$/g, "")
    .replace(/^(?:to|that|about)\s+/i, "");
  return t ? t[0].toUpperCase() + t.slice(1) : "";
}

/**
 * The reminder `text` asks for, or null when it is not one. A trigger ("remind me to…",
 * "don't forget…", "follow up with…") is required: any sentence with a weekday in it is not a
 * reminder, and ⌘K must not hijack a note about Friday's meeting.
 */
export function parseReminderPhrase(text: string, now: Date = new Date()): ReminderPhrase | null {
  const input = text.trim();
  if (!input) return null;
  let rest: string | null = null;
  for (const t of TRIGGERS) {
    const m = t.re.exec(input);
    if (m) {
      rest = t.keep ? input : input.slice(m[0].length);
      break;
    }
  }
  if (rest === null) return null;

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // The LAST date phrase wins: "remind me to send the 12/3 deck friday" is due Friday.
  let found: { index: number; length: number; day: Date } | null = null;
  for (const m of rest.matchAll(DATE_RE)) {
    const day = resolve(m.groups ?? {}, today);
    if (day) found = { index: m.index, length: m[0].length, day };
  }

  let title = rest;
  let due: string | null = null;
  if (found) {
    due = iso(found.day);
    const before = rest.slice(0, found.index).replace(JOINERS, "");
    const after = rest.slice(found.index + found.length);
    title = `${before} ${after}`;
  }
  const clean = tidy(title);
  if (clean.length < 2) return null;
  return { title: clean, due };
}
