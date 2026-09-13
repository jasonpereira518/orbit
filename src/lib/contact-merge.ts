/**
 * Merging two contacts into one, reversibly.
 *
 * ## Why the loser's row is deleted rather than flagged
 *
 * The obvious design is `contacts.merged_into_id` plus `IS NULL` at every read. That does
 * not survive this codebase: there are around a hundred places that read contacts and no
 * shared predicate helper — every one hand-rolls `eq(contacts.userId, ...)`. A single
 * missed filter puts a merged contact back in the graph, in chat retrieval, or in an
 * export, and nothing would catch it. Deleting the row makes the contact invisible
 * everywhere by construction, with no ongoing obligation on any future query.
 *
 * What makes that safe rather than destructive is `contact_merges`: the loser is archived
 * whole (`to_jsonb(c)`), every child row that moved is recorded by id, and every row that
 * had to be deleted instead of moved is archived in full. `unmergeContacts` replays that
 * record. The contact comes back with its original uuid, so ids held elsewhere — note-batch
 * results, chat recommendations — become valid again for free.
 *
 * ## Ordering
 *
 * Everything runs inside one `runAtomicWrite`, which is a real transaction on both drivers
 * (`db.batch` on neon-http, a genuine transaction on PGlite). Statements are pre-built, so
 * nothing may read a result mid-flight — this is why the `repointed` bookkeeping is done
 * with CTEs that fold ids into the archive row inside the same statement, rather than
 * returning them to TypeScript.
 *
 * The loser's DELETE is always the last statement. That is what makes a partial failure
 * lossless: most child FKs are ON DELETE CASCADE, so a delete that ran before its repoints
 * would take the children with it. Every statement is also idempotent (`WHERE contact_id =
 * loser` matches nothing on a rerun), so a merge that somehow lands half-applied can simply
 * be run again.
 */

import { and, eq, sql } from "drizzle-orm";
import { getDb, runAtomicWrite, type AtomicStatement, type AtomicWriter } from "@/db";
import { contactMerges, contacts, duplicateSuggestions } from "@/db/schema";
import { markCohortDirty, rescoreContact } from "@/lib/closeness-materialize";
import { scheduleEmbeddingRebuild } from "@/lib/contact-writes";

/**
 * Child tables that move to the winner with a plain UPDATE.
 *
 * Every one has been checked against its unique indexes: none of them includes
 * `contact_id`, so repointing can never raise a unique violation.
 *
 *  - interactions, reminders, suggested_reminders, action_items — unique on
 *    `(user_id, external_id)` or `(user_id, item_hash)`.
 *  - contact_experiences — no unique index at all.
 *  - outreach_prospects — unique on `(campaign_id, external_*)`.
 *  - user_recruiter_links — unique on `(user_id, recruiter_id)`.
 *  - event_attendees — `event_attendees_identity_uidx` is on `(event_id, identity_key)`;
 *    `contact_id` is not in the key.
 *  - contact_identities — collision is impossible by construction. If the winner already
 *    held one of these `(user_id, kind, value)` rows, the loser could never have obtained
 *    it, so the two sets are disjoint.
 *  - note_batches.seed_contact_id and import_job_rows.contact_id have NO foreign key, so
 *    nothing cascades to protect them; they are listed here precisely because they would
 *    otherwise be left pointing at a uuid that no longer exists.
 *
 * `scoped` says whether the table has a `user_id` column to constrain the UPDATE with.
 * outreach_prospects does not (it is scoped through its campaign); every other table here
 * does, and omitting the predicate would let a merge touch another tenant's rows.
 */
const REPOINTED_TABLES: { table: string; column: string; scoped: boolean }[] = [
  { table: "interactions", column: "contact_id", scoped: true },
  { table: "reminders", column: "contact_id", scoped: true },
  { table: "suggested_reminders", column: "contact_id", scoped: true },
  { table: "action_items", column: "contact_id", scoped: true },
  { table: "contact_experiences", column: "contact_id", scoped: true },
  // No user_id column of its own — scoped through its campaign.
  { table: "outreach_prospects", column: "contact_id", scoped: false },
  { table: "user_recruiter_links", column: "contact_id", scoped: true },
  { table: "event_attendees", column: "contact_id", scoped: true },
  { table: "contact_identities", column: "contact_id", scoped: true },
  { table: "note_batches", column: "seed_contact_id", scoped: true },
  { table: "import_job_rows", column: "contact_id", scoped: true },
];

