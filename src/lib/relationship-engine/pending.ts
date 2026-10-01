/**
 * "Which contacts does the relationship engine still owe a pass?" — a query, never a flag.
 *
 * Shared verbatim by the claim, the count and the cron sweep (the PENDING_TIMELINE_CONTACTS
 * discipline in linkedin-timeline-backfill.ts): if they could disagree, a contact the claim
 * never returns but the count still reports keeps `remaining > 0` forever and the route's
 * re-kick loop spins on it.
 *
 * A message row is a LinkedIn message, or (P2) a chat-export session. Blank rows never make
 * a contact pending, so a claimed contact always has text to read and always advances.
 */
import { sql, type SQL } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";

export const MAX_ATTEMPTS = 3;

/** True for a row the engine reads. `m` is the interactions alias. */
export const MESSAGE_INTERACTION_SQL: SQL = sql`(
  m.interaction_type = 'linkedin_message'
  OR (m.interaction_type = 'message' AND m.source IN ('whatsapp', 'imessage'))
) AND btrim(coalesce(m.raw_notes, '')) <> ''`;

/** True when interaction `m` is past digest `d`'s watermark (or there is none). Shared with gather.ts. */
export const WATERMARK_AFTER_SQL: SQL = sql`(
  d.watermark_at IS NULL
  OR m.interaction_date > d.watermark_at
  OR (m.interaction_date = d.watermark_at AND m.id > d.watermark_interaction_id)
)`;

function pendingFrom(now: Date): SQL {
  return sql`
    FROM contacts c
    LEFT JOIN relationship_digests d ON d.contact_id = c.id
    WHERE coalesce(d.attempts, 0) < ${MAX_ATTEMPTS}
      AND (d.batch_pending_until IS NULL OR d.batch_pending_until < ${now.toISOString()}::timestamptz)
      AND EXISTS (
        SELECT 1 FROM interactions m
         WHERE m.user_id = c.user_id
           AND m.contact_id = c.id
           AND ${MESSAGE_INTERACTION_SQL}
           AND ${WATERMARK_AFTER_SQL}
      )
  `;
}

export async function pendingRelationshipContactCount(userId: string, now: Date = new Date()): Promise<number> {
  const db = await getDb();
  const result = await db.execute(sql`SELECT count(*)::int AS n ${pendingFrom(now)} AND c.user_id = ${userId}`);
  return Number(rowsOf<{ n: number }>(result)[0]?.n ?? 0);
}

/**
 * Pending contacts, the people you talk to most recently first, then the longest threads,
 * then the closest. `exclude` is the caller's attempted-this-invocation set, so a contact
 * the claim keeps returning costs at most one attempt per invocation.
 */
export async function claimPendingContacts(
  userId: string,
  limit: number,
  exclude: Set<string>,
  now: Date = new Date()
): Promise<string[]> {
  const db = await getDb();
  const excluded = [...exclude];
  const result = await db.execute(sql`
    SELECT c.id
      ${pendingFrom(now)}
      AND c.user_id = ${userId}
      ${excluded.length ? sql`AND c.id NOT IN (${sql.join(excluded.map((id) => sql`${id}::uuid`), sql`, `)})` : sql``}
    ORDER BY
      (SELECT max(m.interaction_date) FROM interactions m
        WHERE m.user_id = c.user_id AND m.contact_id = c.id AND ${MESSAGE_INTERACTION_SQL}) DESC NULLS LAST,
      (SELECT count(*) FROM interactions m
        WHERE m.user_id = c.user_id AND m.contact_id = c.id AND ${MESSAGE_INTERACTION_SQL}) DESC,
      coalesce(c.stated_closeness, 0) DESC,
      c.id
    LIMIT ${limit}
  `);
  return rowsOf<{ id: string }>(result).map((r) => r.id);
}

/** Users with pending work and the engine switched on — the cron backstop's input. */
export async function usersWithPendingRelationshipWork(limit: number, now: Date = new Date()): Promise<string[]> {
  const db = await getDb();
  const result = await db.execute(sql`
    SELECT DISTINCT c.user_id ${pendingFrom(now)}
      AND EXISTS (
        SELECT 1 FROM user_settings us
         WHERE us.user_id = c.user_id AND us.relationship_engine_enabled = 1
      )
    LIMIT ${limit}
  `);
  return rowsOf<{ user_id: string }>(result).map((r) => r.user_id);
}
