import { and, eq, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { imports } from "@/db/schema";
import { deleteContactForUser } from "@/lib/contact-delete";
import { fingerprintContact } from "@/lib/imports/import-provenance";

/**
 * Undoing an import.
 *
 * Only people the import CREATED can go, and only while nobody has touched them. "Touched" is
 * deliberately not `contacts.updated_at`: the avatar backfill and the brief writer bump that
 * column minutes after an import, so it reads "touched" for nearly every imported person, and
 * Orbit keeps no per-contact edit trail to consult instead. So the test is a user-authored
 * trace — a tag, a note, a reminder, an interaction, a later merge — plus the fingerprint the
 * import stamped on the row (`import-provenance.ts`).
 *
 * Rows staged before that stamp existed carry no provenance. They fall back to "created at or
 * after the import", the same rule the People list uses, and the preview reports itself as not
 * exact so the UI can say what it cannot vouch for.
 */
export const UNDO_WINDOW_DAYS = 7;

export type UndoCandidate = {
  contactId: string;
  name: string;
  removable: boolean;
  reason?: "tagged" | "noted" | "reminded" | "interacted" | "merged" | "edited";
};

export type UndoPreview = {
  importId: string;
  withinWindow: boolean;
  /** False when any candidate came from the fallback rule rather than a stamped row. */
  exact: boolean;
  candidates: UndoCandidate[];
  removable: number;
  keeping: number;
};

type CandidateRow = {
  contact_id: string;
  full_name: string;
  company: string | null;
  title: string | null;
  email: string | null;
  linkedin_url: string | null;
  notes: string | null;
  fp: string | null;
  stamped: boolean;
  tag_count: number;
  reminder_count: number;
  interaction_count: number;
  merge_count: number;
};

function withinWindow(createdAt: Date, now: Date): boolean {
  return now.getTime() - createdAt.getTime() <= UNDO_WINDOW_DAYS * 86_400_000;
}

/**
 * One statement for the whole decision: who this import created, and what has happened to them
 * since. The counts are correlated subqueries rather than joins so a person with three tags is
 * still one row.
 *
 * `runEndedAt` separates the interactions this import wrote from the ones that arrived after
 * it. `interactions` carries no import id, so the two available signals are used together:
 * every interaction the engine writes carries an `external_id` (that partial unique index is
 * how a retried chunk dedupes — see the bulk insert in `import-engine.ts`), and every one of
 * them is inserted before the engine's own last write to the `imports` row. So an interaction
 * counts as a user-side touch when it has no `external_id` at all — nothing in the engine can
 * produce that — or when it was created after this import's run had already finished.
 *
 * Testing only `external_id IS NULL` would be the unsafe simplification: a calendar sync that
 * logged a meeting with an imported person weeks later carries an external id, and treating
 * that as "untouched" would delete the person and cascade the meeting away with them.
 */
async function candidateRows(
  userId: string,
  importId: string,
  importCreatedAt: Date,
  runEndedAt: Date,
) {
  const db = await getDb();
  const createdAtIso = importCreatedAt.toISOString();
  const runEndedIso = runEndedAt.toISOString();
  return rowsOf<CandidateRow>(
    await db.execute(sql`
      SELECT c.id AS contact_id, c.full_name, c.company, c.title, c.email, c.linkedin_url, c.notes,
             r.payload->'importedBy'->>'fp' AS fp,
             jsonb_exists(r.payload, 'importedBy') AS stamped,
             (SELECT count(*) FROM contact_tags ct WHERE ct.contact_id = c.id)::int AS tag_count,
             (SELECT count(*) FROM reminders rm WHERE rm.contact_id = c.id AND rm.user_id = ${userId})::int AS reminder_count,
             (SELECT count(*) FROM interactions i
                WHERE i.contact_id = c.id AND i.user_id = ${userId}
                  AND (i.external_id IS NULL OR i.created_at > ${runEndedIso}::timestamptz))::int AS interaction_count,
             (SELECT count(*) FROM contact_merges m
                WHERE m.user_id = ${userId} AND m.winner_contact_id = c.id)::int AS merge_count
      FROM import_job_rows r
      JOIN contacts c ON c.id = r.contact_id AND c.user_id = ${userId}
      WHERE r.import_id = ${importId}
        AND r.user_id = ${userId}
        AND r.status = 'done'
        AND r.contact_id IS NOT NULL
        AND (
          (r.payload->'importedBy'->>'created') = 'true'
          OR (NOT jsonb_exists(r.payload, 'importedBy') AND c.created_at >= ${createdAtIso}::timestamptz)
        )
    `),
  );
}

function decide(row: CandidateRow): UndoCandidate {
  const base = { contactId: row.contact_id, name: row.full_name };
  if (row.tag_count > 0) return { ...base, removable: false, reason: "tagged" };
  if ((row.notes ?? "").trim()) return { ...base, removable: false, reason: "noted" };
  if (row.reminder_count > 0) return { ...base, removable: false, reason: "reminded" };
  if (row.interaction_count > 0) return { ...base, removable: false, reason: "interacted" };
  if (row.merge_count > 0) return { ...base, removable: false, reason: "merged" };
  if (row.fp) {
    const current = fingerprintContact({
      fullName: row.full_name,
      company: row.company,
      title: row.title,
      email: row.email,
      linkedinUrl: row.linkedin_url,
    });
    if (current !== row.fp) return { ...base, removable: false, reason: "edited" };
  }
  return { ...base, removable: true };
}

export async function previewUndo(
  userId: string,
  importId: string,
  now: Date = new Date(),
): Promise<UndoPreview | null> {
  const db = await getDb();
  const imp = await db.query.imports.findFirst({
    where: and(eq(imports.id, importId), eq(imports.userId, userId)),
    columns: { id: true, createdAt: true, updatedAt: true, stats: true },
  });
  if (!imp) return null;

  // The engine writes the `imports` row last on every chunk and again on completion, so its
  // `updated_at` is at or after the final interaction this import inserted. `performUndo`
  // deliberately leaves it alone for exactly this reason.
  const runEndedAt = imp.updatedAt > imp.createdAt ? imp.updatedAt : imp.createdAt;
  const rows = await candidateRows(userId, importId, imp.createdAt, runEndedAt);
  const candidates = rows.map(decide);
  return {
    importId,
    withinWindow: withinWindow(imp.createdAt, now) && !imp.stats?.undoneAt,
    exact: rows.every((r) => r.stamped),
    candidates,
    removable: candidates.filter((c) => c.removable).length,
    keeping: candidates.filter((c) => !c.removable).length,
  };
}

export async function performUndo(
  userId: string,
  importId: string,
  now: Date = new Date(),
): Promise<{ removed: number; kept: number }> {
  const preview = await previewUndo(userId, importId, now);
  if (!preview || !preview.withinWindow) return { removed: 0, kept: preview?.keeping ?? 0 };

  let removed = 0;
  for (const candidate of preview.candidates) {
    if (!candidate.removable) continue;
    const { deleted } = await deleteContactForUser(userId, candidate.contactId);
    if (deleted) removed += 1;
  }

  const db = await getDb();
  await db
    .update(imports)
    .set({
      // `stats` only, and no `updated_at`: that column is this rule's marker for "when the
      // import's own writes stopped" (see `previewUndo`), so bumping it here would move the
      // boundary that tells this import's interactions from later ones. `undoneAt` is the
      // record of the undo, and it is what stops a second one.
      stats: sql`coalesce(${imports.stats}, '{}'::jsonb) || ${JSON.stringify({
        undoneAt: now.toISOString(),
        undoneRemoved: removed,
        undoneKept: preview.keeping,
      })}::jsonb`,
    })
    .where(and(eq(imports.id, importId), eq(imports.userId, userId)));

  return { removed, kept: preview.keeping };
}
