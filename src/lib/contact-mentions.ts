import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts, interactionMentions, interactions } from "@/db/schema";
import { settle, unwrap } from "@/lib/settled";

export type ContactMentionRow = { interactionId: string; interactionDate: Date; line: string; otherContactId: string; otherContactName: string; mentionText: string };

function oneLine(aiSummary: string | null, rawNotes: string | null) {
  const text = (aiSummary || rawNotes || "").trim();
  const line = text.split(/\n/)[0]?.trim() || text;
  return line.length > 140 ? `${line.slice(0, 137)}…` : line;
}

/** Both directions: notes about others that name this contact, and this contact's notes that name others. */
export async function listContactMentions(userId: string, contactId: string) {
  const db = await getDb();
  // The two directions are independent reads: started together, taken in the old order.
  const mentionedInRead = settle(db
    .select({ interactionId: interactions.id, interactionDate: interactions.interactionDate, aiSummary: interactions.aiSummary, rawNotes: interactions.rawNotes, otherContactId: contacts.id, otherContactName: contacts.fullName, mentionText: interactionMentions.mentionText })
    .from(interactionMentions)
    .innerJoin(interactions, eq(interactions.id, interactionMentions.interactionId))
    .innerJoin(contacts, eq(contacts.id, interactions.contactId))
    .where(and(eq(interactionMentions.userId, userId), eq(interactionMentions.contactId, contactId)))
    .orderBy(desc(interactions.interactionDate))
    .limit(20));
  const mentionsRead = settle(db
    .select({ interactionId: interactions.id, interactionDate: interactions.interactionDate, aiSummary: interactions.aiSummary, rawNotes: interactions.rawNotes, otherContactId: contacts.id, otherContactName: contacts.fullName, mentionText: interactionMentions.mentionText })
    .from(interactionMentions)
    .innerJoin(interactions, eq(interactions.id, interactionMentions.interactionId))
    .innerJoin(contacts, eq(contacts.id, interactionMentions.contactId))
    .where(and(eq(interactionMentions.userId, userId), eq(interactions.contactId, contactId)))
    .orderBy(desc(interactions.interactionDate))
    .limit(20));
  const mentionedIn = unwrap(await mentionedInRead);
  const mentions = unwrap(await mentionsRead);
  const shape = (r: (typeof mentionedIn)[number]): ContactMentionRow => ({ interactionId: r.interactionId, interactionDate: r.interactionDate, line: oneLine(r.aiSummary, r.rawNotes), otherContactId: r.otherContactId, otherContactName: r.otherContactName, mentionText: r.mentionText });
  return { mentionedIn: mentionedIn.map(shape), mentions: mentions.map(shape) };
}
