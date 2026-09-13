/**
 * `@Name` mentions in a chat question.
 *
 * Two surfaces have to agree on exactly which characters belong to a mention: the composer
 * paints them green, and the send path turns them back into contact ids. A single parser
 * means the highlight can never claim a span the send path does not send.
 *
 * Pure — no React, no DOM, no DB — so `scripts/smoke-chat-mentions.ts` drives it directly.
 */

export type ChatMention = {
  /** Index of the `@`. */
  start: number;
  /** One past the last character of the name. */
  end: number;
  /** The matched name, without the `@`. */
  name: string;
};

/**
 * A mention may only open at the start of the text or after whitespace or an opening
 * bracket/quote. Without this, `jason@example.com` reads as a mention of "Example".
 */
function opensHere(text: string, at: number): boolean {
  if (at === 0) return true;
  return /[\s([{"'‘“–—]/.test(text[at - 1]!);
}

/** A mention ends at a boundary: the next character may not continue a word. */
function closesHere(text: string, at: number): boolean {
  if (at >= text.length) return true;
  return !/[\p{L}\p{N}]/u.test(text[at]!);
}

/**
 * The fallback shape when no name list is available: `@` plus up to three capitalised
 * words.
 *
 * Only reached when rendering a thread loaded from the database, where the attachment list
 * is gone and all that survives is the text. It over-reaches on `@Marcus Webb Who else` —
 * "Who" is capitalised and gets swallowed — which is why every live surface passes `names`
 * and gets an exact match instead. The consequence of the over-reach is one word too much
 * green, never a wrong contact: ids only ever come from the `names` path.
 */
const HEURISTIC_NAME = /^\p{Lu}[\p{L}\p{M}'’-]*(?:[  ]\p{Lu}[\p{L}\p{M}'’-]*){0,2}/u;

/**
 * Every mention in `text`, in order, never overlapping.
 *
 * With `names`, only those names match, longest first — so "Sam" cannot shadow
 * "Sam Whitfield" when both are attached. Matching is case-insensitive because the user is
 * free to retype the token, but the returned `name` is the text as it actually appears.
 */
export function findMentions(text: string, names?: readonly string[]): ChatMention[] {
  const known = names?.length
    ? [...new Set(names.map((n) => n.trim()).filter(Boolean))].sort((a, b) => b.length - a.length)
    : null;
  // An empty-but-present list means "nothing is attached", not "guess": a composer with no
  // attachments must paint nothing, or the green would stop meaning "this is context".
  if (names && !known) return [];

  const found: ChatMention[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "@" || !opensHere(text, i)) continue;
    const rest = text.slice(i + 1);

    if (known) {
      const hit = known.find(
        (name) =>
          rest.slice(0, name.length).toLowerCase() === name.toLowerCase() &&
          closesHere(text, i + 1 + name.length),
      );
      if (!hit) continue;
      found.push({ start: i, end: i + 1 + hit.length, name: rest.slice(0, hit.length) });
      i = found[found.length - 1]!.end - 1;
      continue;
    }

    const m = HEURISTIC_NAME.exec(rest);
    if (!m) continue;
    const name = m[0];
    found.push({ start: i, end: i + 1 + name.length, name });
    i = found[found.length - 1]!.end - 1;
  }
  return found;
}

/**
 * Where a caret sits relative to the mentions around it.
 *
 * A green `@Name` reads as one object, so it has to behave like one: the caret cannot come
 * to rest inside it, and one Backspace takes the whole thing. A `<textarea>` has no notion
 * of an atomic token, so these three answer the only questions the composer needs to fake
 * one — and being pure, they are answerable without a DOM.
 */

/** The mention the caret is strictly inside. Edges are outside: those are valid positions. */
export function mentionUnderCaret(
  text: string,
  caret: number,
  names?: readonly string[],
): ChatMention | null {
  return findMentions(text, names).find((m) => caret > m.start && caret < m.end) ?? null;
}

/** The mention a Backspace here should take whole, i.e. the one the caret sits just after. */
export function mentionBeforeCaret(
  text: string,
  caret: number,
  names?: readonly string[],
): ChatMention | null {
  return findMentions(text, names).find((m) => m.end === caret) ?? null;
}

/** The mention a forward Delete here should take whole. */
export function mentionAfterCaret(
  text: string,
  caret: number,
  names?: readonly string[],
): ChatMention | null {
  return findMentions(text, names).find((m) => m.start === caret) ?? null;
}

/**
 * Where the caret should go when it lands inside a mention.
 *
 * `prefer` is the direction it was travelling, so arrowing left out of a token does not
 * bounce off its own trailing edge and appear stuck. A click has no direction and takes the
 * nearer edge. Returns null when the caret is already somewhere legal.
 */
export function snapCaretOutOfMention(
  text: string,
  caret: number,
  prefer: "left" | "right" | "nearest",
  names?: readonly string[],
): number | null {
  const inside = mentionUnderCaret(text, caret, names);
  if (!inside) return null;
  if (prefer === "left") return inside.start;
  if (prefer === "right") return inside.end;
  return caret - inside.start <= inside.end - caret ? inside.start : inside.end;
}

/**
 * The span a whole-mention delete should remove.
 *
 * Widened by one adjacent space so removing a token from mid-sentence does not leave a
 * double space behind — the trailing one by preference, since that is the space the
 * composer itself added when it inserted the token.
 */
export function mentionDeletionRange(
  text: string,
  mention: ChatMention,
): { from: number; to: number } {
  if (text[mention.end] === " ") return { from: mention.start, to: mention.end + 1 };
  if (text[mention.start - 1] === " ") return { from: mention.start - 1, to: mention.end };
  return { from: mention.start, to: mention.end };
}

/**
 * How much text after an `@` can still be someone's name being typed.
 *
 * Both bounds exist to close the menu on an `@` the user has moved on from: nobody's name
 * runs past 48 characters, and a run with three spaces in it is a sentence, not a name.
 */
const MENTION_QUERY_MAX_LEN = 48;
const MENTION_QUERY_MAX_SPACES = 2;

export type MentionQuery = {
  /** Index of the `@`. */
  start: number;
  /** What has been typed after it, which may be empty. */
  query: string;
};

/**
 * The `@`-token the caret is sitting inside, or null.
 *
 * Deliberately independent of `findMentions`: that one asks "which spans are complete
 * mentions of an attached person", this one asks "is the user part-way through typing
 * one". A half-typed `@Mar` is not a mention yet and must never be painted green, but it
 * is exactly what the autocomplete needs.
 */
export function mentionQueryAt(text: string, caret: number): MentionQuery | null {
  if (caret < 1 || caret > text.length) return null;
  let spaces = 0;
  // Walk back from the caret to the nearest plausible `@`. Bounded by the query limits,
  // so this is a handful of characters however long the box gets.
  for (let i = caret - 1; i >= 0 && caret - i <= MENTION_QUERY_MAX_LEN + 1; i--) {
    const ch = text[i]!;
    if (ch === "\n") return null;
    if (ch === "@") {
      if (!opensHere(text, i)) return null;
      return { start: i, query: text.slice(i + 1, caret) };
    }
    if (ch === " ") {
      spaces++;
      if (spaces > MENTION_QUERY_MAX_SPACES) return null;
    }
  }
  return null;
}

/**
 * Candidates ordered by how well they answer what has been typed.
 *
 * `searchContactsForPicker` returns alphabetically — right for browsing a list, wrong for a
 * type-ahead, where the thing you have half-typed should be first. Pure and generic over
 * the row shape so the people and event lists can share it.
 */
export function rankMentionCandidates<T>(
  query: string,
  items: readonly T[],
  labelsOf: (item: T) => readonly (string | null | undefined)[],
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...items];
  const score = (item: T): number => {
    let best = 3;
    for (const raw of labelsOf(item)) {
      const label = raw?.trim().toLowerCase();
      if (!label) continue;
      if (label.startsWith(q)) return 0;
      // A surname typed on its own should still rank above a mid-word coincidence.
      if (label.split(/\s+/).some((word) => word.startsWith(q))) best = Math.min(best, 1);
      else if (label.includes(q)) best = Math.min(best, 2);
    }
    return best;
  };
  // Decorated sort: `Array.prototype.sort` is stable, so equal scores keep the order the
  // server chose rather than being reshuffled.
  return items
    .map((item, i) => ({ item, i, score: score(item) }))
    .sort((a, b) => a.score - b.score || a.i - b.i)
    .map((entry) => entry.item);
}

/** The literal text the composer inserts for a person. */
export function mentionToken(name: string): string {
  return `@${name}`;
}

/**
 * Which attached people the text still refers to, in the order they appear.
 *
 * The attachment list is a claim about intent; the text is the fact. Deleting `@Marcus Webb`
 * from the box has to drop Marcus from the question's context, and this is what makes that
 * true without watching for edits.
 */
export function activeMentions<T extends { id: string; name: string }>(
  text: string,
  attached: readonly T[],
): T[] {
  if (!attached.length) return [];
  const byLower = new Map<string, T>();
  // First wins, so a later duplicate name cannot steal an earlier person's token.
  for (const p of attached) {
    const key = p.name.trim().toLowerCase();
    if (key && !byLower.has(key)) byLower.set(key, p);
  }
  const out: T[] = [];
  const seen = new Set<string>();
  for (const m of findMentions(text, [...byLower.values()].map((p) => p.name))) {
    const person = byLower.get(m.name.trim().toLowerCase());
    if (!person || seen.has(person.id)) continue;
    seen.add(person.id);
    out.push(person);
  }
  return out;
}

/**
 * A display name that is unique within `taken`.
 *
 * Two people called "Chris" would otherwise share one token, and `activeMentions` would
 * silently attach whichever was added first to both. Falls back to the full name, then to
 * the company, then to a counter — the last of which is ugly but cannot collide.
 */
export function uniqueMentionName(
  candidates: readonly (string | null | undefined)[],
  taken: readonly string[],
): string {
  const used = new Set(taken.map((t) => t.trim().toLowerCase()));
  const options = candidates.map((c) => c?.trim()).filter((c): c is string => Boolean(c));
  for (const option of options) {
    if (!used.has(option.toLowerCase())) return option;
  }
  const base = options[0] ?? "Someone";
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}
