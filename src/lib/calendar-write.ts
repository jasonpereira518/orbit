/**
 * Meetings chat sets up, written to the person's own Google or Outlook calendar.
 *
 * Only for a connection that granted the `calendar_write` purpose (Google `calendar.events`,
 * Graph `Calendars.ReadWrite`) — asked for from the meeting's own card, never at Connect.
 * Nobody is invited: no attendees are sent and Google is told `sendUpdates=none`, so the
 * only calendar that changes is theirs.
 *
 * The meeting stays a `meet` reminder too (Reminders lists it with its time); the reminder's
 * `calendar_event_key` holds the provider's event id, which is how Today's meetings shows it
 * once and how Undo finds the event to remove. The new event is stored in `calendar_events`
 * straight away rather than at the next sync, so it is on the dashboard as soon as it exists.
 *
 * Its own module because it reaches both providers' credentials (as `calendar-window.ts`).
 */
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { calendarEvents, calendarSources, gmailConnections, outlookConnections, reminders } from "@/db/schema";
import { refreshCalendarWindow } from "@/lib/calendar-events";
import { seedCalendarSources } from "@/lib/calendar-sources";
import * as google from "@/lib/connectors/google-calendar";
import * as microsoft from "@/lib/connectors/microsoft-calendar";
import { getValidAccessToken as getGoogleToken } from "@/lib/gmail";
import { GOOGLE_SCOPES, hasScope as hasGoogleScope } from "@/lib/google-scopes";
import { GRAPH_API } from "@/lib/graph-fetch";
import { MICROSOFT_SCOPES, hasScope as hasMicrosoftScope } from "@/lib/microsoft-scopes";
import { getValidAccessToken as getOutlookToken } from "@/lib/outlook";

const GOOGLE_EVENTS_API = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const GRAPH_EVENTS_API = `${GRAPH_API}/me/events`;
const TIMEOUT_MS = 10_000;

export type CalendarProvider = "google" | "microsoft";

export type CalendarWriteDeps = {
  fetchImpl?: typeof fetch;
  getGoogleToken?: typeof getGoogleToken;
  getOutlookToken?: typeof getOutlookToken;
};

type Connection = { provider: CalendarProvider; id: string; email: string; scopes: string | null };

async function activeConnections(userId: string): Promise<Connection[]> {
  const db = await getDb();
  const [g, o] = await Promise.all([
    db.query.gmailConnections.findFirst({ where: and(eq(gmailConnections.userId, userId), eq(gmailConnections.status, "active")) }),
    db.query.outlookConnections.findFirst({ where: and(eq(outlookConnections.userId, userId), eq(outlookConnections.status, "active")) }),
  ]);
  return [
    ...(g ? [{ provider: "google" as const, id: g.id, email: g.emailAddress ?? "", scopes: g.scopes }] : []),
    ...(o ? [{ provider: "microsoft" as const, id: o.id, email: o.emailAddress ?? "", scopes: o.scopes }] : []),
  ];
}

const canWrite = (c: Connection) =>
  c.provider === "google"
    ? hasGoogleScope(c.scopes, GOOGLE_SCOPES.calendarWrite)
    : hasMicrosoftScope(c.scopes, MICROSOFT_SCOPES.calendarWrite);
const canRead = (c: Connection) =>
  c.provider === "google"
    ? hasGoogleScope(c.scopes, GOOGLE_SCOPES.calendar)
    : hasMicrosoftScope(c.scopes, MICROSOFT_SCOPES.calendar);

export type CalendarWriteState =
  | { kind: "ready"; provider: CalendarProvider }
  | { kind: "grant"; provider: CalendarProvider }
  | { kind: "none" };

/**
 * What adding a meeting to a calendar needs right now: `ready` when a connection may write,
 * `grant` naming the provider to ask when one is connected without it, `none` otherwise.
 */
export async function calendarWriteState(userId: string): Promise<CalendarWriteState> {
  const conns = await activeConnections(userId);
  const writer = conns.find(canWrite);
  if (writer) return { kind: "ready", provider: writer.provider };
  const other = conns.find(canRead) ?? conns[0];
  return other ? { kind: "grant", provider: other.provider } : { kind: "none" };
}

export type CalendarMeeting = {
  title: string;
  startsAt: Date;
  durationMin?: number | null;
  location?: string | null;
  description?: string | null;
};

/**
 * Add `m` to the first calendar that may be written, store it in `calendar_events`, and return
 * where it went — or null when no connection may write. A provider refusal throws.
 */
