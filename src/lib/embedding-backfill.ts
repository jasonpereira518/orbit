/**
 * Fills in the embeddings imports no longer write inline.
 *
 * An embedding call is a network round trip to an AI provider; sitting in the middle of a
 * write loop it made a large import both slow and hostage to that provider's availability.
 * Imports defer instead, and this drains two kinds of deferred work:
 *
 *   1. contacts flagged `embedding_stale_at` -> one `'profile'` embedding each;
 *   2. calendar meetings logged by the import engine -> one `'meeting'` embedding each
 *      (see `runMeetingPhase`).
 *
 * **Time-boxed, and self-continuing only with the route's help.** This function stops at
 * `budgetMs` and reports `remaining`; it does not re-enter itself. Continuation is the
 * caller's job, and `POST /api/embeddings/backfill` does it by re-kicking itself while
 * `remaining > 0` — a single invocation cannot be assumed to finish a 5,000-contact
 * backlog. A caller that ignores `remaining` (as that route used to) leaves the rest of the
 * work sitting until the daily cron notices, which is not "self-continuing" in any useful
 * sense and is why this comment now spells out where the loop actually lives.
 */
import { and, asc, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { contactEmbeddings, contacts, embeddingFailures } from "@/db/schema";
import { createEmbeddingsBatch } from "@/lib/ai";
import { embedWithBisect, planEmbeddingBatches } from "@/lib/embedding-batches";
import { classifyAiError, isMissingAiApiKeyError } from "@/lib/errors";
import { internalFetch } from "@/lib/internal-auth";
import {
  buildContactEmbeddingContent,
  computeContentHash,
  CONTACT_EMBEDDING_COLUMNS,
  CONTACT_EMBEDDING_WITH,
  persistEmbeddingVectors,
} from "@/lib/search";
import { backfillMemoryChunks, pendingMemorySourceCount } from "@/lib/memory-backfill";
import { resolveAiAccess } from "@/lib/ai-access";
import { reportError } from "@/lib/report-error";

/** Contacts claimed per pass. */
const CLAIM_SIZE = 500;
/** Leaves room under the 300s ceiling for a self-continuation request. */
export const TIME_BUDGET_MS = 4.5 * 60 * 1000;

/**
 * Fire-and-forget the backfill route for this user.
 *
 * Lives here rather than in `import-engine.ts` (which used to own a private copy) because
 * there are now three callers — the import engine's completion path, the backfill route's
 * own self-continuation, and the daily cron's backstop — and they must all target the same
 * endpoint with the same auth header.
 *
 * Through the route rather than calling `runEmbeddingBackfill` inline: the caller is
 * finished from the user's point of view, and embedding a few thousand contacts can outlive
 * its invocation. Best-effort by design — the daily cron re-kicks anything still pending.
 */
export async function kickEmbeddingBackfill(userId: string) {
  try {
    await internalFetch("/api/embeddings/backfill", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId }),
    });
  } catch (err) {
    // Best-effort — the cron backstop picks up anything still pending. Reported (throttled)
    // so a kick that always fails — a wrong APP_BASE_URL, a rotated CRON_SECRET — is visible.
    reportError(err, { where: "job.embedding-backfill.kick", userId, level: "warning" });
  }
}

/**
 * Errors about the KEY or the account, not the rows: bisecting them would only multiply the
 * failure, and rethrowing keeps the old contract — the work stays pending for the next pass.
 */
export function isKeyLevelEmbeddingError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  if (isMissingAiApiKeyError(message) || /configured for embeddings|has no embeddings api/i.test(message)) {
    return true;
  }
  const kind = classifyAiError(err);
  return kind === "auth" || kind === "quota" || kind === "rate_limit" || kind === "model_unavailable";
}

/** Marks rows the provider refused on their own; see `embeddingFailures` in schema.ts. */
export async function recordEmbeddingFailures(
  userId: string,
  sourceType: "profile" | "meeting" | "memory_chunk",
  failed: Array<{ sourceId: string; error: unknown }>
): Promise<void> {
  if (failed.length === 0) return;
  const db = await getDb();
  await db
    .insert(embeddingFailures)
    .values(failed.map((f) => ({ userId, sourceType, sourceId: f.sourceId, errorKind: classifyAiError(f.error) })))
    .onConflictDoUpdate({
      target: [embeddingFailures.userId, embeddingFailures.sourceType, embeddingFailures.sourceId],
      set: { failedAt: new Date(), errorKind: sql`excluded.error_kind` },
    });
}