/** Fold a statement's moved ids into the archive row, additively. */
function recordMoved(writer: AtomicWriter, mergeId: string, label: string, update: ReturnType<typeof sql>) {
  return writer.execute(sql`
    WITH moved AS (${update})
    UPDATE contact_merges
       SET repointed = coalesce(repointed, '{}'::jsonb) || jsonb_build_object(
             ${label}::text,
             coalesce(
               (coalesce(repointed, '{}'::jsonb) -> ${label}::text),
               '[]'::jsonb
             ) || coalesce((SELECT jsonb_agg(id) FROM moved), '[]'::jsonb)
           )
     WHERE id = ${mergeId}::uuid
  `);
}

/** Archive rows that had to be deleted rather than moved, so unmerge can restore them. */
function recordDeleted(writer: AtomicWriter, mergeId: string, label: string, del: ReturnType<typeof sql>) {
  return writer.execute(sql`
    WITH removed AS (${del})
    UPDATE contact_merges
       SET deleted = coalesce(deleted, '{}'::jsonb) || jsonb_build_object(
             ${label}::text,
             coalesce(
               (coalesce(deleted, '{}'::jsonb) -> ${label}::text),
               '[]'::jsonb
             ) || coalesce((SELECT jsonb_agg(row) FROM removed), '[]'::jsonb)
           )
     WHERE id = ${mergeId}::uuid
  `);
}

export type MergeOptions = {
  reason?: string;
  confidence?: number;
  /** Skip the post-merge recompute. Only for bulk callers that batch it themselves. */
  deferInvalidation?: boolean;
};

export type MergeResult = { mergeId: string; winnerId: string; loserId: string };

/**
 * Merge `loserId` into `winnerId`. Both must belong to `userId`.
 *
 * Field-level policy is `COALESCE(winner, loser)` — the winner's values win and the loser
 * only fills blanks, mirroring `bulkMergeContactsForUser`. `first_interaction_at` and
 * `last_interaction_at` WIDEN with LEAST/GREATEST instead, because merging two records of
 * the same person can only ever grow the known interaction window.
 */
