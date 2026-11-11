import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { attendedEventFilter } from "@/lib/events/store";
import { isSurfaceLive } from "@/lib/surface-visibility";

/**
 * The event the owner is at right now, if any: one they attend (not dismissed) whose
 * `starts_at <= now <= COALESCE(ends_at, starts_at + 3 h)`. Latest start wins.
 * Null when the Events surface is closed for them.
 */
export async function liveEventFor(userId: string, now: Date = new Date()): Promise<{ id: string; title: string } | null> {
  if (!(await isSurfaceLive(userId, "page.events"))) return null;
  const db = await getDb();
  const res = await db.execute(sql`
    SELECT e.id, e.title FROM events e
    WHERE e.user_id = ${userId}
      AND ${attendedEventFilter()}
      AND e.starts_at <= ${now}
      AND ${now} <= COALESCE(e.ends_at, e.starts_at + interval '3 hours')
    ORDER BY e.starts_at DESC
    LIMIT 1`);
  const row = (res.rows as Array<{ id: string; title: string }>)[0];
  return row ? { id: row.id, title: row.title } : null;
}
