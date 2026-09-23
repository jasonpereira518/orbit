import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { userGoals } from "@/db/schema";

/**
 * The user's active goal texts, used to weight closeness and to steer AI
 * suggestions toward what they're actually trying to do.
 *
 * Parameterized by userId so callers outside a server-action request context
 * (route handlers) can use it; `listActiveGoalTexts` in src/actions/goals.ts
 * wraps this with `requireUserId()`.
 *
 * Newest first, and `limit` bounds how many reach a prompt. Chat had its own private copy
 * of this query for exactly that reason; one list is better than two that can disagree about
 * which goals the user is currently working on.
 */
export async function listActiveGoalTextsForUser(
  userId: string,
  options: { limit?: number } = {}
) {
  const db = await getDb();
  const rows = await db.query.userGoals.findMany({
    where: and(eq(userGoals.userId, userId), eq(userGoals.active, 1)),
    columns: { text: true },
    orderBy: [desc(userGoals.createdAt)],
    ...(options.limit ? { limit: options.limit } : {}),
  });
  return rows.map((r) => r.text);
}