/**
 * `embed` defaults to the real provider call; the smoke test overrides it with a
 * deterministic stub so the upsert, RETURNING mapping, chunked vector write, and flag
 * clear all run under test without needing a live AI key. Every real caller gets the
 * default, so this changes no production behavior.
 *
 * `budgetMs` lets a caller that is itself under a deadline take a smaller slice — the daily
 * cron sweeps many users inside one 300s function and cannot hand the full 4.5 minutes to
 * whichever user happens to be first in the list.
 */
export async function runEmbeddingBackfill(
  userId: string,
  embed: typeof createEmbeddingsBatch = createEmbeddingsBatch,
  budgetMs: number = TIME_BUDGET_MS
): Promise<{
  /** Contact and meeting embeddings — unchanged meaning, and what the cron reports. */
  embedded: number;
  /** Passages of notes given an embedding this run. */
  passages: number;
  /** Interactions newly cut into passages this run. No AI involved. */
  indexed: number;
  remaining: number;
}> {
  const db = await getDb();
  const start = Date.now();
  let embedded = 0;

  // Passages FIRST, and not behind anything that can throw. Cutting notes into passages
  // needs no AI at all, and the phases below rethrow key-level errors by design — which, for
  // an account on a key with no embeddings API, is every run. Put this after them and those
  // accounts' history would never become searchable even by its words. A fifth of the
  // budget at most: it is cheap per row, and the embedding phases are what the budget is for.
  const sweep = await backfillMemoryChunks(userId, {
    budgetMs: Math.floor(budgetMs / 5),
  }).catch((err) => {
    reportError(err, { where: "job.embedding-backfill.memory-sweep", userId, level: "warning" });
    return null;
  });
  const indexed = sweep?.indexed ?? 0;

  while (Date.now() - start < budgetMs) {
    // Snapshot the claim moment before reading, and condition both clears below on it. A
    // contact re-stamped (e.g. by a merge) while this pass is embedding it gets a fresh
    // `embedding_stale_at` strictly after this snapshot — that later write must survive
    // the clear, or the contact ends up permanently marked fresh while its stored
    // embedding still reflects the pre-merge content it had when this pass claimed it.
    const claimedAt = new Date();
    const stale = await db.query.contacts.findMany({
      where: and(eq(contacts.userId, userId), isNotNull(contacts.embeddingStaleAt)),
      orderBy: [asc(contacts.embeddingStaleAt)],
      limit: CLAIM_SIZE,
      // Only what the embedding text is built from (plus id) — see CONTACT_EMBEDDING_COLUMNS.
      columns: CONTACT_EMBEDDING_COLUMNS,
      with: CONTACT_EMBEDDING_WITH,
    });
    if (stale.length === 0) break;

    const candidates = stale
      .map((contact) => {
        const content = buildContactEmbeddingContent(contact);
        return { contactId: contact.id, content, contentHash: computeContentHash(content) };
      })
      .filter((entry) => entry.content.trim().length > 0);

    // Stamped stale is not the same as changed: an opportunity write, a merge or a profile
    // save stamps the flag whether or not the embedded text moved. A contact whose stored
    // vector was built from exactly this text needs its flag cleared, not another API call —
    // the same check `rebuildContactEmbedding` makes on the immediate path.
    const storedHash = new Map(
      candidates.length === 0
        ? []
        : (
            await db
              .select({ contactId: contactEmbeddings.contactId, contentHash: contactEmbeddings.contentHash })
              .from(contactEmbeddings)
              .where(
                and(
                  eq(contactEmbeddings.userId, userId),
                  eq(contactEmbeddings.sourceType, "profile"),
                  inArray(contactEmbeddings.contactId, candidates.map((c) => c.contactId))
                )
              )
          ).map((r) => [r.contactId, r.contentHash])
    );
    const unchangedIds = candidates
      .filter((entry) => storedHash.get(entry.contactId) === entry.contentHash)
      .map((entry) => entry.contactId);
    const entries = candidates.filter((entry) => storedHash.get(entry.contactId) !== entry.contentHash);

    const embeddable = new Set(candidates.map((entry) => entry.contactId));
    // A contact with no embeddable text is not pending work — clear its flag so the loop
    // cannot spin on it forever, but write no embedding row. An unchanged one is done too.
    const emptyIds = [
      ...stale.map((c) => c.id).filter((id) => !embeddable.has(id)),
      ...unchangedIds,
    ];

    for (const slice of planEmbeddingBatches(entries, (entry) => entry.content)) {
      // Key-level failures are rethrown by embedWithBisect, leaving `embedding_stale_at` set
      // so the next pass retries. Only a row refused on its own is isolated and marked.
      const outcome = await embedWithBisect(
        slice,
        (entry) => entry.content,
        (texts) => embed(userId, texts),
        isKeyLevelEmbeddingError
      );
      const done = outcome.embedded;

      if (done.length > 0) {
        const tuples = done.map(
          ({ item, vector }) => sql`(
            ${userId}::text, ${item.contactId}::uuid, 'profile'::text,
            ${item.contactId}::text, ${JSON.stringify(vector)}::jsonb,
            ${item.content}::text, ${item.contentHash}::text
          )`
        );
        // content_hash is written so the next pass — and the immediate path — can tell this
        // vector is current. Rows written before it was stored re-embed once, then settle.
        const result = await db.execute(sql`
          INSERT INTO contact_embeddings
            (user_id, contact_id, source_type, source_id, embedding, content, content_hash)
          VALUES ${sql.join(tuples, sql`, `)}
          ON CONFLICT (user_id, contact_id, source_type, source_id)
          DO UPDATE SET embedding = EXCLUDED.embedding, content = EXCLUDED.content, content_hash = EXCLUDED.content_hash
          RETURNING id, contact_id
        `);
        // `db.execute` returns an array on neon-http and `{ rows }` on PGlite; both drivers
        // are in play (production and local), so neither shape can be assumed. `rowsOf` is
        // the shared normalizer for this (see `src/db/index.ts`).
        const idByContact = new Map(
          rowsOf<{ id: string; contact_id: string }>(result).map((r) => [r.contact_id, r.id])
        );
        await persistEmbeddingVectors(
          done
            .map(({ item, vector }) => ({ id: idByContact.get(item.contactId) ?? "", embedding: vector }))
            .filter((row) => row.id)
        );
        await db
          .update(contacts)
          .set({ embeddingStaleAt: null })
          .where(
            and(
              inArray(contacts.id, done.map(({ item }) => item.contactId)),
              lte(contacts.embeddingStaleAt, claimedAt)
            )
          );
        embedded += done.length;
      }

      if (outcome.failed.length > 0) {
        const failedIds = outcome.failed.map(({ item }) => item.contactId);
        await recordEmbeddingFailures(
          userId,
          "profile",
          outcome.failed.map(({ item, error }) => ({ sourceId: item.contactId, error }))
        );
        // Un-flagged so the claim stops returning it; an edit re-stamps it for another try.
        await db
          .update(contacts)
          .set({ embeddingStaleAt: null })
          .where(and(inArray(contacts.id, failedIds), lte(contacts.embeddingStaleAt, claimedAt)));
      }
    }

    if (emptyIds.length > 0) {
      await db
        .update(contacts)
        .set({ embeddingStaleAt: null })
        .where(and(inArray(contacts.id, emptyIds), lte(contacts.embeddingStaleAt, claimedAt)));
    }
  }

  embedded += await runMeetingPhase(userId, embed, start, budgetMs);

  // Passages can only be embedded by an account that HAS an embeddings backend. An account on
  // an Anthropic key never will — there is no Anthropic embeddings API — so its passages stay
  // pending for good, and without this gate every run would throw a key-level error from
  // this phase and record a `backfill.failed` the ops sweep alerts on. Those accounts are
  // served by the lexical arm, which is exactly what it is for.
  //
  // An injected `embed` is its own backend: that seam exists so the smoke can drive the
  // write path without a live key, and gating it on the real account would test nothing.
  const canEmbedPassages = embed !== createEmbeddingsBatch || (await accountCanEmbed(userId));
  const passages = canEmbedPassages
    ? await runMemoryChunkPhase(userId, embed, start, budgetMs)
    : 0;

  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(contacts)
    .where(and(eq(contacts.userId, userId), isNotNull(contacts.embeddingStaleAt)));

  return {
    embedded,
    passages,
    indexed,
    remaining:
      Number(row?.value ?? 0) +
      (await pendingMeetingCount(userId)) +
      // Only work that CAN be done counts as remaining. Passages an account can never embed
      // are not a backlog; counting them would re-kick this route for them every day.
      (canEmbedPassages ? await pendingMemoryChunkCount(userId) : 0) +
      (await pendingMemorySourceCount(userId)),
  };
}

