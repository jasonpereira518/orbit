import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { actionItems, contacts } from "@/db/schema";
import { daysAgo } from "@/lib/duplicates";

export const OPEN_ITEM_ELIGIBLE_DAYS = 14;
export const CLOSE_LOOP_WINDOW_DAYS = 10;
export const CLOSE_LOOP_SCORE_BOOST = 3;

const RECENT_COMPLETION_QUERY_WINDOW_DAYS = 30;

export type ActionItemSignal = {
  openCount: number;
  oldestOpenText: string;
  oldestOpenAgeDays: number;
  recentCompletionText?: string;
  recentCompletionAgeDays?: number;
};

export async function getActionItemSignalsBatch(
  userId: string,
  contactIds: string[]
): Promise<Map<string, ActionItemSignal>> {
  const result = new Map<string, ActionItemSignal>();
  if (!contactIds.length) return result;
  const db = await getDb();

  const openRows = await db
    .select({ contactId: actionItems.contactId, text: actionItems.text, createdAt: actionItems.createdAt })
    .from(actionItems)
    .where(and(eq(actionItems.userId, userId), eq(actionItems.status, "open"), inArray(actionItems.contactId, contactIds)))
    .orderBy(actionItems.createdAt);

  for (const row of openRows) {
    const existing = result.get(row.contactId);
    if (!existing) {
      result.set(row.contactId, {
        openCount: 1,
        oldestOpenText: row.text,
        oldestOpenAgeDays: daysAgo(row.createdAt),
      });
    } else {
      existing.openCount += 1;
    }
  }

  const cutoff = new Date(Date.now() - RECENT_COMPLETION_QUERY_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const doneRows = await db
    .select({
      contactId: actionItems.contactId,
      text: actionItems.text,
      completedAt: actionItems.completedAt,
      lastInteractionAt: contacts.lastInteractionAt,
    })
    .from(actionItems)
    .innerJoin(contacts, eq(contacts.id, actionItems.contactId))
    .where(
      and(
        eq(actionItems.userId, userId),
        eq(actionItems.status, "done"),
        gte(actionItems.completedAt, cutoff),
        inArray(actionItems.contactId, contactIds)
      )
    )
    .orderBy(desc(actionItems.completedAt));

  const decidedRecentCompletion = new Set<string>();
  for (const row of doneRows) {
    if (decidedRecentCompletion.has(row.contactId)) continue;
    if (!row.completedAt) continue;
    // Self-silencing: a completion already superseded by a later interaction must not
    // keep nudging — once the user actually follows up, lastInteractionAt moves past it.
    if (row.lastInteractionAt && row.lastInteractionAt >= row.completedAt) continue;
    decidedRecentCompletion.add(row.contactId);
    const existing = result.get(row.contactId);
    const signal: ActionItemSignal = existing ?? { openCount: 0, oldestOpenText: "", oldestOpenAgeDays: Infinity };
    signal.recentCompletionText = row.text;
    signal.recentCompletionAgeDays = daysAgo(row.completedAt);
    result.set(row.contactId, signal);
  }

  return result;
}
