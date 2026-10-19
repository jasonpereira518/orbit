"use server";

/**
 * The duplicate review surface's server actions.
 *
 * Every export here must be `async` — one non-async export in a "use server" file kills
 * every export in it, and tsc cannot see the problem.
 */

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { contactMerges, contacts } from "@/db/schema";
import { openEngines } from "@/lib/decisions/engine";
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
import { z } from "zod";
import { anyNumber } from "@/lib/input/schemas";
import { defineAction } from "@/lib/input/action";

function revalidateContactSurfaces() {
  revalidatePath("/");
  revalidatePath("/contacts");
  revalidatePath("/contacts/duplicates");
  revalidatePath("/graph");
  revalidatePath("/dashboard");
}

export const listDuplicates = defineAction(
  {},
  async (userId): Promise<DuplicateReview> => {
    // Jev when the account has a TypeSafe key, else the person's own model — only to order the
    // queue and hint at each pair (cached per pair, so a revisit is free).
    return getDuplicateReview(userId, { engines: await openEngines(userId, { llm: true }) });
  }
);

export const countDuplicates = defineAction(
  {},
  async (userId): Promise<number> => {
    return countDuplicatesAwaitingReview(userId);
  }
);

/**
 * Merge one pair. `keepId` survives; `mergeId` is archived and disappears from every view.
 *
 * Passes NO `confidence`, and that is load-bearing: a merge row with a null confidence is how
 * the admin engagement report (`engagementDepth`) tells a person-confirmed merge from the
 * automatic sweep and import-time resolution, which always record one.
 */
export const mergeDuplicatePair = defineAction(
  { schema: z.tuple([z.string(), z.string(), z.string().optional()]) },
  async (userId, keepId: string, mergeId: string, reason?: string) => {
    const result = await mergeContacts(userId, keepId, mergeId, { reason });
    revalidateContactSurfaces();
    revalidatePath(`/contacts/${keepId}`);
    return result;
  }
);

/** Reject a proposed pair. Persisted, so it is never proposed again. */
export const dismissDuplicatePair = defineAction(
  { schema: z.tuple([z.string(), z.string()]) },
  async (userId, contactIdA: string, contactIdB: string) => {
    await dismissPair(userId, contactIdA, contactIdB);
    revalidatePath("/contacts");
    revalidatePath("/contacts/duplicates");
  }
);

export type RecentMerge = {
  id: string;
  reason: string | null;
  mergedAt: Date;
  winnerId: string;
  winnerName: string | null;
  loserName: string | null;
};

/** The undo list. */
export const listRecentMerges = defineAction(
  { schema: z.tuple([anyNumber.optional()]) },
  async (userId, limit: number = 20): Promise<RecentMerge[]> => {
    const db = await getDb();
    // Only what the list shows. `select()` pulled every merge's whole archive — the loser's
    // full row snapshot (inline avatar included) plus every deleted child row — to read one
    // name out of it. The name is extracted in SQL with the same rule the JS applied: the
    // snapshot's `full_name` when it is a JSON string, otherwise null.
    const rows = await db
      .select({
        id: contactMerges.id,
        reason: contactMerges.reason,
        mergedAt: contactMerges.mergedAt,
        winnerContactId: contactMerges.winnerContactId,
        loserName: sql<string | null>`case when jsonb_typeof(${contactMerges.loserSnapshot} -> 'full_name') = 'string' then ${contactMerges.loserSnapshot} ->> 'full_name' end`,
      })
      .from(contactMerges)
      .where(eq(contactMerges.userId, userId))
      .orderBy(desc(contactMerges.mergedAt))
      // Bounded: a server action's arguments come from any client.
      .limit(Math.min(Math.max(Math.trunc(Number(limit) || 20), 1), 100));
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
      loserName: row.loserName ?? null,
    }));
  }
);

/** Undo a merge. The archived contact comes back with its original id and its own rows. */
export const undoMerge = defineAction(
  { schema: z.tuple([z.string()]) },
  async (userId, mergeId: string) => {
    const result = await unmergeContacts(userId, mergeId);
    revalidateContactSurfaces();
    revalidatePath(`/contacts/${result.winnerId}`);
    revalidatePath(`/contacts/${result.loserId}`);
    return result;
  }
);
