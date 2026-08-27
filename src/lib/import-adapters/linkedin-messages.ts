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

/**
 * Earliest and latest valid message dates in a conversation, or `null` if none parse.
 *
 * A message whose date could not be parsed carries `sentAt: null` and is excluded here
 * rather than counted. This is load-bearing, not defensive: an unparseable date used to be
 * written as the epoch, which passes every validity check there is, so a single such
 * message dragged `earliest` to 1970-01-01 — and since `bulkMergeContactsForUser` widens
 * `first_interaction_at` with `LEAST`, that value was permanent, uncorrectable by any
 * later import. A conversation whose dates *all* fail to parse yields `null` for both,
 * which the two callers below turn into `undefined` so the create path falls back through
 * `dateMet` exactly as it does for every other importer.
 */
function messageDateRange(payload: LinkedInMessageThreadRowPayload): {
  earliest: Date | null;
  latest: Date | null;
} {
  let earliest: Date | null = null;
  let latest: Date | null = null;
  for (const m of payload.messages) {
    if (!m.sentAt) continue;
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
 * insert — which targets the real `(user_id, external_id)` unique index — resolves the
 * repeat on conflict rather than logging every message twice. No extra per-chunk existence
 * query is needed; the database does the dedupe.
 *
 * That insert is an `onConflictDoUpdate` since Task 15, not the `onConflictDoNothing` it
 * was written against. Harmless here, and worth stating rather than leaving to be
 * rediscovered: because the id already hashes the date and the content, a message whose
 * date or content changed produces a *different* id and never conflicts at all, so the only
 * way messages reach the conflict branch is a byte-identical re-import — where DO UPDATE
 * writes back the values already there. `interactions` has no `updated_at` for it to touch,
 * so the repeat is a genuine no-op either way.
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
        // Unlike the contact-level date range above, an *interaction* row must carry some
        // date — `interaction_date` is NOT NULL. Import time is the same fallback the
        // pre-engine importer used (`msg.parsedDate || new Date()`), and it is confined to
        // this one row rather than leaking into the contact's permanent
        // `first_interaction_at`, which is what made the epoch sentinel harmful.
        const date = m.sentAt ? new Date(m.sentAt) : null;
        return {
          userId,
          contactId,
          interactionType: "linkedin_message",
          interactionDate: date && !Number.isNaN(date.getTime()) ? date : new Date(),
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
