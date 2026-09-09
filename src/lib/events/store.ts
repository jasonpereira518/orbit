/**
 * Every read and write against the three event tables.
 *
 * `upsertEventAttendees` is deliberately the single chokepoint each acquisition path goes
 * through — paste, CSV, screenshot, Luma, Eventbrite. That is what makes "add another source"
 * mean "write a parser or a fetcher" rather than "reimplement the write and hope it dedupes
 * the same way", and it is where a future browser-extension path would slot in with no new
 * write logic.
 *
 * Every function takes `userId` explicitly and scopes on it. There are no FKs to users
 * anywhere in this schema — ownership is a `WHERE` clause, so forgetting one is a data leak
 * rather than a type error. Auth itself belongs to `src/actions/events.ts`.
 *
 * No `next/*` imports: `internal-auth.ts` and `cron-runs.ts` both record that importing
 * `next/server` alone retains the Node event loop and hangs any `tsx` script, and the sync
 * scheduler and smoke scripts both load this module. `revalidatePath` belongs to whichever
 * caller has a request.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { eventAttendees, events, type EventRecord } from "@/db/schema";
import type {
  AttendeeSource,
  EventProviderId,
  EventRole,
  EventSource,
  RosterRow,
} from "@/lib/events/types";
import type { ParsedAttendee } from "@/lib/events/parse-roster";

export type EventListRow = Pick<
  EventRecord,
  | "id"
  | "title"
  | "startsAt"
  | "venue"
  | "city"
  | "url"
  | "role"
  | "source"
  | "coverImageUrl"
  | "themeColor"
> & { attendeeCount: number; connectedCount: number };

/**
 * The list page.
 *
 * Counts come from one grouped subquery rather than a query per event — a page of 50 events
 * would otherwise be 100 extra round trips, and on `neon-http` every statement is its own
 * HTTPS request with no pipelining, so round-trip count *is* runtime.
 *
 * Ordered newest-first with nulls last: an event whose date nobody recorded belongs at the
 * bottom, not pinned above everything by a NULL sort. `id` trails the sort key to keep the
 * ordering total.
 */
export async function listEventsForUser(userId: string, limit = 100): Promise<EventListRow[]> {
  const db = await getDb();
  const rows = await db.execute(sql`
    SELECT e.id, e.title, e.starts_at, e.venue, e.city, e.url, e.role, e.source,
           e.cover_image_url, e.theme_color,
           COALESCE(a.total, 0)     AS attendee_count,
           COALESCE(a.connected, 0) AS connected_count
      FROM events e
      LEFT JOIN (
        SELECT event_id,
               COUNT(*)                                        AS total,
               COUNT(*) FILTER (WHERE contact_id IS NOT NULL)   AS connected
          FROM event_attendees
         WHERE user_id = ${userId}
         GROUP BY event_id
      ) a ON a.event_id = e.id
     WHERE e.user_id = ${userId}
     ORDER BY e.starts_at DESC NULLS LAST, e.id DESC
     LIMIT ${limit}
  `);
  type Raw = {
    id: string;
    title: string;
    starts_at: string | Date | null;
    venue: string | null;
    city: string | null;
    url: string | null;
    role: EventRole;
    source: EventSource;
    cover_image_url: string | null;
    theme_color: string | null;
    attendee_count: string | number;
    connected_count: string | number;
  };
  // `rowsOf` is the one place that reconciles neon-http (bare array) with pglite (`{ rows }`).
  const raw = rowsOf<Raw>(rows);
  return raw.map((r) => ({
    id: r.id,
    title: r.title,
    startsAt: r.starts_at ? new Date(r.starts_at) : null,
    venue: r.venue,
    city: r.city,
    url: r.url,
    role: r.role,
    source: r.source,
    coverImageUrl: r.cover_image_url,
    themeColor: r.theme_color,
    // Postgres COUNT comes back as a string over the wire on one driver and a number on the
    // other; normalising here keeps every caller from having to know which.
    attendeeCount: Number(r.attendee_count),
    connectedCount: Number(r.connected_count),
  }));
}

