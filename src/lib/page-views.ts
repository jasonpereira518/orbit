import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { pageViews } from "@/db/schema";
import type { DeviceKind } from "@/lib/analytics-visitor";

/**
 * Writes for the traffic pipeline. Read side lives in `src/lib/admin-analytics.ts`.
 *
 * Everything here is fire-and-forget: a failed page view costs one row on an admin chart,
 * and no visitor should ever see a consequence of it. The route handler returns 204
 * regardless, the same contract `/api/presence` has.
 */

export type PageViewInput = {
  id: string;
  visitorHash: string;
  sessionId: string;
  userId: string | null;
  route: string;
  referrerHost: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  device: DeviceKind;
  isBot: boolean;
};

export async function recordPageView(input: PageViewInput): Promise<void> {
  const db = await getDb();
  await db
    .insert(pageViews)
    .values(input)
    // The id comes from the client, so a retried beacon can present one twice. Ignoring
    // the second is right: it is the same view, not a new one.
    .onConflictDoNothing({ target: pageViews.id });
}

/** How long a single view is allowed to claim, before we stop believing it. */
export const MAX_DWELL_MS = 30 * 60_000;

/**
 * Record time spent on a view, from the beacon.
 *
 * MONOTONIC, NOT FIRST-WRITE-WINS. The client reports its running total every time the
 * visitor leaves the page — each tab switch, then again on the way out — because no event
 * reliably means "gone for good". Keeping the greatest value makes those repeats
 * idempotent and order-independent: a beacon that arrives late, or out of order, or twice,
 * can only ever confirm what is already stored. A plain assignment would let the smaller,
 * earlier figure win a race and silently truncate the measurement.
 *
 * The id is client-supplied and therefore forgeable — but the only thing a forger gains is
 * the ability to set `dwell_ms` on a row they themselves just created, which is already
 * true of every other field on it. The clamp is what stops a stray value dragging a median.
 */
export async function recordDwell(id: string, dwellMs: number): Promise<void> {
  if (!Number.isFinite(dwellMs) || dwellMs <= 0) return;
  const clamped = Math.min(Math.round(dwellMs), MAX_DWELL_MS);
  const db = await getDb();
  await db
    .update(pageViews)
    .set({ dwellMs: sql`greatest(coalesce(${pageViews.dwellMs}, 0), ${clamped})` })
    .where(eq(pageViews.id, id));
}

/**
 * How long raw views are kept. `page_views` is the only table in the schema that grows
 * with traffic rather than with the customer base, so it is the only one that needs this.
 */
export const PAGE_VIEW_RETENTION_DAYS = 180;

/** Rows removed per sweep run. The sweep runs every ten minutes, so backlog drains fast. */
const PRUNE_BATCH = 5_000;

/**
 * Drop views past the retention window. Called from the ops sweep.
 *
 * BOUNDED ON PURPOSE, for two reasons. A single unbounded DELETE across a long-neglected
 * table takes a lock for as long as it takes, inside a request with a function timeout;
 * and `.returning()` cannot be narrowed to one column here — `Db` is a union of the
 * neon-http and PGlite drivers and partial returning is not assignable across it — so an
 * unbounded delete would also materialise every deleted ROW just to count them.
 *
 * Deleting a batch per run instead keeps both costs flat. At ten-minute intervals this
 * clears 720k rows a day, far past any plausible arrival rate.
 */
export async function prunePageViews(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - PAGE_VIEW_RETENTION_DAYS * 86_400_000);
  const db = await getDb();
  const deleted = await db
    .delete(pageViews)
    .where(
      sql`${pageViews.id} in (
        select id from page_views
        where created_at < ${cutoff.toISOString()}
        limit ${PRUNE_BATCH}
      )`
    )
    .returning();
  return deleted.length;
}
