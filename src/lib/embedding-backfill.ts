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
import { contacts, embeddingFailures } from "@/db/schema";
import { createEmbeddingsBatch } from "@/lib/ai";
import { embedWithBisect, planEmbeddingBatches } from "@/lib/embedding-batches";
import { classifyAiError, isMissingAiApiKeyError } from "@/lib/errors";
import { internalFetch } from "@/lib/internal-auth";
import { buildContactEmbeddingContent, persistEmbeddingVectors } from "@/lib/search";
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
function isKeyLevelEmbeddingError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  if (isMissingAiApiKeyError(message) || /configured for embeddings|has no embeddings api/i.test(message)) {
    return true;
  }
  const kind = classifyAiError(err);
  return kind === "auth" || kind === "quota" || kind === "rate_limit" || kind === "model_unavailable";
}

/** Marks rows the provider refused on their own; see `embeddingFailures` in schema.ts. */
async function recordEmbeddingFailures(
  userId: string,
  sourceType: "profile" | "meeting",
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
): Promise<{ embedded: number; remaining: number }> {
  const db = await getDb();
  const start = Date.now();
  let embedded = 0;

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
      with: {
        contactTags: { with: { tag: true } },
        profile: true,
        experiences: true,
      },
    });
    if (stale.length === 0) break;

    const entries = stale
      .map((contact) => ({
        contactId: contact.id,
        content: buildContactEmbeddingContent(contact),
      }))
      .filter((entry) => entry.content.trim().length > 0);

    const embeddable = new Set(entries.map((entry) => entry.contactId));
    // A contact with no embeddable text is not pending work — clear its flag so the loop
    // cannot spin on it forever, but write no embedding row.
    const emptyIds = stale.map((c) => c.id).filter((id) => !embeddable.has(id));

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
            ${item.content}::text
          )`
        );
        const result = await db.execute(sql`
          INSERT INTO contact_embeddings
            (user_id, contact_id, source_type, source_id, embedding, content)
          VALUES ${sql.join(tuples, sql`, `)}
          ON CONFLICT (user_id, contact_id, source_type, source_id)
          DO UPDATE SET embedding = EXCLUDED.embedding, content = EXCLUDED.content
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

  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(contacts)
    .where(and(eq(contacts.userId, userId), isNotNull(contacts.embeddingStaleAt)));

  return {
    embedded,
    remaining: Number(row?.value ?? 0) + (await pendingMeetingCount(userId)),
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
 * The content check is what keeps a meeting with no text at all out of the claim
 * entirely rather than needing a "clear the flag" branch the way the profile phase does —
 * there is no flag here to clear. A meeting the provider refused on its own is listed in
 * `embedding_failures` and excluded, or it would keep `remaining > 0` and be resent every
 * hour.
 */
const PENDING_MEETINGS = sql`
  FROM interactions i
  JOIN contacts c ON c.id = i.contact_id
  WHERE i.source IN ('calendar_import', 'calendar_sync', 'google_calendar')
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
            ${item.content}::text
          )`
        );
        // Four-column conflict target, matching `embeddings_user_contact_source_id_uidx`.
        // `source_id` is load-bearing here in a way it is not for the profile phase: a
        // contact has many meetings, each its own row, so a three-column key would make the
        // second meeting of any contact collide with the first.
        const result = await db.execute(sql`
          INSERT INTO contact_embeddings
            (user_id, contact_id, source_type, source_id, embedding, content)
          VALUES ${sql.join(tuples, sql`, `)}
          ON CONFLICT (user_id, contact_id, source_type, source_id)
          DO UPDATE SET embedding = EXCLUDED.embedding, content = EXCLUDED.content
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
