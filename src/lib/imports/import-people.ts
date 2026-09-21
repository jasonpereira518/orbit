import { and, eq, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { imports } from "@/db/schema";

/** Whether an import brought a person into Orbit or matched someone already here. */
export type ImportPersonOutcome = "added" | "existing";

export type ImportedPerson = {
  id: string;
  name: string;
  /** "Title at Company", or whichever half exists. */
  detail: string | null;
};

export type ImportPeoplePage = { people: ImportedPerson[]; hasMore: boolean };

/** People listed per page in the import detail sheet. */
export const IMPORT_PEOPLE_PAGE = 50;

/*
 * Added vs already here.
 *
 * The engine knows which rows it created and which it merged, but keeps only the contact id
 * (`import_job_rows.contact_id`), not which way it went. It doesn't need to: a contact made
 * by this import can't predate it, so `contacts.created_at >= imports.created_at` is exact
 * enough — and it works for every import already in the table with no backfill. The only
 * miss is someone created elsewhere mid-import and then matched by it, which reads "added".
 *
 * Distinct per contact: a messages or calendar import stages one row per thread or meeting,
 * so one person can sit behind many rows. People deleted since are simply not listed —
 * `contact_id` has no foreign key, and the lookup starts from `contacts`.
 *
 * Raw SQL with explicit aliases: both tables have `created_at`, and a column interpolated
 * into a drizzle `sql` projection loses its table prefix.
 */
function importContactIds(userId: string, importId: string) {
  return sql`
    SELECT r.contact_id FROM import_job_rows r
    WHERE r.import_id = ${importId}
      AND r.user_id = ${userId}
      AND r.status = 'done'
      AND r.contact_id IS NOT NULL
  `;
}

export async function countImportPeople(
  userId: string,
  importId: string,
  importCreatedAt: Date,
): Promise<{ added: number; existing: number }> {
  const db = await getDb();
  const [row] = rowsOf<{ added: number; existing: number }>(
    await db.execute(sql`
      SELECT
        count(*) FILTER (WHERE c.created_at >= ${importCreatedAt})::int AS added,
        count(*) FILTER (WHERE c.created_at < ${importCreatedAt})::int AS existing
      FROM contacts c
      WHERE c.user_id = ${userId}
        AND c.id IN (${importContactIds(userId, importId)})
    `),
  );
  return { added: row?.added ?? 0, existing: row?.existing ?? 0 };
}

/** One page of the people an import added, or matched to someone already here, by name. */
export async function listImportPeople(
  userId: string,
  importId: string,
  outcome: ImportPersonOutcome,
  offset = 0,
): Promise<ImportPeoplePage> {
  const db = await getDb();
  const imp = await db.query.imports.findFirst({
    where: and(eq(imports.id, importId), eq(imports.userId, userId)),
    columns: { createdAt: true },
  });
  if (!imp) return { people: [], hasMore: false };

  const start = Math.max(0, Math.floor(offset) || 0);
  const createdFilter =
    outcome === "added"
      ? sql`c.created_at >= ${imp.createdAt}`
      : sql`c.created_at < ${imp.createdAt}`;

  // One past the page, so "Show more" is only offered when there is more.
  const rows = rowsOf<{
    id: string;
    full_name: string;
    title: string | null;
    company: string | null;
  }>(
    await db.execute(sql`
      SELECT c.id, c.full_name, c.title, c.company
      FROM contacts c
      WHERE c.user_id = ${userId}
        AND ${createdFilter}
        AND c.id IN (${importContactIds(userId, importId)})
      ORDER BY lower(c.full_name), c.id
      LIMIT ${IMPORT_PEOPLE_PAGE + 1} OFFSET ${start}
    `),
  );

  return {
    people: rows.slice(0, IMPORT_PEOPLE_PAGE).map((r) => ({
      id: r.id,
      name: r.full_name,
      detail:
        r.title && r.company
          ? `${r.title} at ${r.company}`
          : r.title || r.company || null,
    })),
    hasMore: rows.length > IMPORT_PEOPLE_PAGE,
  };
}
