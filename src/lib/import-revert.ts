/**
 * Undoing an import.
 *
 * An import is the single largest write this app makes on a user's behalf — hundreds of
 * contacts, their interactions, their reminders — from a file the person has usually never
 * read. Getting it wrong was, until now, permanent: there was no way back short of deleting
 * people one at a time and guessing which of them had been there before.
 *
 * ## Why this needed a schema change to be possible at all
 *
 * `import_job_rows` already recorded WHICH contact each row produced. It did not record
 * whether the import CREATED that person or MERGED into someone who was already in the
 * network — both outcomes end as `status: 'done'` with a contact id. A revert built on that
 * alone would have to guess, and the wrong guess deletes a contact that predates the import
 * entirely, taking their whole history with them. That is a worse outcome than the import
 * it was undoing. Schema v34 adds `outcome` and `revert_snapshot`, and `interactions`/
 * `reminders` gained `import_id` so the rows an import inserted can be told from the ones a
 * person wrote by hand.
 *
 * None of the three can be backfilled — nothing recorded create-vs-merge, and the
 * overwritten column values are gone — so imports that finished before v34 are not
 * revertible. `listImports` marks them so, and the UI does not offer a button that would half
 * work.
 *
 * ## What a revert deliberately does NOT do
 *
 * It never overwrites work done after the import. A contact the import created but the user
 * has since edited is kept, not deleted. A contact the import merged into that has been
 * edited since is left exactly as it is, not rolled back. Both are detected by comparing the
 * contact's current `updated_at` against the stamp the import wrote (see
 * `ImportRevertSnapshot.mergedAt`), and both are counted in `ImportRevertStats` so the
 * result can say what it left behind rather than implying the undo was total.
 *
 * That is not a limitation to be engineered away later. An undo whose own side effect is
 * destroying something the user typed afterwards belongs to exactly the defect class the
 * undo exists to serve.
 *
 * ## What it cannot restore
 *
 * Company rows the import's resolver created are left in place (they are shared, unowned by
 * any one contact, and harmless). Embeddings for deleted contacts go with them via the
 * cascade; embeddings for a rolled-back merge are marked stale and rebuilt. Duplicate
 * suggestions and contact identities cascade with the contacts they name.
 */
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  contacts,
  imports,
  importJobRows,
  interactions,
  reminders,
  type ImportRevertSnapshot,
  type ImportRevertStats,
} from "@/db/schema";
import { markCohortDirty } from "@/lib/closeness-materialize";
import {
  REVERT_REFUSAL_MESSAGE,
  describeRevert,
  hasRevertibleStatus,
  type RevertRefusal,
} from "@/lib/import-revert-policy";

// Re-exported so server callers have one import for the whole feature; the definitions live
// in the pure module because the import-history row is a client component.
export { REVERT_REFUSAL_MESSAGE, describeRevert, hasRevertibleStatus };
export type { RevertRefusal };

export type RevertResult =
  | { ok: true; stats: ImportRevertStats }
  | { ok: false; reason: RevertRefusal };

/**
 * The columns `bulkMergeContactsForUser` writes, restored from a snapshot.
 *
 * `embedding_stale_at` is set rather than restored: the contact's text has just changed
 * back, so its embedding is wrong either way and the backfill should redo it. `updated_at`
 * is moved to now for the same reason it is on any other write — the row did just change.
 */
function restoreStatement(contactId: string, userId: string, snap: ImportRevertSnapshot) {
  const ts = (value: string | null) => (value ? new Date(value) : null);
  return sql`
    UPDATE contacts
    SET company              = ${snap.company},
        company_id           = ${snap.companyId}::uuid,
        title                = ${snap.title},
        email                = ${snap.email},
        phone                = ${snap.phone},
        linkedin_url         = ${snap.linkedinUrl},
        first_name           = ${snap.firstName},
        last_name            = ${snap.lastName},
        profile_image_url    = ${snap.profileImageUrl},
        source               = ${snap.source},
        how_met              = ${snap.howMet},
        met_context          = ${snap.metContext},
        date_met             = ${ts(snap.dateMet)},
        first_interaction_at = ${ts(snap.firstInteractionAt)},
        last_interaction_at  = ${ts(snap.lastInteractionAt)},
        embedding_stale_at   = now(),
        updated_at           = now()
    WHERE id = ${contactId}::uuid AND user_id = ${userId}
  `;
}

/** Two timestamps are the same write if they agree to the millisecond. */
function sameInstant(a: Date | null | undefined, b: string | null | undefined) {
  if (!a || !b) return false;
  const other = new Date(b);
  return !Number.isNaN(other.getTime()) && a.getTime() === other.getTime();
}

