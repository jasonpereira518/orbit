/**
 * Reads a contact's messages past the watermark into the window one pass sends the model.
 *
 * Oldest first: the engine walks a backlog forward, so the summary it carries between
 * chunks always describes everything before the chunk it is reading. A backlog bigger than
 * MAX_CHUNKS windows is cut from the OLD end — what is open now lives in recent messages —
 * and the cut is recorded so the run summary can say "older history not read".
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { contacts } from "@/db/schema";
import { MESSAGE_INTERACTION_SQL, WATERMARK_AFTER_SQL } from "@/lib/relationship-engine/pending";
import type { MessageWindow, WindowMessage } from "@/lib/relationship-engine/types";

export const WINDOW_CHARS = 20_000;
export const MAX_CHUNKS = 3;
/** Rows read per contact per pass; far more than three windows of real messages. */
const ROW_LIMIT = 2_000;

export function speakerFor(
  direction: "in" | "out" | null,
  contactFullName: string,
  interactionType?: string
): string {
  // A chat session is one row holding a whole transcript with its own per-line speakers.
  if (interactionType === "message") return "Chat";
  if (direction === "out") return "Me";
  if (direction === "in") return contactFullName.trim().split(/\s+/)[0] || "Them";
  return "?";
}

export function formatMessageLine(m: WindowMessage): string {
  const day = m.at.toISOString().slice(0, 10);
  return `[${day} ${m.speaker}] ${m.text.replace(/\s+/g, " ").trim()}`;
}

export function buildWindow(
  contactId: string,
  rows: WindowMessage[],
  sources: string[],
  /** True when older unread rows exist beyond `rows` (the read was cut at the row limit). */
  olderUnread = false
): MessageWindow | null {
  if (rows.length === 0) return null;
  const lines = rows.map(formatMessageLine);

  // Drop the oldest rows until the backlog fits MAX_CHUNKS windows (always keep the newest).
  let start = 0;
  let total = lines.reduce((n, l) => n + l.length + 1, 0);
  while (total > MAX_CHUNKS * WINDOW_CHARS && start < rows.length - 1) {
    total -= lines[start].length + 1;
    start += 1;
  }
  // The earlier of: the first row the char budget kept, and the first row the row limit kept.
  const truncatedBefore = olderUnread ? rows[0].at : start > 0 ? rows[start].at : null;

  // The window is the oldest kept rows up to WINDOW_CHARS; a single over-long message is clipped.
  const kept: WindowMessage[] = [];
  const keptLines: string[] = [];
  let used = 0;
  for (let i = start; i < rows.length; i++) {
    let line = lines[i];
    if (kept.length === 0 && line.length > WINDOW_CHARS) line = line.slice(0, WINDOW_CHARS);
    if (kept.length > 0 && used + line.length + 1 > WINDOW_CHARS) break;
    kept.push(rows[i]);
    keptLines.push(line);
    used += line.length + 1;
  }
  const last = kept[kept.length - 1];
  return {
    contactId,
    messages: kept,
    text: keptLines.join("\n"),
    last: { at: last.at, interactionId: last.interactionId },
    truncatedBefore,
    sources,
  };
}

function sourceLabel(interactionType: string, source: string | null): string {
  if (interactionType === "linkedin_message") return "linkedin";
  return source ?? "messages";
}

export type WindowBound = { at: Date; interactionId: string };

/**
 * `opts.until` caps a contact's rows at (interaction_date, id) <= the bound: the batch
 * applier re-reads exactly the window the model was sent, never a message that arrived
 * while the batch was out (that one must stay past the watermark, i.e. pending).
 * `opts.rowLimit` caps rows read per contact; the NEWEST rows past the watermark are kept.
 */
export async function loadMessageWindows(
  userId: string,
  contactIds: string[],
  opts: { until?: Map<string, WindowBound>; rowLimit?: number } = {}
): Promise<Map<string, MessageWindow>> {
  const windows = new Map<string, MessageWindow>();
  const rowLimit = opts.rowLimit ?? ROW_LIMIT;
  const ids = [...new Set(contactIds)];
  if (!ids.length) return windows;
  const db = await getDb();

  const people = await db
    .select({ id: contacts.id, fullName: contacts.fullName })
    .from(contacts)
    .where(and(eq(contacts.userId, userId), inArray(contacts.id, ids)));

  type Row = {
    id: string;
    interaction_type: string;
    source: string | null;
    interaction_date: Date | string;
    direction: "in" | "out" | null;
    raw_notes: string | null;
  };

  for (const p of people) {
    const bound = opts.until?.get(p.id);
    // Same row predicate and watermark clause the pending query uses (pending.ts), so a
    // claimed contact always has a window.
    const result = await db.execute(sql`
      SELECT m.id, m.interaction_type, m.source, m.interaction_date, m.direction, m.raw_notes
        FROM interactions m
        LEFT JOIN relationship_digests d ON d.contact_id = m.contact_id
       WHERE m.user_id = ${userId}
         AND m.contact_id = ${p.id}::uuid
         AND ${MESSAGE_INTERACTION_SQL}
         AND ${WATERMARK_AFTER_SQL}
         ${
           bound
             ? sql`AND (date_trunc('milliseconds', m.interaction_date), m.id) <= (${bound.at.toISOString()}::timestamptz, ${bound.interactionId}::uuid)`
             : sql``
         }
       ORDER BY m.interaction_date DESC, m.id DESC
       LIMIT ${rowLimit}
    `);
    // Newest rowLimit rows, flipped back to oldest-first for the window.
    const rows = rowsOf<Row>(result).reverse();

    const messages: WindowMessage[] = rows.map((r) => ({
      interactionId: r.id,
      at: new Date(r.interaction_date),
      direction: r.direction ?? null,
      speaker: speakerFor(r.direction ?? null, p.fullName, r.interaction_type),
      text: r.raw_notes ?? "",
    }));
    const sources = [...new Set(rows.map((r) => sourceLabel(r.interaction_type, r.source)))];
    const window = buildWindow(p.id, messages, sources, rows.length === rowLimit);
    if (window) windows.set(p.id, window);
  }
  return windows;
}
