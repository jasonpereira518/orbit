/**
 * DB-free types and helpers for the Knowledge page's people index, so the client component
 * can import them without dragging `@/db` into the browser bundle.
 */

/**
 * The most people the index loads. The page is a bounded read (audit B4): search and sort
 * run over what was loaded, so an account bigger than this sees its most recently touched
 * people and a count saying so, never a page that grows with the account.
 */
export const KNOWLEDGE_PEOPLE_LIMIT = 300;

/** Shortest and longest search the content search accepts, and the most people it returns. */
export const KNOWLEDGE_SEARCH_MIN_CHARS = 3;
export const KNOWLEDGE_SEARCH_MAX_CHARS = 80;
export const KNOWLEDGE_SEARCH_LIMIT = 50;

/** A person whose notes, messages or facts contain what was searched for. */
export type KnowledgeSearchHit = {
  id: string;
  fullName: string;
  firstName: string | null;
  title: string | null;
  company: string | null;
  hasPhoto: boolean;
  lastInteractionAt: string | null;
  /** A stretch of the matching text, around the match. Null when only their name or role matched. */
  snippet: string | null;
  /** Where the match is: "In a note", "In a message"... Null with a null snippet. */
  where: string | null;
};

/** Characters of summary an index row shows. One line, not a paragraph. */
export const GIST_CHARS = 140;

export type KnowledgePersonRow = {
  id: string;
  fullName: string;
  firstName: string | null;
  title: string | null;
  company: string | null;
  /** The first sentence of the person's AI summary, or null when there isn't one yet. */
  gist: string | null;
  /** Whether a photo is stored. The photo itself is never selected for a list. */
  hasPhoto: boolean;
  /** How many of the user's current goals the person's brief says they bear on. */
  fitCount: number;
  lastInteractionAt: string | null;
};

export type KnowledgePeoplePayload = {
  rows: KnowledgePersonRow[];
  /** Everyone in the account, so the page can say when the index shows only part of it. */
  total: number;
  /** Active goals, so an empty fit can say "add a goal" instead of "nothing fits". */
  goalCount: number;
};

/**
 * One line of a summary: its first sentence, cut at a word boundary if it still runs long.
 * Deterministic on purpose. The index lists hundreds of people and must not make a model
 * call per row, so the gist is whatever the brief already wrote.
 */
export function gistOf(summary: string | null | undefined): string | null {
  const text = (summary ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const sentence = text.match(/^(.+?[.!?])(\s|$)/)?.[1] ?? text;
  if (sentence.length <= GIST_CHARS) return sentence;
  const cut = sentence.slice(0, GIST_CHARS - 1);
  const lastSpace = cut.lastIndexOf(" ");
  const body = lastSpace > GIST_CHARS * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${body.replace(/[\s,;:.–—-]+$/, "")}…`;
}
