import { and, asc, desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { interactions } from "@/db/schema";
import { listEventsTogetherForContact } from "@/lib/events/people-store";
import {
  KNOWLEDGE_TIMELINE_LIMIT,
  KNOWLEDGE_TIMELINE_TEXT_CHARS,
  timelineKindOf,
  type KnowledgeTimeline,
  type KnowledgeTimelineItem,
} from "@/lib/knowledge-timeline-types";

/**
 * Everything that happened with one person, newest first: the messages, notes and meetings
 * logged against them, and the events you were both at.
 *
 * Scoped by `user_id` on every statement, so a contact id that isn't the caller's yields an
 * empty timeline rather than someone else's history. Text is cut in SQL (`left`) so a pasted
 * multi-KB note never crosses the wire to be sliced in JavaScript, and it is raw user text:
 * callers render it as plain text and must not hand it to a model from here.
 *
 * Job changes are not a separate source: they are stored as `job_change` interactions, so
 * they already arrive with the rest. The profile's own `notes` field is not a dated event and
 * lives in the dossier's facts instead.
 */
export async function loadKnowledgeTimeline(
  userId: string,
  contactId: string
): Promise<KnowledgeTimeline> {
  const db = await getDb();

  const [rows, events] = await Promise.all([
    db
      .select({
        id: interactions.id,
        type: interactions.interactionType,
        date: interactions.interactionDate,
        source: interactions.source,
        direction: interactions.direction,
        aiSummary: sql<string | null>`left(${interactions.aiSummary}::text, ${KNOWLEDGE_TIMELINE_TEXT_CHARS})`,
        rawNotes: sql<string | null>`left(${interactions.rawNotes}::text, ${KNOWLEDGE_TIMELINE_TEXT_CHARS})`,
      })
      .from(interactions)
      .where(and(eq(interactions.userId, userId), eq(interactions.contactId, contactId)))
      .orderBy(desc(interactions.interactionDate), asc(interactions.sameDayOrder))
      // One extra row says whether there is more, without counting anything.
      .limit(KNOWLEDGE_TIMELINE_LIMIT + 1)
      .catch(() => []),
    listEventsTogetherForContact(userId, contactId, 20).catch(() => []),
  ]);

  const truncated = rows.length > KNOWLEDGE_TIMELINE_LIMIT;

  const items: KnowledgeTimelineItem[] = rows.slice(0, KNOWLEDGE_TIMELINE_LIMIT).map((r) => ({
    id: `i:${r.id}`,
    kind: timelineKindOf(r.type),
    date: new Date(r.date).toISOString(),
    type: r.type,
    title: null,
    text: r.aiSummary?.trim() || r.rawNotes?.trim() || null,
    source: r.source,
    direction: r.direction === "in" || r.direction === "out" ? r.direction : null,
  }));

  // An event older than the oldest row we kept would sit in a gap the page says it cut off.
  const oldestKept = truncated ? new Date(items[items.length - 1].date).getTime() : -Infinity;
  for (const e of events) {
    if (!e.startsAt) continue;
    const at = new Date(e.startsAt);
    if (at.getTime() < oldestKept) continue;
    items.push({
      id: `e:${e.eventId}`,
      kind: "event",
      date: at.toISOString(),
      type: null,
      title: e.title,
      text: e.spokeTo ? "You spoke with them there." : null,
      source: "events",
      direction: null,
    });
  }

  // Array.sort is stable, so same-day interactions keep their manual order.
  items.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  return { items, truncated };
}