/**
 * The one predicate that defines "a calendar meeting still needing an embedding".
 *
 * Shared verbatim by the claim and the count below, deliberately: if the two could disagree,
 * a row the claim never returns but the count still reports keeps `remaining > 0` forever,
 * and the route's re-kick loop (see this file's header) would spin on it indefinitely. One
 * fragment, two call sites, no way to drift.
 *
 * Scoped to the calendar sources by name, not to `interaction_type = 'meeting'` alone, so a
 * future non-calendar 'meeting' row does not silently join this sweep.
 *
 * The list used to be `calendar_import` only, because the live ICS subscription embedded its
 * own rows inline as it wrote them. That is no longer true: `applyNetworkingEvents` was
 * replaced by the shared ingest path, which flags `embedding_stale_at` and leaves the
 * embedding to a batch rather than paying an AI round trip per row. Every calendar source now
 * depends on this sweep, and leaving one out means its meeting content is silently
 * unsearchable — which is exactly the regression this phase was written to repair the first
 * time. If you add a calendar source, add it here.
 *
 * `microsoft_calendar` and `apple_calendar` joined the list here, alongside `google_calendar` —
 * until now they were the ONLY calendar sources missing, meaning every Outlook meeting synced
 * since Outlook calendar sync shipped had never been embedded, and so had never reached chat or
 * search. Existing rows are picked up retroactively the next time this sweep runs, exactly like
 * any other previously-excluded source — there is no separate backfill needed.
 *
 * The content check is what keeps a meeting with no text at all out of the claim
 * entirely rather than needing a "clear the flag" branch the way the profile phase does —
 * there is no flag here to clear. A meeting the provider refused on its own is listed in
 * `embedding_failures` and excluded, or it would keep `remaining > 0` and be resent every
 * hour.
 */
