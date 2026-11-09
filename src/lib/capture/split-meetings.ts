/**
 * One paste, several meetings: find the dated headers that start each one.
 *
 * People paste a week of notes at once ("Nov 3 — coffee with Sam … / Nov 5 — call with
 * Priya …"). Read as one note, every card shares one date and "next Tuesday" in Priya's
 * notes counts from Sam's coffee. Split at the headers, each meeting is parsed with its own
 * date and the parts fold into one review (`combineCaptureResults`).
 *
 * A header is a short line that starts with a date (optionally after `#`s or a weekday),
 * set apart from the line above it. Fewer than two dated headers → no split, and the note
 * is read exactly as before.
 *
 * ponytail: date headers only. Meetings separated without a date ("Coffee with Sam:") stay
 * one note; add a cheap model pass if people paste those.
 *
 * Pure: no database, no clock beyond the `now` it is given.
 */

export type MeetingSegment = {
  /** The header line, cleaned, shown on each card as "From …". */
  label: string;
  /** The header and everything under it, up to the next header. */
  text: string;
  /** The header's date, YYYY-MM-DD. */
  dateIso: string;
};

/** Past this, a paste is a log, not a few meetings: read it as one note. */
export const MAX_MEETING_SEGMENTS = 8;
const MAX_HEADER_CHARS = 100;
const MIN_SEGMENT_CHARS = 20;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAY = String.raw`(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+`;
const MONTH = String.raw`(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?`;
const LEAD = String.raw`^\s*(?:#{1,6}\s*)?(?:\*\*)?\s*(?:${WEEKDAY})?`;

const PATTERNS: Array<{ re: RegExp; read: (m: RegExpExecArray) => [number | null, number, number] }> = [
  // 2026-11-03
  { re: new RegExp(`${LEAD}(\\d{4})-(\\d{1,2})-(\\d{1,2})\\b`, "i"), read: (m) => [Number(m[1]), Number(m[2]), Number(m[3])] },
  // 11/3, 11/3/26, 11/3/2026
  {
    re: new RegExp(`${LEAD}(\\d{1,2})/(\\d{1,2})(?:/(\\d{2,4}))?\\b`, "i"),
    read: (m) => [m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : null, Number(m[1]), Number(m[2])],
  },
  // Nov 3, November 3rd, Nov 3, 2026
  {
    re: new RegExp(`${LEAD}${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`, "i"),
    read: (m) => [m[3] ? Number(m[3]) : null, MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase()) + 1, Number(m[2])],
  },
  // 3 Nov, 3rd November 2026
  {
    re: new RegExp(`${LEAD}(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH}\\b(?:,?\\s+(\\d{4}))?`, "i"),
    read: (m) => [m[3] ? Number(m[3]) : null, MONTHS.indexOf(m[2]!.slice(0, 3).toLowerCase()) + 1, Number(m[1])],
  },
];

const pad = (n: number) => String(n).padStart(2, "0");

/** The date a header line opens with, as YYYY-MM-DD, or null. A missing year is the latest one not past next week. */
export function headerDate(line: string, now: Date): string | null {
  if (line.trim().length > MAX_HEADER_CHARS) return null;
  for (const { re, read } of PATTERNS) {
    const m = re.exec(line);
    if (!m) continue;
    const [y, mo, d] = read(m);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    let year = y ?? now.getUTCFullYear();
    if (y == null && Date.UTC(year, mo - 1, d) > now.getTime() + 7 * 86_400_000) year -= 1;
    const check = new Date(Date.UTC(year, mo - 1, d));
    if (check.getUTCMonth() !== mo - 1) return null; // Feb 30
    return `${year}-${pad(mo)}-${pad(d)}`;
  }
  return null;
}

function cleanLabel(line: string): string {
  return line.replace(/^\s*#{1,6}\s*/, "").replace(/\*\*/g, "").replace(/[:\s—–-]+$/, "").trim().slice(0, 80);
}

/**
 * The meetings in `corpus`, one per dated header — or [] when it reads as one note (fewer
 * than two headers, two headers on the same date, too many, or a header with nothing under it).
 */
export function splitMeetings(corpus: string, now: Date = new Date()): MeetingSegment[] {
  const lines = corpus.split(/\r?\n/);
  const starts: Array<{ at: number; dateIso: string }> = [];
  lines.forEach((line, i) => {
    const prevBlank = i === 0 || !lines[i - 1]!.trim() || /^\s*(---+|\*\*\*+|___+)\s*$/.test(lines[i - 1]!);
    if (!prevBlank) return;
    const dateIso = headerDate(line, now);
    if (dateIso) starts.push({ at: i, dateIso });
  });
  if (starts.length < 2 || starts.length > MAX_MEETING_SEGMENTS) return [];
  if (new Set(starts.map((s) => s.dateIso)).size < 2) return [];

  const segments: MeetingSegment[] = [];
  // Anything above the first header (a title, "my notes this week") rides with the first meeting.
  starts.forEach((s, n) => {
    const from = n === 0 ? 0 : s.at;
    const to = starts[n + 1]?.at ?? lines.length;
    const text = lines
      .slice(from, to)
      .join("\n")
      .replace(/\n\s*(---+|\*\*\*+|___+)\s*$/, "")
      .trim();
    segments.push({ label: cleanLabel(lines[s.at]!), text, dateIso: s.dateIso });
  });
  if (segments.some((s) => s.text.length - s.label.length < MIN_SEGMENT_CHARS)) return [];
  return segments;
}
