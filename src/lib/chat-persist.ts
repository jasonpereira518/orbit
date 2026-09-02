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
 * Store the assistant's turn and title the thread. Shared by the streaming route and the
 * server action; a no-op (null ids) when the question was asked outside a thread.
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
