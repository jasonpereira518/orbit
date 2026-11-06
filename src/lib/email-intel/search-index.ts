/**
 * Keeping `memory_chunks` in step with `email_events`, so chat can search what the user's
 * mail said.
 *
 * `search-chunk.ts` decides what one event looks like as a passage. This is the part that
 * touches the database: which events are not indexed yet, who their named people resolve to,
 * the write, and the three ways a chunk stops being right.
 *
 * ## Staleness is one predicate, shared
 *
 * `staleEmailEvents` is the claim and the count, so they cannot disagree about what is waiting.
 * An event is stale when no chunk of it carries its current *version*, and the version is
 * computed in SQL from `updated_at` and handed back to the writer, never recomputed in
 * TypeScript. (Interactions hash their text in both places and pin the two to agree; an event
 * has no need: it is only ever inserted, replaced, or, for a rule event, updated in place with
 * `updated_at` bumped, and a timestamp cannot differ between two renderings of itself if only
 * one of them renders it.)
 *
 * ## The three ways a chunk goes wrong, and what handles each
 *
 *  - **The event is gone, dismissed, or its account switched the feature off.** A thread's AI
 *    events are replaced whenever a new message arrives (new ids), so orphaned chunks are the
 *    normal case, not an edge. `pruneEmailEventChunks` deletes chunks with no live, opted-in
 *    event behind them. That includes a switch flipped in SQL, which is why it is a predicate
 *    and not a hook on the Settings action (`deleteEmailEventChunks` is the same delete done
 *    at once, for the action and for Gmail disconnect).
 *  - **The people it names resolve differently than when it was indexed** (a contact was
 *    added, merged or deleted). `reconcileEmailChunkContacts` recomputes who each chunk names
 *    and rewrites `contact_id` / `contact_ids` in place. The text, so the embedding, is
 *    untouched. A merge already rewrites these columns itself; this covers the rest.
 *  - **The text changed.** The version moves, the event is stale again, and `syncMemoryChunksMany`
 *    re-chunks it, carrying over the embedding of any passage whose text did not change.
 *
 * Nothing here calls a model. Embeddings for these chunks are the existing passage phase of the
 * embedding backfill, which does not look at `source_kind`.
 */
import { sql, type SQL } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { syncMemoryChunksMany } from "@/lib/memory-chunks";
import { resolveEmails, normalizedEmail } from "./resolve";
import { emailEventDrafts, type IndexableEvent } from "./search-chunk";
import type { EmailEventPerson } from "./types";

/** Events claimed per pass. Each is one chunk, so this is also the write size. */
export const EMAIL_INDEX_CLAIM = 50;
/** Chunks whose contact ids are re-checked per reconcile. Newest first; the rest are reached as they age in. */
export const EMAIL_RECONCILE_LIMIT = 200;
/** Accounts handled per `runEmailEventIndexing`. */
export const EMAIL_INDEX_USERS = 20;

/**
 * `updated_at` as microseconds since the epoch, in text. Rendered only here, so it is only
 * ever compared with itself.
 */
const VERSION_SQL = sql`(floor(extract(epoch from e.updated_at) * 1000000))::bigint::text`;

/**
 * The one predicate for "an event of an opted-in account whose chunk is missing or out of
 * date". With a `userId` the tenant is bound as a literal inside the NOT EXISTS as well as
 * outside it, for the reason `staleInteractions` gives in `memory-backfill.ts`.
 */
function staleEmailEvents(userId?: string): SQL {
  const outer = userId ? sql`and e.user_id = ${userId}` : sql``;
  const inner = userId ? sql`m.user_id = ${userId}` : sql`m.user_id = e.user_id`;
  return sql`
    from email_events e
    join user_settings s on s.user_id = e.user_id and s.email_intel_enabled = 1
    where e.dismissed_at is null
      and e.kind <> 'other'
      ${outer}
      and not exists (
        select 1 from memory_chunks m
         where ${inner}
           and m.source_kind = 'email_event'
           and m.source_id = e.id
           and m.source_hash = ${VERSION_SQL}
      )
  `;
}

