/**
 * Pure formatting for captured LinkedIn profiles.
 *
 * Kept free of `@/db`, `@/lib/ai` and `@/lib/apollo` on purpose: the contact page renders
 * this in a client component, and a client component that transitively reaches `@/db`
 * fails the build with a `node:fs` chunking error that names neither file.
 *
 * One ordering rule lives here and everything else calls it, so the page, the chat career
 * line, and any future export cannot disagree about what "most recent" means.
 */

import type { ContactExperienceKind } from "@/db/schema";

/** The subset of an experience row that ordering and formatting need. */
export type ExperienceEntry = {
  kind: ContactExperienceKind;
  organization: string;
  title: string | null;
  fieldOfStudy?: string | null;
  startYear: number | null;
  startMonth: number | null;
  endYear: number | null;
  endMonth: number | null;
  isCurrent: boolean;
  sortIndex: number;
};

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** Organizations named in the compact career line, current role included. */
const CAREER_LINE_MAX_ORGS = 4;

/**
 * Sortable rank for a year/month pair. Missing month sorts as mid-year rather than
 * January: "2019" is the whole year, and treating it as its first day would push it below
 * every dated entry from the same year for no reason the source supports.
 */
function datePoint(year: number | null, month: number | null): number | null {
  if (year === null) return null;
  return year * 12 + (month === null ? 6 : month);
}

/** An entry says nothing about when it happened. */
function isUndated(entry: ExperienceEntry): boolean {
  return !entry.isCurrent && entry.startYear === null && entry.endYear === null;
}

/**
 * The ordering rule, stated once.
 *
 * Dated entries sort: current first, then most recently ended, then most recently started.
 * An entry with a start but no end is treated as ongoing and sorts above one that
 * demonstrably ended.
 *
 * Entries with NO dates at all are not sorted at all — they are lifted out, the dated ones
 * are ordered among themselves, and the undated ones are put back at the positions they
 * were captured in. A comparator cannot express this: any total order either floats an
 * undated entry to the top (it has no end date, so it looks ongoing) or sinks it to the
 * bottom (it has no start date, so it looks ancient), and both are inventions. LinkedIn
 * lists an undated entry in a meaningful place, and holding that place is the only honest
 * thing to do with it.
 */
export function orderExperiences<T extends ExperienceEntry>(entries: T[]): T[] {
  // Captured order first, so "the position it was captured in" means sortIndex and not
  // whatever order the caller's array happened to be in.
  const captured = entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) =>
      a.entry.sortIndex !== b.entry.sortIndex
        ? a.entry.sortIndex - b.entry.sortIndex
        : a.index - b.index
    )
    .map((r) => r.entry);

  const dated = captured.filter((e) => !isUndated(e));
  dated.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;

    const aEnd = datePoint(a.endYear, a.endMonth);
    const bEnd = datePoint(b.endYear, b.endMonth);
    if (aEnd !== bEnd) {
      // Nulls first: no end date on an entry that has a start means ongoing, which is
      // more recent than anything that finished.
      if (aEnd === null) return -1;
      if (bEnd === null) return 1;
      return bEnd - aEnd;
    }

    const aStart = datePoint(a.startYear, a.startMonth);
    const bStart = datePoint(b.startYear, b.startMonth);
    if (aStart !== bStart) {
      if (aStart === null) return 1;
      if (bStart === null) return -1;
      return bStart - aStart;
    }

    return a.sortIndex - b.sortIndex;
  });

  // Put the sorted dated entries back into the slots the dated entries occupied, leaving
  // every undated entry exactly where it was.
  const queue = dated[Symbol.iterator]();
  return captured.map((entry) => (isUndated(entry) ? entry : queue.next().value as T));
}

/**
 * Strips control characters and collapses whitespace in text captured from a LinkedIn
 * profile before it reaches a model prompt or a rendered list. The profile's owner wrote
 * every field themselves, so this is exactly the treatment `untrustedPageBlock`
 * (`@/lib/conversation-starters`) gives scraped page text -- same attacker model, same fix.
 * Internal newlines are preserved (collapsed to at most a blank line) for prose fields;
 * use `sanitizeProfileLine` for values that must stay on one line.
 *
 * Built from character codes rather than a literal escape range: this file has been
 * corrupted before by control-byte escapes turning into real control bytes on disk.
 */
function isStrippedControlCode(code: number): boolean {
  const isTab = code === 9;
  const isLf = code === 10;
  const isCr = code === 13;
  return code < 32 && !isTab && !isLf && !isCr;
}

export function sanitizeProfileText(value: string): string {
  let stripped = "";
  for (const ch of value) {
    if (!isStrippedControlCode(ch.charCodeAt(0))) stripped += ch;
  }
  return stripped
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The single-line variant: also folds any newline into a space. Required for values that
 * feed a row-based renderer -- a numbered contact list, a career line, an experience
 * heading -- where an embedded newline would break the row structure regardless of any
 * prompt-injection concern.
 */
export function sanitizeProfileLine(value: string): string {
  return sanitizeProfileText(value)
    .replace(/\n+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
}

/** "Mar 2019 – Nov 2023", "2019 – 2023", "2023 – Present", or "" when undated. */
export function formatExperienceDates(entry: ExperienceEntry): string {
  const part = (year: number | null, month: number | null) => {
    if (year === null) return "";
    const name = month !== null && month >= 1 && month <= 12 ? `${MONTHS[month - 1]} ` : "";
    return `${name}${year}`;
  };
  const start = part(entry.startYear, entry.startMonth);
  const end = entry.isCurrent ? "Present" : part(entry.endYear, entry.endMonth);
  if (!start && !end) return "";
  if (!start) return end;
  if (!end) return start;
  return `${start} – ${end}`;
}

/**
 * The one-line career summary shown for a contact retrieved by a network-wide question.
 *
 * Capped at four organizations total, current role included, in display order. Education
 * contributes at most one school, and only when the roles have not already used the cap —
 * where someone worked is what network questions ask about; where they studied is a
 * tiebreaker.
 */
export function careerLine(entries: ExperienceEntry[]): string | null {
  const ordered = orderExperiences(entries);
  const roles = ordered.filter((e) => e.kind === "role");
  const schools = ordered.filter((e) => e.kind === "education");

  const seen = new Set<string>();
  const parts: string[] = [];
  for (const entry of roles) {
    // Sanitized before dedup and display: an organization name is a single-line value, and
    // `contextBlock` (@/lib/ai) renders this line unfenced in a numbered list — a newline in
    // it would break the row structure, not just look wrong.
    const organization = sanitizeProfileLine(entry.organization);
    const key = organization.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    parts.push(entry.isCurrent ? organization : `ex-${organization}`);
    if (parts.length >= CAREER_LINE_MAX_ORGS) break;
  }

  const rawSchool = parts.length < CAREER_LINE_MAX_ORGS ? schools[0]?.organization ?? null : null;
  const school = rawSchool ? sanitizeProfileLine(rawSchool) : null;
  if (!parts.length && !school) return null;
  if (!parts.length) return school;
  return school ? `${parts.join(", ")} · ${school}` : parts.join(", ");
}