export async function getEventForUser(
  userId: string,
  eventId: string
): Promise<EventRecord | null> {
  const db = await getDb();
  const row = await db.query.events.findFirst({
    where: and(eq(events.id, eventId), eq(events.userId, userId)),
  });
  return row ?? null;
}

export async function listRosterForUser(
  userId: string,
  eventId: string
): Promise<RosterRow[]> {
  const db = await getDb();
  const rows = await db.query.eventAttendees.findMany({
    where: and(eq(eventAttendees.eventId, eventId), eq(eventAttendees.userId, userId)),
    orderBy: [desc(eventAttendees.spokeTo), eventAttendees.fullName],
  });
  return rows.map((r) => ({
    id: r.id,
    fullName: r.fullName,
    email: r.email,
    company: r.company,
    title: r.title,
    linkedinUrl: r.linkedinUrl,
    xHandle: r.xHandle,
    attendeeRole: r.attendeeRole,
    source: r.source,
    spokeTo: r.spokeTo === 1,
    contactId: r.contactId,
  }));
}

export type CreateEventInput = {
  title: string;
  startsAt?: Date | null;
  endsAt?: Date | null;
  timezone?: string | null;
  venue?: string | null;
  city?: string | null;
  url?: string | null;
  role?: EventRole;
  source?: EventSource;
  provider?: EventProviderId | null;
  providerEventId?: string | null;
  description?: string | null;
  coverImageUrl?: string | null;
  coverSourceUrl?: string | null;
  themeColor?: string | null;
  themeSource?: EventRecord["themeSource"];
  attendeeCount?: number | null;
  notes?: string | null;
};

export async function createEventForUser(
  userId: string,
  input: CreateEventInput
): Promise<EventRecord> {
  const db = await getDb();
  const [row] = await db
    .insert(events)
    .values({
      userId,
      title: input.title.trim(),
      startsAt: input.startsAt ?? null,
      endsAt: input.endsAt ?? null,
      timezone: input.timezone ?? null,
      venue: input.venue ?? null,
      city: input.city ?? null,
      url: input.url ?? null,
      role: input.role ?? "attended",
      source: input.source ?? "manual",
      provider: input.provider ?? null,
      providerEventId: input.providerEventId ?? null,
      description: input.description ?? null,
      coverImageUrl: input.coverImageUrl ?? null,
      coverSourceUrl: input.coverSourceUrl ?? null,
      themeColor: input.themeColor ?? null,
      themeSource: input.themeSource ?? null,
      attendeeCount: input.attendeeCount ?? null,
      notes: input.notes ?? null,
    })
    .returning();
  return row!;
}

export async function updateEventForUser(
  userId: string,
  eventId: string,
  patch: Partial<CreateEventInput> & {
    enrichedAt?: Date | null;
    enrichError?: string | null;
    themeLocked?: number;
  }
): Promise<void> {
  const db = await getDb();
  await db
    .update(events)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(events.id, eventId), eq(events.userId, userId)));
}

export async function deleteEventForUser(userId: string, eventId: string): Promise<void> {
  const db = await getDb();
  // Attendees cascade; the contacts they were connected to are deliberately left alone.
  await db.delete(events).where(and(eq(events.id, eventId), eq(events.userId, userId)));
}

/**
 * The one write path for attendees, whatever produced them.
 *
 * Idempotent on `(event_id, identity_key)`: re-pasting a list, re-uploading a CSV, or a
 * provider re-sync all update the rows they already wrote instead of duplicating them. That
 * unique index is the whole mechanism — see `event_attendees_identity_uidx`.
 *
 * `contact_id` and `spoke_to` are conspicuously absent from the update set. They are the
 * human's answer to "did you actually talk to this person", and a re-sync must never revise
 * it. Scalars use COALESCE(excluded, existing) so a later, richer source fills blanks without
 * overwriting something already known — the same set-or-leave-alone rule
 * `bulkMergeContactsForUser` follows.
 *
 * One statement regardless of roster size.
 */
