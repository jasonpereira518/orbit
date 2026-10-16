/**
 * `calendar_events`: the near calendar, mirrored.
 *
 * Why a windowed mirror and not the incremental sync token: Google's `syncToken` returns only
 * what CHANGED, so a weekly 1:1 created months ago never re-arrives as its instances drift into
 * "next week". One windowed read per sync pass (`fetchCalendarWindow`) sidesteps that, and makes
 * deletes free — anything in the window Google no longer returns is gone.
 */
import { and, asc, eq, gte, inArray, lt, notInArray, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import { calendarEvents, contactIdentities, contacts, reminders, type CalendarEventAttendee } from "@/db/schema";
import type { StoredCalendarEvent } from "@/lib/connectors/google-calendar";
import { syncCalendarReminders } from "@/lib/calendar-reminders";

export const EVENTS_WINDOW_PAST_MS = 2 * 86_400_000;
export const EVENTS_WINDOW_FUTURE_MS = 14 * 86_400_000;

export function eventsWindow(now: Date): { from: Date; to: Date } {
  return {
    from: new Date(now.getTime() - EVENTS_WINDOW_PAST_MS),
    to: new Date(now.getTime() + EVENTS_WINDOW_FUTURE_MS),
  };
}

/**
 * Attendee email → the user's contact, through `contact_identities` first (a contact's second
 * address lives only there) and then `contacts.email`.
 */
async function contactIdsByEmail(userId: string, emails: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!emails.length) return out;
  const db = await getDb();
  const [byIdentity, byColumn] = await Promise.all([
    db
      .select({ value: contactIdentities.value, contactId: contactIdentities.contactId })
      .from(contactIdentities)
      .where(
        and(
          eq(contactIdentities.userId, userId),
          eq(contactIdentities.kind, "email"),
          inArray(contactIdentities.value, emails)
        )
      ),
    db
      .select({ email: contacts.email, id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.userId, userId), inArray(sql`lower(${contacts.email})`, emails))),
  ]);
  for (const r of byColumn) if (r.email) out.set(r.email.toLowerCase(), r.id);
  for (const r of byIdentity) out.set(r.value, r.contactId);
  return out;
}

/**
 * Events with their attendees re-matched to contacts now, in one lookup. A row's links were made
 * at its last refresh, so someone added a minute ago (the prep card's "Add") would otherwise
 * still read as a stranger.
 */
export async function relinkEvents<T extends { attendees: CalendarEventAttendee[] }>(
  userId: string,
  events: T[]
): Promise<T[]> {
  const emails = [...new Set(events.flatMap((e) => e.attendees.map((a) => a.email)).filter(Boolean))];
  if (!emails.length) return events;
  const byEmail = await contactIdsByEmail(userId, emails);
  return events.map((e) => ({
    ...e,
    attendees: e.attendees.map((a) => ({ ...a, contactId: (a.email && byEmail.get(a.email)) || a.contactId })),
  }));
}

/**
 * Deletes events and dismisses the still-pending reminders made for the ones not yet started —
 * a prep nudge for a meeting Orbit can no longer see. A follow-up for a meeting that already
 * happened stays: the meeting took place whatever became of the calendar.
 */
export async function dropCalendarEvents(where: SQL, now: Date): Promise<number> {
  const db = await getDb();
  const gone = await db.delete(calendarEvents).where(where).returning();
  const upcoming = new Map<string, string[]>();
  for (const e of gone) {
    if (e.startAt.getTime() <= now.getTime()) continue;
    upcoming.set(e.userId, [...(upcoming.get(e.userId) ?? []), e.providerEventId]);
  }
  for (const [userId, keys] of upcoming) {
    await db
      .update(reminders)
      .set({ status: "dismissed" })
      .where(
        and(eq(reminders.userId, userId), eq(reminders.status, "pending"), inArray(reminders.calendarEventKey, keys))
      );
  }
  return gone.length;
}

/** Rows no sync has touched in this long belong to a calendar Orbit can no longer read. */
export const STALE_EVENT_MS = 24 * 3_600_000;

/**
 * Drops events from calendars that stopped refreshing — access revoked, scope removed, a
 * connection failing for a day. A healthy source re-touches every row on each complete read.
 */
export function pruneStaleCalendarEvents(now: Date): Promise<number> {
  return dropCalendarEvents(lt(calendarEvents.updatedAt, new Date(now.getTime() - STALE_EVENT_MS)), now);
}

/**
 * Rewrite one source's window from a fresh read. `complete: false` (a truncated or failed read)
 * upserts what arrived and deletes nothing, because absence from a partial read proves nothing.
 */
