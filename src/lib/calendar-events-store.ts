/**
 * Storing every calendar event a sync fetched, independent of what — if anything — it does to
 * a contact.
 *
 * `google-calendar.ts`/`outlook-calendar.ts` classify events to decide what touches
 * `interactions` or the events roster, and that classifier deliberately drops most of a
 * calendar (standups, personal blocks, admin noise). This module is the other half: it keeps
 * everything, so `chat-context.ts` can answer a general schedule question from real synced
 * data rather than only from the subset the classifier kept.
 *
 * No `next/*` imports: loaded by the sync scheduler, same restriction every other module on
 * that path documents (see `ingest/events.ts`'s header).
 */
import { and, desc, eq, gte, lt, lte, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { calendarEvents, type CalendarEventAttendee, type CalendarEventRow } from "@/db/schema";
import type { ParsedCalendarEvent } from "@/lib/calendar-import";
import type { EventClassification } from "@/lib/calendar-classify";

export type CalendarEventForStorage = {
  externalId: string;
  title: string;
  startsAt: Date | null;
  endsAt: Date | null;
  organizerEmail: string | null;
  organizerName: string | null;
  attendees: CalendarEventAttendee[];
  location: string | null;
  descriptionExcerpt: string | null;
  classification: EventClassification["kind"];
};

/** Shapes one already-parsed+classified event for storage. Pure — no DB, no classification logic. */
export function toStorageRow(
  event: ParsedCalendarEvent,
  classification: EventClassification["kind"]
): CalendarEventForStorage {
  return {
    externalId: event.uid,
    title: event.summary || "Untitled event",
    startsAt: event.start,
    endsAt: event.end,
    organizerEmail: event.organizer?.email || null,
    organizerName: event.organizer?.name || null,
    attendees: event.attendees.map((a) => ({ name: a.name || null, email: a.email || null })),
    location: event.location || null,
    descriptionExcerpt: event.description ? event.description.slice(0, 500) : null,
    classification,
  };
}

/**
 * Upsert one page's worth of events. One statement regardless of batch size, the same
 * flat-cost rule `ingest/events.ts` enforces for the interaction write path.
 *
 * Keyed on `calendar_events_provider_uidx` — `(user_id, provider, external_id)` — so a
 * re-sync updates the row (title changed, attendee list grew) rather than duplicating it.
 */
export async function upsertCalendarEvents(
  userId: string,
  provider: "google" | "microsoft",
  events: CalendarEventForStorage[]
): Promise<number> {
  if (events.length === 0) return 0;
  const db = await getDb();

  const values = events.map(
    (e) =>
      sql`(${userId}, ${provider}, ${e.externalId}, ${e.title}, ${e.startsAt}, ${e.endsAt},
           ${e.organizerEmail}, ${e.organizerName}, ${JSON.stringify(e.attendees)}::jsonb,
           ${e.location}, ${e.descriptionExcerpt}, ${e.classification})`
  );

  await db.execute(sql`
    INSERT INTO calendar_events
      (user_id, provider, external_id, title, starts_at, ends_at, organizer_email,
       organizer_name, attendees, location, description_excerpt, classification)
    VALUES ${sql.join(values, sql`, `)}
    ON CONFLICT (user_id, provider, external_id) DO UPDATE SET
      title               = excluded.title,
      starts_at           = excluded.starts_at,
      ends_at             = excluded.ends_at,
      organizer_email     = excluded.organizer_email,
      organizer_name      = excluded.organizer_name,
      attendees           = excluded.attendees,
      location            = excluded.location,
      description_excerpt = excluded.description_excerpt,
      classification      = excluded.classification,
      updated_at          = now()
  `);

  return events.length;
}

export type CalendarContextWindow = {
  upcoming: CalendarEventRow[];
  recent: CalendarEventRow[];
};

/**
 * A compact window for chat context: what's coming up and what just happened. Capped on both
 * sides so a heavy calendar cannot blow the prompt budget — `chat-context.ts` folds this into
 * `ChatContext` unconditionally, the same way it already does for active goals.
 */
export async function loadCalendarContextWindow(
  userId: string,
  opts: { daysBack?: number; daysForward?: number; limitPerSide?: number; now?: Date } = {}
): Promise<CalendarContextWindow> {
  const now = opts.now ?? new Date();
  const daysBack = opts.daysBack ?? 7;
  const daysForward = opts.daysForward ?? 7;
  const limit = opts.limitPerSide ?? 20;
  const windowStart = new Date(now.getTime() - daysBack * 86400000);
  const windowEnd = new Date(now.getTime() + daysForward * 86400000);

  const db = await getDb();
  const [upcoming, recent] = await Promise.all([
    db.query.calendarEvents.findMany({
      where: (c) => and(eq(c.userId, userId), gte(c.startsAt, now), lte(c.startsAt, windowEnd)),
      orderBy: (c) => c.startsAt,
      limit,
    }),
    db.query.calendarEvents.findMany({
      where: (c) => and(eq(c.userId, userId), lt(c.startsAt, now), gte(c.startsAt, windowStart)),
      orderBy: (c) => [desc(c.startsAt)],
      limit,
    }),
  ]);

  return { upcoming, recent };
}

/**
 * Drop rows too old to plausibly matter as chat context. This table exists to answer
 * schedule questions, not to be a permanent archive — `interactions` already is one, for the
 * events that mattered enough to touch a contact. Called from the sync scheduler, the same
 * way `purgeExpiredIdempotencyKeys` runs from its own sweep.
 */
export async function pruneOldCalendarEvents(olderThan: Date): Promise<number> {
  const db = await getDb();
  // Bare `.returning()`, not `.returning({ id })` — an explicit field selector defeats
  // Drizzle's overload resolution in this TS version (see `import-engine.ts` for the same
  // note); bare is functionally identical for a count, just returns every column.
  const deleted = await db
    .delete(calendarEvents)
    .where(sql`${calendarEvents.startsAt} < ${olderThan}`)
    .returning();
  return deleted.length;
}
