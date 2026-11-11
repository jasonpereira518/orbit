import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { chatMessages, contacts, type ChatRecommendation } from "@/db/schema";
import { DRAFT_MAX_CHARS } from "@/lib/chat-draft";
import { draftBlocksIn, replaceDraftBlock } from "@/lib/chat-draft-block";

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

/**
 * Keep an edit to a draft block written in the answer's text (`@/lib/chat-draft-block`): the
 * `index`th block's subject and body are rewritten in the saved answer, so a reload and the
 * next turn both read the edited words. No model call — it is a text rewrite.
 *
 * Guarded by the content the read just saw, like `saveDraftEdit`: two tabs saving at once
 * cannot interleave; the loser returns `saved: false` and its text stays in its own tab.
 * Returns what was stored (cleaned, capped) so the editor can show exactly that.
 */
export async function saveDraftBlockEdit(
  userId: string,
  messageId: string,
  index: number,
  edit: { subject?: unknown; body: unknown }
): Promise<{ saved: boolean; subject?: string; body?: string }> {
  if (!Number.isInteger(index) || index < 0) return { saved: false };
  const db = await getDb();
  const row = await db.query.chatMessages.findFirst({
    where: and(eq(chatMessages.id, messageId), eq(chatMessages.userId, userId), eq(chatMessages.role, "assistant")),
    columns: { content: true },
  });
  if (!row?.content) return { saved: false };
  const next = replaceDraftBlock(row.content, index, edit);
  if (next === null) return { saved: false };
  const after = draftBlocksIn(next)[index]!;
  if (next !== row.content) {
    const updated = await db
      .update(chatMessages)
      .set({ content: next })
      .where(and(eq(chatMessages.id, messageId), eq(chatMessages.userId, userId), eq(chatMessages.content, row.content)))
      .returning(); // bare: a field selector breaks over the Db union
    if (updated.length === 0) return { saved: false };
  }
  return { saved: true, subject: after.subject, body: after.body };
}
