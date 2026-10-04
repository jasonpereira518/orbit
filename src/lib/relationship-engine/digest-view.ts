import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { relationshipDigests, relationshipRuns } from "@/db/schema";
import type { DigestView } from "@/lib/relationship-engine/digest-copy";

export * from "@/lib/relationship-engine/digest-copy";

/**
 * The contact's digest, scoped to the user. Null when there is nothing worth showing.
 * One statement: the run's status rides along, because a thread can only become a reminder
 * through a run Undo all can still reach (not undone).
 */
export async function loadDigestView(userId: string, contactId: string): Promise<DigestView | null> {
  const db = await getDb();
  const [row] = await db
    .select({ d: relationshipDigests, runStatus: relationshipRuns.status })
    .from(relationshipDigests)
    .leftJoin(relationshipRuns, and(eq(relationshipRuns.id, relationshipDigests.runId), eq(relationshipRuns.userId, userId)))
    .where(and(eq(relationshipDigests.contactId, contactId), eq(relationshipDigests.userId, userId)))
    .limit(1);
  const d = row?.d;
  if (!d || (!d.summary && !d.whatTheyDo && d.openThreads.length === 0)) return null;
  return {
    whatTheyDo: d.whatTheyDo,
    workingOn: d.workingOn,
    summary: d.summary,
    topics: [...d.topics].sort((a, b) => b.lastDiscussedAt.localeCompare(a.lastDiscussedAt)).slice(0, 8),
    openThreads: d.openThreads.map((t) => ({ ...t, canRemind: row.runStatus != null && row.runStatus !== "undone" })),
    messageCount: d.messageCount,
    sources: d.sources,
    updatedAt: d.updatedAt.toISOString(),
    historyTruncatedBefore: d.historyTruncatedBefore?.toISOString() ?? null,
  };
}
