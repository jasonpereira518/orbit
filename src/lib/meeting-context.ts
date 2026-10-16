/**
 * Everything worth knowing before one meeting — read by the `meeting_context` chat tool and
 * by the prep card (`getMeetingPrep`). No model call: it is the stored brief, the dated
 * history and what is open, so the card costs nothing and the tool answers in one round.
 */
import { and, asc, desc, eq, gt, gte, inArray, isNull, lte, lt, ne, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  actionItems,
  calendarEvents,
  contactBriefs,
  contacts,
  interactions,
  meetingSessions,
  memoryChunks,
  reminders,
  userSettings,
} from "@/db/schema";
import { companyFromEmail, loadGuestBriefs, type GuestBrief } from "@/lib/guest-profiles";
import { listUpcomingEvents, relinkEvents, type CalendarEventRow } from "@/lib/calendar-events";
import { resolveTimeZone, ymdInZone } from "@/lib/reminder-due-bucket";
import { lastSeriesMeeting } from "@/lib/meeting-sessions";

/** The user's own zone, as Settings/Radar last saw it; UTC until then. */
export async function userTimeZone(userId: string): Promise<string> {
  const db = await getDb();
  const settings = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
    columns: { radarDigestTz: true },
  });
  return resolveTimeZone(settings?.radarDigestTz);
}

/** One calendar event as the calendar tools return it: local times, no emails. */
export function eventView(e: CalendarEventRow, tz: string) {
  const when = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return {
    eventId: e.id,
    title: e.title,
    day: ymdInZone(e.startAt, tz),
    start: e.allDay ? "all day" : when.format(e.startAt),
    end: e.endAt && !e.allDay ? when.format(e.endAt) : null,
    timeZone: tz,
    location: e.location,
    call: e.conferenceKind,
    response: e.selfResponse,
    // Never the address: these go to the chat model and over MCP. A guest with no display name
    // is "Guest" unless they are a contact (their name then comes from get_contact).
    attendees: e.attendees.map((a) => ({ name: a.name || "Guest", contactId: a.contactId })),
    attendeeCount: e.attendeeCount,
    guestListHidden: e.guestsHidden,
  };
}

/** "15:00" in `tz` for an instant — what "my 3pm" is matched against. */
export function hhmmInZone(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
}

export type MeetingSelector = { eventId?: string; time?: string; day?: string; query?: string };

export type MeetingPerson = {
  contactId: string;
  name: string;
  company: string | null;
  title: string | null;
  standing: string | null;
  nextStep: string | null;
  recent: Array<{ day: string | null; type: string; summary: string | null }>;
  /** To-dos with this person due on or before the meeting starts — the ones to close first. */
  dueBefore: string[];
  open: string[];
  /** The latest things the user's own notes say involving them, newest first. */
  fromNotes: Array<{ day: string | null; snippet: string }>;
};

export type GuestNotInOrbit = {
  name: string;
  email: string;
  /** From the email domain (free); null for gmail.com and friends. */
  company: string | null;
  /** What a "Look up" (Find people's research) found, when one was run and was sure. */
  profile: GuestBrief | null;
};

/**
 * One meeting and its people. By id, by local start time (and day), by title words, or — with
 * none of those — the next meeting with someone the user knows. Null when nothing matches.
 */
