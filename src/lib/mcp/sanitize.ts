/**
 * Cleaning text an agent or an integration wrote, before it is stored.
 *
 * The reason this exists is second-order and specific to Orbit. Text written through
 * `log_interaction` or the public API lands in `interactions.raw_notes` and `contacts.notes`.
 * Those columns are read back by `prepareChatContext` and fed verbatim into Orbit's OWN chat
 * prompt on every `askNetwork` call, and by `buildContactEmbeddingContent` into the embedding.
 * So a single poisoned note is not a one-shot attack on the agent that wrote it — it is a
 * standing instruction that fires later, on a surface the attacker never touched, every time
 * the user asks a question that retrieves that contact.
 *
 * What this module is for, precisely: removing the characters that let injected text hide
 * from the human who would otherwise notice it. It is NOT a prompt-injection filter, and it
 * must not be described as one — a determined instruction written in plain English survives
 * every transformation here, by design, because stripping plain English would destroy the
 * legitimate content too.
 *
 * The controls that actually bound the damage are structural and live elsewhere: the MCP
 * surface exposes no way to send anything anywhere (see `server.ts`), search returns curated
 * summaries rather than free text, and every write records its provenance in
 * `interactions.source`.
 */

/**
 * Characters that render as nothing, or reverse the visual order of what follows.
 *
 * These are the ones that matter: a note reading "call them next week" in the UI can carry
 * "ignore previous instructions…" that only the tokenizer sees. Zero-width spaces and joiners
 * (200B-200F), the bidirectional overrides (202A-202E), and the isolates (2066-2069).
 */
const INVISIBLE = /[​-‏‪-‮⁦-⁩﻿]/g;

/** HTML that would be rendered rather than shown if the text ever reaches a rich surface. */
const HTML_TAG = /<\/?[a-z][^>]*>/gi;

/**
 * Markdown links whose target is a scheme that executes rather than navigates.
 *
 * The inner alternation allows one level of nested parentheses, because a payload like
 * `[click](javascript:alert(1))` is the common shape and a naive `[^)]*` stops at the first
 * `)` — leaving a stray bracket behind and, worse, leaving the scheme in place for anything
 * that re-parses the text later.
 */
const DANGEROUS_LINK =
  /\[([^\]]*)\]\(\s*(?:javascript|data|vbscript):(?:[^()]|\([^()]*\))*\)/gi;

export const MAX_AGENT_TEXT = 5_000;

/**
 * Normalize text written by an agent or an integration.
 *
 * Deliberately conservative: it removes what is invisible or executable and leaves the prose
 * untouched. A note is the user's own record of a conversation, and mangling it to defend
 * against an attack it probably is not would be a worse outcome than the attack.
 */
export function sanitizeAgentText(input: string): string {
  return input
    .replace(INVISIBLE, "")
    .replace(HTML_TAG, "")
    // Keep the link text, drop the target.
    .replace(DANGEROUS_LINK, "$1")
    // Collapse the runs of blank lines that a stripped block leaves behind.
    .replace(/\n{4,}/g, "\n\n\n")
    .trim()
    .slice(0, MAX_AGENT_TEXT);
}
