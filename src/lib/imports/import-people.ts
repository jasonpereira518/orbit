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
  /**
   * Browser-safe avatar URL, never the raw `profile_image_url` column — that can carry up
   * to 120 KB of base64 per contact (see `clientAvatarUrlSql` in `contact-avatar-sql.ts`).
   * Written by hand rather than by interpolating that helper: a drizzle column reference
   * loses its table qualifier once mixed into this file's aliased raw SQL (the same trap
   * `importContactIds`'s comment below describes for `created_at`).
   */
  profileImageUrl: string | null;
  /**
   * Whether `/api/avatars/{id}` has something to look a photo up from (a LinkedIn URL or an
   * email) when none is stored yet. The done card asks it on demand; without one it would only
   * ever answer 404.
   */
  canResolvePhoto: boolean;
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
 * A Drive doc names several people but its row holds one `contact_id`; the rest ride
 * `payload.contactIds`, which the second arm reads.
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
    UNION
    SELECT (jsonb_array_elements_text(r.payload->'contactIds'))::uuid
    FROM import_job_rows r
    WHERE r.import_id = ${importId}
      AND r.user_id = ${userId}
      AND r.status = 'done'
      AND jsonb_typeof(r.payload->'contactIds') = 'array'
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
    profile_image_url: string | null;
    can_resolve_photo: boolean;
  }>(
    await db.execute(sql`
      SELECT c.id, c.full_name, c.title, c.company,
             CASE
               WHEN c.profile_image_url IS NULL OR btrim(c.profile_image_url) = '' THEN NULL
               WHEN c.profile_image_url LIKE 'data:image/%' THEN '/api/avatars/' || c.id
               WHEN c.profile_image_url LIKE '%unavatar.io%'
                 OR c.profile_image_url LIKE '%static.licdn.com/aero%' THEN NULL
               ELSE btrim(c.profile_image_url)
             END AS profile_image_url,
             (coalesce(btrim(c.linkedin_url), '') <> ''
               OR coalesce(btrim(c.email), '') <> '') AS can_resolve_photo
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
      profileImageUrl: r.profile_image_url,
      canResolvePhoto: Boolean(r.can_resolve_photo),
    })),
    hasMore: rows.length > IMPORT_PEOPLE_PAGE,
  };
}