export async function mergeContacts(
  userId: string,
  winnerId: string,
  loserId: string,
  options: MergeOptions = {}
): Promise<MergeResult> {
  if (winnerId === loserId) throw new Error("mergeContacts: winner and loser are the same contact");

  const db = await getDb();
  const rows = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.userId, userId), sql`${contacts.id} IN (${winnerId}::uuid, ${loserId}::uuid)`));
  const present = new Set(rows.map((r) => r.id));
  if (!present.has(winnerId)) throw new Error(`mergeContacts: winner ${winnerId} not found`);
  if (!present.has(loserId)) throw new Error(`mergeContacts: loser ${loserId} not found`);

  // Generated in JS so every pre-built statement in the batch can reference the archive row
  // it is writing into — nothing can read an id back mid-batch.
  const mergeId = crypto.randomUUID();
  const reason = options.reason ?? null;
  const confidence = options.confidence ?? null;

  // Which archive rows the path compression below is about to rewrite. Read here rather
  // than captured in the batch so unmerge can put them back: without this list, undoing a
  // merge in the middle of a chain would leave an older archive row pointing at the wrong
  // survivor. (A data-modifying CTE could capture it in-statement, but it would be updating
  // contact_merges twice in one statement, which is far harder to read than one SELECT.)
  const compressed = await db
    .select({ id: contactMerges.id })
    .from(contactMerges)
    .where(and(eq(contactMerges.userId, userId), eq(contactMerges.winnerContactId, loserId)));
  const compressedIds = compressed.map((r) => r.id);

  await runAtomicWrite(db, (tx) => {
    const statements: AtomicStatement[] = [];

    // 1. Archive the loser whole, BEFORE anything mutates it.
    //
    // `to_jsonb(c)` over the row, never a drizzle select: `closeness_breakdown` exists in
    // the database but is deliberately undeclared in schema.ts, so a typed projection
    // would drop it from the snapshot silently and unmerge would restore a contact that
    // had quietly lost a column.
    statements.push(
      tx.execute(sql`
        INSERT INTO contact_merges (
          id, user_id, winner_contact_id, loser_contact_id, loser_snapshot,
          repointed, deleted, status, reason, confidence
        )
        SELECT ${mergeId}::uuid, c.user_id, ${winnerId}::uuid, c.id, to_jsonb(c),
               ${JSON.stringify({ contact_merges: compressedIds })}::jsonb,
               '{}'::jsonb, 'in_progress', ${reason}::text, ${confidence}::real
          FROM contacts c
         WHERE c.id = ${loserId}::uuid AND c.user_id = ${userId}
      `)
    );

    // 2. Fold the loser's fields into the winner. COALESCE = fill blanks only, never
    //    clobber; LEAST/GREATEST widen the interaction window.
    statements.push(
      tx.execute(sql`
        UPDATE contacts w
           SET company              = COALESCE(w.company, l.company),
               company_id           = COALESCE(w.company_id, l.company_id),
               title                = COALESCE(w.title, l.title),
               email                = COALESCE(w.email, l.email),
               phone                = COALESCE(w.phone, l.phone),
               linkedin_url         = COALESCE(w.linkedin_url, l.linkedin_url),
               x_handle             = COALESCE(w.x_handle, l.x_handle),
               website              = COALESCE(w.website, l.website),
               location             = COALESCE(w.location, l.location),
               school               = COALESCE(w.school, l.school),
               first_name           = COALESCE(w.first_name, l.first_name),
               last_name            = COALESCE(w.last_name, l.last_name),
               preferred_name       = COALESCE(w.preferred_name, l.preferred_name),
               profile_image_url    = COALESCE(w.profile_image_url, l.profile_image_url),
               source               = COALESCE(w.source, l.source),
               how_met              = COALESCE(w.how_met, l.how_met),
               met_context          = COALESCE(w.met_context, l.met_context),
               date_met             = COALESCE(w.date_met, l.date_met),
               notes                = CASE
                                        WHEN l.notes IS NULL OR btrim(l.notes) = '' THEN w.notes
                                        WHEN w.notes IS NULL OR btrim(w.notes) = '' THEN l.notes
                                        ELSE w.notes || E'\n\n' || l.notes
                                      END,
               first_interaction_at = LEAST(w.first_interaction_at, l.first_interaction_at),
               last_interaction_at  = GREATEST(w.last_interaction_at, l.last_interaction_at),
               embedding_stale_at   = now(),
               updated_at           = now()
          FROM contacts l
         WHERE w.id = ${winnerId}::uuid
           AND l.id = ${loserId}::uuid
           AND w.user_id = ${userId} AND l.user_id = ${userId}
      `)
    );

    // 3. Path-compress earlier merges. Without this, A -> B followed by B -> C leaves A's
    //    archive row naming B, a contact that no longer exists, and alias resolution needs
    //    a recursive CTE with no termination guarantee.
    statements.push(
      tx.execute(sql`
        UPDATE contact_merges
           SET winner_contact_id = ${winnerId}::uuid
         WHERE winner_contact_id = ${loserId}::uuid AND user_id = ${userId}
      `)
    );

    // 4a. Straightforward repoints.
    for (const { table, column, scoped } of REPOINTED_TABLES) {
      const tableRef = sql.raw(table);
      const columnRef = sql.raw(column);
      const scope = scoped ? sql` AND user_id = ${userId}` : sql``;
      statements.push(
        recordMoved(
          tx,
          mergeId,
          table === "note_batches" ? "note_batches.seed_contact_id" : table,
          sql`UPDATE ${tableRef} SET ${columnRef} = ${winnerId}::uuid
               WHERE ${columnRef} = ${loserId}::uuid${scope}
           RETURNING id`
        )
      );
    }

    // 4b. contact_tags: unique on (contact_id, tag_id), so a tag both contacts carry
    //     collides. Move what does not collide, archive-and-drop the rest. Postgres has no
    //     ON CONFLICT for UPDATE, hence the NOT EXISTS guard.
    statements.push(
      recordMoved(
        tx,
        mergeId,
        "contact_tags",
        sql`UPDATE contact_tags t SET contact_id = ${winnerId}::uuid
             WHERE t.contact_id = ${loserId}::uuid
               AND NOT EXISTS (
                 SELECT 1 FROM contact_tags w
                  WHERE w.contact_id = ${winnerId}::uuid AND w.tag_id = t.tag_id)
         RETURNING id`
      )
    );
    statements.push(
      recordDeleted(
        tx,
        mergeId,
        "contact_tags",
        sql`DELETE FROM contact_tags WHERE contact_id = ${loserId}::uuid
         RETURNING to_jsonb(contact_tags) AS row`
      )
    );

    // 4c. interaction_mentions: unique on (interaction_id, contact_id). The interactions
    //     repoint above may have just produced pairs that now collide.
    statements.push(
      recordMoved(
        tx,
        mergeId,
        "interaction_mentions",
        sql`UPDATE interaction_mentions m SET contact_id = ${winnerId}::uuid
             WHERE m.contact_id = ${loserId}::uuid AND m.user_id = ${userId}
               AND NOT EXISTS (
                 SELECT 1 FROM interaction_mentions w
                  WHERE w.interaction_id = m.interaction_id
                    AND w.contact_id = ${winnerId}::uuid)
         RETURNING id`
      )
    );
    statements.push(
      recordDeleted(
        tx,
        mergeId,
        "interaction_mentions",
        sql`DELETE FROM interaction_mentions
             WHERE contact_id = ${loserId}::uuid AND user_id = ${userId}
         RETURNING to_jsonb(interaction_mentions) AS row`
      )
    );

    // 4d. ai_suggestions carries contact ids inside a jsonb array with no FK. Rewrite in
    //     place — cheap, and guarded so it only touches rows that mention the loser.
    statements.push(
      tx.execute(sql`
        UPDATE ai_suggestions
           SET related_contact_ids = (
                 SELECT jsonb_agg(DISTINCT CASE WHEN e = ${loserId} THEN ${winnerId} ELSE e END)
                   FROM jsonb_array_elements_text(related_contact_ids) e)
         WHERE user_id = ${userId}
           AND jsonb_typeof(related_contact_ids) = 'array'
           AND related_contact_ids @> to_jsonb(ARRAY[${loserId}]::text[])
      `)
    );

    // 4e. Derived rows that must NOT be moved.
    //
    // contact_briefs is keyed by contact_id (it IS the primary key) and its stored
    // `recentDiscussions` names interactions that just changed owner, so the winner's brief
    // is stale too — drop both and let it regenerate.
    statements.push(
      recordDeleted(
        tx,
        mergeId,
        "contact_briefs",
        sql`DELETE FROM contact_briefs
             WHERE user_id = ${userId}
               AND contact_id IN (${loserId}::uuid, ${winnerId}::uuid)
         RETURNING to_jsonb(contact_briefs) AS row`
      )
    );

    // contact_profiles is unique on (user_id, contact_id) and only one may survive. Move
    // the loser's only if the winner has none; otherwise the winner's stands.
    statements.push(
      recordMoved(
        tx,
        mergeId,
        "contact_profiles",
        sql`UPDATE contact_profiles p SET contact_id = ${winnerId}::uuid
             WHERE p.contact_id = ${loserId}::uuid AND p.user_id = ${userId}
               AND NOT EXISTS (
                 SELECT 1 FROM contact_profiles w
                  WHERE w.user_id = ${userId} AND w.contact_id = ${winnerId}::uuid)
         RETURNING id`
      )
    );
    statements.push(
      recordDeleted(
        tx,
        mergeId,
        "contact_profiles",
        sql`DELETE FROM contact_profiles
             WHERE contact_id = ${loserId}::uuid AND user_id = ${userId}
         RETURNING to_jsonb(contact_profiles) AS row`
      )
    );

    // contact_embeddings: the loser's whole-contact vector encodes the loser's text, which
    // the fold in step 2 has just changed anyway — delete it and let the rebuild run.
    // Source-bearing rows (a meeting, a note) still describe real material, so those move,
    // guarded against the (user_id, contact_id, source_type, source_id) unique index.
    //
    // Raw SQL, never a drizzle round-trip: `embedding_vector` is runtime-managed and
    // undeclared, and reading these rows through the ORM would drop it.
    statements.push(
      recordDeleted(
        tx,
        mergeId,
        "contact_embeddings",
        sql`DELETE FROM contact_embeddings
             WHERE user_id = ${userId} AND contact_id = ${loserId}::uuid
               AND source_id IS NULL
         RETURNING to_jsonb(contact_embeddings) - 'embedding_vector' AS row`
      )
    );
    statements.push(
      recordMoved(
        tx,
        mergeId,
        "contact_embeddings",
        sql`UPDATE contact_embeddings e SET contact_id = ${winnerId}::uuid
             WHERE e.contact_id = ${loserId}::uuid AND e.user_id = ${userId}
               AND NOT EXISTS (
                 SELECT 1 FROM contact_embeddings w
                  WHERE w.user_id = ${userId} AND w.contact_id = ${winnerId}::uuid
                    AND w.source_type = e.source_type
                    AND w.source_id IS NOT DISTINCT FROM e.source_id)
         RETURNING id`
      )
    );
    statements.push(
      recordDeleted(
        tx,
        mergeId,
        "contact_embeddings",
        sql`DELETE FROM contact_embeddings
             WHERE user_id = ${userId} AND contact_id = ${loserId}::uuid
         RETURNING to_jsonb(contact_embeddings) - 'embedding_vector' AS row`
      )
    );

    // 4f. Suggestions are left to the cascade. Every pair naming the loser — including the
    //     (winner, loser) pair this merge resolves — is deleted when the loser row goes, and
    //     repointing them onto the winner instead would collide with the (user, a, b) unique
    //     index wherever the winner already had a pair with the same third contact. Pairs
    //     naming only the winner must survive untouched: a merge with one contact says
    //     nothing about whether the winner also duplicates somebody else, and marking those
    //     resolved would silently discard a dismissal the user had not made.

    // 5. The loser row. ALWAYS LAST — most child FKs cascade, so this running any earlier
    //    would take rows with it that the statements above still needed to move.
    statements.push(
      tx.execute(sql`
        DELETE FROM contacts WHERE id = ${loserId}::uuid AND user_id = ${userId}
      `)
    );
    statements.push(
      tx.execute(sql`
        UPDATE contact_merges SET status = 'done' WHERE id = ${mergeId}::uuid
      `)
    );

    return statements;
  });

  if (!options.deferInvalidation) await invalidateAfterMerge(userId, winnerId);

  return { mergeId, winnerId, loserId };
}

