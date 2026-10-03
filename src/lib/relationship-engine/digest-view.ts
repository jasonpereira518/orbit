import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { relationshipDigests } from "@/db/schema";
import type { DigestView } from "@/lib/relationship-engine/digest-copy";

export * from "@/lib/relationship-engine/digest-copy";

/** The contact's digest, scoped to the user. Null when there is nothing worth showing. */
export async function loadDigestView(userId: string, contactId: string): Promise<DigestView | null> {
  const db = await getDb();
  const d = await db.query.relationshipDigests.findFirst({
    where: and(eq(relationshipDigests.contactId, contactId), eq(relationshipDigests.userId, userId)),
  });
  if (!d || (!d.summary && !d.whatTheyDo && d.openThreads.length === 0)) return null;
  return {
    whatTheyDo: d.whatTheyDo,
    workingOn: d.workingOn,
    summary: d.summary,
    topics: [...d.topics].sort((a, b) => b.lastDiscussedAt.localeCompare(a.lastDiscussedAt)).slice(0, 8),
    openThreads: d.openThreads.map((t) => ({ ...t, canRemind: d.runId != null })),
    messageCount: d.messageCount,
    sources: d.sources,
    updatedAt: d.updatedAt.toISOString(),
    historyTruncatedBefore: d.historyTruncatedBefore?.toISOString() ?? null,
  };
}
