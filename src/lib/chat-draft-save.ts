import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { chatMessages, contacts, type ChatRecommendation } from "@/db/schema";
import { DRAFT_MAX_CHARS } from "@/lib/chat-draft";

/**
 * Keep the draft a person is working on, on the answer it belongs to, so it survives a reload.
 *
 * It is stored as `edited_draft` on that person's entry in the message's `recommendations`.
 * A person the answer only placed inline has no entry yet, so one is added for them: the
 * card already looks its entry up by contact id, and the grid leaves inline people out.
 *
 * The write is guarded by the JSON the read just saw, like a proposed action's (see
 * `claim` in `@/actions/chat-actions`): two tabs saving at once cannot interleave into a
 * corrupt array. The loser returns false and its text stays in its own tab.
 */
export async function saveDraftEdit(
  userId: string,
  messageId: string,
  contactId: string,
  text: string
): Promise<boolean> {
  const draft = text.slice(0, DRAFT_MAX_CHARS);
  const db = await getDb();
  const row = await db.query.chatMessages.findFirst({
    where: and(eq(chatMessages.id, messageId), eq(chatMessages.userId, userId), eq(chatMessages.role, "assistant")),
    columns: { recommendations: true },
  });
  if (!row) return false;
  const recs: ChatRecommendation[] = row.recommendations ?? [];
  const index = recs.findIndex((r) => r.contact_id === contactId);
  const next = recs.slice();
  if (index >= 0) {
    next[index] = { ...recs[index]!, edited_draft: draft.trim() ? draft : null };
  } else {
    if (!draft.trim()) return true;
    // Only one of this person's own contacts can be added to their answer.
    const contact = await db.query.contacts.findFirst({
      where: and(eq(contacts.id, contactId), eq(contacts.userId, userId)),
      columns: { fullName: true },
    });
    if (!contact) return false;
    next.push({
      contact_id: contactId,
      recruiter_id: null,
      name: contact.fullName,
      reason: "",
      suggested_action: "",
      draft_message: null,
      edited_draft: draft,
    });
  }
  const before = JSON.stringify(recs);
  const updated = await db
    .update(chatMessages)
    .set({ recommendations: next })
    .where(
      and(
        eq(chatMessages.id, messageId),
        eq(chatMessages.userId, userId),
        row.recommendations === null
          ? sql`${chatMessages.recommendations} IS NULL`
          : sql`${chatMessages.recommendations} = ${before}::jsonb`
      )
    )
    .returning(); // bare: a field selector breaks over the Db union
  return updated.length > 0;
}