/**
 * Recompute what the merge invalidated.
 *
 * Deliberately outside the transaction: these are best-effort recomputes, and a provider
 * outage must not roll back a merge that has already landed correctly.
 */
export async function invalidateAfterMerge(userId: string, winnerId: string) {
  await scheduleEmbeddingRebuild(userId, winnerId);
  await markCohortDirty(userId);
  // Without the rescore the winner reads as never-scored, which triggers a full-network
  // recalibration on the user's next page view rather than a one-contact update.
  await rescoreContact(userId, winnerId);
}

/**
 * Follow a merged contact id to the contact that survives.
 *
 * Cheap and safe to call with any id: an id that was never merged returns itself.
 * `winner_contact_id` is path-compressed on every merge, so this is one lookup rather than
 * a walk.
 */
export async function resolveContactId(userId: string, contactId: string): Promise<string> {
  const db = await getDb();
  const [row] = await db
    .select({ winnerContactId: contactMerges.winnerContactId })
    .from(contactMerges)
    .where(
      and(eq(contactMerges.userId, userId), eq(contactMerges.loserContactId, contactId))
    )
    .limit(1);
  return row?.winnerContactId ?? contactId;
}

/**
 * Undo a merge.
 *
 * Best-effort by design. The winner has been live since the merge, so a repointed row may
 * have been edited or deleted in the meantime; every restore is guarded on the row still
 * being where the archive said it was, and a row that moved on is simply left alone rather
 * than resurrected in the wrong place.
 *
 * Merges in a chain may be undone in any order — see the note on `stillMerged` below.
 */
