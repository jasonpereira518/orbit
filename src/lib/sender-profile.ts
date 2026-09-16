/**
 * Who the message is from.
 *
 * Every draft Orbit writes is written as the user, to someone who knows them. Until now the
 * model was told the user's first name (for the sign-off) and their goals, and nothing else
 * — not their role, not what they are working on, not what they are actually after. That is
 * the half of a message that makes an ask land: "could I pick your brain" from nobody in
 * particular is a different message from the same words from a backend engineer moving into
 * platform work.
 *
 * The outreach prompt had been instructing the model to "prefer campaign intent over sender
 * background when they conflict" for some time. There was no sender background. The visible
 * symptom was drafts reaching for "[Your Name]" and "[My Role]" placeholders — the prompt
 * even has a rule forbidding them — because the model had a shaped hole and nothing to put
 * in it.
 *
 * Pure: no database. `loadSenderProfile` in `./sender-profile-server` does the read.
 */

/**
 * Longest bio we will store.
 *
 * Every draft prompt carries this, so it is paid for on every generation, and past a couple
 * of sentences it stops being context and starts being a competing brief — a long bio makes
 * the model write about the sender instead of to the recipient.
 */
export const SENDER_BIO_MAX_LENGTH = 280;

/**
 * Normalize what the user typed into what we will store, or null for "they have not said".
 *
 * Collapses internal whitespace because this is pasted as a single line into a prompt, where
 * a stray newline reads as the end of the block and the rest as a new instruction.
 */
export function normalizeSenderBio(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  return collapsed.slice(0, SENDER_BIO_MAX_LENGTH);
}

/**
 * The prompt block, or null when there is nothing to say.
 *
 * Null rather than "About you: (not specified)" deliberately. Telling a model that a field
 * is unknown invites it to work around the gap out loud — "as someone in your field" — where
 * omitting the block leaves it writing the same message it would have written anyway.
 */
export function senderProfileBlock(bio: string | null | undefined): string | null {
  const clean = normalizeSenderBio(bio);
  return clean ? `About you (the sender), in their own words: ${clean}` : null;
}
