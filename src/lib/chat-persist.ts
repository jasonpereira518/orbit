import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { chatMessages, chatThreads, type ChatRecommendation } from "@/db/schema";
import type { EvidenceSource } from "@/lib/chat-evidence";
import type { StoredProposedAction } from "@/lib/chat-proposed-actions";
import type { ChatStep } from "@/lib/chat-stream-protocol";

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
  turn: {
    answer: string;
    recommendations: ChatRecommendation[];
    /** The stages this answer actually ran, so a reloaded thread still shows its work. */
    activity?: ChatStep[];
    /**
     * A summary of the first message, when one was written in time. Only ever used to NAME an
     * untitled thread; a thread that already has a title keeps it, so a later turn cannot
     * rename a conversation out from under the person.
     */
    title?: string | null;
    /** Every source actually cited in `answer` — see `@/lib/chat-evidence`. */
    evidence?: Record<string, EvidenceSource>;
    /** Actions this answer proposed — see `@/lib/chat-proposed-actions`. */
    proposedActions?: StoredProposedAction[];
  }
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
      activity: turn.activity ?? [],
      evidence: turn.evidence ?? {},
      proposedActions: turn.proposedActions ?? [],
    })
    .returning();
  // Precedence: the name the thread already has, then a written summary, then the old cut of
  // the first message — which is what a summary that failed or ran late falls back to, so a
  // conversation is never left unnamed.
  const title = existingTitle || turn.title?.trim() || titleFromQuestion(question);
  await db
    .update(chatThreads)
    .set({ updatedAt: new Date(), title })
    .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)));
  return { messageId: assistantMessage?.id ?? null, title };
}