export async function addCalendarMeeting(
  userId: string,
  m: CalendarMeeting,
  deps: CalendarWriteDeps = {}
): Promise<{ provider: CalendarProvider; eventId: string } | null> {
  const conn = (await activeConnections(userId)).find(canWrite);
  if (!conn) return null;
  const doFetch = deps.fetchImpl ?? fetch;
  const endsAt = new Date(m.startsAt.getTime() + (m.durationMin ?? 30) * 60_000);
  let stored: google.StoredCalendarEvent[];
  let eventId: string;

  if (conn.provider === "google") {
    const token = await (deps.getGoogleToken ?? getGoogleToken)(userId);
    const res = await doFetch(`${GOOGLE_EVENTS_API}?sendUpdates=none`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        summary: m.title,
        ...(m.location ? { location: m.location } : {}),
        ...(m.description ? { description: m.description } : {}),
        start: { dateTime: m.startsAt.toISOString() },
        end: { dateTime: endsAt.toISOString() },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Google Calendar refused the event (${res.status})`);
    const raw = (await res.json()) as Parameters<typeof google.storedEventsOf>[0][number];
    eventId = String(raw.id ?? "");
    stored = google.storedEventsOf([raw]);
  } else {
    const token = await (deps.getOutlookToken ?? getOutlookToken)(userId);
    const res = await doFetch(GRAPH_EVENTS_API, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json", Prefer: 'outlook.timezone="UTC"' },
      body: JSON.stringify({
        subject: m.title,
        ...(m.location ? { location: { displayName: m.location } } : {}),
        ...(m.description ? { body: { contentType: "text", content: m.description } } : {}),
        start: { dateTime: m.startsAt.toISOString().slice(0, 19), timeZone: "UTC" },
        end: { dateTime: endsAt.toISOString().slice(0, 19), timeZone: "UTC" },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Outlook refused the event (${res.status})`);
    const raw = (await res.json()) as Parameters<typeof microsoft.storedEventsOf>[0][number];
    eventId = String(raw.id ?? "");
    stored = microsoft.storedEventsOf([raw], conn.email);
  }
  if (!eventId) throw new Error("The calendar returned no event id");

  // Best effort: the event exists either way, and the next sync stores it if this does not.
  try {
    const source = await sourceFor(userId, conn);
    if (source && stored.length) await refreshCalendarWindow(userId, source, { events: stored, complete: false }, new Date());
  } catch {
    // Left to the sync.
  }
  return { provider: conn.provider, eventId };
}

async function sourceFor(userId: string, conn: Connection): Promise<string | null> {
  const db = await getDb();
  const find = () =>
    db.query.calendarSources.findFirst({
      where: and(
        eq(calendarSources.userId, userId),
        eq(calendarSources.connectionId, conn.id),
        eq(calendarSources.calendarId, conn.provider === "google" ? "primary" : "default")
      ),
    });
  let source = await find();
  if (!source) {
    await seedCalendarSources(userId);
    source = await find();
  }
  return source?.id ?? null;
}

/**
 * Remove an event Orbit added, by its provider id, and its `calendar_events` row. The provider
 * is the one its stored row came from; without a row (not synced yet), the connection that
 * may write. Already gone at the provider counts as removed.
 */
export async function removeCalendarMeeting(userId: string, eventId: string, deps: CalendarWriteDeps = {}): Promise<void> {
  const db = await getDb();
  const [row] = await db
    .select({ provider: calendarSources.provider })
    .from(calendarEvents)
    .innerJoin(calendarSources, eq(calendarSources.id, calendarEvents.sourceId))
    .where(and(eq(calendarEvents.userId, userId), eq(calendarEvents.providerEventId, eventId)))
    .limit(1);
  const state = row ? null : await calendarWriteState(userId);
  const provider = row?.provider ?? (state?.kind === "ready" ? state.provider : null);
  if (provider !== "google" && provider !== "microsoft") return;

  const doFetch = deps.fetchImpl ?? fetch;
  const id = encodeURIComponent(eventId);
  const res =
    provider === "google"
      ? await doFetch(`${GOOGLE_EVENTS_API}/${id}?sendUpdates=none`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${await (deps.getGoogleToken ?? getGoogleToken)(userId)}` },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        })
      : await doFetch(`${GRAPH_EVENTS_API}/${id}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${await (deps.getOutlookToken ?? getOutlookToken)(userId)}` },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
  if (!res.ok && res.status !== 404 && res.status !== 410) throw new Error(`The calendar refused the removal (${res.status})`);
  await db.delete(calendarEvents).where(and(eq(calendarEvents.userId, userId), eq(calendarEvents.providerEventId, eventId)));
}

/** Put a `meet` reminder's meeting on the calendar and link the two. Null when nothing may write. */
export async function addReminderMeetingToCalendar(
  userId: string,
  reminderId: string,
  deps: CalendarWriteDeps = {}
): Promise<{ provider: CalendarProvider; eventId: string } | null> {
  const db = await getDb();
  const row = await db.query.reminders.findFirst({ where: and(eq(reminders.id, reminderId), eq(reminders.userId, userId)) });
  if (!row || row.actionKind !== "meet" || !row.dueDate || row.status !== "pending") throw new Error("That meeting is gone");
  if (row.calendarEventKey) throw new Error("That meeting is already on your calendar");
  const added = await addCalendarMeeting(userId, { title: row.title, startsAt: row.dueDate, description: row.description }, deps);
  if (added) {
    await db
      .update(reminders)
      .set({ calendarEventKey: added.eventId })
      .where(and(eq(reminders.id, reminderId), eq(reminders.userId, userId)));
  }
  return added;
}
