/** Words that carry no identity in a school's name. */
const SCHOOL_NOISE = /\b(the|of|at|and|for|a)\b/g;

/**
 * The forms one school might be written in.
 *
 * Two, because people write both: "University of North Carolina" on a LinkedIn profile and
 * "UNC" in conversation. Matching only the long form would miss the case this signal is most
 * often useful in — a roster row that says "MIT" against a contact who wrote it out.
 *
 * The acronym is built from the full name INCLUDING "University", because that is where the
 * U in UNC comes from.
 */
export function schoolKeys(value: string): string[] {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return [];

  const words = cleaned.replace(SCHOOL_NOISE, " ").split(/\s+/).filter(Boolean);
  const keys = new Set<string>();
  // The whole name, minus the filler that varies between spellings.
  if (words.length > 0) keys.add(words.join(" "));
  // The acronym, when there is more than one significant word — "mit", "unc", "nyu".
  if (words.length > 1) keys.add(words.map((word) => word[0]).join(""));
  // A short form as written ("unc") is already its own key.
  if (words.length === 1) keys.add(words[0]!);
  return [...keys];
}

function schoolWords(value: string): string[] {
  const words = value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(SCHOOL_NOISE, " ")
    .split(/\s+/)
    .filter(Boolean);
  // "M.I.T." cleans to "m i t": letters written apart are one short form.
  return words.length > 1 && words.every((w) => w.length === 1) ? [words.join("")] : words;
}

/**
 * Which spellings are the same school, for clustering.
 *
 * Stricter than `schoolKeys` on purpose. Matching is for "does this attendee share a school",
 * where a rare false positive costs one point; clustering merges whole groups of people, where a
 * false positive puts Boston University inside Boston College. So:
 *   - A long form's identity is its words minus "university": "Stanford University" and
 *     "Stanford" meet, "Boston University" and "Boston College" do not.
 *   - A one-word short form ("MIT", "UNC") joins the long form whose acronym it is — but only
 *     when exactly one long form in this network has that acronym. "UT" beside both Toronto and
 *     Texas joins neither.
 * Returns raw spelling → group key. Spellings with no usable words are absent.
 */
export function schoolGroupKeys(values: Iterable<string>): Map<string, string> {
  const distinct = [...new Set(values)];
  const parsed = distinct.map((raw) => {
    const words = schoolWords(raw);
    const core = words.filter((w) => w !== "university").join(" ") || words.join(" ");
    return { raw, words, core };
  });

  const coresByAcronym = new Map<string, Set<string>>();
  for (const { words, core } of parsed) {
    if (words.length < 2) continue;
    const acronym = words.map((w) => w[0]).join("");
    const cores = coresByAcronym.get(acronym);
    if (cores) cores.add(core);
    else coresByAcronym.set(acronym, new Set([core]));
  }

  const out = new Map<string, string>();
  for (const { raw, words, core } of parsed) {
    if (words.length === 0) continue;
    const longForms = words.length === 1 ? coresByAcronym.get(words[0]!) : undefined;
    out.set(raw, longForms && longForms.size === 1 ? [...longForms][0]! : core);
  }
  return out;
}
