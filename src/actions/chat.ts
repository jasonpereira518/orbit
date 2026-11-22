"use server";

import { consumeDailyCap } from "@/lib/rate-limit";
import { and, asc, desc, eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import {
  chatMessages,
  chatThreads,
  contacts,
  interactions,
  meetingSessions,
  meetingTranscriptSegments,
} from "@/db/schema";
import { clientAvatarUrlSql } from "@/lib/contact-avatar-sql";
import { requireUserId } from "@/lib/auth";
import {
  buildChatSuggestions,
  GENERIC_SUGGESTIONS,
  GENERIC_RANK,
  type ChatSuggestion,
} from "@/lib/chat-suggestions";
import { loadSuggestionSignals } from "@/lib/chat-suggestions-data";
import { addTurnSteer, markTurnStopped } from "@/lib/chat-persist";
import { isUuid } from "@/lib/input/ids";
import { saveDraftBlockEdit, saveDraftEdit } from "@/lib/chat-draft-save";
import { addMemory, deleteMemory, listMemories, type ChatMemory } from "@/lib/chat-memory";
import { UserFacingError } from "@/lib/errors";
import { PINNED_THREADS_MAX, pinThread, renameThread, searchThreads, type ThreadSearchHit } from "@/lib/chat-threads";
import { discardCountAfter, loadVersions, switchVersion } from "@/lib/chat-versions";
import { isRefineKind, refineDraft } from "@/lib/chat-refine";
import { loadWritingInstructions } from "@/lib/writing-instructions-store";
import { loadEmailEventSnippet } from "@/lib/chat-evidence-snippet";
import { requireUserForSurface } from "@/lib/plan-guards";
import { RATE_LIMITS, consumeBucket } from "@/lib/rate-limit";
import { friendlyError } from "@/lib/errors";
import { TOAST_COPY } from "@/lib/toast-copy";
import { actionFailure } from "@/lib/action-failure";




/** How many threads the history list reads at a time. */
const CHAT_THREAD_PAGE = 100;

export type ChatThreadRow = {
  id: string;
  title: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** Set when the person pinned it; pinned chats lead the history list. */
  pinnedAt: Date | null;
};

/**
 * One page of the history list, newest first. `nextCursor` is null on the last page;
 * otherwise it is passed back as `before` to read the next (older) page.
 */
export type ChatThreadPage = {
  threads: ChatThreadRow[];
  nextCursor: string | null;
};

const THREAD_CURSOR_RE =
  /^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2}){0,2})?)\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/**
 * The history list: titled threads only, newest first, a page at a time.
 *
 * Untitled threads never reach the list. A thread row is created the moment a question is
 * sent but only gets a title once an answer lands, so an untitled one is a chat that never
 * produced anything — the rail already hid them (see `ChatHistoryRail`), after they had been
 * read and shipped. The one exception the rail made, the thread you are in, is a thread the
 * panel itself created or opened, so it is already in the panel's own list and stays there.
 *
 * Keyset-paged on `(updated_at, id)`: the cursor carries `updated_at` as Postgres's own text
 * so it round-trips at full (microsecond) precision — a JavaScript Date would truncate it and
 * skip threads updated in the same millisecond. One row past the page says whether there is
 * another.
 *
 * The first page also carries every pinned thread (there are at most `PINNED_THREADS_MAX`),
 * so a chat pinned long ago is not stranded on a page nobody has loaded. The cursor is taken
 * from the dated page alone, and the client drops ids it already has.
 */
