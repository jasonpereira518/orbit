"use server";

import { eq } from "drizzle-orm";
import { ERROR_SOURCES, recordErrorEvent } from "@/lib/error-events";
import { getDb } from "@/db";
import { contacts } from "@/db/schema";
import { loadGraphData } from "@/lib/graph-data";
import { traced } from "@/lib/perf-trace";
import { deadlineAfter, deadlineReached } from "@/lib/time-budget";
import { getCurrentUserProfile } from "@/lib/auth";
import { rebuildContactEmbedding } from "@/lib/search";
import { requireUserForSurface } from "@/lib/plan-guards";

export type { GraphCluster, UserSocialLinks } from "@/lib/graph-data";

export async function getGraphData() {
  const userId = await requireUserForSurface("page.graph");
  // Handed over un-awaited: the Clerk profile round trip runs alongside the contact scan.
  return traced("graph.load", () => loadGraphData(userId, { profile: getCurrentUserProfile() }), {
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
    () => loadGraphData(userId, { profile: getCurrentUserProfile(), scope: "all" }),
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
}) {
  const userId = await requireUserForSurface("page.graph");
  const db = await getDb();
  const offset = Math.max(0, input?.offset ?? 0);
  // Each rebuild is an embedding round trip; four per tick keeps a tick well inside the
  // page's function ceiling, and the deadline below guards the slow-provider case.
  const limit = Math.min(20, Math.max(1, input?.limit ?? 4));
  const deadline = deadlineAfter(CONSTELLATION_REFRESH_BUDGET_MS);

  const rows = await db.query.contacts.findMany({
    where: eq(contacts.userId, userId),
    columns: { id: true },
  });
  const total = rows.length;
  const slice = rows.slice(offset, offset + limit);

  let processed = offset;
  let failed = 0;
  let firstError: unknown = null;
  let firstFailedId: string | null = null;
  for (const row of slice) {
    // Unattempted rows are simply not counted as processed; the client asks again.
    if (deadlineReached(deadline)) break;
    try {
      await rebuildContactEmbedding(userId, row.id);
    } catch (err) {
      console.error("Embedding rebuild failed", row.id, err);
      failed += 1;
      if (!firstError) {
        firstError = err;
        firstFailedId = row.id;
      }
    }
    processed += 1;
  }

  // One row per batch, never per contact — per-item error rows are how a diagnostic
  // table becomes a log firehose.
  if (failed > 0) {
    await recordErrorEvent({
      source: ERROR_SOURCES.graphRebuildEmbeddings,
      kind: "batch_partial_failure",
      userId,
      message: firstError,
      context: { failed, batchSize: slice.length, total, sampleContactId: firstFailedId },
    });
  }

  const done = processed >= total;
  const graph = done
    ? await traced("graph.load", () => loadGraphData(userId, { profile: getCurrentUserProfile() }), { userId })
    : null;

  return {
    total,
    processed,
    done,
    graph,
  };
}
