"use server";

/**
 * The duplicate review surface's server actions.
 *
 * Every export here must be `async` — one non-async export in a "use server" file kills
 * every export in it, and tsc cannot see the problem.
 */

import { and, desc, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { contactMerges, contacts } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import {
  dismissDuplicatePair as dismissPair,
  mergeContacts,
  unmergeContacts,
} from "@/lib/contact-merge";
import {
  countDuplicatesAwaitingReview,
  getDuplicateReview,
  type DuplicateReview,
} from "@/lib/duplicate-review";

function revalidateContactSurfaces() {
  revalidatePath("/");
  revalidatePath("/contacts");
  revalidatePath("/contacts/duplicates");
  revalidatePath("/graph");
  revalidatePath("/dashboard");
}

export async function listDuplicates(): Promise<DuplicateReview> {
  return getDuplicateReview(await requireUserId());
}

export async function countDuplicates(): Promise<number> {
  return countDuplicatesAwaitingReview(await requireUserId());
}

/** Merge one pair. `keepId` survives; `mergeId` is archived and disappears from every view. */
export async function mergeDuplicatePair(keepId: string, mergeId: string, reason?: string) {
  const userId = await requireUserId();
  const result = await mergeContacts(userId, keepId, mergeId, { reason });
  revalidateContactSurfaces();
  revalidatePath(`/contacts/${keepId}`);
  return result;
}

/** Reject a proposed pair. Persisted, so it is never proposed again. */
export async function dismissDuplicatePair(contactIdA: string, contactIdB: string) {
  await dismissPair(await requireUserId(), contactIdA, contactIdB);
  revalidatePath("/contacts");
  revalidatePath("/contacts/duplicates");
}

export type RecentMerge = {
  id: string;
  reason: string | null;
  mergedAt: Date;
  winnerId: string;
  winnerName: string | null;
  loserName: string | null;
};

/** The undo list. */
export async function listRecentMerges(limit = 20): Promise<RecentMerge[]> {
  const userId = await requireUserId();
  const db = await getDb();
  const rows = await db
    .select()
    .from(contactMerges)
    .where(eq(contactMerges.userId, userId))
    .orderBy(desc(contactMerges.mergedAt))
    .limit(limit);
  if (!rows.length) return [];

  const winners = await db
    .select({ id: contacts.id, fullName: contacts.fullName })
    .from(contacts)
    .where(
      and(
        eq(contacts.userId, userId),
        inArray(contacts.id, [...new Set(rows.map((r) => r.winnerContactId))])
      )
    );
  const nameById = new Map(winners.map((w) => [w.id, w.fullName]));

  return rows.map((row) => ({
    id: row.id,
    reason: row.reason,
    mergedAt: row.mergedAt,
    winnerId: row.winnerContactId,
    winnerName: nameById.get(row.winnerContactId) ?? null,
    // The archived row is the only place this name still exists.
    loserName:
      typeof (row.loserSnapshot as Record<string, unknown>)?.full_name === "string"
        ? ((row.loserSnapshot as Record<string, unknown>).full_name as string)
        : null,
  }));
}

/** Undo a merge. The archived contact comes back with its original id and its own rows. */
export async function undoMerge(mergeId: string) {
  const userId = await requireUserId();
  const result = await unmergeContacts(userId, mergeId);
  revalidateContactSurfaces();
  revalidatePath(`/contacts/${result.winnerId}`);
  revalidatePath(`/contacts/${result.loserId}`);
  return result;
}
