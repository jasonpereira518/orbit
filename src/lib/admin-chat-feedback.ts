import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { chatMessages, userSettings } from "@/db/schema";
import { countInt } from "@/lib/admin-metrics";
import { assertRevealable } from "@/lib/admin-redaction";

/**
 * The thumbs on a chat answer, read for the admin console.
 *
 * `chat_messages.content` is on the permanent denylist in `admin-redaction.ts` — "the most
 * private store in the app" — so this deliberately selects nothing but the rating itself:
 * who rated it, up or down, when, and the optional note a thumbs-down can carry (which is
 * feedback the person meant to send, the same as a `feedback` table row, not a transcript).
 * No join reaches `content`, and `assertRevealable` is called on the exact column list so a
 * future edit that adds one is caught rather than silently shipped.
 */

export const CHAT_FEEDBACK_PAGE_SIZE = 50;

const SELECTED_COLUMNS = [
  "chat_messages.id",
  "chat_messages.user_id",
  "chat_messages.feedback",
  "chat_messages.feedback_note",
  "chat_messages.created_at",
] as const;

export type ChatFeedbackRow = {
  id: string;
  userId: string;
  feedback: "up" | "down";
  feedbackNote: string | null;
  createdAt: Date;
  submitterEmail: string | null;
};

export type ChatFeedbackSummary = {
  up: number;
  down: number;
  last7Days: number;
};

/** Counts for the tiles. */
export async function getChatFeedbackSummary(): Promise<ChatFeedbackSummary> {
  assertRevealable(SELECTED_COLUMNS as unknown as string[]);
  const db = await getDb();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [row] = await db
    .select({
      up: sql<number>`count(*) filter (where ${chatMessages.feedback} = 'up')::int`,
      down: sql<number>`count(*) filter (where ${chatMessages.feedback} = 'down')::int`,
      last7Days: sql<number>`count(*) filter (where ${chatMessages.createdAt} >= ${sevenDaysAgo})::int`,
    })
    .from(chatMessages)
    .where(sql`${chatMessages.feedback} is not null`);

  return { up: row?.up ?? 0, down: row?.down ?? 0, last7Days: row?.last7Days ?? 0 };
}

/** One page of rated answers, newest first — ratings only, never the question or answer text. */
export async function loadChatFeedbackList(options: {
  page: number;
}): Promise<{ rows: ChatFeedbackRow[]; total: number; page: number; pageCount: number }> {
  assertRevealable(SELECTED_COLUMNS as unknown as string[]);
  const db = await getDb();
  const where = and(sql`${chatMessages.feedback} is not null`);

  const [counted] = await db.select({ n: countInt }).from(chatMessages).where(where);
  const total = counted?.n ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / CHAT_FEEDBACK_PAGE_SIZE));
  const page = Math.min(Math.max(1, options.page), pageCount);

  const rows = await db
    .select({
      id: chatMessages.id,
      userId: chatMessages.userId,
      feedback: chatMessages.feedback,
      feedbackNote: chatMessages.feedbackNote,
      createdAt: chatMessages.createdAt,
      submitterEmail: userSettings.email,
    })
    .from(chatMessages)
    .leftJoin(userSettings, eq(userSettings.userId, chatMessages.userId))
    .where(where)
    .orderBy(desc(chatMessages.createdAt))
    .limit(CHAT_FEEDBACK_PAGE_SIZE)
    .offset((page - 1) * CHAT_FEEDBACK_PAGE_SIZE);

  return { rows: rows as ChatFeedbackRow[], total, page, pageCount };
}
