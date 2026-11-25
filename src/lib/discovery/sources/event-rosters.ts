/**
 * Event Roster Candidate Source
 *
 * Mines unconnected attendees across the user's past and upcoming events in event_attendees.
 * Merges repeat appearances into unified RawCandidate profiles.
 */

import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import type { RawCandidate } from "../types";

type EventAttendeeRow = {
  id: string;
  eventId: string;
  fullName: string | null;
  company: string | null;
  title: string | null;
  email: string | null;
  linkedinUrl: string | null;
  attendeeRole: "attendee" | "host" | "speaker" | null;
  identityKey: string;
  eventTitle: string;
  startsAt: string | Date | null;
};

export async function mineEventRosterCandidates(
  userId: string,
  now: Date = new Date(),
  limit: number = 50
): Promise<RawCandidate[]> {
  const db = await getDb();

  const rawRows = await db.execute(
    sql`
      SELECT a.id, a.event_id AS "eventId", a.full_name AS "fullName",
             a.company, a.title, a.email, a.linkedin_url AS "linkedinUrl",
             a.attendee_role AS "attendeeRole", a.identity_key AS "identityKey",
             e.title AS "eventTitle", e.starts_at AS "startsAt"
        FROM event_attendees a
        INNER JOIN events e ON e.id = a.event_id AND e.user_id = a.user_id
       WHERE a.user_id = ${userId}
         AND a.contact_id IS NULL
         AND a.full_name IS NOT NULL
       ORDER BY e.starts_at DESC NULLS LAST
       LIMIT 300
    `
  );

  const rows = rowsOf<EventAttendeeRow>(rawRows);
  if (!rows.length) return [];

  // Group by identityKey or lowercase normalized name
  const candidatesByKey = new Map<string, RawCandidate>();

  for (const row of rows) {
    if (!row.fullName || row.fullName.trim().length < 2) continue;

    const normKey =
      row.linkedinUrl?.toLowerCase() ||
      row.email?.toLowerCase() ||
      row.fullName.trim().toLowerCase();

    const startsAtDate = row.startsAt ? new Date(row.startsAt) : null;
    const isUpcoming = Boolean(startsAtDate && startsAtDate.getTime() > now.getTime());

    const existing = candidatesByKey.get(normKey);
    if (existing) {
      // Add shared event
      existing.sharedEvents?.push({
        eventId: row.eventId,
        eventTitle: row.eventTitle,
        startsAt: startsAtDate,
        isUpcoming,
      });

      // Update role/company/title if more complete
      if (!existing.company && row.company) existing.company = row.company;
      if (!existing.title && row.title) existing.title = row.title;
      if (!existing.linkedinUrl && row.linkedinUrl) existing.linkedinUrl = row.linkedinUrl;
      if (row.attendeeRole && !existing.signals?.includes(row.attendeeRole)) {
        existing.signals?.push(row.attendeeRole);
      }
    } else {
      candidatesByKey.set(normKey, {
        id: `event-cand-${row.id}`,
        fullName: row.fullName.trim(),
        headline: [row.title, row.company].filter(Boolean).join(" at ") || null,
        company: row.company || null,
        title: row.title || null,
        email: row.email || null,
        linkedinUrl: row.linkedinUrl || null,
        source: "event_attendee",
        signals: row.attendeeRole ? [row.attendeeRole] : [],
        sharedEvents: [
          {
            eventId: row.eventId,
            eventTitle: row.eventTitle,
            startsAt: startsAtDate,
            isUpcoming,
          },
        ],
      });
    }

    if (candidatesByKey.size >= limit) break;
  }

  return Array.from(candidatesByKey.values());
}
