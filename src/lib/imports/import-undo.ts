import { and, eq, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { imports, type ImportJobRowPayload, type ImportStats } from "@/db/schema";
import { deleteContactsForUser } from "@/lib/contact-delete";
import { getAdapter } from "@/lib/import-adapters";
import { fingerprintContact } from "@/lib/imports/import-provenance";
import {
  UNDO_WINDOW_DAYS,
  importUndoable,
  withinUndoWindow,
} from "@/lib/imports/import-finish";

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
 * The trap that runs through all of it: an import's OWN writes must never read as a user
 * trace. Every contact-creating adapter tags the people it creates (`["linkedin"]`,
 * `["address-book"]`, …) and the address-book adapter writes `notes` from the source file, so
 * a naive "has a tag / has notes" test says every imported person has been touched and undo
 * removes nobody. `ownWrites` below resolves what the import itself wrote, per row, by asking
 * the adapter, and only what is left over counts.
 *
 * Rows staged before the provenance stamp existed carry no `importedBy`. They fall back to
 * "created at or after the import", the same rule the People list uses, and the preview
 * reports itself as not exact so the UI can say what it cannot vouch for.
 *
 * The window itself is defined in `import-finish.ts` and re-exported here: the history sheet
 * has to decide whether to offer an undo at all, and it is a client component, so it cannot
 * import this module (it reaches `@/db`). One 7, two names for it.
 */
export { UNDO_WINDOW_DAYS };

/**
 * How many candidates a preview will describe. The counts stay exact past it — this caps the
 * array that crosses the server-action boundary, not the decision. A 3,000-person import
 * needs to tell the user two numbers and name the exceptions, not ship 3,000 rows to a
 * confirmation dialog.
 */
export const MAX_UNDO_CANDIDATES = 200;

/**
 * Wall-clock ceiling on one `performUndo` invocation. Removals go out a chunk at a time, each
 * chunk its own atomic write (`deleteContactsForUser` touches seven tables), so a large import
 * cannot finish inside one server action. Stopping cleanly and reporting `done: false` is safe
 * because the operation is idempotent: the people already gone are simply no longer
 * candidates next time.
 */
const UNDO_BUDGET_MS = 20_000;

/**
 * People removed per atomic write. Three round trips per chunk instead of three per person;
 * small enough that one chunk is well inside the budget, which is checked between chunks.
 */
const UNDO_CHUNK = 100;

export type UndoCandidate = {
  contactId: string;
  name: string;
  removable: boolean;
  reason?: "tagged" | "noted" | "reminded" | "interacted" | "merged" | "edited";
};

export type UndoPreview = {
  importId: string;
  /** True only while an undo is still allowed: inside the window AND not already undone. */
  withinWindow: boolean;
  /** Distinct from an expired window, so history can say "Undone" rather than "too late". */
  alreadyUndone: boolean;
  /** False when any candidate came from the fallback rule rather than a stamped row. */
  exact: boolean;
  /** At most `MAX_UNDO_CANDIDATES`, kept-with-a-reason first. `removable`/`keeping` are exact. */
  candidates: UndoCandidate[];
  removable: number;
  keeping: number;
};

export type UndoResult = {
  removed: number;
  kept: number;
  /** False when the time budget ran out; call again to continue. */
  done: boolean;
  /** Removable people still standing when this invocation stopped. */
  remaining: number;
};

type CandidateRow = {
  contact_id: string;
  full_name: string;
  company: string | null;
  title: string | null;
  email: string | null;
  linkedin_url: string | null;
  location: string | null;
  school: string | null;
  phone: string | null;
  website: string | null;
  x_handle: string | null;
  notes: string | null;
  payload: ImportJobRowPayload | null;
  fp: string | null;
  stamped: boolean;
  tag_names: string[];
  reminder_count: number;
  interaction_count: number;
  merge_count: number;
};

const withinWindow = withinUndoWindow;

/**
 * What the import itself wrote to this contact, so those writes are not mistaken for the
 * user's own.
 *
 * Resolved per row, from the row's own payload, rather than from a static list per import
 * type: the adapter's `toCreate` is the single source of truth for what it tagged and noted,
 * it cannot drift from a copy kept elsewhere, and payload-dependent tags stay correct. It is
 * also the only form that works for rows staged before any provenance stamp existed — they
 * still carry their payload, which is all this needs.
 *
 * `toCreate` is pure by contract (see `ImportAdapter`), but it is fed a payload out of the
 * database, so a malformed one is caught: claiming the import wrote nothing keeps the person.
 */
function ownWrites(importType: string, payload: ImportJobRowPayload | null) {
  const empty = { tags: new Set<string>(), notes: "" };
  const adapter = getAdapter(importType);
  if (!adapter || !payload) return empty;
  try {
    const input = adapter.toCreate(payload);
    return {
      tags: new Set((input.tagNames ?? []).map((name) => name.trim().toLowerCase())),
      notes: (input.notes ?? "").trim(),
    };
  } catch {
    return empty;
  }
}

/**
 * One statement for the whole decision: who this import created, and what has happened to them
 * since. The counts are correlated subqueries rather than joins so a person with three tags is
 * still one row.
 *
 * `runEndedAt` separates the interactions this import wrote from the ones that arrived after
 * it. `interactions` carries no import id, so two signals are used together. Every interaction
 * the engine writes through an adapter carries an `external_id` — that partial unique index is
 * how a retried chunk dedupes, and both producers set it — and every one of them lands before
 * the engine's final write to the `imports` row. So an interaction counts as a user-side touch
 * when it has no `external_id`, or when it was created after this import had finished writing.
 *
 * (The engine's bulk insert does have a `noExternalId` branch for adapter rows that omit one,
 * so "no external id" is a property of today's adapters rather than a guarantee of the engine.
 * An adapter that started omitting it would make its own rows read as touches — which keeps
 * people rather than removing them, so the failure is in the safe direction.)
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
      SELECT c.id AS contact_id, c.full_name, c.company, c.title, c.email, c.linkedin_url,
             c.location, c.school, c.phone, c.website, c.x_handle, c.notes,
             r.payload AS payload,
             r.payload->'importedBy'->>'fp' AS fp,
             jsonb_exists(r.payload, 'importedBy') AS stamped,
             (SELECT coalesce(jsonb_agg(t.name), '[]'::jsonb)
                FROM contact_tags ct
                JOIN tags t ON t.id = ct.tag_id AND t.user_id = ${userId}
               WHERE ct.contact_id = c.id) AS tag_names,
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
        AND (
          (r.payload->'importedBy'->>'created') = 'true'
          OR (NOT jsonb_exists(r.payload, 'importedBy') AND c.created_at >= ${createdAtIso}::timestamptz)
        )
    `),
  );
}

function decide(row: CandidateRow, importType: string): UndoCandidate {
  const base = { contactId: row.contact_id, name: row.full_name };
  const own = ownWrites(importType, row.payload);

  const userTags = (row.tag_names ?? []).filter(
    (name) => !own.tags.has(name.trim().toLowerCase()),
  );
  if (userTags.length > 0) return { ...base, removable: false, reason: "tagged" };

  // Not "has notes" but "has notes the import did not write" — and an edit to the import's
  // own note still counts, because the text no longer matches what was written.
  const notes = (row.notes ?? "").trim();
  if (notes && notes !== own.notes) return { ...base, removable: false, reason: "noted" };

  if (row.reminder_count > 0) return { ...base, removable: false, reason: "reminded" };
  if (row.interaction_count > 0) return { ...base, removable: false, reason: "interacted" };
  if (row.merge_count > 0) return { ...base, removable: false, reason: "merged" };
  if (row.fp) {
    // Every field `FingerprintInput` names, read back from the row. One left out here hashes
    // as empty against a stamp that held a value, so everyone carrying it reads "edited" and
    // undo removes nobody — `smoke-import-undo.ts` seeds a person with all of them to catch it.
    const current = fingerprintContact({
      fullName: row.full_name,
      company: row.company,
      title: row.title,
      email: row.email,
      linkedinUrl: row.linkedin_url,
      location: row.location,
      school: row.school,
      phone: row.phone,
      website: row.website,
      xHandle: row.x_handle,
    });
    if (current !== row.fp) return { ...base, removable: false, reason: "edited" };
  }
  return { ...base, removable: true };
}

type Assessment = {
  stats: ImportStats;
  withinWindow: boolean;
  alreadyUndone: boolean;
  exact: boolean;
  /** The FULL list. `previewUndo` caps what it returns; `performUndo` needs all of it. */
  candidates: UndoCandidate[];
};

