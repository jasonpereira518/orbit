"use server";

/**
 * The duplicate review surface's server actions.
 *
 * Every export here must be `async` — one non-async export in a "use server" file kills
 * every export in it, and tsc cannot see the problem.
 */

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { contactMerges, contacts, duplicateSuggestions } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import { openEngines } from "@/lib/decisions/engine";
import {
  dismissDuplicatePair as dismissPair,
  mergeContacts,
  undismissDuplicatePair as undismissPair,
  unmergeContacts,
} from "@/lib/contact-merge";
import {
  countDuplicatesAwaitingReview,
  getDuplicateReview,
  signalsForPair,
  type DuplicateReview,
} from "@/lib/duplicate-review";
import {
  flipDecisionToDifferent,
  recordDuplicateDecision,
  retractDecision,
} from "@/lib/duplicate-model";

function revalidateContactSurfaces() {
  revalidatePath("/");
  revalidatePath("/contacts");
  revalidatePath("/contacts/duplicates");
  revalidatePath("/graph");
  revalidatePath("/dashboard");
}

export async function listDuplicates(): Promise<DuplicateReview> {
  const userId = await requireUserId();
  // Jev when the account has a TypeSafe key, else the person's own model — only to order the
  // queue and hint at each pair (cached per pair, so a revisit is free).
  return getDuplicateReview(userId, { engines: await openEngines(userId, { llm: true }) });
}

export async function countDuplicates(): Promise<number> {
  return countDuplicatesAwaitingReview(await requireUserId());
}

/**
 * Merge one pair. `keepId` survives; `mergeId` is archived and disappears from every view.
 *
 * Passes NO `confidence`, and that is load-bearing: a merge row with a null confidence is how
 * the admin engagement report (`engagementDepth`) tells a person-confirmed merge from the
 * automatic sweep and import-time resolution, which always record one.
 */
export async function mergeDuplicatePair(
  keepId: string,
  mergeId: string,
  reason?: string,
  shown?: DecisionContext
) {
  const userId = await requireUserId();
  // Read BEFORE the merge: it deletes the loser, and the example is what the two looked like.
  const signals = await signalsForPair(userId, keepId, mergeId, clamp01(shown?.engineScore, 0.6));
  const result = await mergeContacts(userId, keepId, mergeId, { reason });
  if (signals) {
    await recordDuplicateDecision(userId, {
      label: "same",
      source: "review_merge",
      signals,
      modelProbability: shown?.modelProbability == null ? null : clamp01(shown.modelProbability, 0.5),
      refId: result.mergeId,
    });
  }
  revalidateContactSurfaces();
  revalidatePath(`/contacts/${keepId}`);
  return result;
}

/** What the page showed when the person decided; both are only numbers, clamped on arrival. */
export type DecisionContext = { engineScore?: number; modelProbability?: number | null };

function clamp01(n: number | null | undefined, fallback: number): number {
  return typeof n === "number" && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

const pairKey = (a: string, b: string) => (a < b ? `${a}:${b}` : `${b}:${a}`);

/** Reject a proposed pair. Persisted, so it is never proposed again. */
export async function dismissDuplicatePair(
  contactIdA: string,
  contactIdB: string,
  shown?: DecisionContext
) {
  const userId = await requireUserId();
  const signals = await signalsForPair(userId, contactIdA, contactIdB, clamp01(shown?.engineScore, 0.6));
  await dismissPair(userId, contactIdA, contactIdB);
  if (signals) {
    await recordDuplicateDecision(userId, {
      label: "different",
      source: "review_dismiss",
      signals,
      modelProbability: shown?.modelProbability == null ? null : clamp01(shown.modelProbability, 0.5),
      refId: pairKey(contactIdA, contactIdB),
    });
  }
  revalidatePath("/contacts");
  revalidatePath("/contacts/duplicates");
}

/** Take a "not the same person" back: the pair returns to the queue, and the example is withdrawn. */
export async function undoDismissDuplicatePair(contactIdA: string, contactIdB: string) {
  const userId = await requireUserId();
  await undismissPair(userId, contactIdA, contactIdB);
  await retractDecision(userId, pairKey(contactIdA, contactIdB));
  revalidatePath("/contacts");
  revalidatePath("/contacts/duplicates");
}

export type RecentDismissal = {
  contactAId: string;
  contactBId: string;
  nameA: string;
  nameB: string;
  /** Employer, or title when there is none: two dismissed "Marcus Lee"s need telling apart. */
  detailA: string | null;
  detailB: string | null;
  resolvedAt: Date | null;
};

/** The "ignored" list: pairs a person said were different, newest first, with an undo. */
export async function listRecentDismissals(limit = 20): Promise<RecentDismissal[]> {
  const userId = await requireUserId();
  const db = await getDb();
  const a = alias(contacts, "ca");
  const b = alias(contacts, "cb");
  const rows = await db
    .select({
      contactAId: duplicateSuggestions.contactAId,
      contactBId: duplicateSuggestions.contactBId,
      nameA: a.fullName,
      nameB: b.fullName,
      // Plain columns, combined below: a column inside a `sql` template in a projection
      // renders unqualified, which is ambiguous across these two aliases of one table.
      companyA: a.company,
      titleA: a.title,
      companyB: b.company,
      titleB: b.title,
      resolvedAt: duplicateSuggestions.resolvedAt,
    })
    .from(duplicateSuggestions)
    .innerJoin(a, eq(a.id, duplicateSuggestions.contactAId))
    .innerJoin(b, eq(b.id, duplicateSuggestions.contactBId))
    .where(
      and(
        eq(duplicateSuggestions.userId, userId),
        eq(duplicateSuggestions.status, "dismissed"),
        eq(duplicateSuggestions.reason, "Dismissed by hand")
      )
    )
    .orderBy(desc(duplicateSuggestions.resolvedAt))
    .limit(Math.min(Math.max(Math.trunc(Number(limit) || 20), 1), 100));
  return rows.map(({ companyA, titleA, companyB, titleB, ...rest }) => ({
    ...rest,
    detailA: companyA || titleA || null,
    detailB: companyB || titleB || null,
  }));
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

/** Undo a merge. The archived contact comes back with its original id and its own rows. */
export async function undoMerge(mergeId: string) {
  const userId = await requireUserId();
  const result = await unmergeContacts(userId, mergeId);
  // The merge was a mistake, so the example that said "same person" was too.
  await flipDecisionToDifferent(userId, mergeId);
  revalidateContactSurfaces();
  revalidatePath(`/contacts/${result.winnerId}`);
  revalidatePath(`/contacts/${result.loserId}`);
  return result;
}
