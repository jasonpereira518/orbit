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
