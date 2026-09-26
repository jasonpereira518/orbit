"use server";

import { and, asc, eq, gt } from "drizzle-orm";
import { ERROR_SOURCES, recordErrorEvent } from "@/lib/error-events";
import { getDb } from "@/db";
import { contacts } from "@/db/schema";
import { loadGraphData } from "@/lib/graph-data";
import { traced } from "@/lib/perf-trace";
import { deadlineAfter, deadlineReached } from "@/lib/time-budget";
import { getDisplayProfile } from "@/lib/auth";
import { rebuildContactEmbedding } from "@/lib/search";
import { requireUserForSurface } from "@/lib/plan-guards";
import { reportError } from "@/lib/report-error";

export type { GraphCluster, UserSocialLinks } from "@/lib/graph-data";

export async function getGraphData() {
  const userId = await requireUserForSurface("page.graph");
  // Handed over un-awaited: the Clerk profile round trip runs alongside the contact scan.
  return traced("graph.load", () => loadGraphData(userId, { profile: getDisplayProfile() }), {
    userId,
  });
}

/**
 * The whole network, including people you have never engaged with.
 *
 * Deliberately its own call rather than a flag on the page load. The chart is the people you
 * know; everyone else is a much larger set (~741 bytes a head, so megabytes on a real
 * network) that most visits never look at. Fetching it only when someone asks is what keeps
 * the option from costing anything on every other page view.
 *
 * The client caches the result for the session, so toggling back and forth costs one fetch,
 * not one per toggle.
 */
export async function getFullGraphData() {
  const userId = await requireUserForSurface("page.graph");
  return traced(
    "graph.load.all",
    () => loadGraphData(userId, { profile: getDisplayProfile(), scope: "all" }),
    { userId }
  );
}

/** Wall-clock budget for one constellation refresh tick. */
const CONSTELLATION_REFRESH_BUDGET_MS = 20_000;

/**
 * Rebuild embeddings in chunks so the client can show progress.
 * Call repeatedly until done === true.
 */
export async function refreshConstellationBatch(input?: {
  offset?: number;
  limit?: number;
  /** The last id the previous tick attempted; the next tick starts after it. */
  after?: string | null;
  /** The total the first tick reported, handed back so later ticks need not count again. */
  total?: number;
}) {
  const userId = await requireUserForSurface("page.graph");
  const db = await getDb();
  const offset = Math.max(0, input?.offset ?? 0);
  // Each rebuild is an embedding round trip; four per tick keeps a tick well inside the
  // page's function ceiling, and the deadline below guards the slow-provider case.
  const limit = Math.min(20, Math.max(1, input?.limit ?? 4));
  const deadline = deadlineAfter(CONSTELLATION_REFRESH_BUDGET_MS);

  // A keyset page of ids, in id order. Every tick used to read ALL the user's ids to take a
  // handful, unordered, by offset: quadratic over a refresh, and at 50,000 contacts about
  // 12,500 ticks of 50,000 ids each. The order also makes the walk stable, which offsets
  // into an unordered read never were.
  const after = typeof input?.after === "string" && input.after ? input.after : null;
  const [slice, total] = await Promise.all([
    db.query.contacts.findMany({
      where: after ? and(eq(contacts.userId, userId), gt(contacts.id, after)) : eq(contacts.userId, userId),
      columns: { id: true },
      orderBy: [asc(contacts.id)],
      limit,
    }),
    Number.isInteger(input?.total) && (input?.total ?? -1) >= 0
      ? Promise.resolve(input!.total!)
      : db.$count(contacts, eq(contacts.userId, userId)),
  ]);

  let processed = offset;
  let cursor = after;
  let failed = 0;
  let firstError: unknown = null;
  let firstFailedId: string | null = null;
  for (const row of slice) {
    // Unattempted rows are simply not counted as processed; the client asks again.
    if (deadlineReached(deadline)) break;
    try {
      await rebuildContactEmbedding(userId, row.id);
    } catch (err) {
      failed += 1;
      if (!firstError) {
        firstError = err;
        firstFailedId = row.id;
      }
    }
    processed += 1;
    cursor = row.id;
  }

  // One row per batch, never per contact — per-item error rows are how a diagnostic
  // table becomes a log firehose.
  if (failed > 0) {
    reportError(firstError, {
      where: "action.graph.rebuild-embeddings",
      userId,
      extra: { failed, batchSize: slice.length, sampleContactId: firstFailedId },
    });
    await recordErrorEvent({
      source: ERROR_SOURCES.graphRebuildEmbeddings,
      kind: "batch_partial_failure",
      userId,
      message: firstError,
      context: { failed, batchSize: slice.length, total, sampleContactId: firstFailedId },
    });
  }

  // Done when the walk ran off the end: a short page, fully attempted. `processed >= total`
  // too, for a count that was right; a contact added mid-refresh just extends the walk.
  const attemptedAll = cursor === (slice.at(-1)?.id ?? after);
  const done = (slice.length < limit && attemptedAll) || processed >= total;
  const graph = done
    ? await traced("graph.load", () => loadGraphData(userId, { profile: getDisplayProfile() }), { userId })
    : null;

  return {
    total,
    processed,
    done,
    graph,
    cursor,
  };
}