export async function listChatThreads(before?: string | null): Promise<ChatThreadPage> {
  const userId = await requireUserForSurface("page.chat");
  const db = await getDb();
  let olderThan: SQL | undefined;
  if (before) {
    const match = THREAD_CURSOR_RE.exec(before);
    if (!match) throw new Error("Invalid history cursor");
    olderThan = sql`(${chatThreads.updatedAt}, ${chatThreads.id}) < (${match[1]}::timestamptz, ${match[2]}::uuid)`;
  }
  const rows = await db
    .select({
      id: chatThreads.id,
      title: chatThreads.title,
      createdAt: chatThreads.createdAt,
      updatedAt: chatThreads.updatedAt,
      pinnedAt: chatThreads.pinnedAt,
      cursorAt: sql<string>`${chatThreads.updatedAt}::text`,
    })
    .from(chatThreads)
    .where(
      and(
        eq(chatThreads.userId, userId),
        isNotNull(chatThreads.title),
        sql`btrim(${chatThreads.title}) <> ''`,
        olderThan
      )
    )
    .orderBy(desc(chatThreads.updatedAt), desc(chatThreads.id))
    .limit(CHAT_THREAD_PAGE + 1);
  const page = rows.slice(0, CHAT_THREAD_PAGE);
  const last = page[page.length - 1];
  const listed = new Set(page.map((t) => t.id));
  const pinned = before
    ? []
    : await db
        .select({
          id: chatThreads.id,
          title: chatThreads.title,
          createdAt: chatThreads.createdAt,
          updatedAt: chatThreads.updatedAt,
          pinnedAt: chatThreads.pinnedAt,
        })
        .from(chatThreads)
        .where(and(eq(chatThreads.userId, userId), isNotNull(chatThreads.pinnedAt), isNotNull(chatThreads.title)))
        .orderBy(desc(chatThreads.pinnedAt))
        .limit(PINNED_THREADS_MAX);
  return {
    threads: [
      ...page.map(({ cursorAt: _cursorAt, ...thread }) => thread),
      ...pinned.filter((t) => !listed.has(t.id)),
    ],
    nextCursor: rows.length > CHAT_THREAD_PAGE && last ? `${last.cursorAt}|${last.id}` : null,
  };
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
  //
  // Only THIS thread's claims: the message id is the key's second `:` field, so the read is
  // bounded by the thread's own answers rather than by an arbitrary cut. It used to take the
  // first 500 of the account's claims in no particular order, which for a heavy sender could
  // leave out the very claims this thread needed and offer a sent draft again.
  // `interactions_user_chat_send_idx` (partial, `source = 'chat_send'`) narrows to the
  // account's claims; the key predicate filters those. The regex below still decides.
  const messageIds = new Set(messages.filter((m) => m.role === "assistant").map((m) => m.id));
  const [versions, claims] = await Promise.all([
    lastAssistant?.slot ? loadVersions(db, userId, threadId, lastAssistant.slot) : [],
    messageIds.size > 0
      ? db
          .select({ externalId: interactions.externalId, at: interactions.interactionDate })
          .from(interactions)
          .where(
            and(
              eq(interactions.userId, userId),
              eq(interactions.source, "chat_send"),
              inArray(sql`split_part(${interactions.externalId}, ':', 2)`, [...messageIds])
            )
          )
      : [],
  ]);
  const sent: Record<string, Record<string, string>> = {};
  for (const claim of claims) {
    const match = /^chat-send:([^:]+):([^:]+)$/.exec(claim.externalId ?? "");
    if (!match || !messageIds.has(match[1])) continue;
    (sent[match[1]] ??= {})[match[2]] = claim.at.toISOString();
  }

  return { thread, messages, sent, versions, versionSlot: lastAssistant?.slot ?? null };
}

