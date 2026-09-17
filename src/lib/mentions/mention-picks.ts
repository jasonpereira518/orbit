/**
 * An `@`-pick: a contact the person chose from a menu, and the token that stands for them
 * in the text box.
 *
 * Pure — no React, no DOM, no `@/db` — so both composers and the smoke suite can drive it.
 * Lifted out of `chat-panel.tsx`, where `tokenForPerson` was a `useCallback` closing over
 * component state and therefore unreachable from anything else. The capture composer needs
 * exactly the same minting rule, and two implementations of "which token stands for this
 * contact" is how one composer ends up attaching a person the other renders as grey text.
 *
 * The shape is `{ id, name }` rather than `{ contactId, name }` on purpose: it is what
 * `activeMentions` in `@/lib/chat-mentions` already takes, and what chat's `attached` state
 * already is. Renaming the field would buy nothing and touch every chat call site. Paths
 * that speak to the database map `id` to `contactId` at their own boundary.
 */
import { activeMentions, mentionToken, uniqueMentionName } from "@/lib/chat-mentions";

export type MentionPick = { id: string; name: string };

/** A picked contact's id must be a uuid; `mention_picks` is written from a browser. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Bounds the jsonb column and the `@` menu's own reach. Nobody tags 50 people in one note. */
export const MAX_MENTION_PICKS = 50;
export const MAX_MENTION_PICK_NAME = 120;

/**
 * Register a contact and hand back the token that stands for them.
 *
 * Re-picking someone reuses their existing token; a namesake gets a longer one
 * ("Chris Doyle" beside "Chris"), because two people sharing a token means `activeMentions`
 * can only ever resolve it to one of them — and the other silently stops being attached.
 *
 * Returns a new array rather than mutating, so callers can drop it straight into `setState`.
 */
export function addMentionPick(
  picks: readonly MentionPick[],
  contactId: string,
  nameCandidates: readonly (string | null | undefined)[],
): { picks: MentionPick[]; token: string } {
  const already = picks.find((p) => p.id === contactId);
  if (already) return { picks: [...picks], token: mentionToken(already.name) };
  const name = uniqueMentionName(nameCandidates, picks.map((p) => p.name));
  return { picks: [...picks, { id: contactId, name }], token: mentionToken(name) };
}

/**
 * The picks whose token is still present in the text.
 *
 * The text is the fact and the pick list is only a claim about it: deleting `@Ada` from the
 * box has to un-attach Ada, or a note saves a link to somebody the person removed on
 * purpose. Everything downstream reads this, never the raw list.
 */
export function activePicks(text: string, picks: readonly MentionPick[]): MentionPick[] {
  return activeMentions(text, picks);
}

/** The names to paint as mention marks behind the textarea. */
export function pickNames(picks: readonly MentionPick[]): string[] {
  return picks.map((p) => p.name);
}

/**
 * Validate a `mention_picks` payload that arrived from a browser.
 *
 * Shape only — that an id is a uuid, not that it belongs to the caller. Ownership is
 * checked against the caller's own contacts at resolution time
 * (`resolveMentionsWithPicks`), where the full subject list is already loaded and the check
 * is therefore free. Doing it here as well would mean a second query on the hot path for
 * no additional safety.
 */
export function sanitizeMentionPicks(value: unknown): MentionPick[] {
  if (!Array.isArray(value)) return [];
  const out: MentionPick[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (out.length >= MAX_MENTION_PICKS) break;
    if (!raw || typeof raw !== "object") continue;
    const { id, name } = raw as { id?: unknown; name?: unknown };
    if (typeof id !== "string" || !UUID_RE.test(id)) continue;
    if (typeof name !== "string") continue;
    const trimmed = name.replace(/\s+/g, " ").trim().slice(0, MAX_MENTION_PICK_NAME);
    if (!trimmed || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: trimmed });
  }
  return out;
}