export async function upsertEventAttendees(
  userId: string,
  eventId: string,
  attendees: ParsedAttendee[],
  source: AttendeeSource
): Promise<number> {
  if (attendees.length === 0) return 0;
  const db = await getDb();

  const values = attendees.map(
    (a) =>
      sql`(${eventId}::uuid, ${userId}, ${a.fullName}, ${a.email}, ${a.company}, ${a.title},
           ${a.linkedinUrl}, ${a.xHandle}, ${source}, ${a.identityKey})`
  );

  await db.execute(sql`
    INSERT INTO event_attendees
      (event_id, user_id, full_name, email, company, title, linkedin_url, x_handle, source, identity_key)
    VALUES ${sql.join(values, sql`, `)}
    ON CONFLICT (event_id, identity_key) DO UPDATE SET
      full_name    = COALESCE(event_attendees.full_name, excluded.full_name),
      email        = COALESCE(event_attendees.email, excluded.email),
      company      = COALESCE(event_attendees.company, excluded.company),
      title        = COALESCE(event_attendees.title, excluded.title),
      linkedin_url = COALESCE(event_attendees.linkedin_url, excluded.linkedin_url),
      x_handle     = COALESCE(event_attendees.x_handle, excluded.x_handle),
      updated_at   = now()
  `);

  return attendees.length;
}

/** Toggle "I spoke to this person". Scoped by user, so an id from a client cannot cross owners. */
export async function setSpokeToForUser(
  userId: string,
  eventId: string,
  attendeeIds: string[],
  spokeTo: boolean
): Promise<void> {
  if (attendeeIds.length === 0) return;
  const db = await getDb();
  await db
    .update(eventAttendees)
    .set({ spokeTo: spokeTo ? 1 : 0, updatedAt: new Date() })
    .where(
      and(
        eq(eventAttendees.userId, userId),
        eq(eventAttendees.eventId, eventId),
        inArray(eventAttendees.id, attendeeIds)
      )
    );
}

/** Attendee rows by id, always re-read server-side rather than trusted from the client. */
export async function loadAttendeesForUser(
  userId: string,
  eventId: string,
  attendeeIds: string[]
) {
  if (attendeeIds.length === 0) return [];
  const db = await getDb();
  return db.query.eventAttendees.findMany({
    where: and(
      eq(eventAttendees.userId, userId),
      eq(eventAttendees.eventId, eventId),
      inArray(eventAttendees.id, attendeeIds)
    ),
  });
}

/**
 * Record which contact each attendee became, in one statement.
 *
 * `UPDATE ... FROM (VALUES ...)` rather than a loop: the ingest path already collapsed to
 * three statements per batch, and a per-row write here would put the round trips straight back.
 */
export async function linkAttendeesToContacts(
  userId: string,
  links: Array<{ attendeeId: string; contactId: string }>
): Promise<void> {
  if (links.length === 0) return;
  const db = await getDb();
  const values = links.map((l) => sql`(${l.attendeeId}::uuid, ${l.contactId}::uuid)`);
  await db.execute(sql`
    UPDATE event_attendees AS a
       SET contact_id = v.contact_id, converted_at = now(), spoke_to = 1, updated_at = now()
      FROM (VALUES ${sql.join(values, sql`, `)}) AS v(attendee_id, contact_id)
     WHERE a.id = v.attendee_id AND a.user_id = ${userId}
  `);
}

/** Undo one connection. Clears the link but never deletes the contact — see the UI copy. */
export async function unlinkAttendeeForUser(
  userId: string,
  attendeeId: string
): Promise<void> {
  const db = await getDb();
  await db
    .update(eventAttendees)
    .set({ contactId: null, convertedAt: null, spokeTo: 0, updatedAt: new Date() })
    .where(and(eq(eventAttendees.userId, userId), eq(eventAttendees.id, attendeeId)));
}
