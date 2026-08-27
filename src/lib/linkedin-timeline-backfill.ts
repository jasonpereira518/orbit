/**
 * Derives LinkedIn relationship timeline events (initial reach-out, meetings, in-person
 * meetups) from message threads *after* the import that logged those messages has finished.
 *
 * ## Why this exists
 *
 * The per-conversation importer the engine replaced called
 * `extractLinkedInTimelineEvents` inline, once per conversation, in the middle of its write
 * loop — one AI completion per conversation, blocking the import. Moving LinkedIn messages
 * onto the resumable engine (Task 14) dropped that call and nothing replaced it: raw
 * messages still land in `interactions`, but the scannable events a user actually reads on
 * a contact's timeline silently stopped being produced.
 *
 * Putting it back on the engine's per-row `interactions()` seam is not an option — that
 * seam is a pure function with no DB access and no AI budget, and a per-row provider round
 * trip is exactly the cost the engine exists to remove. Putting it on `finalize` is not an
 * option either: `finalize` runs inline in the import's completion path with no time
 * budget and no resumption, so a 500-conversation import would issue 500 sequential AI
 * calls, blow the 300s function ceiling, and have the whole thing swallowed by the
 * engine's `.catch(() => null)`.
 *
 * So it is deferred, batched, time-boxed and self-continuing — the same shape as
 * `runEmbeddingBackfill` (`src/lib/embedding-backfill.ts`), for the same reasons.
 *
 * ## No new column
 *
 * There is deliberately no "timeline events pending" flag, and no `conversation_id` on
 * `interactions`. Following the embedding backfill's meeting phase: what is left is a
 * *query*, not state to keep in sync. A contact needs events when it has LinkedIn message
 * rows and carries no `li-event:` interaction yet (`PENDING_TIMELINE_CONTACTS` below).
 * A flag column would have to be set by the adapter, cleared by this runner, backfilled
 * for existing rows, and taught to the PGlite bootstrap DDL — all to encode something two
 * `EXISTS` clauses already know for free.
 *
 * ## Grouped by contact, not by conversation
 *
 * The old extractor keyed events by `conversationId` because it ran while the parsed CSV
 * was still in memory. Read back from `interactions`, conversation groupings are gone —
 * but they turn out not to be needed. `resolveConversations` resolves each conversation to
 * one primary participant, so a conversation maps to exactly one contact; where two
 * conversations resolve to the *same* person, one merged thread is a better input to the
 * extractor than two partial ones, and it is already how `enrichContactsFromMessages`
 * (the other post-hoc reader of these same rows) regroups them. Events are therefore keyed
 * `li-event:<contactId>:…` rather than `li-event:<conversationId>:…`.
 *
 * That namespace difference is also what keeps this from re-deriving events for threads
 * the *old* importer already processed: those contacts carry `li-event:<conversationId>:…`
 * rows, which the pending predicate's `external_id LIKE 'li-event:%'` sees, so they are
 * never claimed. They keep the events they have; they do not get a second, differently-keyed
 * set.
 *
 * ## Known fidelity gap vs. the pre-engine importer
 *
 * `extractLinkedInTimelineEvents` accepts a `from` label per message and puts it in the
 * transcript it shows the model. Nothing stores it any more: Task 14's
 * `LinkedInMessageThreadRowPayload` carries only `{ id, body, sentAt }`, so the sender is
 * dropped at parse time, before any row is written. This runner therefore passes
 * `from: null` and the model sees an undirected thread — it can still tell that a meeting
 * was proposed, but not by whom. Closing that gap means widening the payload, the parse,
 * and the adapter's `aiSummary`, which is a change to the import path rather than to this
 * restoration, and is deliberately not done here.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { interactions } from "@/db/schema";
import { getAppBaseUrl } from "@/lib/app-url";
import {
  extractLinkedInTimelineEvents,
  type LinkedInTimelineEvent,
} from "@/lib/linkedin-timeline-events";

/** Contacts claimed per pass. */
const CLAIM_SIZE = 100;

/**
 * Messages handed to the extractor per contact, **oldest first**.
 *
 * Ascending, unlike `enrichContactsFromMessages`' descending read of the same rows, and the
 * difference is load-bearing rather than stylistic: that function summarizes a relationship
 * and wants the most *recent* 80 messages, while the first event this extractor emits is
 * the initial reach-out — the earliest message in the thread. Taking the newest 80 of a
 * long thread would stamp a "first reach-out" that is nothing of the sort. 80 matches the
 * extractor's own internal `.slice(0, 80)`, so a lower number here would silently discard
 * context it was willing to use.
 */
