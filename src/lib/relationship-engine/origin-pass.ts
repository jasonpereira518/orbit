/**
 * The one-time origin pass (LinkedIn deep read, launch catch-up).
 *
 * Contacts the engine read before the deep read have a watermark past the opening of their
 * thread, so the normal pass never sees "great meeting you at…" again, nor the invitation notes
 * and recommendations that are older than the watermark. This second, smaller reader looks at
 * exactly that: the opening messages plus the LinkedIn signals, once per contact.
 *
 * "Owed" is a query, never a flag: a digest with a watermark, no origin, and no
 * `ORIGIN_CHECKED` in `sources`. The in-flight marker is the runner's (`batch_job_id`,
 * `batch_pending_until`), so a claimed contact is also out of the normal pending set until its
 * batch lands. It never writes the watermark, the summary, facts, reminders or attempts.
 */
import { sql, type SQL } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { BATCH_STALE_HOURS } from "@/lib/ai-batch";
import { formatMessageLine, signalSpeaker, speakerFor } from "@/lib/relationship-engine/gather";
import { MESSAGE_INTERACTION_SQL, ORIGIN_CHECKED, SIGNAL_ROW_SQL } from "@/lib/relationship-engine/pending";
import type { MessageWindow, WindowMessage } from "@/lib/relationship-engine/types";

export { ORIGIN_CHECKED };
/** Opening messages, in characters of window text. */
export const ORIGIN_WINDOW_CHARS = 6_000;
/** Invitation notes, recommendations, your LinkedIn notes. */
export const ORIGIN_SIGNAL_LIMIT = 10;
/** Per signal. */
export const ORIGIN_SIGNAL_CHARS = 1_000;
const OPENING_ROW_LIMIT = 60;

/** `d` is relationship_digests. Shared verbatim by the claim, the count and the user list. */
function owedSql(now: Date): SQL {
  return sql`d.watermark_at IS NOT NULL
    AND d.origin IS NULL
    AND NOT (d.sources @> ${JSON.stringify([ORIGIN_CHECKED])}::jsonb)
    AND (d.batch_pending_until IS NULL OR d.batch_pending_until < ${now.toISOString()}::timestamptz)`;
}

/**
 * Signals first (each clipped), then the oldest messages until ORIGIN_WINDOW_CHARS, all in date
 * order. Null when there is nothing to read. `truncatedBefore` is always null: this window is
 * not a pass over the backlog and records no cut.
 */
export function buildOriginWindow(contactId: string, opening: WindowMessage[], signals: WindowMessage[]): MessageWindow | null {
  const byDate = (a: WindowMessage, b: WindowMessage) => a.at.getTime() - b.at.getTime();
  const kept: WindowMessage[] = [...signals]
    .sort(byDate)
    .slice(0, ORIGIN_SIGNAL_LIMIT)
    .map((s) => ({ ...s, text: s.text.slice(0, ORIGIN_SIGNAL_CHARS) }));
  let used = 0;
  for (const m of [...opening].sort(byDate)) {
    const length = formatMessageLine(m).length + 1;
    if (used === 0 && length > ORIGIN_WINDOW_CHARS) {
      kept.push({ ...m, text: m.text.slice(0, ORIGIN_WINDOW_CHARS) });
      break;
    }
    if (used + length > ORIGIN_WINDOW_CHARS) break;
    kept.push(m);
    used += length;
  }
  if (!kept.length) return null;
  // Stable: signals stay ahead of a message of the same instant.
  kept.sort(byDate);
  const last = kept[kept.length - 1];
  return {
    contactId,
    messages: kept,
    text: kept.map(formatMessageLine).join("\n"),
    last: { at: last.at, interactionId: last.interactionId },
    truncatedBefore: null,
    sources: [],
  };
}

type Row = {
  id: string;
  interaction_type: string;
  interaction_date: Date | string;
  direction: "in" | "out" | null;
  raw_notes: string | null;
  external_id: string | null;
};

/**
 * Opening = message rows at or before the watermark, oldest first. Signals = the LinkedIn
 * export's per-person rows, oldest first, whatever their date.
 */
