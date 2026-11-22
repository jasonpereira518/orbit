import { and, count, eq, isNotNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { chatThreads } from "@/db/schema";
import { escapeLike } from "@/lib/contact-search-rank";

/**
 * What the person does to a saved conversation: rename it, pin it, find it again.
 *
 * Each takes the user id and scopes every statement by it, so a thread id from another
 * account matches nothing. The server actions in `@/actions/chat` are thin wrappers.
 */
export const THREAD_TITLE_MAX = 120;
export const PINNED_THREADS_MAX = 20;
const SEARCH_LIMIT = 20;
const SNIPPET_RADIUS = 50;

/** The stored title, or null when the thread is not this person's or the title is unusable. */
export async function renameThread(userId: string, threadId: string, title: string): Promise<string | null> {
  const next = title.trim().replace(/\s+/g, " ").slice(0, THREAD_TITLE_MAX);
  if (!next) return null;
  const db = await getDb();
  const rows = await db
    .update(chatThreads)
    .set({ title: next })
    .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)))
    .returning();
  return rows.length ? next : null;
}

/**
 * Pin or unpin. `updated_at` is left alone: pinning is not activity, and the history list
 * is ordered by it. "limit" when the person already has `PINNED_THREADS_MAX` pinned.
 */
export async function pinThread(
  userId: string,
  threadId: string,
  pinned: boolean
): Promise<{ ok: true; pinnedAt: Date | null } | { ok: false; reason: "limit" | "missing" }> {
  const db = await getDb();
  if (pinned) {
    const [row] = await db
      .select({ n: count() })
      .from(chatThreads)
      .where(and(eq(chatThreads.userId, userId), isNotNull(chatThreads.pinnedAt)));
    if ((row?.n ?? 0) >= PINNED_THREADS_MAX) return { ok: false, reason: "limit" };
  }
  const pinnedAt = pinned ? new Date() : null;
  const rows = await db
    .update(chatThreads)
    .set({ pinnedAt })
    .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)))
    .returning();
  return rows.length ? { ok: true, pinnedAt } : { ok: false, reason: "missing" };
}

export type ThreadSearchHit = {
  id: string;
  title: string | null;
  updatedAt: Date;
  /** The words around the match in a message, or null when only the title matched. */
  snippet: string | null;
};

/** The text either side of the first match, on one line. */
export function snippetAround(content: string, query: string): string {
  const flat = content.replace(/\s+/g, " ").trim();
  const at = flat.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return flat.slice(0, SNIPPET_RADIUS * 2);
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(flat.length, at + query.length + SNIPPET_RADIUS);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

/**
 * Saved conversations whose title or any shown message contains `query`, newest first.
 *
 * ponytail: a literal ILIKE scan of one person's messages. Fine at hundreds of chats; add a
 * pg_trgm index on chat_messages.content if someone's history makes this slow.
 */
export async function searchThreads(userId: string, query: string): Promise<ThreadSearchHit[]> {
  const q = query.trim().slice(0, 100);
  if (q.length < 2) return [];
  const pattern = `%${escapeLike(q)}%`;
  const db = await getDb();
  // Table-qualified names are written out: a `${column}` inside `sql` in a select renders
  // unqualified, which would make the correlated subqueries compare a column to itself.
  const matching = sql`
    SELECT m.content FROM chat_messages m
    WHERE m.thread_id = chat_threads.id AND m.user_id = ${userId} AND m.is_active AND m.content ILIKE ${pattern}
    ORDER BY m.created_at LIMIT 1`;
  const rows = await db
    .select({
      id: chatThreads.id,
      title: chatThreads.title,
      updatedAt: chatThreads.updatedAt,
      hit: sql<string | null>`(${matching})`,
    })
    .from(chatThreads)
    .where(
      and(
        eq(chatThreads.userId, userId),
        isNotNull(chatThreads.title),
        sql`btrim(chat_threads.title) <> ''`,
        sql`(chat_threads.title ILIKE ${pattern} OR EXISTS (${matching}))`
      )
    )
    .orderBy(sql`chat_threads.updated_at DESC`)
    .limit(SEARCH_LIMIT);
  return rows.map(({ hit, ...row }) => ({ ...row, snippet: hit ? snippetAround(hit, q) : null }));
}
