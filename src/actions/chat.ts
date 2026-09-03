"use server";

import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import {
  chatMessages,
  chatThreads,
  interactions,
  userGoals,
  type ChatRecommendation,
} from "@/db/schema";
import { chatWithNetwork } from "@/lib/ai";
import { getAttentionBrief, isAttentionQuestion } from "@/lib/chat-attention";
import { getClosenessCohort } from "@/lib/closeness-cohort";
import { findOrgRosters } from "@/lib/chat-roster";
import { getQueryEmbedding } from "@/lib/embedding-cache";
import { hybridSearchContacts, type RankedContact } from "@/lib/hybrid-search";
import {
  budgetContactsContext,
  CANDIDATE_POOL,
  rerankCandidates,
  understandQuery,
} from "@/lib/chat-retrieval";
import { isRecruiterIntent } from "@/lib/recruiters";
import { loadRecruitersForChat } from "@/actions/recruiters";
import { requireUserForSurface } from "@/lib/plan-guards";
import { traced } from "@/lib/perf-trace";

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
    const q = question.trim();
    if (!q) throw new Error("Question is required");

    const threadId = options?.threadId;
    const focusContactId = options?.contactId?.trim() || null;
    const thread =
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

    // Stage 0 + 1 in parallel: the query embedding (cached) and the flash-tier
    // query parse. Both are accuracy-only — either can fail without blocking.
    const activeGoals = await db.query.userGoals.findMany({
      where: and(eq(userGoals.userId, userId), eq(userGoals.active, 1)),
      columns: { text: true },
      orderBy: [desc(userGoals.createdAt)],
      limit: 5,
    }).catch(() => []);
    const [queryEmbedding, parsedQuery] = await Promise.all([
      getQueryEmbedding(userId, q).catch(() => null),
      understandQuery(userId, q, activeGoals.map((g) => g.text)),
    ]);

    // Stage 2: wide retrieval. Lexical arms use the raw question (names are
    // typed verbatim); the parse contributes filters and expansion terms.
    const candidates = await hybridSearchContacts(userId, {
      query: q,
      embedding: queryEmbedding,
      filters: parsedQuery.filters,
      expansionTerms: parsedQuery.expansionTerms,
      limit: CANDIDATE_POOL,
    });

    // Stage 3: flash-tier rerank down to the answer set.
    const retrieved = await rerankCandidates(userId, q, candidates);

    if (focusContactId) {
      const { contacts: contactsTable } = await import("@/db/schema");
      const focused = await db.query.contacts.findFirst({
        where: and(
          eq(contactsTable.id, focusContactId),
          eq(contactsTable.userId, userId)
        ),
        with: { contactTags: { with: { tag: true } } },
      });
      if (focused) {
        const focusEntry: RankedContact = {
          id: focused.id,
          fullName: focused.fullName,
          preferredName: focused.preferredName,
          company: focused.company,
          school: focused.school,
          title: focused.title,
          location: focused.location,
          email: focused.email,
          industry: focused.industry,
          notes: focused.notes,
          aiSummary: focused.aiSummary,
          keyFacts: focused.keyFacts || [],
          relationshipScore: focused.relationshipScore,
          priorityLevel: focused.priorityLevel,
          closenessTier: focused.closenessTier,
          tags: focused.contactTags.map((ct) => ct.tag.name),
          rrfScore: 1,
          relevance: 1,
          matchedArms: [],
          filterMatched: true,
        };
        const without = retrieved.filter((c) => c.id !== focusContactId);
        retrieved.splice(0, retrieved.length, focusEntry, ...without.slice(0, 11));
      }
    }

    const snippets = await loadKnowledgeSnippets(
      userId,
      retrieved.map((c) => c.id)
    );

    if (focusContactId) {
      const focusMsgs = await db.query.interactions.findMany({
        where: and(
          eq(interactions.userId, userId),
          eq(interactions.contactId, focusContactId)
        ),
        orderBy: [desc(interactions.interactionDate)],
        limit: 16,
      });
      snippets.set(focusContactId, {
        recentMessages: focusMsgs
          .map((m) => (m.aiSummary || m.rawNotes || "").trim())
          .filter(Boolean)
          .slice(0, 12)
          .map((t) => t.slice(0, 320)),
      });
    }

    const scopedQuestion = focusContactId
      ? `[Focus: answer primarily about the pinned contact id=${focusContactId}. You may use other contacts only for intros/context.]\n\n${q}`
      : q;

    // Exhaustive membership for any organisation the question names — the one thing a
    // relevance-ranked top-K cannot supply. Never fatal: a failure here just means the
    // answer falls back to the retrieved subset.
    const orgRosters = await findOrgRosters(userId, q).catch(() => []);

    // Who the dashboard would say needs attention. Only for questions that ask; see
    // `isAttentionQuestion`. Failure is non-fatal — the answer just loses this grounding.
    const attention = isAttentionQuestion(q)
      ? await getAttentionBrief(
          userId,
          (await getClosenessCohort(userId).catch(() => null))?.interactedIds
        ).catch(() => null)
      : null;

    const recruiterIntent = isRecruiterIntent(q);
    const recruitersForChat = recruiterIntent
      ? await loadRecruitersForChat(q, 8)
      : [];

    const maxScore = Math.max(
      1,
      ...recruitersForChat.map((r) => r.score)
    );

    // Stage 4 prep: context sized by rank under a total budget.
    const budgeted = budgetContactsContext(retrieved, snippets);

    const result = await chatWithNetwork(
      userId,
      scopedQuestion,
      budgeted,
      priorTurns,
      orgRosters,
      attention,
      recruitersForChat.map((r) => ({
        id: r.id,
        fullName: r.fullName,
        firm: r.firm,
        specialty: r.specialty,
        avgRating: r.avgRating,
        logCount: r.logCount,
        personalRating: r.personalRating,
        status: r.status,
        notes: r.notes,
        piiUnlocked: r.piiUnlocked,
        relevance: r.score / maxScore,
      }))
    );

    // Roster and attention contacts are as legitimate a recommendation as retrieved ones —
    // they came from the same user's own rows — so they must not be filtered out for being
    // outside the retrieval pass. But the retrieval side of the allow-list must reflect what
    // the model actually saw, not everything retrieved — budgetContactsContext can drop
    // trailing contacts once the char budget runs out.
    const allowedContacts = new Set([
      ...budgeted.map((c) => c.id),
      ...orgRosters.flatMap((r) => r.people.map((p) => p.id)),
      ...(attention?.overdue.map((c) => c.id) ?? []),
      ...(attention?.suggestions.map((c) => c.id) ?? []),
    ]);
    const allowedRecruiters = new Set(recruitersForChat.map((r) => r.id));
    const recommendations = (result.recommendations || []).filter((r) => {
      if (r.recruiter_id) return allowedRecruiters.has(r.recruiter_id);
      if (r.contact_id) return allowedContacts.has(r.contact_id);
      return false;
    }) as ChatRecommendation[];

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
        .where(
          and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId))
        );
      title = nextTitle;
    }

    return {
      ok: true as const,
      threadId: threadId ?? null,
      title: title ?? null,
      messageId: messageId ?? null,
      answer: result.answer,
      recommendations,
      retrieved: retrieved.map((c) => ({
        id: c.id,
        fullName: c.fullName,
        company: c.company,
        title: c.title,
        relevance: c.relevance,
      })),
      focusedContactId: focusContactId,
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
