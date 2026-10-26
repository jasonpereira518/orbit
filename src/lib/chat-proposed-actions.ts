/**
 * Chat-proposed actions: the model proposes a change and a person's click is what actually makes
 * it. Never the other way around — see the rule at the top of `src/lib/mcp/server.ts`, which
 * applies here in full. Every proposal names one of the chat writes (`CHAT_WRITES` in
 * @/lib/tools/chat-writes) and is committed through that catalog entry by
 * `commitProposedAction` (@/actions/chat-actions), from the stored input, re-validated.
 *
 * This module holds the stored shape. Types only.
 */

/**
 * A proposal: one of the chat writes (`CHAT_WRITES` in @/lib/tools/chat-writes), by name, and
 * the input it will be committed with. The answer loop makes these by calling the write
 * (`@/lib/tools/chat-proposals`); it is committed through the catalog entry, re-validated
 * against that entry's schema from the stored input.
 *
 * `kind` is always "tool". It is the stored format: rows written before every proposal was a
 * catalog write carried other kinds, and `scripts/migrate-legacy-chat-proposals.ts` rewrote them.
 */
export type ProposedActionArgs = { kind: "tool"; tool: string; input: Record<string, unknown> };

export type ProposedAction = {
  /** Minted by Orbit, never taken from the model — the commit action addresses a proposal by this. */
  id: string;
  args: ProposedActionArgs;
  /** The exact text or plain-language summary the confirm card shows. Never re-derived later. */
  preview: string;
  status: "proposed";
};

/**
 * What actually lives in `chat_messages.proposed_actions`, after a proposal has possibly been
 * acted on. `committing` is the claimed-but-not-yet-settled state a single CAS update passes
 * through — see `@/actions/chat-actions` — and should never be visible for more than the
 * length of one write; a row stuck there is evidence of a crashed commit, not a valid state
 * to build UI around.
 */
export type StoredProposedAction = Omit<ProposedAction, "status"> & {
  /** `undoing` and `undone` only ever follow `done`, on a proposal whose commit left an `undo`. */
  status: "proposed" | "committing" | "done" | "dismissed" | "failed" | "undoing" | "undone";
  /** The id of the row the commit produced or changed, once it has. */
  resultId?: string | null;
  /** The inverse the done card's Undo runs, stored by the commit. */
  undo?: { tool: string; input: Record<string, unknown> } | null;
  /** Where the done card's "View" goes. */
  href?: string | null;
  /** Whether this may be applied without a click (Phase 3), or always asks. */
  tier?: "auto" | "confirm";
  /** The card warns, and there is no undo. */
  destructive?: boolean;
  /** The contact the card shows. */
  contactId?: string | null;
  /** Applied by chat itself under the person's auto-apply setting (`@/lib/chat-auto-apply`). */
  autoApplied?: boolean;
};
