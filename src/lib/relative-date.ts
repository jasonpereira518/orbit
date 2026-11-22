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
import { addLocalDaysAtNoon } from "@/lib/dates";
import { WEEKDAYS, atLocalNoon } from "@/lib/interaction-date";
import { formatDistance } from "date-fns";

export type DateBasis = "absolute" | "relative" | "vague";

export type ResolvedRelativeDate = {
  date: Date;
  basis: DateBasis;
  /** Which grammar rule fired — surfaced in the results view and asserted by the smoke test. */
  rule: string;
};

export const DEFAULT_VAGUE_WINDOW_DAYS = 14;

/**
 * Shared with `src/lib/cadence-phrase.ts`, which reads counts out of "every two weeks".
 * Exported rather than copied: a second number-word table is how "a couple" comes to mean 2
 * in one file and 3 in another.
 */
export const NUMBER_WORDS: Record<string, number> = {
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
  return addLocalDaysAtNoon(from, delta);
}

/** Monday of the week after the anchor's week (weeks start Monday). */
function nextWeekMonday(from: Date) {
  const dow = from.getDay(); // 0 = Sunday
  const daysUntilNextMonday = dow === 0 ? 1 : 8 - dow;
  return addLocalDaysAtNoon(from, daysUntilNextMonday);
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

  if (p === "tomorrow") return relative(addLocalDaysAtNoon(base, 1), "tomorrow");

  // "in N days|weeks|months", N numeric or a small number word.
  const inN = p.match(/^in ([a-z]+(?: [a-z]+){0,2}|\d+) (day|week|month)s?$/);
  if (inN) {
    const n = parseCount(inN[1]);
    if (n == null || n <= 0) return null;
    const unit = inN[2];
    if (unit === "day") return relative(addLocalDaysAtNoon(base, n), "in-n-units");
    if (unit === "week") return relative(addLocalDaysAtNoon(base, n * 7), "in-n-units");
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
    return relative(addLocalDaysAtNoon(base, delta === 0 ? 0 : delta), "end-of-week");
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
    return { date: addLocalDaysAtNoon(base, days), basis: "vague", rule: "vague" };
  }

  return null;
}

/**
 * "Last touch …" wording. A timestamp later today reads "today" rather than "in about 9
 * hours": date-only interactions were stored at noon before `clampSameDayToNow`, so old rows
 * still carry a noon that is ahead of the morning. Anything else is date-fns' own distance.
 */
export function formatLastTouch(at: Date, now: Date = new Date()): string {
  const sameDay =
    at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate();
  if (sameDay && at.getTime() > now.getTime()) return "today";
  return formatDistance(at, now, { addSuffix: true });
}

// ---------------------------------------------------------------------------------------
// Relative LABELS ("3d", "11 minutes ago"): the one place the wording is decided.
//
// Pure functions of (then, now) so they are testable at a fixed instant. `<RelativeTime>`
// and the admin tables call these; nothing should hand-build a "Nd ago" string. The rules
// below reproduce, byte for byte, the copies they replaced (pinned in
// `relative-label.test.ts`), including the quirks: a future date reads "-5m" in the short
// format, and an invalid date reads "NaNy".
// ---------------------------------------------------------------------------------------

export type RelativeFormat = "short" | "long";

/**
 * Compact admin wording: "just now", "5m", "3h", "12d", "2y". Rounds each unit independently
 * and switches unit at the rounded value (59.5 minutes is "1h"), so a label never reads "60m".
 * `ago: true` appends " ago" to everything except "just now".
 */
export function shortRelativeLabel(then: Date, now: Date = new Date(), opts: { ago?: boolean } = {}): string {
  const suffix = opts.ago ? " ago" : "";
  const diff = now.getTime() - then.getTime();
  const mins = Math.round(diff / 60_000);
  if (Math.abs(mins) < 1) return "just now";
  if (Math.abs(mins) < 60) return `${mins}m${suffix}`;

  const hours = Math.round(diff / 3_600_000);
  if (Math.abs(hours) < 24) return `${hours}h${suffix}`;

  const days = Math.round(diff / 86_400_000);
  if (Math.abs(days) < 365) return `${days}d${suffix}`;

  return `${Math.round(days / 365)}y${suffix}`;
}

/**
 * Sentence wording: "11 minutes ago", "in about 2 hours" (date-fns). Throws a RangeError for
 * an invalid date, as date-fns does; callers that take untrusted strings catch it.
 */
export function longRelativeLabel(then: Date, now: Date = new Date()): string {
  return formatDistance(then, now, { addSuffix: true });
}

/** The label for a `format`, as `<RelativeTime format>` renders it. */
export function relativeLabel(then: Date, now: Date = new Date(), format: RelativeFormat = "short"): string {
  return format === "long" ? longRelativeLabel(then, now) : shortRelativeLabel(then, now);
}

/**
 * The status-strip wording: "3 min ago", "5 h ago", "4 d ago". A THIRD style, not a variant of
 * `shortRelativeLabel`, because it disagrees on every boundary: it clamps the future to "just
 * now" (short gives "-5m"), keeps hours up to 47 (short switches to days at 24), and spaces
 * its units. Kept as its own named formatter so the health strip reads exactly as before.
 */
export function minutesAgoLabel(then: Date, now: Date = new Date()): string {
  const mins = Math.max(0, Math.round((now.getTime() - then.getTime()) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}
