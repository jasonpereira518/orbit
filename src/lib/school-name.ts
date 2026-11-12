/**
 * Folding two spellings of one school together.
 *
 * Companies get `canonicalCompanyClusterName`, backed by an alias table. Schools got
 * nothing — `chat-roster.ts` did `const canonical = raw` for them — so "MIT" and
 * "Massachusetts Institute of Technology" were two organisations with two separate counts,
 * and a question naming either one saw only half the alumni.
 *
 * An alias table would work for the schools somebody thought to list and fail silently for
 * every other. This folds by acronym instead, derived from the user's own values: if their
 * network contains both a multi-word name and a short name matching its initials, the two
 * are the same school. No table to keep, and it works for a school nobody anticipated.
 *
 * Pure — no DB, no React. `scripts/smoke-chat-suggestions.ts` drives it directly.
 */

/** Words that carry no initial: "Massachusetts Institute of Technology" is MIT, not MIOT. */
const SKIP_WORDS = new Set(["of", "the", "and", "at", "for", "in", "de", "du", "la", "le"]);

/**
 * An acronym-shaped name is 2-6 letters, no spaces. Below two it is not an acronym; above
 * six it is a word. "MIT" and "UCLA" qualify; "Yale" does not, which is correct — it has no
 * long form to fold into.
 */
const ACRONYM_RE = /^[a-z]{2,6}$/;

function words(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** The initials of the significant words, or null when there are too few to be an acronym. */
export function schoolAcronym(name: string | null | undefined): string | null {
  if (!name) return null;
  const significant = words(name).filter((w) => !SKIP_WORDS.has(w));
  if (significant.length < 2) return null;
  const acronym = significant.map((w) => w[0]).join("");
  return ACRONYM_RE.test(acronym) ? acronym : null;
}

/**
 * True when the name is itself written as an acronym.
 *
 * Case is the whole signal, and lowercasing first destroys it: "MIT" and "Yale" are both
 * single words of two to six letters, and only the capitals say which one is an initialism.
 * The cost is that a user who typed "mit" in lower case gets no fold — better than folding
 * "Yale" into "Yale Aeronautics Lab East".
 */
export function looksLikeAcronym(name: string | null | undefined): boolean {
  if (!name) return false;
  return /^[A-Z]{2,6}$/.test(name.trim());
}

/**
 * Every raw school name mapped to the display name it should fold into.
 *
 * The long form wins as the display, matching `canonicalCompanyClusterName`, which resolves
 * "AWS" to "Amazon Web Services" rather than the other way round. A name that folds into
 * nothing maps to itself, so callers can look up unconditionally.
 */
export function foldSchoolNames(names: readonly string[]): Map<string, string> {
  const cleaned = [...new Set(names.map((n) => n?.trim()).filter(Boolean))] as string[];

  // Longest first, so the fullest spelling becomes the display for its acronym.
  const byAcronym = new Map<string, string>();
  for (const name of [...cleaned].sort((a, b) => b.length - a.length)) {
    const acronym = schoolAcronym(name);
    if (acronym && !byAcronym.has(acronym)) byAcronym.set(acronym, name);
  }

  const out = new Map<string, string>();
  for (const name of cleaned) {
    if (looksLikeAcronym(name)) {
      const expanded = byAcronym.get(name.trim().toLowerCase());
      out.set(name, expanded ?? name);
      continue;
    }
    // A long name folds to whichever long name owns its acronym, which is itself unless a
    // longer spelling of the same school is also present.
    const acronym = schoolAcronym(name);
    out.set(name, (acronym && byAcronym.get(acronym)) || name);
  }
  return out;
}

/** Significant words of a name, each flagged for whether it was written as an acronym. */
function tokens(name: string | null | undefined): { w: string; acro: boolean }[] {
  if (!name) return [];
  return name
    .replace(/[^A-Za-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t && !SKIP_WORDS.has(t.toLowerCase()))
    .map((t) => ({ w: t.toLowerCase(), acro: looksLikeAcronym(t) }));
}

/**
 * True when `a[i]` is an acronym whose letters are the initials of the next words in `b`.
 * A name that is only an acronym (MIT, USC) never expands; one with a qualifier ("UNC Chapel Hill", "UNC CH") may.
 */
function spelledBy(a: { w: string; acro: boolean }, aQualified: boolean, b: { w: string }[], j: number): boolean {
  const k = a.w.length;
  return aQualified && a.acro && j + k <= b.length && b.slice(j, j + k).every((t, n) => t.w[0] === a.w[n]);
}

/**
 * True when two spellings name the same school. Both sequences must be consumed together:
 * equal words pair up, and an acronym pairs with the run of words its letters are the
 * initials of. A prefix never matches, so "UNC" is not "University of North Carolina at
 * Charlotte" and "Yale" is not "Yale School of Management".
 */
export function sameSchool(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = tokens(a);
  const y = tokens(b);
  if (!x.length || !y.length) return false;
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i].w === y[j].w) {
      i++;
      j++;
    } else if (spelledBy(x[i], x.length > 1, y, j)) {
      j += x[i].w.length;
      i++;
    } else if (spelledBy(y[j], y.length > 1, x, i)) {
      i += y[j].w.length;
      j++;
    } else {
      return false;
    }
  }
  return i === x.length && j === y.length;
}
