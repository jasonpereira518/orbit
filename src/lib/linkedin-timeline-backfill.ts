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
 * ## Sender labelling
 *
 * `extractLinkedInTimelineEvents` accepts a `from` label per message and puts it in the
 * transcript it shows the model. That label was dead for a while — the payload carried only
 * `{ id, body, sentAt }`, so the sender was dropped at parse time and this runner passed
 * `from: null`, leaving the model to read an undirected thread. It could tell a meeting was
 * proposed but not by whom.
 *
 * `interactions.direction` closed that. Rows imported before it exists still carry NULL and
 * still read as `"?"`, so a contact's transcript is labelled only as well as its most recent
 * import — a re-upload of the LinkedIn export is what upgrades it.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { interactions, userSettings } from "@/db/schema";
import { AI_DERIVED_SOURCE } from "@/lib/interaction-provenance";
import { internalFetch } from "@/lib/internal-auth";
import {
  dedupeTimelineEvents,
  extractLinkedInTimelineEvents,
  heuristicTimelineEvents,
  prepareTimelineExtraction,
  timelineEventsFromAnswer,
  type LinkedInTimelineEvent,
} from "@/lib/linkedin-timeline-events";
import { MAX_BATCH_REQUESTS, submitAiBatch } from "@/lib/ai-batch";
import { gateSkips, gateText } from "@/lib/decisions/gates";
import { SKIP_GATE_TUNING } from "@/lib/decisions/catalog";
import { mapPool } from "@/lib/decisions/jev";
import { openEngines, type Engines } from "@/lib/decisions/engine";
import { RATE_LIMITS, consumeBucket, isRateLimitedError } from "@/lib/rate-limit";
import {
  TIMELINE_MIN_MESSAGES_FOR_AI,
  qualifiesForTimelineAi,
  usableTimelineMessageCount,
  utcDayKey,
} from "@/lib/timeline-cost";
import { reportError } from "@/lib/report-error";

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
  try {
    await internalFetch("/api/linkedin/timeline-events/backfill", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId }),
    });
  } catch (err) {
    // Best-effort — the cron backstop picks up anything still pending. Reported (throttled)
    // so a kick that always fails — a wrong APP_BASE_URL, a rotated CRON_SECRET — is visible.
    reportError(err, { where: "job.timeline-backfill.kick", userId, level: "warning" });
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
 * Pending contacts whose thread would cost a model call — what the import card's estimate
 * multiplies. Same predicate as the claim, plus the extractor's own skip rule.
 */
export async function pendingTimelineAiContactCount(userId: string): Promise<number> {
  const db = await getDb();
  const result = await db.execute(sql`
    SELECT count(*)::int AS n ${PENDING_TIMELINE_CONTACTS}
      AND c.user_id = ${userId}
      AND (
        SELECT count(*) FROM interactions q
         WHERE q.user_id = c.user_id
           AND q.contact_id = c.id
           AND q.interaction_type = 'linkedin_message'
           AND btrim(coalesce(q.raw_notes, '')) <> ''
      ) >= ${TIMELINE_MIN_MESSAGES_FOR_AI}
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
      AND EXISTS (
        SELECT 1 FROM user_settings us
         WHERE us.user_id = c.user_id AND us.timeline_backfill_enabled = 1
      )
    LIMIT ${limit}
  `);
  return rowsOf<{ user_id: string }>(result).map((r) => r.user_id);
}

/**
 * Writes a contact's derived events. `DO NOTHING` rather than the engine's `DO UPDATE`:
 * unlike a re-imported message row, a re-derived event is a *fresh* model output for text
 * that has not changed. If some row with this `externalId` already exists — a concurrent
 * invocation, the pre-engine importer, or this contact's rule-based events written when its
 * batch was submitted — the stored one is not stale, and there is nothing to gain by
 * overwriting it with a differently-worded summary of the same message.
 *
 * Returns how many rows were actually new.
 */
export async function writeTimelineEvents(
  userId: string,
  contactId: string,
  events: LinkedInTimelineEvent[]
): Promise<number> {
  if (events.length === 0) return 0;
  const db = await getDb();
  const inserted = await db
    .insert(interactions)
    .values(
      events.map((ev) => ({
        userId,
        contactId,
        interactionType: ev.interactionType,
        interactionDate: ev.interactionDate,
        source: AI_DERIVED_SOURCE,
        externalId: ev.externalId,
        rawNotes: ev.rawNotes,
        aiSummary: ev.summary,
        topics: [],
        sameDayOrder: 0,
      }))
    )
    // The `where` mirrors the partial unique index's own predicate — Postgres will not
    // accept the index as an arbiter otherwise.
    .onConflictDoNothing({
      target: [interactions.userId, interactions.externalId],
      where: sql`${interactions.externalId} is not null`,
    })
    .returning();
  return inserted.length;
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
  budgetMs: number = TIME_BUDGET_MS,
  opts: { dailyCap?: number; now?: Date; submit?: typeof submitAiBatch; engines?: Engines } = {}
): Promise<{
  contactsProcessed: number;
  eventsCreated: number;
  remaining: number;
  capped: boolean;
  enabled: boolean;
}> {
  const db = await getDb();
  const submit = opts.submit ?? submitAiBatch;
  const start = Date.now();
  let contactsProcessed = 0;
  let eventsCreated = 0;
  let capped = false;

  // Opt-in (audit A6): the work costs the user's own AI key, so it never starts unasked.
  const settings = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
    columns: { timelineBackfillEnabled: true },
  });
  if ((settings?.timelineBackfillEnabled ?? 0) !== 1) {
    return {
      contactsProcessed: 0,
      eventsCreated: 0,
      remaining: await pendingTimelineContactCount(userId),
      capped: false,
      enabled: false,
    };
  }
  const dailyCap = opts.dailyCap ?? RATE_LIMITS.timelineBackfillDaily.limit;
  const bucketKey = `${userId}:${utcDayKey(opts.now ?? new Date())}`;

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
  /** Threads waiting to be sent as a batch, filled by the claim loop below. */
  let queued: Array<{ contactId: string; prompt: { system: string; user: string }; baseEvents: LinkedInTimelineEvent[] }> = [];

  claiming: while (Date.now() - start < budgetMs) {
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
        // The three fields the thread is rebuilt from below.
        columns: { rawNotes: true, direction: true, interactionDate: true },
        orderBy: [asc(interactions.interactionDate)],
        limit: MESSAGE_LIMIT,
      });
      if (msgs.length === 0) continue;

      // Only a thread that will reach the model spends from the daily allowance.
      if (qualifiesForTimelineAi(usableTimelineMessageCount(msgs.map((m) => m.rawNotes)))) {
        try {
          await consumeBucket("timelineBackfill", bucketKey, { limit: dailyCap, windowSec: 86_400 });
        } catch (err) {
          if (!isRateLimitedError(err)) throw err;
          capped = true;
          break claiming;
        }
      }

      const asMessages = msgs.map((m) => ({
        // Null for rows imported before `direction` existed; the extractor renders those
        // as "?" exactly as it did when nothing stored the sender at all.
        from: m.direction === "out" ? "you" : m.direction === "in" ? "them" : null,
        content: m.rawNotes || "",
        parsedDate: m.interactionDate ? new Date(m.interactionDate) : null,
      }));

      // A thread that needs the model is queued for a batch instead of asked one at a time:
      // half price, and nobody is waiting on an opt-in backfill. Threads that need no model
      // (a lone reach-out) are finished here and now.
      const prepared = prepareTimelineExtraction(contactId, asMessages);
      if (prepared.prompt) {
        queued.push({ contactId, prompt: prepared.prompt, baseEvents: prepared.baseEvents });
        contactsProcessed += 1;
        continue;
      }

      // Uncaught on purpose, matching `runEmbeddingBackfill`'s two phases: a failure here
      // must leave the contact without `li-event:` rows so the next pass retries it.
      // Swallowing it would mark the work done by omission.
      const events: LinkedInTimelineEvent[] = await extract(
        userId,
        // The extractor's scope id, which is all it does with this argument: it prefixes
        // every `externalId` it mints. A contact id, not a conversation id — see this
        // file's header for why, and why that difference is what protects threads the
        // pre-engine importer already processed.
        contactId,
        asMessages
      );

      contactsProcessed += 1;
      if (events.length === 0) continue;

      eventsCreated += await writeTimelineEvents(userId, contactId, events);
    }
  }

  // Most of these threads never arrange a meeting, and for those the rule-derived events
  // are the entire answer — the batch would spend a call per thread to confirm it. With a
  // decision model, the queue is gated in parallel first and a confident "no meeting here"
  // writes the rule events and drops out of the batch. Without one the queue is untouched.
  const engines = opts.engines ?? (await openEngines(userId));
  if (queued.length) {
    const keep = await mapPool(queued, SKIP_GATE_TUNING.concurrency, async (q) =>
      !(await gateSkips(engines, "timeline", { messages: gateText(q.prompt.user) }))
    );
    const skipped = queued.filter((_, i) => !keep[i]);
    queued = queued.filter((_, i) => keep[i]);
    for (const q of skipped) eventsCreated += await writeTimelineEvents(userId, q.contactId, q.baseEvents);
  }

  // Submit what the claim loop queued. The rule-based events are written as each batch is
  // accepted: they are correct without a model, and writing them is also what takes the
  // contact out of the pending set, so a batch in flight is never claimed a second time.
  for (let i = 0; i < queued.length; i += MAX_BATCH_REQUESTS) {
    const slice = queued.slice(i, i + MAX_BATCH_REQUESTS);
    const items = slice.map((q, n) => ({ customId: `t${n}`, contactId: q.contactId }));
    const jobId = await submit(
      userId,
      "import.linkedin.timeline",
      slice.map((q, n) => ({ customId: `t${n}`, system: q.prompt.system, user: q.prompt.user, temperature: 0.1 })),
      { items, contactIds: slice.map((q) => q.contactId) }
    );
    if (jobId) {
      for (const q of slice) eventsCreated += await writeTimelineEvents(userId, q.contactId, q.baseEvents);
      continue;
    }
    // Batching unavailable (no key, allowance spent, provider refused): do it the ordinary
    // way, one thread at a time, exactly as before.
    for (const q of slice) {
      const msgs = await db.query.interactions.findMany({
        where: and(
          eq(interactions.userId, userId),
          eq(interactions.contactId, q.contactId),
          eq(interactions.interactionType, "linkedin_message")
        ),
        // The three fields the thread is rebuilt from below.
        columns: { rawNotes: true, direction: true, interactionDate: true },
        orderBy: [asc(interactions.interactionDate)],
        limit: MESSAGE_LIMIT,
      });
      const events = await extract(
        userId,
        q.contactId,
        msgs.map((m) => ({
          from: m.direction === "out" ? "you" : m.direction === "in" ? "them" : null,
          content: m.rawNotes || "",
          parsedDate: m.interactionDate ? new Date(m.interactionDate) : null,
        })),
        // Already gated above, on its way into the queue. Passing the same engines means the
        // second ask is answered from the decision cache rather than billed again.
        { engines }
      );
      eventsCreated += await writeTimelineEvents(userId, q.contactId, events);
    }
  }

  return {
    contactsProcessed,
    eventsCreated,
    remaining: await pendingTimelineContactCount(userId),
    capped,
    enabled: true,
  };
}

