/**
 * Initials for a name, for wherever a person has no photo — the constellation's stars, the
 * import done card's faces, admin rows, capture results.
 *
 * Works in graphemes, not UTF-16 code units: indexing a string by `[0]` splits an emoji or a
 * letter with a combining mark in half ("😀 Sam" gave a lone surrogate). Characters that are
 * not letters (emoji, digits, punctuation) are skipped, so "😀 Sam" is "S" and "(Jo) Lee" is
 * "JL".
 */

const LETTER = /\p{L}/u;
/** Scripts with no case, where a name reads as one unit and two characters look wrong. */
const ONE_GLYPH_SCRIPT =
  /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}|\p{Script=Arabic}|\p{Script=Hebrew}/u;
const CJK = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u;

let segmenter: Intl.Segmenter | null | undefined;

function graphemes(text: string): string[] {
  if (segmenter === undefined) {
    segmenter =
      typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
        ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
        : null;
  }
  if (segmenter) return Array.from(segmenter.segment(text), (s) => s.segment);
  // Code points: keeps surrogate pairs whole, though not combining sequences.
  return Array.from(text);
}

/** The word's graphemes from its first letter on, or none when it has no letter at all. */
function fromFirstLetter(word: string): string[] {
  const g = graphemes(word);
  const start = g.findIndex((c) => LETTER.test(c));
  return start === -1 ? [] : g.slice(start);
}

/**
 * Two letters for a name: the first and last word's initials, or the first two letters of a
 * one-word name. A one-word name in Chinese, Japanese, Korean, Arabic or Hebrew gives one
 * character, as does any CJK name. "?" when there is no letter to use.
 */
export function initialsFromName(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .map(fromFirstLetter)
    .filter((g) => g.length > 0);
  if (words.length === 0) return "?";
  const first = words[0];
  const lead = first[0];
  if (words.length === 1 ? ONE_GLYPH_SCRIPT.test(lead) : CJK.test(lead)) return lead;
  if (words.length === 1) {
    const second = first.slice(1).find((c) => LETTER.test(c)) ?? "";
    return (lead + second).toUpperCase();
  }
  return (lead + words[words.length - 1][0]).toUpperCase();
}

/** One letter for a name, grapheme-safe, or "?" when there is none. */
export function firstInitial(name: string): string {
  const words = name.trim().split(/\s+/).map(fromFirstLetter);
  const lead = words.find((g) => g.length > 0)?.[0];
  return lead ? lead.toUpperCase() : "?";
}
