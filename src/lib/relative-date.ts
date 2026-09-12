/**
 * Resolves a relative date phrase ("in two weeks", "next Friday", "soon") against an anchor
 * date — the date the note is about, not necessarily today.
 *
 * Pure and deterministic so the grammar is checkable without a model; the AI only copies
 * the phrase verbatim, and `validateCommitments` proves the phrase exists in the note before
 * this runs. Unknown phrasing returns null rather than a guess.
 *
 * Deliberately NOT `parseInteractionDateFromNotes`: that walks yearless dates backwards to
 * date a past interaction. This always looks forward.
 */
import { WEEKDAYS, atLocalNoon } from "@/lib/interaction-date";

export type DateBasis = "absolute" | "relative" | "vague";

export type ResolvedRelativeDate = {
  date: Date;
  basis: DateBasis;
  /** Which grammar rule fired — surfaced in the results view and asserted by the smoke test. */
  rule: string;
};

export const DEFAULT_VAGUE_WINDOW_DAYS = 14;

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, a: 1, an: 1, "a couple of": 2, "a couple": 2,
  couple: 2, "a few": 3, few: 3, several: 3,
};

const WEEKDAY_ALTERNATION = Object.keys(WEEKDAYS).sort((a, b) => b.length - a.length).join("|");

const VAGUE_RE =
  /^(soon|at some point|sometime|some time|later|eventually|when (i|you|we) (get|have) (a|the) chance|next time|when (i'm|you're|i am|you are) back)$/;

function norm(phrase: string) {
  return phrase.replace(/\s+/g, " ").trim().toLowerCase();
}

function addDays(d: Date, n: number) {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return atLocalNoon(out);
}

/** Month arithmetic that clamps to the last day of the target month instead of overflowing. */
function addMonths(d: Date, n: number) {
  const target = new Date(d.getFullYear(), d.getMonth() + n, 1, 12);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(d.getDate(), lastDay));
  return atLocalNoon(target);
}

function endOfMonth(d: Date) {
  return atLocalNoon(new Date(d.getFullYear(), d.getMonth() + 1, 0, 12));
}

/** First strictly-after occurrence of a weekday. "Friday" on a Friday means next week. */
function nextWeekday(from: Date, weekday: number) {
  const delta = (weekday - from.getDay() + 7) % 7 || 7;
  return addDays(from, delta);
}

/** Monday of the week after the anchor's week (weeks start Monday). */
function nextWeekMonday(from: Date) {
  const dow = from.getDay(); // 0 = Sunday
  const daysUntilNextMonday = dow === 0 ? 1 : 8 - dow;
  return addDays(from, daysUntilNextMonday);
}

function parseCount(raw: string): number | null {
  const s = raw.trim();
  if (/^\d+$/.test(s)) return Number(s);
  return NUMBER_WORDS[s] ?? null;
}

export function resolveRelativeDate(
  phrase: string,
  anchor: Date,
  opts?: { defaultWindowDays?: number }
): ResolvedRelativeDate | null {
  const p = norm(phrase);
  if (!p) return null;
  const base = atLocalNoon(anchor);
  const relative = (date: Date, rule: string): ResolvedRelativeDate => ({ date, basis: "relative", rule });

  if (p === "tomorrow") return relative(addDays(base, 1), "tomorrow");

  // "in N days|weeks|months", N numeric or a small number word.
  const inN = p.match(/^in ([a-z]+(?: [a-z]+){0,2}|\d+) (day|week|month)s?$/);
  if (inN) {
    const n = parseCount(inN[1]);
    if (n == null || n <= 0) return null;
    const unit = inN[2];
    if (unit === "day") return relative(addDays(base, n), "in-n-units");
    if (unit === "week") return relative(addDays(base, n * 7), "in-n-units");
    return relative(addMonths(base, n), "in-n-units");
  }

  // Bare weekday, "next <weekday>", "this <weekday>" — all mean the first one strictly after the anchor.
  const wd = p.match(new RegExp(`^(?:next |this |on )?(${WEEKDAY_ALTERNATION})$`));
  if (wd) {
    const weekday = WEEKDAYS[wd[1]];
    if (weekday == null) return null;
    return relative(nextWeekday(base, weekday), "weekday");
  }

  if (p === "next week") return relative(nextWeekMonday(base), "next-week");
  if (p === "next month") {
    return relative(atLocalNoon(new Date(base.getFullYear(), base.getMonth() + 1, 1, 12)), "next-month");
  }

  if (/^(end of (the )?week|eow)$/.test(p)) {
    // Friday of the anchor's week; if the anchor is already Friday or later, next Friday.
    const friday = 5;
    const delta = (friday - base.getDay() + 7) % 7;
    return relative(addDays(base, delta === 0 ? 0 : delta), "end-of-week");
  }
  if (/^(end of (the )?month|eom)$/.test(p)) return relative(endOfMonth(base), "end-of-month");
  if (/^(end of (the )?quarter|eoq)$/.test(p)) {
    const qEndMonth = Math.floor(base.getMonth() / 3) * 3 + 2;
    return relative(atLocalNoon(new Date(base.getFullYear(), qEndMonth + 1, 0, 12)), "end-of-quarter");
  }
  if (/^(end of (the )?year|eoy)$/.test(p)) {
    return relative(atLocalNoon(new Date(base.getFullYear(), 11, 31, 12)), "end-of-year");
  }

  // "Q1".."Q4": first day of that quarter, next future occurrence (a quarter already begun rolls a year).
  const q = p.match(/^q([1-4])$/);
  if (q) {
    const startMonth = (Number(q[1]) - 1) * 3;
    let candidate = new Date(base.getFullYear(), startMonth, 1, 12);
    if (candidate <= base) candidate = new Date(base.getFullYear() + 1, startMonth, 1, 12);
    return relative(atLocalNoon(candidate), "quarter");
  }

  if (/^after the holidays$/.test(p)) {
    const jan2 = new Date(base.getFullYear() + (base.getMonth() === 0 && base.getDate() < 2 ? 0 : 1), 0, 2, 12);
    return relative(atLocalNoon(jan2), "after-holidays");
  }

  if (VAGUE_RE.test(p)) {
    const days = opts?.defaultWindowDays ?? DEFAULT_VAGUE_WINDOW_DAYS;
    return { date: addDays(base, days), basis: "vague", rule: "vague" };
  }

  return null;
}
