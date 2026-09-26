import { and, gt, isNotNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import { PRESENCE_WINDOW_MS } from "@/lib/presence-window";

/**
 * Live presence — "is this person on the app right now", as opposed to "when did they last
 * do something".
 *
 * WHY A HEARTBEAT AT ALL. `user_settings.last_active_at` was previously written only by
 * `ensureUserSettings`, on an authenticated *server* request, throttled to 15 minutes. That
 * answers "last seen" well and "active now" not at all: a user reading their dashboard,
 * scrolling their contacts and opening panels generates zero server requests, so they would
 * sit at up to fifteen minutes stale while actively using the product.
 *
 * So every visible tab beats. The beat writes the same column rather than a new one —
 * `last_active_at` already means "the last time this human was present", and the heartbeat
 * simply makes it true at a resolution that supports the question. A second column would
 * have left every read site deciding which of two near-identical timestamps to trust.
 *
 * This module imports only drizzle, `@/db` and the timing constants. Keep it that way: it
 * is pulled in by the admin roster, two API routes and the smoke tests, and a `next/server`
 * import here would hang every script that reaches it.
 *
 * The constants and `isLive` live in `presence-window.ts` rather than here so that the
 * client heartbeat can read the interval without pulling `@/db` — and PGlite's `node:fs` —
 * into the browser bundle. See that file.
 */

/**
 * Record a beat.
 *
 * One statement, no SELECT first: the staleness check is IN the UPDATE's WHERE, so a beat
 * that finds the stamp already fresh matches no row and writes nothing. That matters
 * because every open tab beats on its own 45s clock: someone with four tabs open wrote the
 * wide `user_settings` row four times a beat window, each a new row version touching the
 * `last_active_at` index. Now it is at most once per `HEARTBEAT_DEDUPE_MS`, which is still
 * well inside `PRESENCE_WINDOW_MS`, so "active now" reads exactly as before.
 *
 * Deliberately does not touch `updated_at`: presence is not a settings change.
 */
export async function recordHeartbeat(userId: string): Promise<void> {
  const db = await getDb();
  await db
    .update(userSettings)
    .set({ lastActiveAt: new Date() })
    .where(
      sql`${userSettings.userId} = ${userId}
          AND (${userSettings.lastActiveAt} IS NULL
               OR ${userSettings.lastActiveAt} < now() - make_interval(secs => ${HEARTBEAT_DEDUPE_MS / 1000}))`
    );
}

/**
 * The shortest gap between two presence writes for one user. Less than one heartbeat, so a
 * single tab still writes every beat, and less than half the presence window, so a live user
 * can never read as gone.
 */
export const HEARTBEAT_DEDUPE_MS = 40 * 1000;

/**
 * The set of user ids currently live.
 *
 * Returns ids only — never emails, names or counts. The admin roster polls this every few
 * seconds and already has every other column server-rendered, so shipping anything more
 * would be re-sending the page contents on a timer to move a dot.
 */
export async function liveUserIds(now: Date = new Date()): Promise<string[]> {
  const db = await getDb();
  const cutoff = new Date(now.getTime() - PRESENCE_WINDOW_MS);

  const rows = await db
    .select({ userId: userSettings.userId })
    .from(userSettings)
    .where(
      and(
        isNotNull(userSettings.lastActiveAt),
        gt(userSettings.lastActiveAt, cutoff)
      )
    );

  return rows.map((r) => r.userId);
}