const PENDING_MEETINGS = sql`
  FROM interactions i
  JOIN contacts c ON c.id = i.contact_id
  WHERE i.source IN ('calendar_import', 'calendar_sync', 'google_calendar', 'microsoft_calendar', 'apple_calendar')
    AND i.interaction_type = 'meeting'
    AND i.external_id IS NOT NULL
    AND (btrim(c.full_name) <> '' OR btrim(coalesce(i.raw_notes, '')) <> '')
    AND NOT EXISTS (
      SELECT 1 FROM contact_embeddings e
      WHERE e.user_id = i.user_id
        AND e.contact_id = i.contact_id
        AND e.source_type = 'meeting'
        AND e.source_id = i.external_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM embedding_failures f
      WHERE f.user_id = i.user_id
        AND f.source_type = 'meeting'
        AND f.source_id = i.contact_id::text || ':' || i.external_id
    )
`;

/**
 * How many calendar meetings still need a `'meeting'` embedding.
 *
 * Exported so a smoke test can assert against the REAL `PENDING_MEETINGS` predicate rather
 * than a copy of it. A test that restates the source list would keep passing if someone
 * narrowed the predicate back — which is the precise regression this phase exists to prevent.
 */
export async function pendingMeetingCount(userId: string): Promise<number> {
  const db = await getDb();
  const result = await db.execute(sql`
    SELECT count(*)::int AS n ${PENDING_MEETINGS} AND i.user_id = ${userId}
  `);
  return Number(rowsOf<{ n: number }>(result)[0]?.n ?? 0);
}

/**
 * Phase 2: `'meeting'` embeddings for calendar imports.
 *
 * The per-row importer the engine replaced called `upsertContactEmbedding(userId,
 * contactId, "meeting", ...)` for every logged meeting, so meeting notes were semantically
 * searchable (`src/actions/search.ts` reads every source type, not just `'profile'`). Moving
 * calendar onto the engine dropped that call and nothing replaced it — meeting content
 * silently stopped being searchable for anything imported through the engine.
 *
 * Restored here rather than in the adapter, and this is the whole point: putting it back
 * per row would reintroduce exactly the per-row AI round trip this work exists to remove.
 * Here it is batched (`planEmbeddingBatches`, capped by items and estimated tokens),
 * time-boxed, and resumable, and
 * it needs no new column or flag — `contact_embeddings` already records which meetings have
 * been embedded, so "what is left" is a query rather than state to keep in sync.
 *
 * The content string reproduces the old importer's (`fullName` + newline + `rawNotes`, where
 * `rawNotes` is the same note that importer built), so a meeting embedded by the old path
 * and one embedded here are indistinguishable to search. `chr(10)`, not an escape sequence:
 * a `\n` written inside a JS template literal is already a real newline by the time
 * Postgres sees it, which makes the SQL depend on invisible whitespace surviving every
 * future edit of this string.
 */