export async function unmergeContacts(userId: string, mergeId: string): Promise<MergeResult> {
  const db = await getDb();
  const [merge] = await db
    .select()
    .from(contactMerges)
    .where(and(eq(contactMerges.userId, userId), eq(contactMerges.id, mergeId)))
    .limit(1);
  if (!merge) throw new Error(`unmergeContacts: merge ${mergeId} not found`);

  const [winner] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.userId, userId), eq(contacts.id, merge.winnerContactId)))
    .limit(1);
  if (!winner) {
    throw new Error("unmergeContacts: the surviving contact no longer exists");
  }

  // Undoing merges out of order is allowed, and works, because of path compression: this
  // row's `winner_contact_id` is rewritten forward on every subsequent merge, so it always
  // names the contact that is alive right now and holds this merge's rows. Undoing A -> B
  // after B -> C pulls A's own recorded children back out of C, which is exactly right.
  //
  // The check below is therefore not about ordering. It catches the one genuinely broken
  // case: the surviving contact has been hard-deleted (`deleteContact`), so the rows this
  // merge recorded went with it and there is nothing left to give back.
  const [stillMerged] = await db
    .select({ id: contactMerges.id })
    .from(contactMerges)
    .where(
      and(eq(contactMerges.userId, userId), eq(contactMerges.loserContactId, merge.winnerContactId))
    )
    .limit(1);
  if (stillMerged) {
    throw new Error(
      "unmergeContacts: the surviving contact is itself merged away; undo that merge first"
    );
  }

  const repointed = (merge.repointed ?? {}) as Record<string, string[]>;
  const deleted = (merge.deleted ?? {}) as Record<string, unknown[]>;
  const loserId = merge.loserContactId;
  const winnerId = merge.winnerContactId;

  // The columns the snapshot may actually be inserted into.
  //
  // `sort_key`, `linkedin_slug` and `search_tsv` are GENERATED ALWAYS ... STORED. They are
  // present in the snapshot, because it was taken with `to_jsonb(c)` over the whole row, but
  // Postgres rejects any INSERT that names them — so the restore needs an explicit column
  // list, and `INSERT INTO contacts SELECT *` cannot work. Asking the catalogue rather than
  // hardcoding the three means a generated column added later does not break unmerge.
  //
  // Read outside the batch: pre-built statements cannot consume a result mid-flight.
  const catalogue = await db.execute(sql`
    SELECT column_name FROM information_schema.columns
     WHERE table_name = 'contacts' AND table_schema = current_schema()
       AND is_generated = 'NEVER'
     ORDER BY ordinal_position
  `);
  const catalogueRows = (Array.isArray(catalogue) ? catalogue : catalogue.rows) as {
    column_name: string;
  }[];
  const snapshot = merge.loserSnapshot as Record<string, unknown>;
  const restoreColumns = catalogueRows
    .map((r) => r.column_name)
    .filter((name) => Object.hasOwn(snapshot, name));
  if (!restoreColumns.includes("id")) {
    throw new Error("unmergeContacts: snapshot is missing the contact id");
  }
  // Only the insertable keys reach jsonb_populate_record. Passing the generated ones
  // through would make it cast `search_tsv`'s rendered text back to tsvector.
  const restorePayload = Object.fromEntries(
    restoreColumns.map((name) => [name, snapshot[name] ?? null])
  );

  await runAtomicWrite(db, (tx) => {
    const statements: AtomicStatement[] = [];

    // 1. Bring the contact row back, with its original id so every id held elsewhere
    //    (note-batch results, chat recommendations) becomes valid again.
    //
    //    `restoreColumns` (above) is why this names its columns explicitly.
    const columnList = sql.join(
      restoreColumns.map((name) => sql.raw(`"${name}"`)),
      sql`, `
    );
    statements.push(
      tx.execute(sql`
        INSERT INTO contacts (${columnList})
        SELECT ${columnList}
          FROM jsonb_populate_record(NULL::contacts, ${JSON.stringify(restorePayload)}::jsonb)
        ON CONFLICT (id) DO NOTHING
      `)
    );

    // 2. Move the recorded rows back, each guarded on still belonging to the winner.
    for (const { table, column } of REPOINTED_TABLES) {
      const label = table === "note_batches" ? "note_batches.seed_contact_id" : table;
      const ids = repointed[label];
      if (!ids?.length) continue;
      statements.push(
        tx.execute(sql`
          UPDATE ${sql.raw(table)} SET ${sql.raw(column)} = ${loserId}::uuid
           WHERE id = ANY(${sql`ARRAY[${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}]`})
             AND ${sql.raw(column)} = ${winnerId}::uuid
        `)
      );
    }
    for (const table of [
      "contact_tags",
      "interaction_mentions",
      "contact_profiles",
      "contact_embeddings",
    ]) {
      const ids = repointed[table];
      if (!ids?.length) continue;
      statements.push(
        tx.execute(sql`
          UPDATE ${sql.raw(table)} SET contact_id = ${loserId}::uuid
           WHERE id = ANY(${sql`ARRAY[${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}]`})
             AND contact_id = ${winnerId}::uuid
        `)
      );
    }

    // 3. Restore rows that were deleted rather than moved. ON CONFLICT DO NOTHING because
    //    the winner may legitimately have recreated an equivalent row since.
    for (const [table, rows] of Object.entries(deleted)) {
      if (!rows?.length) continue;
      statements.push(
        tx.execute(sql`
          INSERT INTO ${sql.raw(table)}
          SELECT * FROM jsonb_populate_recordset(
            NULL::${sql.raw(table)},
            ${JSON.stringify(rows)}::jsonb)
          ON CONFLICT DO NOTHING
        `)
      );
    }

    // 4. Undo the path compression this merge applied, so an older archive row in the chain
    //    points back at the contact that has just come back.
    const compressedIds = repointed.contact_merges ?? [];
    if (compressedIds.length) {
      statements.push(
        tx.execute(sql`
          UPDATE contact_merges
             SET winner_contact_id = ${loserId}::uuid
           WHERE user_id = ${userId}
             AND id = ANY(${sql`ARRAY[${sql.join(
               compressedIds.map((id) => sql`${id}::uuid`),
               sql`, `
             )}]`})
             AND winner_contact_id = ${winnerId}::uuid
        `)
      );
    }

    // 5. The archive row goes last: while it exists, `resolveContactId` still redirects the
    //    restored id at the winner.
    statements.push(
      tx.execute(sql`DELETE FROM contact_merges WHERE id = ${mergeId}::uuid AND user_id = ${userId}`)
    );

    return statements;
  });

  // Both contacts changed; both need rescoring.
  await invalidateAfterMerge(userId, winnerId);
  await scheduleEmbeddingRebuild(userId, loserId);
  await rescoreContact(userId, loserId);

  return { mergeId, winnerId, loserId };
}

