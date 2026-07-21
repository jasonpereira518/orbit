"use server";

import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import {
  chatMessages,
  chatThreads,
  interactions,
  type ChatRecommendation,
} from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import { chatWithNetwork } from "@/lib/ai";
import { semanticSearchContacts } from "@/lib/search";

const TITLE_MAX = 72;
const PRIOR_TURN_LIMIT = 8;

async function loadKnowledgeSnippets(
  userId: string,
  contactIds: string[]
): Promise<Map<string, { recentMessages: string[] }>> {
  const result = new Map<string, { recentMessages: string[] }>();
  if (!contactIds.length) return result;

  const db = await getDb();
  const msgs = await db.query.interactions.findMany({
    where: and(
      eq(interactions.userId, userId),
      inArray(interactions.contactId, contactIds),
      eq(interactions.interactionType, "linkedin_message")
    ),
    orderBy: [desc(interactions.interactionDate)],
    limit: contactIds.length * 8,
  });

  const byContact = new Map<string, string[]>();
  for (const m of msgs) {
    const list = byContact.get(m.contactId) || [];
    if (list.length >= 6) continue;
    const text = (m.aiSummary || m.rawNotes || "").trim();
    if (!text) continue;
    list.push(text.slice(0, 280));
    byContact.set(m.contactId, list);
  }

  for (const id of contactIds) {
    result.set(id, {
      recentMessages: byContact.get(id) || [],
    });
  }
  return result;
}

function titleFromQuestion(question: string) {
  const trimmed = question.trim().replace(/\s+/g, " ");
  if (trimmed.length <= TITLE_MAX) return trimmed;
  return `${trimmed.slice(0, TITLE_MAX - 1).trimEnd()}…`;
}

export async function listChatThreads() {
  const userId = await requireUserId();
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
  const userId = await requireUserId();
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
  const userId = await requireUserId();
  const db = await getDb();
  const [row] = await db.insert(chatThreads).values({ userId }).returning();
  return row;
}

export async function deleteChatThread(threadId: string) {
  const userId = await requireUserId();
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
  options?: { threadId?: string }
) {
  const userId = await requireUserId();
  const db = await getDb();
  const q = question.trim();
  if (!q) throw new Error("Question is required");

  const threadId = options?.threadId;
  let thread =
    threadId != null
      ? await db.query.chatThreads.findFirst({
          where: and(
            eq(chatThreads.id, threadId),
            eq(chatThreads.userId, userId)
          ),
        })
      : null;

  if (threadId && !thread) throw new Error("Chat not found");

  const priorTurns =
    threadId != null
      ? (
          await db.query.chatMessages.findMany({
            where: and(
              eq(chatMessages.threadId, threadId),
              eq(chatMessages.userId, userId)
            ),
            orderBy: [desc(chatMessages.createdAt)],
            limit: PRIOR_TURN_LIMIT,
            columns: { role: true, content: true },
          })
        )
          .reverse()
          .map((m) => ({ role: m.role, content: m.content }))
      : [];

  if (threadId) {
    await db.insert(chatMessages).values({
      threadId,
      userId,
      role: "user",
      content: q,
    });
  }

  const retrieved = await semanticSearchContacts(userId, q, 12);
  const snippets = await loadKnowledgeSnippets(
    userId,
    retrieved.map((c) => c.id)
  );

  const result = await chatWithNetwork(
    userId,
    q,
    retrieved.map((c) => ({
      id: c.id,
      fullName: c.fullName,
      company: c.company,
      title: c.title,
      relationshipScore: c.relationshipScore,
      aiSummary: c.aiSummary,
      notes: c.notes,
      keyFacts: c.keyFacts || [],
      recentMessages: snippets.get(c.id)?.recentMessages || [],
      tags: c.tags,
      relevance: c.relevance,
    })),
    priorTurns
  );

  const allowed = new Set(retrieved.map((c) => c.id));
  const recommendations = (result.recommendations || []).filter((r) =>
    allowed.has(r.contact_id)
  ) as ChatRecommendation[];

  let messageId: string | undefined;
  let title: string | null | undefined = thread?.title;

  if (threadId) {
    const [assistantMessage] = await db
      .insert(chatMessages)
      .values({
        threadId,
        userId,
        role: "assistant",
        content: result.answer,
        recommendations,
      })
      .returning();
    messageId = assistantMessage.id;

    const nextTitle = thread?.title || titleFromQuestion(q);
    await db
      .update(chatThreads)
      .set({
        updatedAt: new Date(),
        title: nextTitle,
      })
      .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)));
    title = nextTitle;
  }

  return {
    threadId,
    title: title ?? null,
    messageId,
    answer: result.answer,
    recommendations,
    retrieved: retrieved.map((c) => ({
      id: c.id,
      fullName: c.fullName,
      company: c.company,
      title: c.title,
      relevance: c.relevance,
    })),
  };
}