export async function getMeetingContext(
  userId: string,
  sel: MeetingSelector,
  now: Date
): Promise<{
  event: CalendarEventRow;
  tz: string;
  people: MeetingPerson[];
  notInOrbit: GuestNotInOrbit[];
  /** For a recurring meeting that was recorded before: what the last one decided and left open. */
  lastTime: { day: string; decisions: string[]; actionItems: string[] } | null;
} | null> {
  const tz = await userTimeZone(userId);
  const all = await listUpcomingEvents(userId, {
    from: new Date(now.getTime() - 2 * 86_400_000),
    to: new Date(now.getTime() + 14 * 86_400_000),
    limit: 200,
  });
  // Started up to an hour ago still counts as "my next meeting" — they may be in it.
  const soon = all.filter((e) => !e.allDay && (e.endAt ?? e.startAt).getTime() > now.getTime() - 3_600_000);
  const words = (sel.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const found = sel.eventId
    ? all.find((e) => e.id === sel.eventId)
    : sel.time
      ? soon.find((e) => hhmmInZone(e.startAt, tz) === sel.time && (!sel.day || ymdInZone(e.startAt, tz) === sel.day))
      : words.length
        ? soon.find((e) => words.every((w) => e.title.toLowerCase().includes(w)))
        : soon.find((e) => e.startAt.getTime() > now.getTime() - 3_600_000 && e.attendees.some((a) => a.contactId));
  if (!found) return null;
  const [event] = await relinkEvents(userId, [found]);

  const ids = [...new Set(event.attendees.map((a) => a.contactId).filter((c): c is string => !!c))].slice(0, 8);
  const strangers = event.attendees.filter((a) => !a.contactId).slice(0, 10);
  const looked = await loadGuestBriefs(userId, strangers);
  const notInOrbit: GuestNotInOrbit[] = strangers.map((a) => ({
    name: a.name,
    email: a.email,
    company: companyFromEmail(a.email),
    profile: looked.get(a.email.toLowerCase()) ?? null,
  }));
  const last = event.seriesId ? await lastSeriesMeeting(userId, event.seriesId) : null;
  const lastTime = last
    ? {
        day: ymdInZone(last.startedAt, tz),
        decisions: last.decisions,
        actionItems: last.actionItems.map((a) => (a.owner ? `${a.text} — ${a.owner === "me" ? "you" : a.owner}` : a.text)),
      }
    : null;
  if (!ids.length) return { event, tz, people: [], notInOrbit, lastTime };

  const db = await getDb();
  const [people, briefs, todos, items, recent, notes] = await Promise.all([
    db.query.contacts.findMany({
      where: and(eq(contacts.userId, userId), inArray(contacts.id, ids)),
      columns: { id: true, fullName: true, company: true, title: true },
    }),
    db.query.contactBriefs.findMany({
      where: and(eq(contactBriefs.userId, userId), inArray(contactBriefs.contactId, ids)),
      columns: { contactId: true, standing: true, nextStep: true },
    }),
    db.query.reminders.findMany({
      where: and(
        eq(reminders.userId, userId),
        inArray(reminders.contactId, ids),
        eq(reminders.status, "pending"),
        // Not the meeting's own prep/follow-up reminders: those are about this event.
        isNull(reminders.calendarEventKey)
      ),
      columns: { contactId: true, title: true, dueDate: true },
      orderBy: [asc(reminders.dueDate)],
      limit: 40,
    }),
    db.query.actionItems.findMany({
      where: and(eq(actionItems.userId, userId), inArray(actionItems.contactId, ids), eq(actionItems.status, "open")),
      columns: { contactId: true, text: true },
      limit: 40,
    }),
    Promise.all(
      ids.map((id) =>
        db.query.interactions.findMany({
          // The past only: calendar sync logs this very meeting as an interaction too.
          where: and(
            eq(interactions.userId, userId),
            eq(interactions.contactId, id),
            lte(interactions.interactionDate, now)
          ),
          orderBy: [desc(interactions.interactionDate)],
          limit: 3,
          columns: { interactionType: true, interactionDate: true, aiSummary: true },
        })
      )
    ),
    // What the user's own notes say with them in it. Lexical-free and embedding-free: just the
    // newest passages that name them (the contacts GIN index), never the generated brief.
    Promise.all(
      ids.map((id) =>
        db
          .select({ occurredAt: memoryChunks.occurredAt, content: memoryChunks.content })
          .from(memoryChunks)
          .where(
            and(
              eq(memoryChunks.userId, userId),
              sql`${memoryChunks.contactIds} && array[${id}]::uuid[]`,
              ne(memoryChunks.sourceKind, "brief")
            )
          )
          .orderBy(sql`${memoryChunks.occurredAt} desc nulls last`)
          .limit(2)
      )
    ),
  ]);
  const notesBy = new Map(notes.map((rows, i) => [ids[i], rows]));
  const snippet = (text: string) => {
    const t = text.replace(/\s+/g, " ").trim();
    return t.length > 180 ? `${t.slice(0, 177)}…` : t;
  };
  const recentBy = new Map(recent.map((rows, i) => [ids[i], rows]));
  return {
    event,
    tz,
    notInOrbit,
    lastTime,
    people: people.map((c) => {
      const brief = briefs.find((b) => b.contactId === c.id);
      return {
        contactId: c.id,
        name: c.fullName,
        company: c.company,
        title: c.title,
        standing: brief?.standing ?? null,
        nextStep: brief?.nextStep ?? null,
        recent: (recentBy.get(c.id) ?? []).map((i) => ({
          day: i.interactionDate ? ymdInZone(i.interactionDate, tz) : null,
          type: i.interactionType,
          summary: i.aiSummary,
        })),
        dueBefore: todos
          .filter((t) => t.contactId === c.id && t.dueDate && t.dueDate.getTime() <= event.startAt.getTime())
          .map((t) => t.title)
          .slice(0, 5),
        open: [
          ...todos
            .filter((t) => t.contactId === c.id && !(t.dueDate && t.dueDate.getTime() <= event.startAt.getTime()))
            .map((t) => t.title),
          ...items.filter((t) => t.contactId === c.id).map((t) => t.text),
        ].slice(0, 5),
        fromNotes: (notesBy.get(c.id) ?? []).map((n) => ({
          day: n.occurredAt ? ymdInZone(n.occurredAt, tz) : null,
          snippet: snippet(n.content),
        })),
      };
    }),
  };
}

/**
 * The next meeting with someone the user knows, starting within `withinMs` — for the app
 * pulse, which runs every 90 seconds per tab, so one indexed read, plus the contact re-match
 * when a meeting is near.
 */
export async function nextKnownMeeting(
  userId: string,
  now: Date,
  withinMs: number
): Promise<{ eventId: string; title: string; startIso: string; people: string[] } | null> {
  const db = await getDb();
  const rows = await db
    .select({
      id: calendarEvents.id,
      title: calendarEvents.title,
      startAt: calendarEvents.startAt,
      attendees: calendarEvents.attendees,
    })
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.userId, userId),
        gt(calendarEvents.startAt, now),
        lt(calendarEvents.startAt, new Date(now.getTime() + withinMs)),
        eq(calendarEvents.allDay, false),
        or(isNull(calendarEvents.selfResponse), ne(calendarEvents.selfResponse, "declined"))
      )
    )
    .orderBy(asc(calendarEvents.startAt))
    .limit(5);
  // Two small reads, only when a meeting is near: someone added since the last sync counts now.
  const linked = await relinkEvents(userId, rows);
  const e = linked.find((r) => r.attendees.some((a) => a.contactId));
  if (!e) return null;
  return {
    eventId: e.id,
    title: e.title,
    startIso: e.startAt.toISOString(),
    people: e.attendees
      .filter((a) => a.contactId)
      .map((a) => a.name || a.email)
      .slice(0, 4),
  };
}

