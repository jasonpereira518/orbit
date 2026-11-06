import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
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
  /** Orbit's own traffic. See `src/lib/analytics-internal.ts`. Defaults to false. */
  isInternal?: boolean;
};

export async function recordPageView(input: PageViewInput): Promise<void> {
  const db = await getDb();
  await db
    .insert(pageViews)
    .values({ ...input, isInternal: input.isInternal ?? false })
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
 * The longest page load we record. Past this the measurement is not a page load any more —
 * a laptop lid closed mid-navigation, a tab throttled in the background — and one such
 * value would drag every percentile on the admin page.
 */
export const MAX_LOAD_MS = 60_000;

/**
 * Record how long a view took to show its content, from the `load` beacon.
 *
 * FIRST WRITE WINS, the opposite of dwell. A load is measured exactly once per view, so a
 * second beacon for the same id can only be a retry or a forgery; neither should replace
 * the first figure. `nav_type` is written in the same statement so the two can never
 * disagree about which measurement the number is.
 */
export async function recordLoad(
  id: string,
  loadMs: number,
  navType: "hard" | "soft"
): Promise<void> {
  if (!Number.isFinite(loadMs) || loadMs < 0 || loadMs > MAX_LOAD_MS) return;
  const db = await getDb();
  await db
    .update(pageViews)
    .set({ loadMs: Math.round(loadMs), navType })
    .where(and(eq(pageViews.id, id), isNull(pageViews.loadMs)));
}

/** Past this a vital is not a measurement any more (a lid closed mid-load), same as `MAX_LOAD_MS`. */
export const MAX_VITAL_MS = 60_000;
/** CLS ×1000. A CLS of 10 is already absurd; anything above is noise. */
export const MAX_CLS_MILLI = 10_000;

export type Vitals = { lcpMs?: unknown; inpMs?: unknown; clsMilli?: unknown };

/**
 * Record Core Web Vitals for a view, from the `vitals` beacon.
 *
 * MONOTONIC, like dwell: the client reports each metric as it changes (LCP until the first
 * input, INP and CLS until the page hides), so each column keeps the greatest value seen and a
 * late or repeated beacon can only confirm it. A value out of range is dropped, not clamped.
 *
 * FIRST VIEW ONLY. The client sends vitals only for the document's first view, and the
 * `nav_type` guard holds that on the server too: a soft navigation has no LCP, so a vitals
 * beacon naming a soft view's id is a bug or a forgery, and updates nothing.
 */
export async function recordVitals(id: string, vitals: Vitals): Promise<void> {
  const valid = (v: unknown, max: number): number | null =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max ? Math.round(v) : null;
  const lcp = valid(vitals.lcpMs, MAX_VITAL_MS);
  const inp = valid(vitals.inpMs, MAX_VITAL_MS);
  const cls = valid(vitals.clsMilli, MAX_CLS_MILLI);
  const set: Partial<Record<"lcpMs" | "inpMs" | "clsMilli", SQL>> = {};
  if (lcp !== null) set.lcpMs = sql`greatest(coalesce(${pageViews.lcpMs}, 0), ${lcp})`;
  if (inp !== null) set.inpMs = sql`greatest(coalesce(${pageViews.inpMs}, 0), ${inp})`;
  if (cls !== null) set.clsMilli = sql`greatest(coalesce(${pageViews.clsMilli}, 0), ${cls})`;
  if (Object.keys(set).length === 0) return;
  const db = await getDb();
  await db
    .update(pageViews)
    .set(set)
    .where(and(eq(pageViews.id, id), sql`${pageViews.navType} is distinct from 'soft'`));
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
