import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { chatMessages, chatThreads, type ChatRecommendation } from "@/db/schema";

const TITLE_MAX = 72;

export function titleFromQuestion(question: string) {
  const trimmed = question.trim().replace(/\s+/g, " ");
  if (trimmed.length <= TITLE_MAX) return trimmed;
  return `${trimmed.slice(0, TITLE_MAX - 1).trimEnd()}…`;
}

/**
 * Store both halves of a completed exchange and title the thread. Shared by the streaming
 * route and the server action; a no-op (null ids) when the question was asked outside a
 * thread.
 *
 * The user's message is written HERE, not when the request arrives. Both callers used to
 * insert it up front, before the model was called, and neither rolled it back when the
 * call failed — so a failed send left the question sitting in the thread with no answer
 * and no failure marker, looking exactly like a conversation the assistant had ignored.
 * With no AI key configured, every send produced one.
 *
 * Those orphans were not merely cosmetic: `prepareChatContext` feeds the last
 * PRIOR_TURN_LIMIT (8) messages back to the model, so once a key was finally added, the
 * first real answer came preceded by up to eight unanswered questions.
 */
export async function persistAssistantTurn(
  userId: string,
  threadId: string | null,
  existingTitle: string | null,
  question: string,
  turn: { answer: string; recommendations: ChatRecommendation[] }
): Promise<{ messageId: string | null; title: string | null }> {
  if (!threadId) return { messageId: null, title: existingTitle };
  const db = await getDb();
  await db
    .insert(chatMessages)
    .values({ threadId, userId, role: "user", content: question });
  const [assistantMessage] = await db
    .insert(chatMessages)
    .values({
      threadId,
      userId,
      role: "assistant",
      content: turn.answer,
      recommendations: turn.recommendations,
    })
    .returning();
  const title = existingTitle || titleFromQuestion(question);
  await db
    .update(chatThreads)
    .set({ updatedAt: new Date(), title })
    .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)));
  return { messageId: assistantMessage?.id ?? null, title };
}

/**
 * Remove a thread that was auto-created for a turn that then failed, leaving it empty.
 *
 * The client calls `ensureThread()` before sending, so a failed first send used to leave
 * a permanent, untitled "New chat" in the history — the title is only ever set by
 * `persistAssistantTurn`, which never runs on the failure path. Only ever deletes a
 * thread with no messages at all, so an existing conversation is never touched.
 */
export async function discardEmptyThread(userId: string, threadId: string | null) {
  if (!threadId) return;
  const db = await getDb();
  const existing = await db.query.chatMessages.findFirst({
    where: and(eq(chatMessages.threadId, threadId), eq(chatMessages.userId, userId)),
    columns: { id: true },
  });
  if (existing) return;
  await db
    .delete(chatThreads)
    .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)));
}