export async function refreshCalendarWindow(
  userId: string,
  sourceId: string,
  read: { events: StoredCalendarEvent[]; complete: boolean },
  now: Date
): Promise<{ stored: number }> {
  const db = await getDb();
  const { to } = eventsWindow(now);
  const { events } = read;
  const emails = [...new Set(events.flatMap((e) => e.attendees.map((a) => a.email).filter(Boolean)))];
  const byEmail = await contactIdsByEmail(userId, emails);

  if (read.complete) {
    // Everything before the window's end that this read did not return: deleted, cancelled, or
    // aged out past the back edge.
    const ids = events.map((e) => e.providerEventId);
    await db
      .delete(calendarEvents)
      .where(
        and(
          eq(calendarEvents.sourceId, sourceId),
          lt(calendarEvents.startAt, to),
          ids.length ? notInArray(calendarEvents.providerEventId, ids) : undefined
        )
      );
  }

  const rows = events.map((e) => ({
    userId,
    sourceId,
    ...e,
    attendees: e.attendees.map(
      (a): CalendarEventAttendee => ({ ...a, contactId: (a.email && byEmail.get(a.email)) || null })
    ),
    updatedAt: now,
  }));
  if (rows.length) {
    await db
      .insert(calendarEvents)
      .values(rows)
      .onConflictDoUpdate({
        target: [calendarEvents.sourceId, calendarEvents.providerEventId],
        set: {
          icalUid: sql`excluded.ical_uid`,
          seriesId: sql`excluded.series_id`,
          title: sql`excluded.title`,
          startAt: sql`excluded.start_at`,
          endAt: sql`excluded.end_at`,
          allDay: sql`excluded.all_day`,
          location: sql`excluded.location`,
          agenda: sql`excluded.agenda`,
          conferenceUrl: sql`excluded.conference_url`,
          conferenceKind: sql`excluded.conference_kind`,
          attendees: sql`excluded.attendees`,
          attendeeCount: sql`excluded.attendee_count`,
          guestsHidden: sql`excluded.guests_hidden`,
          selfResponse: sql`excluded.self_response`,
          organizerEmail: sql`excluded.organizer_email`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
  }
  // Prep and post-meeting reminders read the same rows, with attendees already resolved.
  await syncCalendarReminders(userId, rows, read.complete, now);
  return { stored: events.length };
}

export type CalendarEventRow = typeof calendarEvents.$inferSelect;

/**
 * The user's events overlapping [from, to), soonest first. With `contactId`, only events that
 * person is on. Bounded: the window is two weeks, and `limit` caps it further.
 */
export async function listUpcomingEvents(
  userId: string,
  opts: { from: Date; to: Date; contactId?: string; limit?: number }
): Promise<CalendarEventRow[]> {
  const db = await getDb();
  return db
    .select()
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.userId, userId),
        lt(calendarEvents.startAt, opts.to),
        gte(sql`coalesce(${calendarEvents.endAt}, ${calendarEvents.startAt})`, opts.from),
        opts.contactId
          ? sql`${calendarEvents.attendees} @> ${JSON.stringify([{ contactId: opts.contactId }])}::jsonb`
          : undefined
      )
    )
    .orderBy(asc(calendarEvents.startAt))
    .limit(opts.limit ?? 50);
}

/** One event by the provider's per-instance id — what a recording stores. Null once it ages out of the window. */
export async function findEventByKey(userId: string, providerEventId: string): Promise<CalendarEventRow | null> {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(calendarEvents)
    .where(and(eq(calendarEvents.userId, userId), eq(calendarEvents.providerEventId, providerEventId)))
    .limit(1);
  return row ?? null;
}

/**
 * The calendar event a recording was of, when it was started without the calendar nudge:
 * an event under way when recording began, or starting within 15 minutes of it. One such event
 * is the answer; among several, the one whose title or guests match the recording's, and only
 * when it clearly beats the rest. Otherwise null — a wrong link is worse than none.
 */
export function pickEventForRecording(
  candidates: CalendarEventRow[],
  recording: { title: string | null; attendees: Array<{ name: string; email?: string | null }> }
): CalendarEventRow | null {
  const timed = candidates.filter((e) => !e.allDay && e.selfResponse !== "declined");
  if (timed.length <= 1) return timed[0] ?? null;
  const title = recording.title?.trim().toLowerCase() || null;
  const emails = new Set(recording.attendees.map((a) => a.email?.toLowerCase()).filter((e): e is string => !!e));
  const names = new Set(recording.attendees.map((a) => a.name.trim().toLowerCase()).filter(Boolean));
  const scored = timed
    .map((e) => ({
      e,
      score:
        (title && e.title.trim().toLowerCase() === title ? 2 : 0) +
        e.attendees.filter((a) => emails.has(a.email) || names.has(a.name.trim().toLowerCase())).length,
    }))
    .sort((a, b) => b.score - a.score);
  return scored[0].score > 0 && scored[0].score > scored[1].score ? scored[0].e : null;
}

export async function matchEventForSession(
  userId: string,
  startedAt: Date,
  recording: { title: string | null; attendees: Array<{ name: string; email?: string | null }> }
): Promise<CalendarEventRow | null> {
  const candidates = await listUpcomingEvents(userId, {
    from: startedAt,
    to: new Date(startedAt.getTime() + 15 * 60_000),
    limit: 20,
  });
  return pickEventForRecording(candidates, recording);
}

/** One of the user's events by its row id (owner-scoped) — for links like /capture?event=. */
export async function findEventById(userId: string, id: string): Promise<CalendarEventRow | null> {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(calendarEvents)
    .where(and(eq(calendarEvents.userId, userId), eq(calendarEvents.id, id)))
    .limit(1);
  return row ?? null;
}
