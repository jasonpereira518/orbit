import { cache } from "react";
import { and, eq, gte, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts, interactions, userGoals } from "@/db/schema";
import {
  applyClosenessCohort,
  buildClosenessCohort,
  computeRawCloseness,
  CADENCE_WINDOW_DAYS,
  type ClosenessBreakdown,
  type ClosenessCohort,
} from "@/lib/closeness";

/**
 * The columns the raw formula reads. A caller that has already loaded its
 * contacts can donate them (see `getClosenessCohort`) instead of paying for a
 * second scan; typing the donation this way means dropping one of these
 * columns from the caller's query is a compile error, not a silent scoring
 * difference between pages.
 */
export type ClosenessCohortRow = {
  id: string;
  relationshipScore: number | null;
  lastInteractionAt: Date | string | null;
  createdAt: Date | string;
  company: string | null;
  title: string | null;
  industry: string | null;
  howMet: string | null;
  aiSummary: string | null;
  keyFacts: string[] | null;
  sharedInterests: string[] | null;
  contactTags: Array<{ tag: { name: string } }>;
};

export type ClosenessCohortResult = {
  cohort: ClosenessCohort;
  byId: Map<string, ClosenessBreakdown>;
  /** Mean of the absolute scores. Unlike the blended mean it still moves with network health. */
  averageRaw: number;
  goals: string[];
  touchCounts: Map<string, number>;
};

/**
 * Per-request store, so whichever surface asks first decides how the cohort is
 * built and everyone else reuses that one result. Keyed by user and rebuilt
 * every request — `cache()` gives us a fresh Map per request, so nothing leaks
 * between users or survives a mutation.
 */
const cohortStore = cache(() => new Map<string, Promise<ClosenessCohortResult>>());

/**
 * Score every one of a user's contacts against the distribution they form.
 *
 * Shared per request so the five surfaces that display closeness (list, detail,
 * graph, network metrics, dashboard stats) all read one identical ranking —
 * previously each recomputed its own, and the graph fed in different fields,
 * so the same person could sit in a different ring on /graph than /contacts.
 *
 * `preloadedRows` lets a caller that is already scanning contacts hand over
 * that work — pass the *promise*, not the awaited rows, so its query still runs
 * in parallel with the goal and interaction queries here.
 */
export function getClosenessCohort(
  userId: string,
  preloadedRows?: ClosenessCohortRow[] | Promise<ClosenessCohortRow[]>
): Promise<ClosenessCohortResult> {
  const store = cohortStore();
  const existing = store.get(userId);
  if (existing) return existing;

  const pending = buildCohortResult(userId, preloadedRows);
  store.set(userId, pending);
  return pending;
}

async function buildCohortResult(
  userId: string,
  preloadedRows?: ClosenessCohortRow[] | Promise<ClosenessCohortRow[]>
): Promise<ClosenessCohortResult> {
  const db = await getDb();
  const since = new Date(
    Date.now() - CADENCE_WINDOW_DAYS * 24 * 60 * 60 * 1000
  );

  const [rows, goalRows, touchRows] = await Promise.all([
    preloadedRows ??
      db.query.contacts.findMany({
        where: eq(contacts.userId, userId),
        // Only what the formula reads. `notes` is deliberately excluded — see
        // the goal-haystack note below.
        columns: {
          id: true,
          relationshipScore: true,
          lastInteractionAt: true,
          createdAt: true,
          company: true,
          title: true,
          industry: true,
          howMet: true,
          aiSummary: true,
          keyFacts: true,
          sharedInterests: true,
        },
        with: { contactTags: { with: { tag: true } } },
      }),
    db.query.userGoals.findMany({
      where: and(eq(userGoals.userId, userId), eq(userGoals.active, 1)),
      columns: { text: true },
    }),
    db
      .select({
        contactId: interactions.contactId,
        count: sql<number>`count(*)::int`,
      })
      .from(interactions)
      .where(
        and(
          eq(interactions.userId, userId),
          gte(interactions.interactionDate, since)
        )
      )
      .groupBy(interactions.contactId),
  ]);

  const goals = goalRows.map((g) => g.text);
  const touchCounts = new Map<string, number>(
    touchRows.map((r) => [r.contactId, Number(r.count) || 0])
  );

  // The goal haystack intentionally omits `notes`: keeping it would mean
  // pulling every note body on every request, and the list payload already
  // drops notes for slimming — so including it here is what made /graph and
  // /contacts disagree about the same contact's ring.
  const raws = rows.map((c) =>
    computeRawCloseness(
      { ...c, notes: null, tags: c.contactTags.map((ct) => ct.tag.name) },
      goals,
      touchCounts.get(c.id) ?? 0
    )
  );

  const cohort = buildClosenessCohort(raws);

  const byId = new Map<string, ClosenessBreakdown>();
  rows.forEach((c, i) => {
    byId.set(c.id, applyClosenessCohort(raws[i], cohort));
  });

  const averageRaw = raws.length
    ? raws.reduce((sum, r) => sum + r.raw, 0) / raws.length
    : 0;

  return { cohort, byId, averageRaw, goals, touchCounts };
}
