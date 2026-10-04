import { desc, eq, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { contactBriefs, contacts } from "@/db/schema";
import {
  gistOf,
  KNOWLEDGE_PEOPLE_LIMIT,
  type KnowledgePeoplePayload,
} from "@/lib/knowledge-people-types";

/**
 * The people index on /knowledge, bounded like the feed beside it (audit B4).
 *
 * Two statements: one aggregate for the account totals, and one LIMITed read of the most
 * recently touched people. The summary is cut in SQL (`left`) so a multi-KB summary never
 * crosses the wire to be sliced here; `notes` is never selected; the photo is reduced to a
 * boolean, because a stored avatar can be an inline data URL and this is a list.
 *
 * `fit_count` counts the brief's goal-fit items whose goal is still active. The join to
 * `user_goals` is what makes a deleted goal stop counting without a brief regenerating,
 * which is why the count lives in SQL rather than in the stored jsonb.
 */
export async function loadKnowledgePeople(userId: string): Promise<KnowledgePeoplePayload> {
  const db = await getDb();

  const [totals, rows] = await Promise.all([
    db.execute(sql`
      SELECT (SELECT count(*)::int FROM contacts WHERE user_id = ${userId}) AS total,
             (SELECT count(*)::int FROM user_goals WHERE user_id = ${userId} AND active = 1) AS goals
    `),
    db
      .select({
        id: contacts.id,
        fullName: contacts.fullName,
        firstName: contacts.firstName,
        title: contacts.title,
        company: contacts.company,
        lastInteractionAt: contacts.lastInteractionAt,
        summary: sql<string | null>`left(${contacts.aiSummary}::text, 320)`,
        hasPhoto: sql<boolean>`(${contacts.profileImageUrl} IS NOT NULL AND ${contacts.profileImageUrl} <> '')`,
        fitCount: sql<number>`coalesce((
          SELECT count(*)::int
            FROM jsonb_array_elements(${contactBriefs.goalFit} -> 'items') AS e
            JOIN user_goals g ON g.id::text = e ->> 'goalId'
           WHERE g.user_id = ${userId} AND g.active = 1
        ), 0)`,
      })
      .from(contacts)
      .leftJoin(contactBriefs, eq(contactBriefs.contactId, contacts.id))
      .where(eq(contacts.userId, userId))
      .orderBy(sql`${contacts.lastInteractionAt} DESC NULLS LAST`, desc(contacts.updatedAt), desc(contacts.id))
      .limit(KNOWLEDGE_PEOPLE_LIMIT),
  ]);

  const t = rowsOf<{ total: number; goals: number }>(totals)[0];

  return {
    total: Number(t?.total ?? 0),
    goalCount: Number(t?.goals ?? 0),
    rows: rows.map((r) => ({
      id: r.id,
      fullName: r.fullName,
      firstName: r.firstName,
      title: r.title,
      company: r.company,
      gist: gistOf(r.summary),
      hasPhoto: Boolean(r.hasPhoto),
      fitCount: Number(r.fitCount) || 0,
      lastInteractionAt: r.lastInteractionAt ? new Date(r.lastInteractionAt).toISOString() : null,
    })),
  };
}
