import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { imports } from "@/db/schema";

/**
 * Remove one flagged commitment from an import the user owns. False when nothing matched.
 *
 * One statement, filtered in SQL: a read-modify-write here would lose a second dismissal made
 * at the same moment, and the Drive runner appends flags the same way (`appendFlagsSql`), so
 * neither side can put back what the other removed.
 */
export async function removeDriveFlag(userId: string, importId: string, flagId: string): Promise<boolean> {
  const db = await getDb();
  const updated = await db
    .update(imports)
    .set({
      stats: sql`jsonb_set(
        ${imports.stats},
        '{flaggedCommitments}',
        (
          select coalesce(jsonb_agg(x.e order by x.ord), '[]'::jsonb)
          from jsonb_array_elements(${imports.stats}->'flaggedCommitments') with ordinality as x(e, ord)
          where x.e->>'id' is distinct from ${flagId}
        )
      )`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(imports.id, importId),
        eq(imports.userId, userId),
        sql`${imports.stats}->'flaggedCommitments' @> ${JSON.stringify([{ id: flagId }])}::jsonb`,
      ),
    )
    .returning();
  return updated.length > 0;
}