export async function createChatThread() {
  try {
    const userId = await requireUserForSurface("page.chat");
    await consumeDailyCap("chatThreadDaily", userId);
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

  if (source.kind === "email_event") return loadEmailEventSnippet(userId, source);

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

  if (source.kind === "meeting") {
    const meeting = await db.query.meetingSessions.findFirst({
      where: and(
        eq(meetingSessions.id, source.sourceId),
        eq(meetingSessions.userId, userId),
        inArray(meetingSessions.status, ["analyzed", "saved"])
      ),
      columns: { id: true, title: true, startedAt: true, digest: true },
    });
    if (!meeting) return { found: false as const };
    // The line that was cited, when there is one; otherwise how the meeting went overall.
    const line =
      source.startMs === null
        ? null
        : await db.query.meetingTranscriptSegments.findFirst({
            where: and(
              eq(meetingTranscriptSegments.sessionId, meeting.id),
              eq(meetingTranscriptSegments.userId, userId),
              eq(meetingTranscriptSegments.startMs, source.startMs)
            ),
            columns: { text: true },
          });
    return {
      found: true as const,
      kind: "meeting" as const,
      meetingId: meeting.id,
      contactId: null,
      contactName: null,
      title: meeting.title?.trim() || meeting.digest?.title?.trim() || "Untitled meeting",
      date: meeting.startedAt.toISOString().slice(0, 10),
      snippet: (line?.text || meeting.digest?.summary || "").trim().slice(0, 600),
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

/**
 * Keep a draft the person wrote or edited on an answer's card, so a reload does not lose it.
 * Quiet on failure: the text is still on screen, and the next save tries again.
 */
export async function saveChatDraft(messageId: string, contactId: string, text: string) {
  const userId = await requireUserForSurface("page.chat");
  if (!isUuid(messageId) || !isUuid(contactId) || typeof text !== "string") return { ok: false as const };
  return { ok: await saveDraftEdit(userId, messageId, contactId, text) };
}

/**
 * Keep an edit made to a draft written in an answer (an email's subject and body, or a
 * LinkedIn note). Rewrites that block in the saved answer — no model call. Quiet on failure:
 * the text stays on screen and the next save tries again.
 */
export async function saveChatDraftBlock(messageId: string, index: number, edit: { subject?: string; body: string }) {
  const userId = await requireUserForSurface("page.chat");
  if (!isUuid(messageId) || !edit || typeof edit.body !== "string") return { saved: false as const };
  return saveDraftBlockEdit(userId, messageId, index, { subject: edit.subject, body: edit.body });
}

/** What Orbit is keeping in mind for this person across chats, newest first. */
export async function listChatMemories(): Promise<ChatMemory[]> {
  const userId = await requireUserForSurface("page.chat");
  return listMemories(userId);
}

/** The person adds a memory themselves, from the Context sheet. */
export async function addChatMemory(text: string) {
  const userId = await requireUserForSurface("page.chat");
  if (typeof text !== "string") return { ok: false as const, error: "There’s nothing to remember there" };
  try {
    return { ok: true as const, memory: await addMemory(userId, text) };
  } catch (err) {
    if (err instanceof UserFacingError) return { ok: false as const, error: err.message };
    throw err;
  }
}

export async function deleteChatMemory(id: string) {
  const userId = await requireUserForSurface("page.chat");
  if (!isUuid(id)) return { ok: false as const };
  return { ok: await deleteMemory(userId, id) };
}

/** Rename a saved conversation. A title, once set, is never overwritten by a later answer. */
export async function renameChatThread(threadId: string, title: string) {
  const userId = await requireUserForSurface("page.chat");
  if (!isUuid(threadId) || typeof title !== "string") return { ok: false as const };
  const stored = await renameThread(userId, threadId, title);
  return stored ? { ok: true as const, title: stored } : { ok: false as const };
}

/** Pin a conversation to the top of the history list, or unpin it. */
export async function pinChatThread(threadId: string, pinned: boolean) {
  const userId = await requireUserForSurface("page.chat");
  if (!isUuid(threadId)) return { ok: false as const, reason: "missing" as const };
  return pinThread(userId, threadId, pinned === true);
}

/** Saved conversations whose title or messages contain `query`. */
export async function searchChatThreads(query: string): Promise<ThreadSearchHit[]> {
  const userId = await requireUserForSurface("page.chat");
  if (typeof query !== "string") return [];
  return searchThreads(userId, query);
}

/**
 * The person pressed Stop on a streaming answer (audit L-25). The stream's abort alone reads
 * the same as a dropped connection, which keeps the question; this says it was on purpose,
 * so the unanswered question is discarded. Ownership is enforced inside `markTurnStopped`.
 */
export async function stopChatTurn(threadId: string, turnId: string) {
  const userId = await requireUserForSurface("page.chat");
  if (!isUuid(threadId) || !isUuid(turnId)) return { ok: false as const };
  await markTurnStopped(userId, threadId, turnId);
  return { ok: true as const };
}

/** A steer is a nudge, not a new question: long ones go through the queue as their own turn. */
const STEER_MAX_CHARS = 1000;

/**
 * The person sent a message to steer the answer being written. It waits on the thread for
 * the running turn to read between lookup rounds; the turn confirms with a `steer:<id>` step.
 * Ownership is enforced inside `addTurnSteer`.
 */
export async function steerChatTurn(threadId: string, turnId: string, id: string, text: string) {
  const userId = await requireUserForSurface("page.chat");
  const note = typeof text === "string" ? text.trim() : "";
  if (!isUuid(threadId) || !isUuid(turnId) || !isUuid(id) || !note || note.length > STEER_MAX_CHARS) {
    return { ok: false as const };
  }
  await addTurnSteer(userId, threadId, turnId, { id, text: note });
  return { ok: true as const };
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
