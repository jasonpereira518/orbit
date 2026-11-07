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

const OUTCOME_COLUMNS = [
  "chat_messages.role",
  "chat_messages.answer_outcome",
  "chat_messages.created_at",
] as const;

/** Labelled assistant answers in the last 7 days, by outcome. */
export type ChatOutcomeSummary = {
  answered: number;
  partial: number;
  abstained: number;
  /** answered + partial + abstained; answers stored before the label existed are not counted. */
  labelled: number;
};

/**
 * How often chat answered, in the last 7 days — see `labelAnswer` in `@/lib/chat-abstention`.
 * Counts only: the label is computed from the answer when it is stored, so this never needs
 * to read `content`, and the column list is checked like the ratings query above.
 */
export async function getChatOutcomeSummary(): Promise<ChatOutcomeSummary> {
  assertRevealable(OUTCOME_COLUMNS as unknown as string[]);
  const db = await getDb();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const [row] = await db
    .select({
      answered: sql<number>`count(*) filter (where ${chatMessages.answerOutcome} = 'answered')::int`,
      partial: sql<number>`count(*) filter (where ${chatMessages.answerOutcome} = 'partial')::int`,
      abstained: sql<number>`count(*) filter (where ${chatMessages.answerOutcome} = 'abstained')::int`,
    })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.role, "assistant"),
        sql`${chatMessages.answerOutcome} is not null`,
        sql`${chatMessages.createdAt} >= ${sevenDaysAgo}`
      )
    );
  const answered = row?.answered ?? 0;
  const partial = row?.partial ?? 0;
  const abstained = row?.abstained ?? 0;
  return { answered, partial, abstained, labelled: answered + partial + abstained };
}

/** One page of rated answers, newest first — ratings only, never the question or answer text. */
export async function loadChatFeedbackList(options: {
  page: number;
}): Promise<{ rows: ChatFeedbackRow[]; total: number; page: number; pageCount: number }> {
  assertRevealable(SELECTED_COLUMNS as unknown as string[]);
  const db = await getDb();
  const where = and(sql`${chatMessages.feedback} is not null`);

  const pageOf = (page: number) =>
    db
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

  // The count and the requested page in parallel rather than one after the other. The
  // page is only clamped from above when someone asks past the end (a stale link after a
  // purge), and only then is it read again. Not `count(*) over ()` on the page query: that
  // has to sort every rated row before it can LIMIT, where this one reads fifty off an index.
  const requested = Math.max(1, options.page);
  const [[counted], firstRead] = await Promise.all([
    db.select({ n: countInt }).from(chatMessages).where(where),
    pageOf(requested),
  ]);
  const total = counted?.n ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / CHAT_FEEDBACK_PAGE_SIZE));
  const page = Math.min(requested, pageCount);
  const rows = page === requested ? firstRead : await pageOf(page);

  return { rows: rows as ChatFeedbackRow[], total, page, pageCount };
}
