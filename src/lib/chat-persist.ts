import { and, desc, eq } from "drizzle-orm";
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
 * Store both halves of a completed exchange and title the thread. Shared by the streaming
 * route and the server action; a no-op (null ids) when the question was asked outside a
 * thread.
 *
 * The CALLER writes the user's row, not this function. Both callers need its id and its
 * `attachedContacts` before the model runs, and a version request has to write it into the
 * slot it is versioning (`resolveVersionTarget`), so the write cannot move in here —
 * attempting it wrote the question into the thread twice, the unversioned copy being the
 * one a reloaded thread rendered.
 *
 * What a failed send must not leave behind is that row with no answer under it: it looks
 * exactly like a conversation the assistant ignored, and `prepareChatContext` feeds the
 * last PRIOR_TURN_LIMIT (8) messages back to the model, so once a key was finally added
 * the first real answer came preceded by up to eight unanswered questions. With no AI key
 * configured, every send produced one. `discardUnansweredQuestion` below is what clears
 * it, called from both callers' failure paths.
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

/**
 * Remove a question whose turn failed before any answer was stored.
 *
 * Narrow on purpose: it deletes the one row by id, and only while it is still the LAST
 * message in its thread. A retry that already landed an answer, or a later turn, leaves
 * the question exactly where it is — a question with an answer under it is a real part of
 * the conversation, however the first attempt went.
 */
export async function discardUnansweredQuestion(
  userId: string,
  threadId: string | null,
  messageId: string | null
) {
  if (!threadId || !messageId) return;
  const db = await getDb();
  const last = await db.query.chatMessages.findFirst({
    where: and(eq(chatMessages.threadId, threadId), eq(chatMessages.userId, userId)),
    orderBy: [desc(chatMessages.createdAt)],
    columns: { id: true, role: true },
  });
  if (last?.id !== messageId || last.role !== "user") return;
  await db
    .delete(chatMessages)
    .where(and(eq(chatMessages.id, messageId), eq(chatMessages.userId, userId)));
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