export async function revertImport(
  userId: string,
  importId: string
): Promise<RevertResult> {
  const db = await getDb();

  const importRow = await db.query.imports.findFirst({
    where: and(eq(imports.id, importId), eq(imports.userId, userId)),
  });
  if (!importRow) return { ok: false, reason: "not_found" };
  if (importRow.revertedAt) return { ok: false, reason: "already_reverted" };
  if (!hasRevertibleStatus(importRow)) return { ok: false, reason: "still_running" };

  // Only rows that actually produced a contact. `pending`/`skipped`/`failed` rows wrote
  // nothing, so there is nothing of theirs to undo.
  const rows = await db.query.importJobRows.findMany({
    where: and(
      eq(importJobRows.importId, importId),
      eq(importJobRows.userId, userId),
      isNotNull(importJobRows.contactId)
    ),
    columns: {
      rowIndex: true,
      contactId: true,
      outcome: true,
      revertSnapshot: true,
    },
    orderBy: (r, { asc }) => [asc(r.rowIndex)],
  });

  const createdIds = new Set<string>();
  /**
   * The EARLIEST snapshot per contact, which is the only one that describes the state
   * before this import touched them at all.
   *
   * Two rows of one import can merge into the same person — two LinkedIn message threads
   * for one contact, two attendees of one meeting resolving to the same row. The second
   * row's snapshot was taken after the first row's merge had already landed, so restoring
   * it would restore the import's own output. Rows arrive in `rowIndex` order and chunks
   * are processed in that order, so the first snapshot seen for a contact is the pre-import
   * one.
   */
  const mergeSnapshots = new Map<string, ImportRevertSnapshot>();
  let rowsUnknown = 0;

  for (const row of rows) {
    const contactId = row.contactId;
    if (!contactId) continue;
    if (row.outcome === "created") {
      createdIds.add(contactId);
    } else if (row.outcome === "merged") {
      // A merged row with no snapshot is not "nothing to restore" — it is a row whose prior
      // state was never captured, and silently skipping it would leave the import's
      // overwrite in place while reporting the merge as undone.
      if (!row.revertSnapshot) rowsUnknown++;
      else if (!mergeSnapshots.has(contactId)) mergeSnapshots.set(contactId, row.revertSnapshot);
    } else {
      // Written before schema v34: contact id known, create-vs-merge unknown. Counted and
      // left alone; deleting on a guess is the harm this whole module exists to avoid.
      rowsUnknown++;
    }
  }

  // A contact this import created and LATER merged into (a second row folding more data
  // into the person the first row made) belongs to the create side: deleting them removes
  // the merge too, and restoring a snapshot of a row that is about to be deleted is
  // pointless. Resolved here rather than in the loop so row order cannot matter.
  for (const id of createdIds) mergeSnapshots.delete(id);

  const stats: ImportRevertStats = {
    contactsDeleted: 0,
    contactsKept: 0,
    mergesReverted: 0,
    mergesKept: 0,
    interactionsDeleted: 0,
    remindersDeleted: 0,
    rowsUnknown,
  };

  // ---------------------------------------------------------------- created contacts
  //
  // Deleted only if untouched since the import wrote them. `created_at === updated_at` is
  // the test: every write path in the app stamps `updated_at`, and nothing in the import's
  // own tail (embedding backfill, closeness recalibration, outreach suggestions) does —
  // verified, and load-bearing, because if any of them did then no imported contact would
  // ever look untouched and this branch would never delete anything.
  if (createdIds.size > 0) {
    const candidates = await db.query.contacts.findMany({
      where: and(eq(contacts.userId, userId), inArray(contacts.id, [...createdIds])),
      columns: { id: true, createdAt: true, updatedAt: true },
    });

    const deletable = candidates
      .filter((c) => c.createdAt.getTime() === c.updatedAt.getTime())
      .map((c) => c.id);

    stats.contactsKept = candidates.length - deletable.length;

    if (deletable.length > 0) {
      // Interactions, reminders, embeddings, identities, tags and duplicate suggestions all
      // cascade or null out from the contact — see the REFERENCES clauses in the bootstrap
      // DDL — so this one delete is the whole removal.
      const deleted = await db
        .delete(contacts)
        .where(and(eq(contacts.userId, userId), inArray(contacts.id, deletable)))
        // Bare `.returning()`, not a field selector: this project's Drizzle version types
        // `delete().returning()` as zero-argument. The rows are only counted.
        .returning();
      stats.contactsDeleted = deleted.length;
    }
  }

  // ----------------------------------------------------------------- merged contacts
  if (mergeSnapshots.size > 0) {
    const ids = [...mergeSnapshots.keys()];
    const current = await db.query.contacts.findMany({
      where: and(eq(contacts.userId, userId), inArray(contacts.id, ids)),
      columns: { id: true, updatedAt: true },
    });
    const updatedAtById = new Map(current.map((c) => [c.id, c.updatedAt]));

    for (const [contactId, snap] of mergeSnapshots) {
      const seen = updatedAtById.get(contactId);
      // Gone already (deleted by hand, or merged away) — nothing to restore, and nothing
      // lost by saying so.
      if (!seen) {
        stats.mergesKept = (stats.mergesKept ?? 0) + 1;
        continue;
      }
      if (!sameInstant(seen, snap.mergedAt)) {
        // Edited since the import. Restoring would throw that edit away.
        stats.mergesKept = (stats.mergesKept ?? 0) + 1;
        continue;
      }
      await db.execute(restoreStatement(contactId, userId, snap));
      stats.mergesReverted = (stats.mergesReverted ?? 0) + 1;
    }
  }

  // -------------------------------------------------------- interactions and reminders
  //
  // Keyed on `import_id`, which is written only on INSERT — a row that already existed and
  // was merely refreshed by this import kept whatever provenance it had, so a hand-written
  // note a re-import happened to touch is not deleted here.
  //
  // Runs after the contact deletes, so rows that cascaded away are already gone and are not
  // counted twice.
  const deletedInteractions = await db
    .delete(interactions)
    .where(and(eq(interactions.userId, userId), eq(interactions.importId, importId)))
    .returning();
  stats.interactionsDeleted = deletedInteractions.length;

  const deletedReminders = await db
    .delete(reminders)
    .where(and(eq(reminders.userId, userId), eq(reminders.importId, importId)))
    .returning();
  stats.remindersDeleted = deletedReminders.length;

  await db
    .update(imports)
    .set({ revertedAt: new Date(), revertStats: stats, updatedAt: new Date() })
    .where(and(eq(imports.id, importId), eq(imports.userId, userId)));

  // Scores are cohort-relative, so removing a few hundred people changes everyone else's.
  await markCohortDirty(userId).catch(() => null);

  return { ok: true, stats };
}
