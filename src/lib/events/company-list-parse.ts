/**
 * Turning a career fair's employer list into company names.
 *
 * The input is whatever the user copied off the fair's page or their phone: a bulleted list,
 * a booth table, a comma-separated run-on, a screenshot run through transcription. All of it
 * arrives here as text.
 *
 * ## Why this is deliberately dumb
 *
 * It strips booth numbers and list decoration, splits, dedupes, and stops. It does not try to
 * recognise real companies, correct spellings, or expand abbreviations — every one of those
 * would turn "user pasted something odd" into "Orbit invented a company", and the user cannot
 * tell which rows were invented. Anything unparseable is COUNTED and reported instead, the
 * same contract `parse-roster.ts` holds for guest lists.
 *
 * Pure: no network, no database, no AI.
 */
import { normalizeCompanyKey } from "@/lib/company-name";

/** A fair with more exhibitors than this is a mis-paste, not a fair. */
export const MAX_COMPANY_ROWS = 500;

export type CompanyListResult = {
  names: string[];
  /** Lines that carried nothing usable. Reported, never silently dropped. */
  skipped: number;
  /** Duplicates collapsed within this paste. */
  deduped: number;
};

/** Leading list decoration: bullets, numbering, booth labels. */
const LEADING_JUNK =
  /^\s*(?:[-–—•*·]+\s*|\d{1,4}[.)]\s+|(?:booth|table|stand|room)\s*#?\s*[\w-]{1,6}\s*[-–—:|]?\s*)+/i;

/** Trailing decoration: a booth number written after the name, or a bare parenthetical. */
const TRAILING_JUNK = /\s*[-–—|]\s*(?:booth|table|stand)\s*#?\s*[\w-]{1,6}\s*$/i;

/** Words that are a heading, not an exhibitor. */
const HEADING =
  /^(?:companies?|employers?|exhibitors?|sponsors?|attending|participants?|our partners|list|name|organization|organisation)\s*:?\s*$/i;

function clean(raw: string): string | null {
  let value = raw.replace(LEADING_JUNK, "").replace(TRAILING_JUNK, "").trim();
  // A trailing parenthetical is usually a note ("(hiring interns)"), not part of the name.
  value = value.replace(/\s*\([^)]{0,60}\)\s*$/, "").trim();
  value = value.replace(/[,;|]+$/, "").trim();
  if (!value) return null;
  if (HEADING.test(value)) return null;
  // A name has to contain a letter, and cannot be a whole paragraph.
  if (!/\p{L}/u.test(value)) return null;
  if (value.length > 80) return null;
  return value.replace(/\s+/g, " ");
}

/**
 * Split a pasted list into candidate names.
 *
 * Newlines first; only if the paste is a single line does it fall back to commas — a list of
 * "Stripe, Inc." rows would otherwise be split down the middle of every name.
 */
function splitInput(text: string): string[] {
  const lines = text
    .split(/\r?\n|\t/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length > 1) return lines;
  return (lines[0] ?? "").split(/\s*[,;|]\s*/).filter(Boolean);
}

export function parseCompanyList(text: string): CompanyListResult {
  const out: string[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  let deduped = 0;

  for (const raw of splitInput(text ?? "").slice(0, MAX_COMPANY_ROWS)) {
    const name = clean(raw);
    if (!name) {
      skipped++;
      continue;
    }
    // Deduped on the same key the rest of the feature compares companies by — the
    // suffix-stripped one — so "Stripe" and "Stripe, Inc." collapse here exactly as they
    // will on the panel. Dedupe on the raw key instead and a fair's list shows both, which
    // looks like a broken import and doubles every count beside them.
    const key = companyMatchKeys(name).at(-1) ?? "";
    if (!key) {
      skipped++;
      continue;
    }
    if (seen.has(key)) {
      deduped++;
      continue;
    }
    seen.add(key);
    out.push(name);
  }

  return { names: out, skipped, deduped };
}

/**
 * Two spellings of one company.
 *
 * Returns the normalised key with and without a corporate suffix, so "Stripe" matches
 * "Stripe, Inc." — which is the difference between the panel saying "you know two people
 * here" and saying nothing at all. Suffixes only: nothing here guesses at abbreviations.
 */
const CORPORATE_SUFFIX =
  /\s+(?:inc|llc|ltd|limited|corp|corporation|co|company|gmbh|sa|nv|bv|plc|pbc|llp|lp)$/i;

export function companyMatchKeys(name: string | null | undefined): string[] {
  const key = normalizeCompanyKey(name ?? "");
  if (!key) return [];
  const stripped = key.replace(CORPORATE_SUFFIX, "").trim();
  return stripped && stripped !== key ? [key, stripped] : [key];
}

export type EventKind = "career_fair" | "conference" | "meetup" | "party" | "other";

const CAREER_FAIR = /\b(career fair|job fair|recruit(?:ing|ment) (?:event|day|fair)|hiring (?:fair|event|day)|internship fair|employer (?:expo|showcase)|meet the (?:firms|employers))\b/i;
const CONFERENCE = /\b(conference|summit|symposium|convention|expo|congress|keynote|devcon|con\s*20\d\d)\b/i;
const MEETUP = /\b(meetup|meet-?up|workshop|hack(?:athon|night)|user group|lunch and learn|office hours|demo (?:day|night)|talk|panel|seminar)\b/i;
const PARTY = /\b(party|mixer|social|happy hour|drinks|dinner|brunch|after ?party|celebration|birthday)\b/i;

/**
 * What kind of event this looks like, from its own words.
 *
 * Only used to WEIGHT relevance — a recruiter at a career fair is the most useful person in
 * the room and the same recruiter at a party is just a guest. Null is a perfectly good
 * answer; the scoring falls back to its defaults.
 */
export function eventKindOf(input: {
  title?: string | null;
  description?: string | null;
  organizerName?: string | null;
}): EventKind | null {
  // Title first and description second: a conference description routinely mentions its
  // after-party, and the title is what the host actually called the thing.
  const title = input.title ?? "";
  const rest = [input.description?.slice(0, 500), input.organizerName].filter(Boolean).join(" ");

  for (const text of [title, rest]) {
    if (!text) continue;
    if (CAREER_FAIR.test(text)) return "career_fair";
    if (CONFERENCE.test(text)) return "conference";
    if (MEETUP.test(text)) return "meetup";
    if (PARTY.test(text)) return "party";
  }
  return null;
}
