/**
 * Your network, as a vocabulary for the transcriber.
 *
 * WHY THIS IS THE WHOLE POINT. A general speech model has never heard of the people you
 * know. "I grabbed coffee with Priya Raman" comes back as "Prea Ramen", and in a
 * networking CRM that is not a cosmetic error: the capture parser reads the misspelling as
 * a person it has never seen and creates a *second* contact. Voice capture that silently
 * forks your contacts on every note is worse than no voice capture.
 *
 * Every engine in the chain can be biased toward a word list, and all three take it
 * differently:
 *
 *   - Wispr  → `context.dictionary_context`, a real array of terms.
 *   - Whisper → the `prompt` parameter, which is prior text, not a list, and is capped at
 *               224 tokens. Much tighter, so it gets a shorter slice.
 *   - Gemini  → ordinary prompt text, since it is a general model reading instructions.
 *
 * So the term list is built once here and shaped per engine at the call site. The pure
 * half is everything except `loadNetworkVocabulary`, which is the only function that
 * touches the database — that split is what lets `scripts/smoke-wispr.ts` test the
 * selection and the caps under node.
 */

import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts } from "@/db/schema";

/**
 * How many terms Wispr's dictionary gets.
 *
 * A guess at a sane ceiling rather than a documented limit — see the header of
 * `src/lib/wispr.ts` about what could not be verified. Chosen so the JSON stays small
 * (~6 KB) next to an 11 MB audio payload, where it costs nothing.
 */
export const MAX_VOCABULARY_TERMS = 300;

/**
 * Whisper's `prompt` is capped at 224 tokens and silently truncates past it — from the
 * FRONT, which would drop exactly the most-recent contacts this list is ordered to put
 * first. So the budget is enforced here instead, in characters, at roughly three
 * characters per token with room to spare.
 */
export const WHISPER_PROMPT_MAX_CHARS = 550;

/** Longer than this is a pasted paragraph in a company field, not a name. */
const MAX_TERM_LENGTH = 48;

/** How many contacts to read. Above this the tail is too weakly related to bias toward. */
const CONTACT_SCAN_LIMIT = 400;

/** The fields of one contact that are worth teaching the transcriber. */
export type VocabularySource = {
  fullName: string | null;
  preferredName: string | null;
  company: string | null;
  school: string | null;
};

/**
 * Flatten contact rows into a deduplicated, ordered term list.
 *
 * Order is load-bearing, because every engine truncates. Rows arrive most-recently-seen
 * first and that order is preserved: the person you spoke to last week is far more likely
 * to be in this recording than the one you met at a conference two years ago.
 *
 * Full names are split into their parts *as well as* kept whole. A recogniser biased
 * toward "Priya Raman" as one string does not necessarily get "Priya" right on its own,
 * and people say first names alone constantly.
 */
export function collectVocabularyTerms(
  rows: readonly VocabularySource[],
  limit: number = MAX_VOCABULARY_TERMS,
): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];

  const add = (raw: string | null | undefined) => {
    if (terms.length >= limit) return;
    const term = normalizeTerm(raw);
    if (!term) return;
    const key = term.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    terms.push(term);
  };

  // Two passes. Whole names first for every contact, then the parts — so that a cap which
  // bites part-way through still covers the full name of everyone in the list rather than
  // every fragment of the first few.
  for (const row of rows) {
    add(row.fullName);
    add(row.preferredName);
  }
  for (const row of rows) {
    for (const part of nameParts(row.fullName)) add(part);
  }
  for (const row of rows) {
    add(row.company);
    add(row.school);
  }

  return terms;
}

/**
 * The pieces of a full name worth adding on their own.
 *
 * Single letters and initials are dropped — biasing toward "J" would corrupt ordinary
 * speech for no gain. So are the particles in names like "van der Berg", which are common
 * words and are already covered by the whole-name entry.
 */
const NAME_PARTICLES = new Set([
  "van", "von", "de", "der", "den", "del", "della", "di", "da", "dos", "du",
  "ter", "ten", "op", "la", "le", "el", "al", "bin", "ibn", "ben", "san",
  "st", "mac", "mc", "the", "and",
]);