/** What a submitted timeline batch needs to map its answers back onto. */
export type TimelineBatchPayload = { items: Array<{ customId: string; contactId: string }>; contactIds: string[] };

/**
 * Writes one batched answer back, or — when `content` is null, meaning the batch will never
 * answer — the heuristic events the inline path falls back to. The thread is read again and
 * prepared exactly as it was at submit, because an event's date is resolved against the
 * message it came from.
 */
export async function applyTimelineOutcome(
  userId: string,
  contactId: string,
  content: string | null
): Promise<number> {
  const db = await getDb();
  const msgs = await db.query.interactions.findMany({
    where: and(
      eq(interactions.userId, userId),
      eq(interactions.contactId, contactId),
      eq(interactions.interactionType, "linkedin_message")
    ),
    orderBy: [asc(interactions.interactionDate)],
    limit: MESSAGE_LIMIT,
  });
  if (msgs.length === 0) return 0;

  const { usable } = prepareTimelineExtraction(
    contactId,
    msgs.map((m) => ({
      from: m.direction === "out" ? "you" : m.direction === "in" ? "them" : null,
      content: m.rawNotes || "",
      parsedDate: m.interactionDate ? new Date(m.interactionDate) : null,
    }))
  );
  if (usable.length === 0) return 0;

  let events: LinkedInTimelineEvent[];
  try {
    events = content ? timelineEventsFromAnswer(contactId, usable, content) : heuristicTimelineEvents(contactId, usable);
  } catch {
    // An answer that is not the shape it promised is worth no more than no answer at all.
    events = heuristicTimelineEvents(contactId, usable);
  }
  return writeTimelineEvents(userId, contactId, dedupeTimelineEvents(events));
}