type ChunkWho = { contactId: string | null; contactIds: string[] };

/** Who each event's named people are, as contact ids, in the order the email named them. */
async function resolveWho(userId: string, peopleByKey: Map<string, EmailEventPerson[]>): Promise<Map<string, ChunkWho>> {
  const emails = [...peopleByKey.values()].flat().map((p) => p.email ?? "");
  const owners = await resolveEmails(userId, emails);
  const out = new Map<string, ChunkWho>();
  for (const [key, people] of peopleByKey) {
    const ids: string[] = [];
    for (const p of people) {
      const normalized = normalizedEmail(p.email);
      const id = normalized ? owners.get(normalized) : undefined;
      if (id && !ids.includes(id)) ids.push(id);
    }
    out.set(key, { contactId: ids[0] ?? null, contactIds: ids });
  }
  return out;
}

export type EmailIndexResult = {
  /** Events given a chunk this pass. */
  indexed: number;
  /** Claimed events that could not be written safely (see `emailEventPassage`). */
  skipped: number;
  /** Chunks removed because their event is gone, dismissed or its account is not opted in. */
  pruned: number;
  /** Chunks whose people were re-resolved to something different. */
  reconciled: number;
};

/**
 * Index an account's waiting events, then tidy. Bounded and idempotent: a second call with
 * nothing new does nothing but the two reads that prove it.
 *
 * An event that cannot be written (it trips the injection detector) stays "waiting" and is
 * claimed again each pass. That is the right cost for something that should not exist (the
 * extraction validator rejects such text before it is stored) and the wrong thing to count
 * as backlog, so it is reported as `skipped` and never as work remaining.
 */
export async function indexEmailEventsForUser(
  userId: string,
  options: { limit?: number; reconcile?: boolean } = {}
): Promise<EmailIndexResult> {
  const db = await getDb();
  const rows = rowsOf<IndexableEvent>(
    await db.execute(sql`
      select e.id, e.kind, e.company, e.role, e.stage, e.occurred_at, e.due_at, e.summary,
             e.evidence_quote, e.people, e.asks, ${VERSION_SQL} as version
        from (select e.* ${staleEmailEvents(userId)}) e
       order by e.occurred_at desc, e.id
       limit ${options.limit ?? EMAIL_INDEX_CLAIM}
    `)
  );

  let indexed = 0;
  let skipped = 0;
  if (rows.length > 0) {
    const who = await resolveWho(userId, new Map(rows.map((r) => [r.id, r.people ?? []])));
    const sources = rows.flatMap((row) => {
      const drafts = emailEventDrafts(row, who.get(row.id) ?? { contactId: null, contactIds: [] });
      if (drafts.length === 0) {
        skipped++;
        return [];
      }
      return [{ sourceId: row.id, drafts, sourceHash: row.version }];
    });
    if (sources.length > 0) {
      await syncMemoryChunksMany(userId, "email_event", sources);
      indexed = sources.length;
    }
  }

  const pruned = await pruneEmailEventChunks(userId);
  const reconciled = options.reconcile ? await reconcileEmailChunkContacts(userId) : 0;
  return { indexed, skipped, pruned, reconciled };
}

/**
 * Delete chunks with no live, opted-in event behind them. RETURNING so the count is the rows
 * actually removed (a driver's `rowCount` is not uniform across neon-http and PGlite).
 */
export async function pruneEmailEventChunks(userId: string): Promise<number> {
  const db = await getDb();
  const removed = rowsOf<{ id: string }>(
    await db.execute(sql`
      delete from memory_chunks m
       where m.user_id = ${userId}
         and m.source_kind = 'email_event'
         and not exists (
           select 1
             from email_events e
             join user_settings s on s.user_id = e.user_id and s.email_intel_enabled = 1
            where e.user_id = ${userId}
              and e.id = m.source_id
              and e.dismissed_at is null
              and e.kind <> 'other'
         )
      returning m.id
    `)
  );
  return removed.length;
}