const MESSAGE_LIMIT = 80;

/** Leaves room under the 300s ceiling for a self-continuation request. */
export const TIME_BUDGET_MS = 4.5 * 60 * 1000;

/**
 * The one predicate that defines "a contact whose LinkedIn thread still needs events".
 *
 * Shared verbatim by the claim, the per-user count, and the cron's user sweep — the same
 * discipline as `PENDING_MEETINGS` in `embedding-backfill.ts`, and for the same reason: if
 * the claim and the count could disagree, a contact the claim never returns but the count
 * still reports keeps `remaining > 0` forever and the route's re-kick loop spins on it.
 *
 * `raw_notes` non-empty is not decoration. It is what guarantees the claim makes progress:
 * `extractLinkedInTimelineEvents` emits its rule-based reach-out event unconditionally for
 * any thread with at least one non-empty message, so every claimed contact is certain to
 * produce at least one `li-event:` row and drop straight out of this predicate. A contact
 * whose messages are all blank would otherwise be claimed, yield nothing, and be claimed
 * again on the next iteration forever.
 *
 * Matched on `interaction_type` alone rather than also on `source`, matching
 * `enrichContactsFromMessages`: `'linkedin_message'` is only ever written by the LinkedIn
 * messages importer, and the source string differs between the pre-engine rows
 * (`'linkedin_messages_import'`) and the engine's (`'linkedin_messages'`), so filtering on
 * it would quietly exclude every thread imported before Task 14.
 */
const PENDING_TIMELINE_CONTACTS = sql`
  FROM contacts c
  WHERE EXISTS (
      SELECT 1 FROM interactions m
      WHERE m.user_id = c.user_id
        AND m.contact_id = c.id
        AND m.interaction_type = 'linkedin_message'
        AND btrim(coalesce(m.raw_notes, '')) <> ''
    )
    AND NOT EXISTS (
      SELECT 1 FROM interactions e
      WHERE e.user_id = c.user_id
        AND e.contact_id = c.id
        AND e.external_id LIKE 'li-event:%'
    )
`;

/**
 * Fire-and-forget the timeline backfill route for this user.
 *
 * Through the route rather than calling the runner inline, for the same reason
 * `kickEmbeddingBackfill` does: the caller (the LinkedIn messages adapter's `finalize`) is
 * finished from the user's point of view, and one AI completion per contact across a few
 * hundred contacts can outlive that invocation many times over. Best-effort — the daily
 * cron re-kicks anything still pending.
 */
export async function kickLinkedInTimelineBackfill(userId: string) {
  const secret = process.env.CRON_SECRET;
  try {
    await fetch(`${getAppBaseUrl()}/api/linkedin/timeline-events/backfill`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
      },
      body: JSON.stringify({ userId }),
    });
  } catch {
    // Best-effort — the cron backstop picks up anything still pending.
  }
}

/** How many contacts are still waiting on timeline events for this user. */
export async function pendingTimelineContactCount(userId: string): Promise<number> {
  const db = await getDb();
  const result = await db.execute(sql`
    SELECT count(*)::int AS n ${PENDING_TIMELINE_CONTACTS} AND c.user_id = ${userId}
  `);
  return Number(rowsOf<{ n: number }>(result)[0]?.n ?? 0);
}

/**
 * Users with at least one contact waiting on timeline events — the cron backstop's input.
 *
 * `DISTINCT` over the same predicate rather than a second, hand-written one, so the sweep
 * can never look for users the runner would then find nothing to do for.
 */
export async function usersWithPendingTimelineEvents(limit: number): Promise<string[]> {
  const db = await getDb();
  const result = await db.execute(sql`
    SELECT DISTINCT c.user_id ${PENDING_TIMELINE_CONTACTS}
    LIMIT ${limit}
  `);
  return rowsOf<{ user_id: string }>(result).map((r) => r.user_id);
}

/**
 * `extract` defaults to the real hybrid rule+AI extractor; the smoke test overrides it with
 * a deterministic stub so the claim, the message readback, the bulk insert, the flagless
 * "pending" predicate and second-pass idempotence all run under test without depending on
 * which events a model happens to return. Every real caller gets the default.
 *
 * `budgetMs` lets a caller that is itself under a deadline take a smaller slice, the same
 * seam `runEmbeddingBackfill` exposes for the cron sweep.
 */
