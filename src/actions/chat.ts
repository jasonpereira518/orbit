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
import { maybeGather } from "@/lib/chat-gather";
import { citedIds, stripUnresolvedMarkers } from "@/lib/chat-evidence";
import { validateProposedActions } from "@/lib/chat-proposed-actions";
import {
  buildChatSuggestions,
  GENERIC_SUGGESTIONS,
  GENERIC_RANK,
  type ChatSuggestion,
} from "@/lib/chat-suggestions";
import { loadSuggestionSignals } from "@/lib/chat-suggestions-data";
import { persistAssistantTurn } from "@/lib/chat-persist";
import { discardCountAfter, loadVersions, switchVersion } from "@/lib/chat-versions";
import { isRefineKind, refineDraft } from "@/lib/chat-refine";
import { loadWritingInstructions } from "@/lib/writing-instructions-store";
import { requireUserForSurface } from "@/lib/plan-guards";
import { traced } from "@/lib/perf-trace";
import { RATE_LIMITS, consumeBucket } from "@/lib/rate-limit";
import { friendlyError } from "@/lib/errors";
import { TOAST_COPY } from "@/lib/toast-copy";
import { actionFailure } from "@/lib/action-failure";




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

  // The thread and its messages together, ownership checked after. Safe because each read
  // carries its own `user_id = caller` predicate: for a thread that is missing or someone
  // else's, the messages read finds nothing of theirs and the throw below is unchanged.
  const [thread, messages] = await Promise.all([
    db.query.chatThreads.findFirst({
      where: and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)),
    }),
    db.query.chatMessages.findMany({
      where: and(
        eq(chatMessages.threadId, threadId),
        eq(chatMessages.userId, userId),
        eq(chatMessages.isActive, true)
      ),
      orderBy: [asc(chatMessages.createdAt)],
    }),
  ]);
  if (!thread) throw new Error("Chat not found");

  // Every version of the LAST turn, for the switcher — only the last turn ever has more than
  // one. `versions` is empty for a thread with no messages or whose last turn was never
  // versioned, which is the common case and costs nothing extra to detect.
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");

  // Which drafts in this thread have already been emailed. Derived, not stored: the send
  // claims an interaction row keyed `chat-send:<messageId>:<contactId>`, so that row IS the
  // record, and a reloaded card cannot offer to send again what the timeline says was sent.
  // Read alongside the versions — both depend only on the messages above.
  const messageIds = new Set(messages.filter((m) => m.role === "assistant").map((m) => m.id));
  const [versions, claims] = await Promise.all([
    lastAssistant?.slot ? loadVersions(db, userId, threadId, lastAssistant.slot) : [],
    messageIds.size > 0
      ? db
          .select({ externalId: interactions.externalId, at: interactions.interactionDate })
          .from(interactions)
          .where(and(eq(interactions.userId, userId), eq(interactions.source, "chat_send")))
          .limit(500)
      : [],
  ]);
  const sent: Record<string, Record<string, string>> = {};
  for (const claim of claims) {
    const match = /^chat-send:([^:]+):([^:]+)$/.exec(claim.externalId ?? "");
    if (!match || !messageIds.has(match[1]!)) continue;
    (sent[match[1]!] ??= {})[match[2]!] = claim.at.toISOString();
  }

  return { thread, messages, sent, versions, versionSlot: lastAssistant?.slot ?? null };
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

export async function updateChatThreadContext(threadId: string, note: string | null) {
  const userId = await requireUserForSurface("page.chat");
  const db = await getDb();
  const trimmed = note?.trim() || null;
  const [row] = await db
    .update(chatThreads)
    .set({ contextNote: trimmed, updatedAt: new Date() })
    .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)))
    .returning();
  if (!row) throw new Error("Chat not found");
  return { contextNote: row.contextNote };
}

/**
 * Thumbs on one answer. Scoped to the user's own rows, and to assistant turns only — there
 * is nothing to rate about your own question.
 *
 * Passing the value already stored clears it, so the same button both sets and un-sets.
 */
export async function setChatMessageFeedback(
  messageId: string,
  value: "up" | "down" | null,
  note?: string | null
) {
  const userId = await requireUserForSurface("page.chat");
  const db = await getDb();
  const existing = await db.query.chatMessages.findFirst({
    where: and(eq(chatMessages.id, messageId), eq(chatMessages.userId, userId)),
    columns: { id: true, role: true, feedback: true },
  });
  if (!existing || existing.role !== "assistant") throw new Error("Answer not found");

  const next = existing.feedback === value ? null : value;
  await db
    .update(chatMessages)
    .set({
      feedback: next,
      // A note only belongs to the rating it was written for; clearing the rating clears it.
      feedbackNote: next ? (note?.trim() || null) : null,
    })
    .where(and(eq(chatMessages.id, messageId), eq(chatMessages.userId, userId)));
  return { feedback: next };
}

/**
 * The snippet behind one citation, fetched at click time rather than stored: `chat_messages`
 * carries only the id, not a copy of the note or interaction it points at (see the `evidence`
 * column). Re-reads the LIVE record, user-scoped, so a deleted or edited source reads as
 * "removed" or shows what it says today rather than a stale echo of what it said when the
 * answer was written.
 */
