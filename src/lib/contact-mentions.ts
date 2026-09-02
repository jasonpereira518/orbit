import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts, interactionMentions, interactions } from "@/db/schema";

export type ContactMentionRow = { interactionId: string; interactionDate: Date; line: string; otherContactId: string; otherContactName: string; mentionText: string };

function oneLine(aiSummary: string | null, rawNotes: string | null) {
  const text = (aiSummary || rawNotes || "").trim();
  const line = text.split(/\n/)[0]?.trim() || text;
  return line.length > 140 ? `${line.slice(0, 137)}…` : line;
}

/** Both directions: notes about others that name this contact, and this contact's notes that name others. */
export async function listContactMentions(userId: string, contactId: string) {
  const db = await getDb();
  const mentionedIn = await db
    .select({ interactionId: interactions.id, interactionDate: interactions.interactionDate, aiSummary: interactions.aiSummary, rawNotes: interactions.rawNotes, otherContactId: contacts.id, otherContactName: contacts.fullName, mentionText: interactionMentions.mentionText })
    .from(interactionMentions)
    .innerJoin(interactions, eq(interactions.id, interactionMentions.interactionId))
    .innerJoin(contacts, eq(contacts.id, interactions.contactId))
    .where(and(eq(interactionMentions.userId, userId), eq(interactionMentions.contactId, contactId)))
    .orderBy(desc(interactions.interactionDate))
    .limit(20);
  const mentions = await db
    .select({ interactionId: interactions.id, interactionDate: interactions.interactionDate, aiSummary: interactions.aiSummary, rawNotes: interactions.rawNotes, otherContactId: contacts.id, otherContactName: contacts.fullName, mentionText: interactionMentions.mentionText })
    .from(interactionMentions)
    .innerJoin(interactions, eq(interactions.id, interactionMentions.interactionId))
    .innerJoin(contacts, eq(contacts.id, interactionMentions.contactId))
    .where(and(eq(interactionMentions.userId, userId), eq(interactions.contactId, contactId)))
    .orderBy(desc(interactions.interactionDate))
    .limit(20);
  const shape = (r: (typeof mentionedIn)[number]): ContactMentionRow => ({ interactionId: r.interactionId, interactionDate: r.interactionDate, line: oneLine(r.aiSummary, r.rawNotes), otherContactId: r.otherContactId, otherContactName: r.otherContactName, mentionText: r.mentionText });
  return { mentionedIn: mentionedIn.map(shape), mentions: mentions.map(shape) };
}

/**
 * Batched version of `listContactMentions` for chat grounding: two queries total regardless
 * of how many contacts are asked about, not two per contact. `inArray` cannot cap rows per
 * group, so each query is bounded by `contactIds.length * 5` and truncated to 3 per contact
 * per direction in memory — both result sets are already ordered by interaction date desc,
 * so `slice(0, 3)` per group is correct without a re-sort.
 */
export async function listContactMentionsBatch(
  userId: string,
  contactIds: string[]
): Promise<Map<string, { mentionedByLines: string[]; mentionsOfLines: string[] }>> {
  const result = new Map<string, { mentionedByLines: string[]; mentionsOfLines: string[] }>();
  if (!contactIds.length) return result;
  const db = await getDb();
  const cap = contactIds.length * 5;

  const mentionedByRows = await db
    .select({ targetContactId: interactionMentions.contactId, otherName: contacts.fullName, interactionDate: interactions.interactionDate })
    .from(interactionMentions)
    .innerJoin(interactions, eq(interactions.id, interactionMentions.interactionId))
    .innerJoin(contacts, eq(contacts.id, interactions.contactId))
    .where(and(eq(interactionMentions.userId, userId), inArray(interactionMentions.contactId, contactIds)))
    .orderBy(desc(interactions.interactionDate))
    .limit(cap);

  const mentionsOfRows = await db
    .select({ sourceContactId: interactions.contactId, otherName: contacts.fullName, interactionDate: interactions.interactionDate })
    .from(interactionMentions)
    .innerJoin(interactions, eq(interactions.id, interactionMentions.interactionId))
    .innerJoin(contacts, eq(contacts.id, interactionMentions.contactId))
    .where(and(eq(interactionMentions.userId, userId), inArray(interactions.contactId, contactIds)))
    .orderBy(desc(interactions.interactionDate))
    .limit(cap);

  const ensure = (id: string) => {
    if (!result.has(id)) result.set(id, { mentionedByLines: [], mentionsOfLines: [] });
    return result.get(id)!;
  };
  for (const r of mentionedByRows) {
    const entry = ensure(r.targetContactId);
    if (entry.mentionedByLines.length < 3) entry.mentionedByLines.push(r.otherName);
  }
  for (const r of mentionsOfRows) {
    const entry = ensure(r.sourceContactId);
    if (entry.mentionsOfLines.length < 3) entry.mentionsOfLines.push(r.otherName);
  }
  return result;
}
