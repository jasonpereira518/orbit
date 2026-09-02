"use server";

import { and, asc, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
  chatMessages,
  chatThreads,
  type ChatRecommendation,
} from "@/db/schema";
import { chatWithNetwork } from "@/lib/ai";
import { prepareChatContext } from "@/lib/chat-context";
import { persistAssistantTurn } from "@/lib/chat-persist";
import { requireUserForSurface } from "@/lib/plan-guards";
import { traced } from "@/lib/perf-trace";




export async function listChatThreads() {
  const userId = await requireUserForSurface("page.chat");
  const db = await getDb();
  return db.query.chatThreads.findMany({
    where: eq(chatThreads.userId, userId),
    orderBy: [desc(chatThreads.updatedAt)],
    columns: {
      id: true,
      title: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

export async function getChatThread(threadId: string) {
  const userId = await requireUserForSurface("page.chat");
  const db = await getDb();

  const thread = await db.query.chatThreads.findFirst({
    where: and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)),
  });
  if (!thread) throw new Error("Chat not found");

  const messages = await db.query.chatMessages.findMany({
    where: and(
      eq(chatMessages.threadId, threadId),
      eq(chatMessages.userId, userId)
    ),
    orderBy: [asc(chatMessages.createdAt)],
  });

  return { thread, messages };
}

export async function createChatThread() {
  try {
    const userId = await requireUserForSurface("page.chat");
    const db = await getDb();
    const [row] = await db.insert(chatThreads).values({ userId }).returning();
    if (!row) throw new Error("Could not create chat thread");
    return {
      id: row.id,
      title: row.title,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  } catch (err) {
    const { toUserFacingError } = await import("@/lib/errors");
    throw toUserFacingError(err, "Could not start a new chat");
  }
}

export async function deleteChatThread(threadId: string) {
  const userId = await requireUserForSurface("page.chat");
  const db = await getDb();
  const existing = await db.query.chatThreads.findFirst({
    where: and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)),
    columns: { id: true },
  });
  if (!existing) throw new Error("Chat not found");
  await db
    .delete(chatThreads)
    .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)));
  return { ok: true as const };
}

export async function askNetwork(
  question: string,
  options?: { threadId?: string; contactId?: string }
) {
  // Traced because this is the one action with no upper bound of its own: retrieval plus
  // a full model completion, on a user's own key. A slow provider used to be invisible.
  return traced("chat.askNetwork", () => askNetworkInner(question, options));
}

async function askNetworkInner(
  question: string,
  options?: { threadId?: string; contactId?: string }
) {
  try {
    const userId = await requireUserForSurface("page.chat");
    const db = await getDb();
    const threadId = options?.threadId ?? null;

    // Everything the model is shown, with the independent lookups running side by side.
    // Shared with the streaming route so the two paths cannot drift.
    const ctx = await prepareChatContext(userId, question, {
      threadId,
      focusContactId: options?.contactId,
    });

    if (threadId) {
      await db.insert(chatMessages).values({ threadId, userId, role: "user", content: ctx.q });
    }

    const result = await chatWithNetwork(
      userId,
      ctx.scopedQuestion,
      ctx.modelContacts,
      ctx.priorTurns,
      ctx.orgRosters,
      ctx.attention,
      ctx.modelRecruiters
    );
    const recommendations = ctx.filterRecommendations(
      (result.recommendations || []) as ChatRecommendation[]
    );

    const saved = await persistAssistantTurn(userId, threadId, ctx.thread?.title ?? null, ctx.q, {
      answer: result.answer,
      recommendations,
    });

    return {
      ok: true as const,
      threadId,
      title: saved.title,
      messageId: saved.messageId,
      answer: result.answer,
      recommendations,
      retrieved: ctx.retrieved.map((c) => ({
        id: c.id,
        fullName: c.fullName,
        company: c.company,
        title: c.title,
        relevance: c.relevance,
      })),
      focusedContactId: options?.contactId?.trim() || null,
    };
  } catch (err) {
    const { MISSING_AI_API_KEY_MESSAGE, toUserFacingError } = await import(
      "@/lib/errors"
    );
    return {
      ok: false as const,
      error: toUserFacingError(err, MISSING_AI_API_KEY_MESSAGE).message,
    };
  }
}
