/**
 * Reads a contact's messages past the watermark into the window one pass sends the model.
 *
 * Oldest first: the engine walks a backlog forward, so the summary it carries between
 * chunks always describes everything before the chunk it is reading. A backlog bigger than
 * MAX_CHUNKS windows is cut from the OLD end — what is open now lives in recent messages —
 * and the cut is recorded so the run summary can say "older history not read".
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts, interactions, relationshipDigests } from "@/db/schema";
import type { MessageWindow, WindowMessage } from "@/lib/relationship-engine/types";

export const WINDOW_CHARS = 20_000;
export const MAX_CHUNKS = 3;
/** Rows read per contact per pass; far more than three windows of real messages. */
const ROW_LIMIT = 2_000;

export function speakerFor(direction: "in" | "out" | null, contactFullName: string): string {
  if (direction === "out") return "Me";
  if (direction === "in") return contactFullName.trim().split(/\s+/)[0] || "Them";
  return "?";
}

export function formatMessageLine(m: WindowMessage): string {
  const day = m.at.toISOString().slice(0, 10);
  return `[${day} ${m.speaker}] ${m.text.replace(/\s+/g, " ").trim()}`;
}

export function buildWindow(contactId: string, rows: WindowMessage[], sources: string[]): MessageWindow | null {
  if (rows.length === 0) return null;
  const lines = rows.map(formatMessageLine);

  // Drop the oldest rows until the backlog fits MAX_CHUNKS windows (always keep the newest).
  let start = 0;
  let total = lines.reduce((n, l) => n + l.length + 1, 0);
  while (total > MAX_CHUNKS * WINDOW_CHARS && start < rows.length - 1) {
    total -= lines[start].length + 1;
    start += 1;
  }
  const truncatedBefore = start > 0 ? rows[start].at : null;

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

export async function loadMessageWindows(userId: string, contactIds: string[]): Promise<Map<string, MessageWindow>> {
  const windows = new Map<string, MessageWindow>();
  const ids = [...new Set(contactIds)];
  if (!ids.length) return windows;
  const db = await getDb();

  const people = await db
    .select({
      id: contacts.id,
      fullName: contacts.fullName,
      watermarkAt: relationshipDigests.watermarkAt,
      watermarkInteractionId: relationshipDigests.watermarkInteractionId,
    })
    .from(contacts)
    .leftJoin(relationshipDigests, eq(relationshipDigests.contactId, contacts.id))
    .where(and(eq(contacts.userId, userId), inArray(contacts.id, ids)));

  for (const p of people) {
    const after = p.watermarkAt
      ? sql`AND (${interactions.interactionDate} > ${p.watermarkAt.toISOString()}::timestamptz
               OR (${interactions.interactionDate} = ${p.watermarkAt.toISOString()}::timestamptz
                   AND ${interactions.id} > ${p.watermarkInteractionId}::uuid))`
      : sql``;
    const rows = await db
      .select({
        id: interactions.id,
        interactionType: interactions.interactionType,
        source: interactions.source,
        interactionDate: interactions.interactionDate,
        direction: interactions.direction,
        rawNotes: interactions.rawNotes,
      })
      .from(interactions)
      .where(
        and(
          eq(interactions.userId, userId),
          eq(interactions.contactId, p.id),
          sql`(${interactions.interactionType} = 'linkedin_message'
               OR (${interactions.interactionType} = 'message' AND ${interactions.source} IN ('whatsapp', 'imessage')))
              AND btrim(coalesce(${interactions.rawNotes}, '')) <> '' ${after}`
        )
      )
      .orderBy(asc(interactions.interactionDate), asc(interactions.id))
      .limit(ROW_LIMIT);

    const messages: WindowMessage[] = rows.map((r) => ({
      interactionId: r.id,
      at: new Date(r.interactionDate),
      direction: r.direction ?? null,
      speaker: speakerFor(r.direction ?? null, p.fullName),
      text: r.rawNotes ?? "",
    }));
    const sources = [...new Set(rows.map((r) => sourceLabel(r.interactionType, r.source)))];
    const window = buildWindow(p.id, messages, sources);
    if (window) windows.set(p.id, window);
  }
  return windows;
}
