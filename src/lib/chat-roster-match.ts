import { normalizeCompanyName } from "@/lib/company-name";

/**
 * Whether an organisation name is one `findOrgRosters` can actually resolve.
 *
 * Split out of `chat-roster.ts` because two sides now need the same answer. The roster
 * builder asks it of a name it found in the network; the composer's suggestion cards ask it
 * *before* offering "Who else do I know at {company}?" — a card for a company that fails
 * these tests looks identical to one that works, but the roster silently never fires and
 * the model answers from a relevance-ranked guess while the question implies a complete
 * count. Two copies of this list would have drifted into exactly that gap.
 *
 * Pure: no DB, no React. `scripts/smoke-chat-suggestions.ts` drives it directly.
 */

/**
 * Names shorter than this are not matched: a two-letter company would fire on almost any
 * question, and the false positives are worse than the miss.
 */
export const MIN_ORG_NAME_LEN = 3;

/** Everyday words that also happen to be company names; matching them is nearly always wrong. */
const STOPLIST_SOURCE = [
  "the", "and", "for", "you", "who", "how", "new", "one", "next", "now", "all",
  "get", "app", "inc", "llc", "self", "self employed", "freelance", "student",
  "none", "n/a", "unknown", "independent",
  // Imports really do write these as literal text — a CSV column that held SQL NULL, or a
  // scraper that stringified one. Without them a roster gets built for a company called
  // "null", and the answer names everyone whose employer failed to import.
  "null", "undefined", "nil",
];

/** The comparison form: normalised, punctuation flattened, single-spaced. */
export function orgMatchKey(name: string): string {
  return normalizeCompanyName(name)
    .replace(/[^a-z0-9+&. ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Entries are flattened through `orgMatchKey`, not stored raw.
 *
 * The list has always been written the way a person spells these ("n/a"), but the value it
 * is tested against has always been flattened — so "N/A" turned into "n a", missed the
 * entry, and a roster was built for it. Running the list through the same function is what
 * makes the two agree.
 */
export const ORG_STOPLIST: ReadonlySet<string> = new Set(STOPLIST_SOURCE.map(orgMatchKey));

/**
 * A question, padded and flattened so a whole-word test can be a plain substring test.
 * Punctuation becomes spaces, so "at Google?" and "Google's" both match "google".
 */
export function normalizeQuestionForOrgs(question: string): string {
  return ` ${question.toLowerCase().replace(/[^a-z0-9+&. ]+/g, " ").replace(/\s+/g, " ").trim()} `;
}

/** True when this name is worth matching at all. */
export function isRosterMatchableOrg(name: string | null | undefined): boolean {
  if (!name) return false;
  const key = orgMatchKey(name);
  return key.length >= MIN_ORG_NAME_LEN && !ORG_STOPLIST.has(key);
}

/** True when `haystack` (already normalised) names this organisation. */
export function questionMentionsOrg(haystack: string, name: string): boolean {
  if (!isRosterMatchableOrg(name)) return false;
  return haystack.includes(` ${orgMatchKey(name)} `);
}
