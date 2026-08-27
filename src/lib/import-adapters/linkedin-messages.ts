import type { LinkedInMessageThreadRowPayload } from "@/db/schema";
import type { ImportAdapter, InteractionInsert } from "@/lib/import-engine";

/**
 * The `imports.import_type` value LinkedIn messages import jobs carry.
 *
 * Lives here rather than in `import-job-dispatch.ts` (which re-exports it, so every
 * existing call site is unchanged) so the adapter registry can key on it without importing
 * the dispatcher — the dispatcher reaches the engine, and the engine reaches the registry.
 */
export const LINKEDIN_MESSAGES_IMPORT_TYPE = "linkedin_messages";

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
    };
  },

  toMerge(payload) {
    return {
      linkedinUrl: payload.linkedinUrl || undefined,
      firstName: payload.firstName || undefined,
      lastName: payload.lastName || undefined,
      source: "linkedin_messages",
      howMet: "LinkedIn messages",
      metContext: "online",
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
};
