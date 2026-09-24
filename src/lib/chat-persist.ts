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
    /**
     * Set for a version request: writes the assistant row into this slot/version, inactive,
     * and flips exactly it and its paired user row active once it lands — see
     * `@/lib/chat-versions`. Omitted for an ordinary new turn, which leaves `slot` null (the
     * column default) exactly like a row from before this feature — `resolveVersionTarget`
     * backfills a real slot for BOTH rows of a pair together, the first time either is
     * edited or regenerated, so a half-backfilled pair (one row slotted, its partner not)
     * can never happen.
     */
    version?: { slot: string; version: number; userMessageId: string };
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
      ...(turn.version
        ? { slot: turn.version.slot, version: turn.version.version, isActive: false }
        : {}),
    })
    .returning();
  if (turn.version && assistantMessage) {
    const { activateVersion } = await import("@/lib/chat-versions");
    await activateVersion(db, threadId, turn.version.slot, turn.version.userMessageId, assistantMessage.id);
  }
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