function nameParts(fullName: string | null | undefined): string[] {
  const name = normalizeTerm(fullName);
  if (!name) return [];
  const parts = name.split(/[\s-]+/);
  // A single-word name adds nothing over the whole-name entry already present.
  if (parts.length < 2) return [];
  return parts.filter(
    (p) => p.length > 1 && !p.endsWith(".") && !NAME_PARTICLES.has(p.toLowerCase()),
  );
}

/**
 * Trim a raw field into something worth handing an engine, or null.
 *
 * Rejects anything with a digit or an @ — "Acme Corp (2019)", "sarah@acme.com" and
 * "+1 555…" all land in these columns in practice, and none of them is a word anyone says
 * out loud. Rejects punctuation-only leftovers for the same reason.
 */
function normalizeTerm(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.replace(/\s+/g, " ").trim();
  if (trimmed.length < 2 || trimmed.length > MAX_TERM_LENGTH) return null;
  if (/[@\d]/.test(trimmed)) return null;
  if (!/\p{L}/u.test(trimmed)) return null;
  return trimmed;
}

/**
 * Terms → Whisper's `prompt`.
 *
 * OpenAI's guidance is that the prompt should read like prior text in the same language,
 * not like a machine-readable list, so this is a comma-separated run of names rather than
 * JSON. Truncated by whole terms, never mid-word: half a name is a worse prior than no
 * name.
 */
export function vocabularyToWhisperPrompt(
  terms: readonly string[],
  maxChars: number = WHISPER_PROMPT_MAX_CHARS,
): string {
  if (terms.length === 0) return "";
  // A short lead-in so the model reads what follows as names rather than as content to
  // transcribe. Counted against the budget like everything else.
  const lead = "People and companies mentioned: ";
  // The closing "." is part of what gets sent, so it has to come out of the budget before
  // the loop, not after it. Appending it to an already-full string returned `maxChars + 1`
  // — one over a cap this function is the only enforcer of.
  const budget = maxChars - 1;
  let out = lead;
  for (const term of terms) {
    const next = out === lead ? out + term : `${out}, ${term}`;
    if (next.length > budget) break;
    out = next;
  }
  if (out === lead) return "";
  return `${out}.`;
}

/**
 * Terms → a line for a general model's prompt (Gemini).
 *
 * Explicitly framed as spelling guidance, because unlike the other two this model is
 * reading instructions and will otherwise happily transcribe the list itself.
 */
export function vocabularyToPromptLine(terms: readonly string[]): string {
  if (terms.length === 0) return "";
  return `Names that may appear, spelled correctly: ${terms.join(", ")}. Use these spellings when you hear them; do not add them if you do not hear them.`;
}

/**
 * Read the user's network and build the term list.
 *
 * Failure is not an error: a transcript with misspelled names is much better than no
 * transcript, so every caller treats an empty list as normal and this never throws.
 */
export async function loadNetworkVocabulary(
  userId: string,
  limit: number = MAX_VOCABULARY_TERMS,
): Promise<string[]> {
  try {
    const db = await getDb();
    const rows = await db
      .select({
        fullName: contacts.fullName,
        preferredName: contacts.preferredName,
        company: contacts.company,
        school: contacts.school,
      })
      .from(contacts)
      .where(eq(contacts.userId, userId))
      // Most-recently-seen first, with never-interacted contacts last rather than first —
      // a NULL sorts high on a plain DESC in Postgres, which would put exactly the least
      // relevant rows at the front of a list that gets truncated.
      //
      // Written as one `sql` fragment rather than `desc(sql\`… NULLS LAST\`)`: Drizzle's
      // `desc()` appends its keyword AFTER the fragment, producing
      // `… NULLS LAST desc`, which Postgres rejects. `loadNetworkVocabulary` catches and
      // returns [], so that mistake reads as "this user has no contacts" and is invisible
      // until someone notices the names are never right. See
      // `scripts/smoke-transcription-vocabulary.ts`.
      .orderBy(sql`${contacts.lastInteractionAt} DESC NULLS LAST`)
      .limit(CONTACT_SCAN_LIMIT);

    return collectVocabularyTerms(rows, limit);
  } catch {
    return [];
  }
}
