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

export type SearchStatus = "not_looking" | "open" | "active";
export const SEARCH_STATUS_OPTIONS: readonly { value: SearchStatus; label: string }[] = [
  { value: "not_looking", label: "Not looking" },
  { value: "open", label: "Open to opportunities" },
  { value: "active", label: "Actively looking" },
];
export const TARGET_ROLE_MAX_LENGTH = 120;
export type SearchProfile = {
  targetRole: string | null;
  graduationYear: number | null;
  searchStatus: SearchStatus | null;
};

export function normalizeSearchProfile(input: unknown): SearchProfile {
  const v = (input ?? {}) as Record<string, unknown>;
  // Same single-line rule as the bio: this lands in a prompt.
  const role = typeof v.targetRole === "string" ? v.targetRole.replace(/\s+/g, " ").trim().slice(0, TARGET_ROLE_MAX_LENGTH) : "";
  const year = typeof v.graduationYear === "string" ? Number(v.graduationYear) : v.graduationYear;
  const status = SEARCH_STATUS_OPTIONS.some((o) => o.value === v.searchStatus) ? (v.searchStatus as SearchStatus) : null;
  return {
    targetRole: role || null,
    graduationYear: typeof year === "number" && Number.isInteger(year) && year >= 1950 && year <= 2100 ? year : null,
    searchStatus: status,
  };
}

const STATUS_PHRASE: Record<SearchStatus, string> = {
  active: "actively looking",
  open: "open to opportunities",
  not_looking: "not looking right now",
};

/** One line for the draft prompt, beside the bio. Null when nothing is set. */
export function senderFactsLine(p: SearchProfile, now: Date = new Date()): string | null {
  const parts: string[] = [];
  if (p.graduationYear) parts.push(`${p.graduationYear >= now.getUTCFullYear() ? "Graduating" : "Graduated"} in ${p.graduationYear}`);
  if (p.targetRole) parts.push(`${p.searchStatus === "not_looking" ? "interested in" : "looking for"} ${p.targetRole} roles`);
  if (p.searchStatus) parts.push(STATUS_PHRASE[p.searchStatus]);
  return parts.length ? `About the sender: ${parts.join("; ")}` : null;
}
