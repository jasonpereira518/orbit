"use server";

import { and, asc, desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  chatMessages,
  chatThreads,
  contacts,
  interactions,
  type ChatRecommendation,
} from "@/db/schema";
import { chatWithNetwork } from "@/lib/ai";
import { clientAvatarUrlSql } from "@/lib/contact-avatar-sql";
import { requireUserId } from "@/lib/auth";
import { prepareChatContext } from "@/lib/chat-context";
import {
  buildChatSuggestions,
  GENERIC_SUGGESTIONS,
  GENERIC_RANK,
  type ChatSuggestion,
} from "@/lib/chat-suggestions";
import { loadSuggestionSignals } from "@/lib/chat-suggestions-data";
import { persistAssistantTurn } from "@/lib/chat-persist";
import { requireUserForSurface } from "@/lib/plan-guards";
import { traced } from "@/lib/perf-trace";
import { RATE_LIMITS, consumeBucket } from "@/lib/rate-limit";
import { friendlyError } from "@/lib/errors";
import { TOAST_COPY } from "@/lib/toast-copy";




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
    throw new Error(friendlyError(err, TOAST_COPY.chatStartFailed));
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
  options?: { threadId?: string; contactId?: string; contextContactIds?: string[] }
) {
  // Traced because this is the one action with no upper bound of its own: retrieval plus
  // a full model completion, on a user's own key. A slow provider used to be invisible.
  return traced("chat.askNetwork", () => askNetworkInner(question, options));
}

async function askNetworkInner(
  question: string,
  options?: { threadId?: string; contactId?: string; contextContactIds?: string[] }
) {
  try {
    const userId = await requireUserForSurface("page.chat");
    await consumeBucket("chat", userId, RATE_LIMITS.chat);
    const db = await getDb();
    const threadId = options?.threadId ?? null;

    // Everything the model is shown, with the independent lookups running side by side.
    // Shared with the streaming route so the two paths cannot drift.
    const ctx = await prepareChatContext(userId, question, {
      threadId,
      focusContactId: options?.contactId,
      contextContactIds: options?.contextContactIds,
    });

    if (threadId) {
      await db.insert(chatMessages).values({
        threadId,
        userId,
        role: "user",
        content: ctx.q,
        attachedContacts: ctx.attachedPeople.map((p) => ({ id: p.id, name: p.name })),
      });
    }

    const result = await chatWithNetwork(
      userId,
      ctx.scopedQuestion,
      ctx.modelContacts,
      ctx.priorTurns,
      ctx.orgRosters,
      ctx.attention,
      ctx.modelRecruiters,
      ctx.focusProfile,
      ctx.attachedContext
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
    // Returned as data, so unlike a throw it is never stripped in production — which
    // made `toUserFacingError` (it keeps `err.message`) a leak that reached users. On the
    // server the real error is still in hand, so `friendlyError` can recognise a genuine
    // missing key; the key message is no longer the fallback for every other failure.
    return {
      ok: false as const,
      error: friendlyError(err, TOAST_COPY.chatFailed),
    };
  }
}

/**
 * The personalised cards under the composer, best first.
 *
 * Guarded with `requireUserId`, deliberately **not** `requireUserForSurface("page.chat")`
 * like its neighbours: the floating ask bar shows the same suggestions and is mounted by
 * `AppShell` on nearly every route, so a user whose chat surface is hidden would otherwise
 * get a thrown action while sitting on `/contacts`.
 *
 * Never throws. A failure here should cost the user their personalisation, not their
 * composer, so anything going wrong falls back to the four generic questions.
 */
export async function getChatSuggestions(): Promise<ChatSuggestion[]> {
  try {
    const userId = await requireUserId();
    const signals = await loadSuggestionSignals(userId);
    return buildChatSuggestions(signals);
  } catch {
    return GENERIC_SUGGESTIONS.map((question, i) => ({
      id: `generic:${i}`,
      kind: "generic" as const,
      question,
      basis: "",
      contactIds: [],
      interactionType: null,
      rank: GENERIC_RANK,
    }));
  }
}

/** One meeting/call/note the composer's tools menu can pull into a question. */
export type EventPickerOption = {
  id: string;
  contactId: string;
  contactName: string;
  /** Drives the gendered fallback illustration when there is no photo. */
  contactFirstName: string | null;
  /**
   * Browser-safe already, decided in Postgres.
   *
   * Never `profile_image_url` itself: that column holds base64 up to 120 KB a row when Blob
   * storage is unconfigured, so a 25-row picker would drag the bytes out of the database
   * only to rewrite them to `/api/avatars/{id}`.
   */
  contactAvatarUrl: string | null;
  interactionType: string;
  interactionDate: string;
  summary: string | null;
};

/**
 * Recent interactions for the composer's tools menu — the "events" half of `+`.
 *
 * Mirrors `searchContactsForPicker`: a bounded, searchable slice rather than the whole
 * history. Searches the person's name and the interaction's own text, because "the coffee
 * with Marcus" and "that intro call" are both how people actually refer to a meeting.
 */
export async function searchEventsForPicker(
  q?: string,
  limit = 25
): Promise<EventPickerOption[]> {
  const userId = await requireUserForSurface("page.chat");
  const db = await getDb();

  const term = q?.trim();
  const conditions = [eq(interactions.userId, userId)];
  if (term) {
    const like = `%${term.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    conditions.push(
      sql`(${contacts.fullName} ILIKE ${like}
        OR coalesce(${contacts.preferredName}, '') ILIKE ${like}
        OR coalesce(${interactions.aiSummary}, '') ILIKE ${like}
        OR coalesce(${interactions.rawNotes}, '') ILIKE ${like}
        OR ${interactions.interactionType} ILIKE ${like})`
    );
  }

  const rows = await db
    .select({
      id: interactions.id,
      contactId: interactions.contactId,
      fullName: contacts.fullName,
      preferredName: contacts.preferredName,
      firstName: contacts.firstName,
      avatarUrl: clientAvatarUrlSql.as("avatar_url"),
      interactionType: interactions.interactionType,
      interactionDate: interactions.interactionDate,
      aiSummary: interactions.aiSummary,
      rawNotes: interactions.rawNotes,
    })
    .from(interactions)
    .innerJoin(contacts, eq(contacts.id, interactions.contactId))
    .where(and(...conditions))
    .orderBy(desc(interactions.interactionDate), desc(interactions.sameDayOrder))
    .limit(Math.min(Math.max(limit, 1), 50));

  return rows.map((r) => ({
    id: r.id,
    contactId: r.contactId,
    contactName: r.preferredName?.trim() || r.fullName,
    contactFirstName: r.firstName,
    contactAvatarUrl: r.avatarUrl,
    interactionType: r.interactionType,
    interactionDate: r.interactionDate.toISOString(),
    // A one-line gist; the picker is a list, not a reader.
    summary:
      r.aiSummary?.trim() ||
      r.rawNotes?.trim().split("\n")[0]?.slice(0, 120) ||
      null,
  }));
}