export async function getEvidenceSnippet(messageId: string, id: string) {
  const userId = await requireUserForSurface("page.chat");
  const db = await getDb();
  const message = await db.query.chatMessages.findFirst({
    where: and(eq(chatMessages.id, messageId), eq(chatMessages.userId, userId), eq(chatMessages.role, "assistant")),
    columns: { evidence: true },
  });
  const source = message?.evidence?.[id];
  if (!source) return { found: false as const };

  if (source.kind === "contact") {
    const contact = await db.query.contacts.findFirst({
      where: and(eq(contacts.id, source.contactId), eq(contacts.userId, userId)),
      columns: { id: true, fullName: true, preferredName: true, aiSummary: true, notes: true },
    });
    if (!contact) return { found: false as const };
    return {
      found: true as const,
      kind: "contact" as const,
      contactId: contact.id,
      contactName: contact.preferredName || contact.fullName,
      snippet: (contact.aiSummary || contact.notes || "").trim().slice(0, 600),
    };
  }

  const row = await db.query.interactions.findFirst({
    where: and(eq(interactions.id, source.sourceId), eq(interactions.userId, userId)),
    columns: { contactId: true, interactionType: true, interactionDate: true, aiSummary: true, rawNotes: true },
  });
  if (!row) return { found: false as const };
  const contact = await db.query.contacts.findFirst({
    where: and(eq(contacts.id, row.contactId), eq(contacts.userId, userId)),
    columns: { id: true, fullName: true, preferredName: true },
  });
  return {
    found: true as const,
    kind: "interaction" as const,
    interactionId: source.sourceId,
    contactId: contact?.id ?? row.contactId,
    contactName: contact ? contact.preferredName || contact.fullName : null,
    interactionType: row.interactionType,
    date: row.interactionDate.toISOString().slice(0, 10),
    snippet: (row.aiSummary || row.rawNotes || "").trim().slice(0, 600),
  };
}

/** How many messages editing `assistantMessageId` would discard — for the confirm dialog. */
export async function previewEditDiscard(assistantMessageId: string) {
  const userId = await requireUserForSurface("page.chat");
  const db = await getDb();
  const message = await db.query.chatMessages.findFirst({
    where: and(eq(chatMessages.id, assistantMessageId), eq(chatMessages.userId, userId), eq(chatMessages.role, "assistant")),
    columns: { threadId: true },
  });
  if (!message) throw new Error("Answer not found");
  const discardCount = await discardCountAfter(db, userId, message.threadId, assistantMessageId);
  return { discardCount };
}

/** Show a different version of the last turn — the `‹ 2/3 ›` switcher. */
export async function switchChatVersion(threadId: string, slot: string, version: number) {
  const userId = await requireUserForSurface("page.chat");
  const db = await getDb();
  const target = await switchVersion(db, userId, threadId, slot, version);
  if (!target) throw new Error("That version was not found");
  return target;
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
  const requestStartedAt = Date.now();
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

    // The same routing as the streaming route, so the two paths cannot answer differently.
    const { evidence, notePassages } = await maybeGather(userId, ctx, { requestStartedAt });

    const result = await chatWithNetwork(
      userId,
      ctx.scopedQuestion,
      ctx.modelContacts,
      ctx.priorTurns,
      ctx.orgRosters,
      ctx.attention,
      ctx.modelRecruiters,
      ctx.focusProfile,
      ctx.attachedContext,
      ctx.goals,
      ctx.attentionLite,
      evidence,
      notePassages,
      ctx.writingInstructions
    );
    const recommendations = ctx.filterRecommendations(
      (result.recommendations || []) as ChatRecommendation[]
    );
    // No stream to clean up after here — the non-streaming path never shows an invented
    // citation before it can be stripped, so this simply never persists one.
    const validIds = new Set(Object.keys(result.evidence));
    const { text: cleanAnswer } = stripUnresolvedMarkers(result.answer, validIds);
    const citedEvidence = Object.fromEntries(citedIds(cleanAnswer).map((id) => [id, result.evidence[id]]));
    const proposedActions = validateProposedActions(result.proposedActions, ctx.allowedContacts, ctx.contactNames);

    const saved = await persistAssistantTurn(userId, threadId, ctx.thread?.title ?? null, ctx.q, {
      answer: cleanAnswer,
      recommendations,
      evidence: citedEvidence,
      proposedActions,
    });

    return {
      ok: true as const,
      threadId,
      title: saved.title,
      messageId: saved.messageId,
      answer: cleanAnswer,
      recommendations,
      proposedActions,
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
      error: await actionFailure(err, TOAST_COPY.chatFailed, "chat.ask-network"),
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

/**
 * Rewrite a draft from a recommendation card: one of a fixed set of chips (Shorter, Warmer,
 * More direct, More formal), never free text — see `chat-refine.ts` for why.
 *
 * Returns the new draft, or a friendly failure that leaves the person's current text alone.
 * The rate bucket is the chat one: this is a fast-tier call, but it is still the user's own
 * key and a button that can be pressed in a loop.
 */
export async function refineChatDraft(draft: string, kind: string) {
  try {
    const userId = await requireUserForSurface("page.chat");
    await consumeBucket("chat", userId, RATE_LIMITS.chat);
    if (!isRefineKind(kind)) return { ok: false as const, error: TOAST_COPY.draftRefineFailed };
    const writingInstructions = await loadWritingInstructions(userId).catch(() => null);
    const next = await refineDraft(userId, { draft, kind, writingInstructions });
    if (!next) return { ok: false as const, error: TOAST_COPY.draftRefineFailed };
    return { ok: true as const, draft: next };
  } catch (err) {
    return {
      ok: false as const,
      error: await actionFailure(err, TOAST_COPY.draftRefineFailed, "chat.refine-draft"),
    };
  }
}