/**
 * Record a pair the app was not confident enough to merge on its own, for a human to decide.
 * Idempotent per pair.
 */
export async function recordDuplicateSuggestion(
  userId: string,
  contactIdA: string,
  contactIdB: string,
  reason: string,
  confidence: number
) {
  if (contactIdA === contactIdB) return;
  // Canonical ordering so "A and B" and "B and A" are the same row, not two.
  const [a, b] = contactIdA < contactIdB ? [contactIdA, contactIdB] : [contactIdB, contactIdA];
  const db = await getDb();
  await db
    .insert(duplicateSuggestions)
    .values({ userId, contactAId: a, contactBId: b, reason, confidence })
    // A pair already dismissed must stay dismissed — re-proposing it on every import is
    // exactly what makes a review queue useless.
    .onConflictDoNothing({
      target: [
        duplicateSuggestions.userId,
        duplicateSuggestions.contactAId,
        duplicateSuggestions.contactBId,
      ],
    });
}

/**
 * Reject a pair, permanently.
 *
 * Keyed on the two contacts, not on a suggestion id, because a pair found by scanning for a
 * shared name (`findNameCollisions`) has no stored row until this writes one. Without that,
 * a duplicate predating this feature could be seen on the review page but never dismissed,
 * and would be proposed again on every visit.
 */
export async function dismissDuplicatePair(
  userId: string,
  contactIdA: string,
  contactIdB: string
) {
  if (contactIdA === contactIdB) return;
  // Same canonical ordering as `recordDuplicateSuggestion`, so this writes the row a write
  // path would otherwise later try to create — and the conflict target matches.
  const [a, b] = contactIdA < contactIdB ? [contactIdA, contactIdB] : [contactIdB, contactIdA];
  const db = await getDb();
  const now = new Date();
  await db
    .insert(duplicateSuggestions)
    .values({
      userId,
      contactAId: a,
      contactBId: b,
      reason: "Dismissed by hand",
      confidence: 0,
      status: "dismissed",
      resolvedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        duplicateSuggestions.userId,
        duplicateSuggestions.contactAId,
        duplicateSuggestions.contactBId,
      ],
      set: { status: "dismissed", resolvedAt: now },
    });
}
