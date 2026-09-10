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
  findIdentityCollisions,
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

/**
 * Merge every pair that shares an identifier.
 *
 * Only the certain half of the review — a shared email or LinkedIn profile is not a guess.
 * Name suggestions are never bulk-merged; that is the whole reason they are a separate list.
 *
 * Sequential rather than parallel: each merge changes what the next one sees (a three-way
 * duplicate produces two overlapping pairs), and the list is recomputed after each one.
 */
export async function mergeAllCertainDuplicates() {
  const userId = await requireUserId();
  let merged = 0;
  // Bounded: each pass re-reads the collisions, and a pass that merges nothing stops the
  // loop. The cap is a backstop against a cycle nobody has thought of.
  for (let pass = 0; pass < 25; pass++) {
    const pairs = await findIdentityCollisions(userId, 50);
    if (!pairs.length) break;
    let mergedThisPass = 0;
    for (const pair of pairs) {
      try {
        await mergeContacts(userId, pair.keep.id, pair.merge.id, { reason: pair.reason });
        merged += 1;
        mergedThisPass += 1;
      } catch {
        // A pair whose other half was already merged by an earlier pair in this same pass.
        // Skipped rather than fatal: the recomputed next pass sees the current truth.
      }
    }
    if (mergedThisPass === 0) break;
  }
  revalidateContactSurfaces();
  return { merged };
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
