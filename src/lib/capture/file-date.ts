/**
 * What date a dropped meeting-note file is about.
 *
 * Pure and DOM-free (it takes a plain `{ name, lastModified }`), so
 * `scripts/smoke-capture-file-date.ts` drives it without a browser.
 *
 * Precedence, and the reasoning for it:
 *
 *   1. a date the MODEL reads out of the file's contents — content always beats metadata,
 *      because metadata is something a human never curated
 *   2. a date in the FILENAME — people who keep meeting notes name them by date
 *   3. `File.lastModified`, and only when it is more than a day older than the upload
 *   4. the upload moment
 *
 * This module answers 2 and 3. The caller feeds the result in as `hints.eventDate`, which
 * leaves 1 free to win: `runCaptureParse` only stamps `anchorBasis: "hint"` when the parse
 * found no date of its own.
 *
 * Tier 3 is hedged deliberately. `lastModified` is the least trustworthy signal here — a
 * file copied out of Drive, Dropbox or an email attachment carries the COPY time, and a
 * browser returns `Date.now()` for a file with no mtime at all. Without the 24-hour guard,
 * "mtime" silently means "today" while looking like evidence.
 */

export type FileDateSource = "filename" | "mtime" | "none";

/** Older than this and a real filesystem date is worth believing. */
export const MTIME_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/** Anything outside this is a version number or an id, not a year. */
const MIN_YEAR = 1990;

function pad(n: number) {
  return String(n).padStart(2, "0");
}

export function toIsoDay(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Real calendar date, or null. Rejects 2026-02-31 rather than rolling it into March. */
function makeDay(year: number, month: number, day: number, maxYear: number): string | null {
  if (year < MIN_YEAR || year > maxYear) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(year, month - 1, day, 12, 0, 0, 0);
  if (Number.isNaN(d.getTime())) return null;
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  return toIsoDay(d);
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

/** `2026-03-15`, `2026_03_15`, `2026.03.15` — year first, so never ambiguous. */
const ISO_RE = /(?<![0-9])(20\d{2})[-_.](\d{1,2})[-_.](\d{1,2})(?![0-9])/;
/** `20260315`, and `IMG_20260315_093000`. Eight digits, year first. */
const COMPACT_RE = /(?<![0-9])(20\d{2})(\d{2})(\d{2})(?![0-9])/;
/** `Mar 15 2026`, `15 March 2026`, `March-15-2026`. */
const MONTH_FIRST_RE = new RegExp(
  `\\b(${Object.keys(MONTHS).join("|")})[-_. ]+(\\d{1,2})(?:st|nd|rd|th)?[-_., ]+(20\\d{2})\\b`,
  "i"
);
const DAY_FIRST_RE = new RegExp(
  `\\b(\\d{1,2})(?:st|nd|rd|th)?[-_. ]+(${Object.keys(MONTHS).join("|")})[-_., ]+(20\\d{2})\\b`,
  "i"
);
/**
 * `03-15-2026` or `15-03-2026` — the ambiguous ones.
 *
 * Only resolved when exactly one component is greater than 12, which settles it. A file
 * named `03-04-2026` could be 3 April or 4 March depending on who named it, and guessing
 * silently shifts every relative reminder in that note. It stays unread.
 */
const AMBIGUOUS_RE = /(?<![0-9])(\d{1,2})[-_.](\d{1,2})[-_.](20\d{2})(?![0-9])/;

/**
 * A date from the filename, or null.
 *
 * `maxYear` bounds the future: a year beyond next year is a build number or an id that
 * happens to start with 20, not a meeting date.
 */
export function dateFromFilename(name: string, now = new Date()): string | null {
  const maxYear = now.getFullYear() + 1;
  const base = name.replace(/\.[A-Za-z0-9]{1,8}$/, "");

  const iso = base.match(ISO_RE);
  if (iso) {
    const hit = makeDay(Number(iso[1]), Number(iso[2]), Number(iso[3]), maxYear);
    if (hit) return hit;
  }

  const compact = base.match(COMPACT_RE);
  if (compact) {
    const hit = makeDay(Number(compact[1]), Number(compact[2]), Number(compact[3]), maxYear);
    if (hit) return hit;
  }

  const monthFirst = base.match(MONTH_FIRST_RE);
  if (monthFirst) {
    const month = MONTHS[monthFirst[1].toLowerCase()];
    const hit = month ? makeDay(Number(monthFirst[3]), month, Number(monthFirst[2]), maxYear) : null;
    if (hit) return hit;
  }

  const dayFirst = base.match(DAY_FIRST_RE);
  if (dayFirst) {
    const month = MONTHS[dayFirst[2].toLowerCase()];
    const hit = month ? makeDay(Number(dayFirst[3]), month, Number(dayFirst[1]), maxYear) : null;
    if (hit) return hit;
  }

  const ambiguous = base.match(AMBIGUOUS_RE);
  if (ambiguous) {
    const a = Number(ambiguous[1]);
    const b = Number(ambiguous[2]);
    const year = Number(ambiguous[3]);
    // Exactly one of the two can be a month. Both ≤ 12 is unresolvable; both > 12 is not a date.
    if (a > 12 && b <= 12) return makeDay(year, b, a, maxYear);
    if (b > 12 && a <= 12) return makeDay(year, a, b, maxYear);
  }

  return null;
}

export type FileDateGuess = { iso: string | null; source: FileDateSource };

export function anchorForFile(
  file: { name: string; lastModified?: number },
  now = new Date()
): FileDateGuess {
  const fromName = dateFromFilename(file.name, now);
  if (fromName) return { iso: fromName, source: "filename" };

  const mtime = file.lastModified;
  if (typeof mtime === "number" && Number.isFinite(mtime) && mtime > 0) {
    if (now.getTime() - mtime > MTIME_MIN_AGE_MS) {
      const d = new Date(mtime);
      if (!Number.isNaN(d.getTime()) && d.getFullYear() >= MIN_YEAR) {
        return { iso: toIsoDay(d), source: "mtime" };
      }
    }
  }

  return { iso: null, source: "none" };
}