async function runMeetingPhase(
  userId: string,
  embed: typeof createEmbeddingsBatch,
  start: number,
  budgetMs: number
): Promise<number> {
  const db = await getDb();
  let embedded = 0;

  while (Date.now() - start < budgetMs) {
    const claimed = rowsOf<{
      contact_id: string;
      external_id: string;
      content: string;
    }>(
      await db.execute(sql`
        SELECT
          i.contact_id,
          i.external_id,
          btrim(c.full_name || chr(10) || coalesce(i.raw_notes, '')) AS content
        ${PENDING_MEETINGS} AND i.user_id = ${userId}
        ORDER BY i.interaction_date DESC
        LIMIT ${CLAIM_SIZE}
      `)
    );
    if (claimed.length === 0) break;

    for (const slice of planEmbeddingBatches(claimed, (row) => row.content)) {
      // Uncaught key-level failures for the same reason as the profile phase: they must
      // leave these meetings unembedded so the next pass retries them. There is no flag to
      // preserve here — the absence of the `contact_embeddings` row *is* the pending state.
      const outcome = await embedWithBisect(
        slice,
        (row) => row.content,
        (texts) => embed(userId, texts),
        isKeyLevelEmbeddingError
      );
      const done = outcome.embedded;

      if (done.length > 0) {
        const tuples = done.map(
          ({ item, vector }) => sql`(
            ${userId}::text, ${item.contact_id}::uuid, 'meeting'::text,
            ${item.external_id}::text, ${JSON.stringify(vector)}::jsonb,
            ${item.content}::text, ${computeContentHash(item.content)}::text
          )`
        );
        // Four-column conflict target, matching `embeddings_user_contact_source_id_uidx`.
        // `source_id` is load-bearing here in a way it is not for the profile phase: a
        // contact has many meetings, each its own row, so a three-column key would make the
        // second meeting of any contact collide with the first.
        const result = await db.execute(sql`
          INSERT INTO contact_embeddings
            (user_id, contact_id, source_type, source_id, embedding, content, content_hash)
          VALUES ${sql.join(tuples, sql`, `)}
          ON CONFLICT (user_id, contact_id, source_type, source_id)
          DO UPDATE SET embedding = EXCLUDED.embedding, content = EXCLUDED.content, content_hash = EXCLUDED.content_hash
          RETURNING id, source_id
        `);
        const idBySourceId = new Map(
          rowsOf<{ id: string; source_id: string }>(result).map((r) => [r.source_id, r.id])
        );
        await persistEmbeddingVectors(
          done
            .map(({ item, vector }) => ({ id: idBySourceId.get(item.external_id) ?? "", embedding: vector }))
            .filter((row) => row.id)
        );
        embedded += done.length;
      }

      await recordEmbeddingFailures(
        userId,
        "meeting",
        outcome.failed.map(({ item, error }) => ({ sourceId: `${item.contact_id}:${item.external_id}`, error }))
      );
    }
  }

  return embedded;
}

/**
 * Whether this account has any embeddings backend, asked without minting a key or throwing.
 * False for an Anthropic-only account; see the gate in `runEmbeddingBackfill`.
 */
export async function accountCanEmbed(userId: string): Promise<boolean> {
  try {
    return (await resolveAiAccess(userId)).embeddingBackend() !== null;
  } catch {
    return false;
  }
}

/**
 * The one predicate that defines "a passage still needing an embedding".
 *
 * Shared by the claim and the count for the same reason `PENDING_MEETINGS` is: if they could
 * disagree, the route's re-kick loop would spin on a row the claim never returns.
 *
 * `embedded_hash IS DISTINCT FROM content_hash` is served by the partial
 * `memory_chunks_pending_idx`, so this stays the size of the outstanding work rather than the
 * table. A chunk the provider refused on its own is listed in `embedding_failures`, keyed by
 * id AND hash: an edit re-chunks the note into new rows with new ids, so a refused passage
 * gets another try exactly when its text changes, and not before.
 */