async function assess(
  userId: string,
  importId: string,
  now: Date,
): Promise<Assessment | null> {
  const db = await getDb();
  const imp = await db.query.imports.findFirst({
    where: and(eq(imports.id, importId), eq(imports.userId, userId)),
    columns: { id: true, importType: true, createdAt: true, updatedAt: true, stats: true },
  });
  if (!imp) return null;
  // Neither card offers undo for these, and this is what makes that more than a hidden button:
  // their rows carry no provenance, so the candidates below would be the wrong people.
  if (!importUndoable(imp.importType)) return null;

  const stats = imp.stats ?? {};
  // The frozen end of the run, written by the engine when it marked the import completed or
  // failed. `updated_at` is only the fallback for imports from before that field existed: an
  // admin retry moves it, and a boundary that moves forward starts ignoring interactions that
  // arrived after the import, which is the direction that deletes people.
  const frozen = stats.runEndedAt ? new Date(stats.runEndedAt) : null;
  const runEndedAt =
    frozen && !Number.isNaN(frozen.getTime())
      ? frozen
      : imp.updatedAt > imp.createdAt
        ? imp.updatedAt
        : imp.createdAt;

  const rows = await candidateRows(userId, importId, imp.createdAt, runEndedAt);
  const alreadyUndone = Boolean(stats.undoneAt);
  return {
    stats,
    withinWindow: withinWindow(imp.createdAt, now) && !alreadyUndone,
    alreadyUndone,
    exact: rows.every((r) => r.stamped),
    candidates: rows.map((row) => decide(row, imp.importType)),
  };
}

