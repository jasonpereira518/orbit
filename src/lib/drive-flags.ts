import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { imports } from "@/db/schema";

/** Remove one flagged commitment from an import the user owns. False when nothing matched. */
export async function removeDriveFlag(userId: string, importId: string, flagId: string): Promise<boolean> {
  const db = await getDb();
  const row = await db.query.imports.findFirst({
    where: and(eq(imports.id, importId), eq(imports.userId, userId)),
    columns: { stats: true },
  });
  const flags = row?.stats?.flaggedCommitments ?? [];
  if (!row || !flags.some((f) => f.id === flagId)) return false;
  await db
    .update(imports)
    .set({ stats: { ...(row.stats ?? {}), flaggedCommitments: flags.filter((f) => f.id !== flagId) }, updatedAt: new Date() })
    .where(and(eq(imports.id, importId), eq(imports.userId, userId)));
  return true;
}