function pendingMemoryChunks(userId: string) {
  // The tenant is bound as a literal inside the subquery too — see `unindexedInteractions`
  // in `@/lib/memory-backfill` for why a correlation alone is not a tenant boundary.
  return sql`
    FROM memory_chunks m
    WHERE m.user_id = ${userId}
      AND m.embedded_hash IS DISTINCT FROM m.content_hash
      AND NOT EXISTS (
        SELECT 1 FROM embedding_failures f
        WHERE f.user_id = ${userId}
          AND f.source_type = 'memory_chunk'
          AND f.source_id = m.id::text || ':' || m.content_hash
      )
  `;
}
/** How many passages still need an embedding. Exported for the smoke, against the real predicate. */
export async function pendingMemoryChunkCount(userId: string): Promise<number> {
  const db = await getDb();
  const result = await db.execute(sql`
    SELECT count(*)::int AS n ${pendingMemoryChunks(userId)}
  `);
  return Number(rowsOf<{ n: number }>(result)[0]?.n ?? 0);
}

/**
 * Phase 3: embeddings for passages of the user's own notes (`memory_chunks`).
 *
 * Without this the passage index is lexical only — it finds a note by its words and never by
 * its meaning, so "who is raising money?" misses a note that says "closing a seed round".
 * Same shape as the meeting phase: batched, bisected on refusal, time-boxed, resumable, and
 * no new flag — the hash columns already say what is pending.
 *
 * The write is conditional on `content_hash` still matching what was claimed. A note edited
 * mid-pass is re-chunked into NEW rows (delete-then-insert in `syncMemoryChunks`), so a
 * vector computed from the old text finds nothing to land on rather than overwriting the
 * new passage with a stale meaning.
 */
export async function runMemoryChunkPhase(
  userId: string,
  embed: typeof createEmbeddingsBatch,
  start: number,
  budgetMs: number
): Promise<number> {
  const db = await getDb();
  let embedded = 0;

  while (Date.now() - start < budgetMs) {
    const claimed = rowsOf<{ id: string; content: string; content_hash: string }>(
      await db.execute(sql`
        SELECT m.id, m.content, m.content_hash
        ${pendingMemoryChunks(userId)}
        ORDER BY m.occurred_at DESC NULLS LAST
        LIMIT ${CLAIM_SIZE}
      `)
    );
    if (claimed.length === 0) break;

    let progressed = 0;
    for (const slice of planEmbeddingBatches(claimed, (row) => row.content)) {
      // Key-level failures are rethrown, leaving every passage pending for the next pass —
      // including for accounts on a key with no embeddings API, which is why the passage
      // SWEEP runs before any phase that can throw (see `runEmbeddingBackfill`).
      const outcome = await embedWithBisect(
        slice,
        (row) => row.content,
        (texts) => embed(userId, texts),
        isKeyLevelEmbeddingError
      );

      const done = outcome.embedded;
      for (let i = 0; i < done.length; i += MEMORY_VECTOR_WRITE_CHUNK) {
        const part = done.slice(i, i + MEMORY_VECTOR_WRITE_CHUNK);
        const tuples = part.map(
          ({ item, vector }) =>
            sql`(${item.id}::uuid, ${JSON.stringify(vector)}::jsonb, ${item.content_hash}::text)`
        );
        const landed = rowsOf<{ id: string }>(
          await db.execute(sql`
            UPDATE memory_chunks AS m
               SET embedding = v.emb, embedded_hash = v.hash
              FROM (VALUES ${sql.join(tuples, sql`, `)}) AS v(id, emb, hash)
             WHERE m.id = v.id AND m.user_id = ${userId} AND m.content_hash = v.hash
            RETURNING m.id
          `)
        );
        const landedIds = new Set(landed.map((r) => r.id));
        await persistEmbeddingVectors(
          part
            .filter(({ item }) => landedIds.has(item.id))
            .map(({ item, vector }) => ({ id: item.id, embedding: vector })),
          "memory_chunks"
        );
        embedded += landedIds.size;
        progressed += part.length;
      }

      if (outcome.failed.length > 0) {
        await recordEmbeddingFailures(
          userId,
          "memory_chunk",
          outcome.failed.map(({ item, error }) => ({
            sourceId: `${item.id}:${item.content_hash}`,
            error,
          }))
        );
        progressed += outcome.failed.length;
      }
    }
    // A pass that neither embedded nor marked anything would claim the same rows again
    // forever. Cannot happen with the predicate above, but a loop with a wall-clock budget
    // as its only exit is one bad predicate away from burning the whole budget, so say so.
    if (progressed === 0) break;
  }

  return embedded;
}

/**
 * Rows per UPDATE. Each carries a full 1,536-float vector as jsonb text (~18KB), so this
 * matches `VECTOR_WRITE_CHUNK` in `@/lib/search` for the same neon-http statement-size reason.
 */
const MEMORY_VECTOR_WRITE_CHUNK = 50;
