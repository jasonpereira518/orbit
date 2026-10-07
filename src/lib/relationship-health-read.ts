import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { AI_DERIVED_SOURCE } from "@/lib/interaction-provenance";
import {
  HEALTH_LOOKBACK_DAYS,
  relationshipHealth,
  type RelationshipHealth,
} from "@/lib/relationship-health";

/**
 * One contact's health series, for the contact page. A single statement: the contact's
 * cadence rides along on every row via the join, and a contact with no rows in the window
 * has no score anyway.
 *
 * Group-chat sessions are a touch but not a 1:1 exchange — their `direction` only says
 * whether the user or anyone else spoke last — so it is dropped here. They are marked only
 * by the header `to-rows.ts` prefixes onto their transcripts (`groupHeader` in
 * conversations/sessions.ts).
 */
export async function getRelationshipHealth(
  userId: string,
  contactId: string,
  now = new Date()
): Promise<RelationshipHealth | null> {
  const db = await getDb();
  const rows = rowsOf<{
    interaction_date: string | Date;
    direction: "in" | "out" | null;
    source: string | null;
    cadence_days: number | null;
  }>(
    await db.execute(sql`
      SELECT i.interaction_date,
        CASE WHEN i.source IN ('whatsapp', 'imessage') AND left(i.raw_notes, 12) = '# Group chat'
          THEN NULL ELSE i.direction END AS direction,
        i.source, c.cadence_days
      FROM interactions i
      JOIN contacts c ON c.id = i.contact_id AND c.user_id = ${userId}
      WHERE i.user_id = ${userId}
        AND i.contact_id = ${contactId}
        AND i.interaction_date >= ${new Date(now.getTime() - HEALTH_LOOKBACK_DAYS * 86_400_000).toISOString()}::timestamptz
        AND i.interaction_date <= ${now.toISOString()}::timestamptz
        AND (i.source IS NULL OR i.source <> ${AI_DERIVED_SOURCE})
    `)
  );
  return relationshipHealth(
    rows.map((r) => ({ at: new Date(r.interaction_date), direction: r.direction, source: r.source })),
    { now, cadenceDays: rows[0]?.cadence_days ?? null }
  );
}