export async function runLinkedInTimelineBackfill(
  userId: string,
  extract: typeof extractLinkedInTimelineEvents = extractLinkedInTimelineEvents,
  budgetMs: number = TIME_BUDGET_MS
): Promise<{ contactsProcessed: number; eventsCreated: number; remaining: number }> {
  const db = await getDb();
  const start = Date.now();
  let contactsProcessed = 0;
  let eventsCreated = 0;

  /**
   * Contacts this pass has already attempted.
   *
   * The predicate above makes a no-progress claim impossible *by construction*, but this
   * runner spends real money per iteration and the cost of being wrong about that is an
   * unbounded loop of AI calls against the same contact. So the invariant is also enforced
   * structurally: a contact is attempted at most once per invocation, and a claim that
   * returns nothing new ends the pass. Anything the claim keeps handing back is left for
   * the next invocation, where it is visible as `remaining` rather than as spend.
   */
  const attempted = new Set<string>();

  while (Date.now() - start < budgetMs) {
    const claimed = rowsOf<{ id: string }>(
      await db.execute(sql`
        SELECT c.id ${PENDING_TIMELINE_CONTACTS} AND c.user_id = ${userId}
        ORDER BY c.id
        LIMIT ${CLAIM_SIZE}
      `)
    )
      .map((r) => r.id)
      .filter((id) => !attempted.has(id));

    if (claimed.length === 0) break;

    for (const contactId of claimed) {
      if (Date.now() - start >= budgetMs) break;
      attempted.add(contactId);

      const msgs = await db.query.interactions.findMany({
        where: and(
          eq(interactions.userId, userId),
          eq(interactions.contactId, contactId),
          eq(interactions.interactionType, "linkedin_message")
        ),
        orderBy: [asc(interactions.interactionDate)],
        limit: MESSAGE_LIMIT,
      });
      if (msgs.length === 0) continue;

      // Uncaught on purpose, matching `runEmbeddingBackfill`'s two phases: a failure here
      // must leave the contact without `li-event:` rows so the next pass retries it.
      // Swallowing it would mark the work done by omission. In practice the extractor
      // itself never rejects — it catches a provider failure and falls back to its
      // heuristic pass — so what actually reaches here is a database error, which is
      // exactly the thing that should stop the pass rather than be counted as progress.
      const events: LinkedInTimelineEvent[] = await extract(
        userId,
        // The extractor's scope id, which is all it does with this argument: it prefixes
        // every `externalId` it mints. A contact id, not a conversation id — see this
        // file's header for why, and why that difference is what protects threads the
        // pre-engine importer already processed.
        contactId,
        msgs.map((m) => ({
          // See the header's fidelity note: the sender is no longer stored anywhere.
          from: null,
          content: m.rawNotes || "",
          parsedDate: m.interactionDate ? new Date(m.interactionDate) : null,
        }))
      );

      contactsProcessed += 1;
      if (events.length === 0) continue;

      // One insert for the whole contact's events, and `DO NOTHING` rather than the
      // engine's `DO UPDATE`: unlike a re-imported message row, a re-derived event is a
      // *fresh* model output for text that has not changed. If some row with this
      // `externalId` already exists — a concurrent invocation, or the pre-engine importer
      // — the stored one is not stale and there is nothing to gain by overwriting it with
      // a differently-worded summary of the same message.
      const inserted = await db
        .insert(interactions)
        .values(
          events.map((ev) => ({
            userId,
            contactId,
            interactionType: ev.interactionType,
            interactionDate: ev.interactionDate,
            source: "linkedin_messages",
            externalId: ev.externalId,
            rawNotes: ev.rawNotes,
            aiSummary: ev.summary,
            topics: [],
            sameDayOrder: 0,
          }))
        )
        // The `where` mirrors the partial unique index's own predicate — Postgres will not
        // accept the index as an arbiter otherwise. Same clause the engine's bulk
        // interaction insert passes as `targetWhere`; Drizzle spells it `where` on
        // `onConflictDoNothing` and `targetWhere` on `onConflictDoUpdate`, and both emit
        // the index predicate in the same position.
        .onConflictDoNothing({
          target: [interactions.userId, interactions.externalId],
          where: sql`${interactions.externalId} is not null`,
        })
        .returning();

      eventsCreated += inserted.length;
    }
  }

  return {
    contactsProcessed,
    eventsCreated,
    remaining: await pendingTimelineContactCount(userId),
  };
}