export async function loadOriginWindows(userId: string, contactIds: string[]): Promise<Map<string, MessageWindow>> {
  const windows = new Map<string, MessageWindow>();
  const ids = [...new Set(contactIds)];
  if (!ids.length) return windows;
  const db = await getDb();
  const people = rowsOf<{ id: string; full_name: string }>(
    await db.execute(sql`
      SELECT id, full_name FROM contacts
       WHERE user_id = ${userId} AND id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
    `)
  );
  for (const p of people) {
    const [opening, signals] = await Promise.all([
      db.execute(sql`
        SELECT m.id, m.interaction_type, m.interaction_date, m.direction, m.raw_notes, m.external_id
          FROM interactions m
          JOIN relationship_digests d ON d.contact_id = m.contact_id
         WHERE m.user_id = ${userId} AND m.contact_id = ${p.id}::uuid
           AND ${MESSAGE_INTERACTION_SQL}
           AND (date_trunc('milliseconds', m.interaction_date) < d.watermark_at
                OR (date_trunc('milliseconds', m.interaction_date) = d.watermark_at
                    AND (d.watermark_interaction_id IS NULL OR m.id <= d.watermark_interaction_id)))
         ORDER BY m.interaction_date ASC, m.id ASC
         LIMIT ${OPENING_ROW_LIMIT}
      `),
      db.execute(sql`
        SELECT m.id, m.interaction_type, m.interaction_date, m.direction, m.raw_notes, m.external_id
          FROM interactions m
         WHERE m.user_id = ${userId} AND m.contact_id = ${p.id}::uuid
           AND ${SIGNAL_ROW_SQL}
         ORDER BY m.interaction_date ASC, m.id ASC
         LIMIT ${ORIGIN_SIGNAL_LIMIT}
      `),
    ]);
    const firstName = p.full_name.trim().split(/\s+/)[0] || "Them";
    const toMessage = (r: Row): WindowMessage => ({
      interactionId: r.id,
      at: new Date(r.interaction_date),
      direction: r.direction ?? null,
      speaker: signalSpeaker(r.external_id, firstName) ?? speakerFor(r.direction ?? null, p.full_name, r.interaction_type),
      text: r.raw_notes ?? "",
    });
    const window = buildOriginWindow(p.id, rowsOf<Row>(opening).map(toMessage), rowsOf<Row>(signals).map(toMessage));
    if (window) windows.set(p.id, window);
  }
  return windows;
}

/**
 * Atomically marks up to `limit` owed digests in flight (batch_job_id = claimId) and returns
 * their contact ids, longest threads first. The outer predicate is re-checked on the row a
 * concurrent claim just wrote, so one contact goes to one claim.
 */
export async function claimOriginContacts(userId: string, limit: number, claimId: string, now: Date = new Date()): Promise<string[]> {
  if (limit <= 0) return [];
  const db = await getDb();
  const until = new Date(now.getTime() + BATCH_STALE_HOURS * 3_600_000);
  const result = await db.execute(sql`
    UPDATE relationship_digests d
       SET batch_job_id = ${claimId}::uuid, batch_pending_until = ${until.toISOString()}::timestamptz
     WHERE d.user_id = ${userId}
       AND d.contact_id IN (
         SELECT d.contact_id FROM relationship_digests d
          WHERE d.user_id = ${userId} AND ${owedSql(now)}
          ORDER BY d.message_count DESC, d.contact_id
          LIMIT ${limit}
       )
       AND ${owedSql(now)}
    RETURNING d.contact_id
  `);
  return rowsOf<{ contact_id: string }>(result).map((r) => r.contact_id);
}

export async function originPendingCount(userId: string, now: Date = new Date()): Promise<number> {
  const db = await getDb();
  const result = await db.execute(sql`SELECT count(*)::int AS n FROM relationship_digests d WHERE d.user_id = ${userId} AND ${owedSql(now)}`);
  return Number(rowsOf<{ n: number }>(result)[0]?.n ?? 0);
}

/** Users with owed digests and the engine on. `onlyUsers` null = everyone. */
export async function usersWithOriginWork(limit: number, onlyUsers: string[] | null, now: Date = new Date()): Promise<string[]> {
  if (onlyUsers && !onlyUsers.length) return [];
  const db = await getDb();
  const result = await db.execute(sql`
    SELECT DISTINCT d.user_id FROM relationship_digests d
     WHERE ${owedSql(now)}
       ${onlyUsers ? sql`AND d.user_id IN (${sql.join(onlyUsers.map((u) => sql`${u}`), sql`, `)})` : sql``}
       AND EXISTS (
         SELECT 1 FROM user_settings us
          WHERE us.user_id = d.user_id AND us.relationship_engine_enabled = 1
       )
     LIMIT ${limit}
  `);
  return rowsOf<{ user_id: string }>(result).map((r) => r.user_id);
}
