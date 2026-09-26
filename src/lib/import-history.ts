import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { imports } from "@/db/schema";

/**
 * When this person last finished an import of any of these kinds, or null if never.
 * Completed runs only — a failed or cancelled one isn't something to report as imported.
 */
export async function lastCompletedImportAt(
  userId: string,
  importTypes: readonly string[]
): Promise<Date | null> {
  if (importTypes.length === 0) return null;
  const db = await getDb();
  const [row] = await db
    .select({ at: imports.updatedAt })
    .from(imports)
    .where(
      and(
        eq(imports.userId, userId),
        eq(imports.status, "completed"),
        inArray(imports.importType, [...importTypes])
      )
    )
    .orderBy(desc(imports.updatedAt))
    .limit(1);
  return row?.at ?? null;
}
