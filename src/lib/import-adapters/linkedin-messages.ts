import type { LinkedInMessageThreadRowPayload } from "@/db/schema";
import type { ImportAdapter, InteractionInsert } from "@/lib/import-engine";
import { enrichContactsFromMessages } from "@/lib/message-enrichment";

/**
 * The `imports.import_type` value LinkedIn messages import jobs carry.
 *
 * Lives here rather than in `import-job-dispatch.ts` (which re-exports it, so every
 * existing call site is unchanged) so the adapter registry can key on it without importing
 * the dispatcher — the dispatcher reaches the engine, and the engine reaches the registry.
 */
export const LINKEDIN_MESSAGES_IMPORT_TYPE = "linkedin_messages";

/** Earliest and latest valid message dates in a conversation, or `null` if none parse. */
function messageDateRange(payload: LinkedInMessageThreadRowPayload): {
  earliest: Date | null;
  latest: Date | null;
} {
  let earliest: Date | null = null;
  let latest: Date | null = null;
  for (const m of payload.messages) {
    const d = new Date(m.sentAt);
    if (Number.isNaN(d.getTime())) continue;
    if (!earliest || d < earliest) earliest = d;
    if (!latest || d > latest) latest = d;
  }
  return { earliest, latest };
}

/**
 * One conversation per row. `startLinkedInMessagesImport` (src/actions/imports.ts) parses
 * the CSV and resolves every conversation's primary participant exactly once, so nothing
 * here re-parses or re-fetches contacts per row — that per-batch re-fetch was the whole
 * problem this task exists to remove.
 *
 * `externalId` is the entire dedupe mechanism (see Task 14's brief): each message's `id` is
 * a hash of (conversationId, date, content) computed once at parse time, so re-importing the
 * same export produces the same `interactions.externalId` values and the engine's bulk
 * `onConflictDoNothing()` insert — which targets the real `(user_id, external_id)` unique
 * index — silently no-ops on the repeat rather than logging every message twice. No extra
 * per-chunk existence query is needed; the database does the dedupe.
 */
export const linkedinMessagesAdapter: ImportAdapter<LinkedInMessageThreadRowPayload> = {
  identity(payload) {
    // Today's importer skips a conversation with no resolvable LinkedIn profile URL —
    // `startLinkedInMessagesImport` only ever produces rows like that when called directly
    // (as this adapter's own tests do); `resolveConversations` filters them out of the
    // production parse path already. Preserved here so the row still reaches a terminal
    // `skipped` status instead of being silently dropped.
    if (!payload.linkedinUrl) return null;
    return {
      fullName: payload.fullName,
      linkedinUrl: payload.linkedinUrl,
    };
  },

  toCreate(payload) {
    const { earliest, latest } = messageDateRange(payload);
    return {
      fullName: payload.fullName,
      firstName: payload.firstName || undefined,
      lastName: payload.lastName || undefined,
      linkedinUrl: payload.linkedinUrl || undefined,
      source: "linkedin_messages",
      relationshipScore: 2,
      howMet: "LinkedIn messages",
      metContext: "online",
      tagNames: ["linkedin", "messages"],
      // Real conversation history, not import time: closeness scoring reads both
      // firstInteractionAt (relationship age) and lastInteractionAt (recency), and
      // `contactInsertValues` derives lastInteractionAt from `dateMet` on create — see its
      // comment. Importing a five-year-old conversation with both left at "now" would score
      // it as brand new. `earliest ?? undefined` (not `null`) so a conversation with no
      // parseable dates falls back through `dateMet` the same way the create path already
      // does for every other importer, rather than forcing `now` directly.
      firstInteractionAt: earliest ?? undefined,
      dateMet: latest ? latest.toISOString() : undefined,
    };
  },

  toMerge(payload) {
    const { earliest, latest } = messageDateRange(payload);
    return {
      linkedinUrl: payload.linkedinUrl || undefined,
      firstName: payload.firstName || undefined,
      lastName: payload.lastName || undefined,
      source: "linkedin_messages",
      howMet: "LinkedIn messages",
      metContext: "online",
      // `date_met` still only fills in if unset (COALESCE) — harmless here since create
      // already populated it, kept for parity with the LinkedIn connections adapter.
      dateMet: latest ? latest.toISOString() : undefined,
      // `firstInteractionAt`/`lastInteractionAt` WIDEN on merge (LEAST/GREATEST in
      // `bulkMergeContactsForUser` — see its doc comment), not COALESCE-set-once. This is
      // the fix for the real regression the old per-row importer didn't have: re-exporting
      // the same conversation six months later, with six months of new messages, now
      // advances `last_interaction_at` to the newest message this run found, instead of
      // leaving recency scoring frozen at whatever the first import saw.
      firstInteractionAt: earliest ?? undefined,
      lastInteractionAt: latest ?? undefined,
    };
  },

  interactions(payload, contactId, userId): InteractionInsert[] {
    return payload.messages
      .filter((m) => m.body.trim())
      .map((m) => {
        const date = new Date(m.sentAt);
        return {
          userId,
          contactId,
          interactionType: "linkedin_message",
          interactionDate: Number.isNaN(date.getTime()) ? new Date() : date,
          source: "linkedin_messages",
          externalId: m.id,
          rawNotes: m.body,
          aiSummary: m.body.slice(0, 240),
          topics: [],
        };
      });
  },

  /**
   * AI enrichment, restored per Task 14 fix round 1: `enrichContactsFromMessages` re-reads
   * each contact's `interactions` rows itself (see `src/lib/message-enrichment.ts` — it
   * queries by `contactId` + `interactionType: "linkedin_message"`, nothing from this job's
   * payloads), so it fits the engine's once-per-job finalization seam exactly, the same
   * shape as `recalibrateCloseness`/`refreshOutreachSuggestions`. Kept off the per-chunk
   * path deliberately: it makes one AI provider call per contact, and running it per chunk
   * instead of once per job would reintroduce a per-row provider round trip — exactly what
   * Phase 2 removed from the embedding path.
   */
  async finalize(userId, contactIds) {
    if (contactIds.length === 0) return;
    await enrichContactsFromMessages(userId, contactIds);
  },
};
