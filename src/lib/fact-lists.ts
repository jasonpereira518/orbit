/**
 * Merging the free-text lists an extraction produces — `key_facts`, `shared_interests`,
 * `opportunities` — into the ones a contact already has.
 *
 * These columns are written from two very different places, and they need opposite
 * semantics:
 *
 *   - A PERSON editing the contact is stating the whole list. If they delete a fact, it is
 *     gone. That is a replace, and it is what `updateContactForUser` does by default.
 *
 *   - An EXTRACTION — a pasted note, a capture, the browser extension — has seen exactly one
 *     conversation. It is in no position to say that a fact recorded six months ago is no
 *     longer true, and it routinely returns an empty list simply because that note was about
 *     something else. Letting it write that empty list through deleted everything the
 *     contact had accumulated: paste a note that mentions someone in passing, and their key
 *     facts, shared interests and opportunities were all replaced with `[]`.
 *
 * So extraction paths union instead. They may add, never remove; only a person removes.
 */

/**
 * The most entries we will keep in one of these lists.
 *
 * Union-only growth needs a ceiling or a contact mentioned in fifty notes ends up with a
 * list nobody will read, and every prompt that includes it gets more expensive. Oldest
 * entries win when the cap bites: the early facts about someone are usually the durable
 * ones ("was infra PM at Stripe"), and the late ones the incidental.
 */
export const FACT_LIST_CAP = 24;

function clean(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * Existing entries first, then whatever the extraction added that is genuinely new.
 *
 * Deduped case- and whitespace-insensitively, because the same fact phrased by the model
 * twice is the common case — "Leads the Codex team" and "leads the codex team" are not two
 * facts. The FIRST spelling survives, so a user's own capitalisation is not overwritten by
 * a later extraction's.
 */
export function mergeFactList(
  existing: unknown,
  incoming: unknown,
  cap: number = FACT_LIST_CAP
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const source of [existing, incoming]) {
    if (!Array.isArray(source)) continue;
    for (const raw of source) {
      const value = clean(raw);
      if (!value) continue;
      const key = value.toLowerCase().replace(/\s+/g, " ");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(value);
      if (out.length >= cap) return out;
    }
  }
  return out;
}

/**
 * Normalize a list a PERSON submitted. Replace semantics — an empty list means empty.
 *
 * Still trims and dedupes, because the editor lets someone paste, and two identical bullets
 * are a mistake rather than an intent.
 */
export function normalizeFactList(value: unknown, cap: number = FACT_LIST_CAP): string[] {
  return mergeFactList(value, [], cap);
}