/** Past this, "how did it go?" is history, not a question. */
const UNLOGGED_WITHIN_MS = 3 * 3_600_000;

/**
 * The meeting that just ended with someone the user knows and left no trace: not recorded, and
 * no note or log for those people since it started. For the app pulse's "How did it go?" card —
 * one indexed read, then two small ones only when there is a candidate.
 */
export async function lastUnloggedMeeting(
  userId: string,
  now: Date
): Promise<{ eventId: string; title: string; endIso: string; people: string[] } | null> {
  const db = await getDb();
  const rows = await db
    .select({
      id: calendarEvents.id,
      providerEventId: calendarEvents.providerEventId,
      title: calendarEvents.title,
      startAt: calendarEvents.startAt,
      endAt: calendarEvents.endAt,
      attendees: calendarEvents.attendees,
      attendeeCount: calendarEvents.attendeeCount,
    })
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.userId, userId),
        lte(calendarEvents.endAt, now),
        gte(calendarEvents.endAt, new Date(now.getTime() - UNLOGGED_WITHIN_MS)),
        eq(calendarEvents.allDay, false),
        or(isNull(calendarEvents.selfResponse), ne(calendarEvents.selfResponse, "declined"))
      )
    )
    .orderBy(desc(calendarEvents.endAt))
    .limit(5);
  // A real meeting: someone known on it, and small enough to be a conversation.
  const e = rows.find((r) => r.attendeeCount > 0 && r.attendeeCount <= 8 && r.attendees.some((a) => a.contactId));
  if (!e || !e.endAt) return null;
  const ids = e.attendees.map((a) => a.contactId).filter((c): c is string => !!c);
  const [recorded, logged] = await Promise.all([
    db
      .select({ id: meetingSessions.id })
      .from(meetingSessions)
      .where(and(eq(meetingSessions.userId, userId), eq(meetingSessions.calendarEventKey, e.providerEventId)))
      .limit(1),
    db
      .select({ id: interactions.id })
      .from(interactions)
      .where(
        and(
          eq(interactions.userId, userId),
          inArray(interactions.contactId, ids),
          gte(interactions.createdAt, e.startAt),
          // Calendar sync logs the meeting itself; that is not the user writing anything down.
          or(isNull(interactions.source), ne(interactions.source, "google_calendar"))
        )
      )
      .limit(1),
  ]);
  if (recorded.length || logged.length) return null;
  return {
    eventId: e.id,
    title: e.title,
    endIso: e.endAt.toISOString(),
    people: e.attendees
      .filter((a) => a.contactId)
      .map((a) => a.name || a.email)
      .slice(0, 4),
  };
}
