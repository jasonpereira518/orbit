import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { userGoals } from "@/db/schema";

/**
 * The user's active goal texts, used to weight closeness and to steer AI
 * suggestions toward what they're actually trying to do.
 *
 * Parameterized by userId so callers outside a server-action request context
 * (route handlers) can use it; `listActiveGoalTexts` in src/actions/goals.ts
 * wraps this with `requireUserId()`.
 */
export async function listActiveGoalTextsForUser(userId: string) {
  const db = await getDb();
  const rows = await db.query.userGoals.findMany({
    where: and(eq(userGoals.userId, userId), eq(userGoals.active, 1)),
    columns: { text: true },
  });
  return rows.map((r) => r.text);
}