/** Every chunk indexed from an account's mail, at once: the switch turned off, Gmail disconnected. */
export async function deleteEmailEventChunks(userId: string): Promise<void> {
  const db = await getDb();
  await db.execute(sql`delete from memory_chunks where user_id = ${userId} and source_kind = 'email_event'`);
}

type ReconcileRow = {
  id: string;
  contact_id: string | null;
  contact_ids: string[] | null;
  people: EmailEventPerson[] | null;
};

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/**
 * Re-resolve who the newest chunks name, and rewrite the ones that moved. Content is never
 * touched, so nothing becomes stale and nothing is re-embedded.
 */
export async function reconcileEmailChunkContacts(userId: string, limit: number = EMAIL_RECONCILE_LIMIT): Promise<number> {
  const db = await getDb();
  const rows = rowsOf<ReconcileRow>(
    await db.execute(sql`
      select m.id, m.contact_id, m.contact_ids, e.people
        from memory_chunks m
        join email_events e on e.id = m.source_id and e.user_id = ${userId}
       where m.user_id = ${userId} and m.source_kind = 'email_event'
       order by m.occurred_at desc nulls last, m.id
       limit ${limit}
    `)
  );
  if (rows.length === 0) return 0;

  const who = await resolveWho(userId, new Map(rows.map((r) => [r.id, r.people ?? []])));
  let changed = 0;
  for (const row of rows) {
    const next = who.get(row.id) ?? { contactId: null, contactIds: [] };
    if (row.contact_id === next.contactId && sameSet(row.contact_ids ?? [], next.contactIds)) continue;
    const ids = next.contactIds.length
      ? sql`ARRAY[${sql.join(next.contactIds.map((id) => sql`${id}::uuid`), sql`, `)}]::uuid[]`
      : sql`'{}'::uuid[]`;
    await db.execute(sql`
      update memory_chunks
         set contact_id = ${next.contactId}::uuid, contact_ids = ${ids}
       where id = ${row.id}::uuid and user_id = ${userId}
    `);
    changed++;
  }
  return changed;
}

/**
 * Accounts with email-index work outstanding: events waiting for a chunk, or chunks that
 * should not exist any more (an account switched off in SQL, a dismissed event). For the daily
 * backstop; `runEmailEventIndexing` is the quick path.
 */
export async function usersWithPendingEmailEventWork(limit: number): Promise<string[]> {
  const db = await getDb();
  const [waiting, leftover] = await Promise.all([
    db.execute(sql`select distinct e.user_id ${staleEmailEvents()} limit ${limit}`),
    db.execute(sql`
      select distinct m.user_id from memory_chunks m
       where m.source_kind = 'email_event'
         and not exists (
           select 1
             from email_events e
             join user_settings s on s.user_id = e.user_id and s.email_intel_enabled = 1
            where e.user_id = m.user_id and e.id = m.source_id and e.dismissed_at is null and e.kind <> 'other'
         )
       limit ${limit}
    `),
  ]);
  const picked = new Set(rowsOf<{ user_id: string }>(waiting).map((r) => r.user_id));
  for (const { user_id } of rowsOf<{ user_id: string }>(leftover)) {
    if (picked.size >= limit) break;
    picked.add(user_id);
  }
  return [...picked].slice(0, limit);
}

export type EmailEventIndexingStats = { users: number; indexed: number; skipped: number; pruned: number; errors: number };

/**
 * The email-insights sweep's last step: index what extraction just stored, so chat can find
 * it within the sweep's own fifteen minutes instead of the daily backstop. No model call.
 */
export async function runEmailEventIndexing(deps: { deadline: number }): Promise<EmailEventIndexingStats> {
  const stats: EmailEventIndexingStats = { users: 0, indexed: 0, skipped: 0, pruned: 0, errors: 0 };
  for (const userId of await usersWithPendingEmailEventWork(EMAIL_INDEX_USERS)) {
    if (Date.now() >= deps.deadline) break;
    stats.users++;
    try {
      const result = await indexEmailEventsForUser(userId);
      stats.indexed += result.indexed;
      stats.skipped += result.skipped;
      stats.pruned += result.pruned;
    } catch {
      stats.errors++;
    }
  }
  return stats;
}