export async function previewUndo(
  userId: string,
  importId: string,
  now: Date = new Date(),
): Promise<UndoPreview | null> {
  const found = await assess(userId, importId, now);
  if (!found) return null;

  const kept = found.candidates.filter((c) => !c.removable);
  const removable = found.candidates.filter((c) => c.removable);
  return {
    importId,
    withinWindow: found.withinWindow,
    alreadyUndone: found.alreadyUndone,
    exact: found.exact,
    // Kept first: those are the ones the confirmation has to explain, and they are the ones
    // that must survive the cap.
    candidates: [...kept, ...removable].slice(0, MAX_UNDO_CANDIDATES),
    removable: removable.length,
    keeping: kept.length,
  };
}

export async function performUndo(
  userId: string,
  importId: string,
  now: Date = new Date(),
  options: { budgetMs?: number } = {},
): Promise<UndoResult> {
  const found = await assess(userId, importId, now);
  const keeping = found?.candidates.filter((c) => !c.removable).length ?? 0;
  if (!found || !found.withinWindow) {
    return { removed: 0, kept: keeping, done: true, remaining: 0 };
  }

  const targets = found.candidates.filter((c) => c.removable);
  // Real elapsed time, never the injected `now` — that clock is for the undo window.
  const budgetMs = options.budgetMs ?? UNDO_BUDGET_MS;
  const startedAt = Date.now();
  let removed = 0;
  let index = 0;
  // `index` only advances past a chunk once its write has landed, so `remaining` and a
  // resumed run see exactly the people still standing.
  while (index < targets.length) {
    if (Date.now() - startedAt >= budgetMs) break;
    const chunk = targets.slice(index, index + UNDO_CHUNK);
    const { deletedIds } = await deleteContactsForUser(
      userId,
      chunk.map((t) => t.contactId),
    );
    removed += deletedIds.length;
    index += chunk.length;
  }
  const done = index >= targets.length;

  const db = await getDb();
  await db
    .update(imports)
    .set({
      // `stats` only, and no `updated_at`: for an import from before `runEndedAt` was frozen
      // that column is still this rule's boundary (see `assess`), so bumping it here would
      // move it. `undoneAt` is the record of the undo, and it is what stops a second one —
      // so it is written only once the run actually finished, leaving a budget-exhausted
      // run resumable. The removed count accumulates across those resumptions.
      stats: sql`coalesce(${imports.stats}, '{}'::jsonb) || ${JSON.stringify({
        ...(done ? { undoneAt: now.toISOString() } : {}),
        undoneRemoved: (found.stats.undoneRemoved ?? 0) + removed,
        undoneKept: keeping,
      })}::jsonb`,
    })
    .where(and(eq(imports.id, importId), eq(imports.userId, userId)));

  return { removed, kept: keeping, done, remaining: targets.length - index };
}
