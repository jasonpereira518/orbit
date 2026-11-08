/**
 * Saving event notes and synchronizing them into the user's knowledge context.
 *
 * Stored primarily on `events.notes`, and mirrored to `interactions` under the
 * deterministic external key `evt:<eventId>:notes` with `interaction_type = 'event'`.
 *
 * This dual persistence ensures:
 * 1. The event page can display and edit notes quickly with single-row latency.
 * 2. Orbit's Knowledge Base (/knowledge) automatically surfaces event notes in its timeline
 *    and overview metrics.
 * 3. Orbit AI Chat retrieval and semantic search can ground questions like "What did I learn
 *    at AI Summit?" directly from the user's event notes context.
 */

import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { interactions } from "@/db/schema";
import { eventExternalIdBase } from "@/lib/ingest/external-id";
import { getEventForUser, updateEventForUser } from "@/lib/events/store";

export async function saveAndSyncEventNotes(
  userId: string,
  eventId: string,
  notes: string
): Promise<{ ok: boolean; savedAt: Date }> {
  const event = await getEventForUser(userId, eventId);
  if (!event) {
    throw new Error("Event not found or unauthorized");
  }

  const trimmedNotes = notes.trim();
  const now = new Date();

  // 1. Update the primary event record
  await updateEventForUser(userId, eventId, {
    notes: trimmedNotes || null,
  });

  // 2. Synchronize to `interactions` for Knowledge Base and AI Chat retrieval
  const db = await getDb();
  const externalId = `${eventExternalIdBase(eventId)}:notes`;
  const interactionDate = event.startsAt ?? event.createdAt;
  const venueLocation = [event.venue, event.city].filter(Boolean).join(", ");
  const titleSummary = venueLocation
    ? `${event.title} (${venueLocation})`
    : event.title;

  if (trimmedNotes) {
    // Upsert the event note interaction
    await db.execute(sql`
      INSERT INTO interactions (
        id,
        user_id,
        external_id,
        interaction_type,
        interaction_date,
        ai_summary,
        raw_notes,
        created_at,
        updated_at
      )
      VALUES (
        gen_random_uuid(),
        ${userId},
        ${externalId},
        'event',
        ${interactionDate},
        ${titleSummary},
        ${trimmedNotes},
        ${now},
        ${now}
      )
      ON CONFLICT (user_id, external_id) WHERE external_id IS NOT NULL
      DO UPDATE SET
        ai_summary = ${titleSummary},
        raw_notes = ${trimmedNotes},
        interaction_date = ${interactionDate},
        updated_at = ${now}
    `);
  } else {
    // If the note was completely cleared, remove the corresponding interaction entry
    await db
      .delete(interactions)
      .where(
        and(
          eq(interactions.userId, userId),
          eq(interactions.externalId, externalId)
        )
      );
  }

  return { ok: true, savedAt: now };
}
