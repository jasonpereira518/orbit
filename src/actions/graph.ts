"use server";

import { and, asc, count, eq, gt } from "drizzle-orm";
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function nonNegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

/**
 * Rebuild embeddings in chunks so the client can show progress.
 * Call repeatedly until done === true.
 *
 * Keyset-paged: each tick reads only its own page (`id > after ORDER BY id LIMIT n`), and
 * hands back `cursor` for the next one. It used to read every contact id on every tick and
 * slice by offset — ~375 full scans to refresh 3,000 contacts, with no ORDER BY, so a page
 * could skip or repeat rows. The total is counted once, on the first tick (no `after`); the
 * client carries it, and `processed`, forward.
 */
export async function refreshConstellationBatch(input?: {
  /** The last contact id the previous tick attempted; omitted on the first tick. */
  after?: string | null;
  /** Rows attempted by earlier ticks, as the previous tick returned it. */
  processed?: number;
  /** The first tick's `total`, carried forward so later ticks need not count again. */
  total?: number;
  limit?: number;
}) {
  const userId = await requireUserForSurface("page.graph");
  const db = await getDb();
  // Actions are reachable by direct POST, so the cursor is checked before it meets a uuid
  // column (where a malformed one would be a database error rather than a clear refusal).
  const after = input?.after || null;
  if (after !== null && (typeof after !== "string" || !UUID_RE.test(after))) {
    throw new Error("Invalid refresh cursor");
  }
  const processedBefore = nonNegativeInt(input?.processed) ?? 0;
  // Only a later tick carries a total; the first one (no cursor) always counts.
  const carriedTotal = after === null ? null : nonNegativeInt(input?.total);
  // Each rebuild is an embedding round trip; four per tick keeps a tick well inside the
  // page's function ceiling, and the deadline below guards the slow-provider case.
  const limit = Math.min(20, Math.max(1, input?.limit ?? 4));
  const deadline = deadlineAfter(CONSTELLATION_REFRESH_BUDGET_MS);

  // One row past the page says whether another tick is needed, so the last page does not
  // cost an extra, empty tick. The count runs alongside the page, first tick only.
  const [page, counted] = await Promise.all([
    db
      .select({ id: contacts.id })
      .from(contacts)
      .where(
        after === null
          ? eq(contacts.userId, userId)
          : and(eq(contacts.userId, userId), gt(contacts.id, after))
      )
      .orderBy(asc(contacts.id))
      .limit(limit + 1),
    carriedTotal === null
      ? db.select({ value: count() }).from(contacts).where(eq(contacts.userId, userId))
      : Promise.resolve(null),
  ]);
  const slice = page.slice(0, limit);
  const hasMore = page.length > limit;

  let processed = processedBefore;
  let cursor = after;
  let attemptedAll = true;
  let failed = 0;
  let firstError: unknown = null;
  let firstFailedId: string | null = null;
  for (const row of slice) {
    // Unattempted rows are simply not counted as processed; the client asks again, from
    // the cursor, which only ever advances past rows that were attempted.
    if (deadlineReached(deadline)) {
      attemptedAll = false;
      break;
    }
    cursor = row.id;
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
  }

  // Contacts added or deleted mid-refresh can move the real count off the first tick's;
  // never report more processed than total.
  const total = Math.max(carriedTotal ?? counted?.[0]?.value ?? 0, processed);

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

  const done = attemptedAll && !hasMore;
  const graph = done
    ? await traced("graph.load", () => loadGraphData(userId, { profile: getDisplayProfile() }), { userId })
    : null;

  return {
    total,
    processed,
    done,
    /** Pass back as `after` on the next tick. */
    cursor,
    graph,
  };
}
