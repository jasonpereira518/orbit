/**
 * The user's upcoming meetings as a block in the chat prompt — so "what's on tomorrow?" or
 * "when do I next see Priya?" is answered in one pass from the stored calendar window, with
 * no research round. Preparing for a meeting still goes to research (`meeting_context`).
 */
import { addDaysYmd, ymdInZone } from "@/lib/reminder-due-bucket";
import { fromWallClockInput } from "@/lib/events/wall-clock";
import { EVENTS_WINDOW_PAST_MS, listUpcomingEvents, relinkEvents, type CalendarEventRow } from "@/lib/calendar-events";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts } from "@/db/schema";
import { hhmmInZone, isHandle, userTimeZone } from "@/lib/meeting-context";
import { freeSlots } from "@/lib/calendar-free";
import type { ParsedQuery } from "@/lib/chat-retrieval";

/** The mirror holds two weeks; a question about further out gets what there is. */
const MAX_DAYS = 14;
const DEFAULT_DAYS = 7;
const MAX_EVENTS = 15;
/** Meetings that already happened, shown before the upcoming ones — the newest few. */
const MAX_PAST_EVENTS = 8;

export type ChatCalendar = {
  tz: string;
  /** The prompt block, unfenced (ai.ts fences it). */
  text: string;
  /** Known attendees, for the recommendation allowlist and people cards. */
  people: Array<{ id: string; name: string }>;
  eventCount: number;
};

function wordsOf(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);
}

/** An attendee is "Priya" when every word asked for is one of their name's words. */
function attendeeMatches(name: string, person: string): boolean {
  const have = new Set(wordsOf(name));
  const want = wordsOf(person);
  return want.length > 0 && want.every((w) => have.has(w));
}

export async function loadChatCalendar(
  userId: string,
  parsed: Pick<ParsedQuery, "calendarWindow" | "person"> | null,
  availability: boolean,
  now: Date,
  tzOverride?: string,
  options: {
    /**
     * Also show what already happened in the stored window (the mirror keeps
     * `EVENTS_WINDOW_PAST_MS`, two days), so "who did I meet yesterday?" is answered too. Only
     * when the window asked about starts today — a question about next week gets next week.
     */
    recentPast?: boolean;
  } = {}
): Promise<ChatCalendar> {
  const tz = tzOverride ?? (await userTimeZone(userId));
  const today = ymdInZone(now, tz);
  const lastDay = addDaysYmd(today, MAX_DAYS);
  const window = parsed?.calendarWindow;
  const person = parsed?.person;
  const firstDay = window && window.after > today ? (window.after > lastDay ? lastDay : window.after) : today;
  const endDay = window
    ? window.before < firstDay
      ? firstDay
      : window.before > lastDay
        ? lastDay
        : window.before
    : person
      ? lastDay
      : addDaysYmd(today, DEFAULT_DAYS);
  // Today counts from now: what already ended is not "on" today any more.
  const from = firstDay === today ? now : (fromWallClockInput(`${firstDay}T00:00`, tz) ?? now);
  const to = fromWallClockInput(`${addDaysYmd(endDay, 1)}T00:00`, tz) ?? new Date(now.getTime() + MAX_DAYS * 86_400_000);

  // A person is matched by name on the invite, so someone not yet in Orbit is found too.
  // Or by the title: a guest with no display name is still the "David" of "Chat with David".
  const keep = (list: CalendarEventRow[]) =>
    (person
      ? list.filter((e) => attendeeMatches(e.title, person) || e.attendees.some((a) => attendeeMatches(a.name, person)))
      : list
    ).filter((e) => e.selfResponse !== "declined");
  const withPast = Boolean(options.recentPast) && firstDay === today;
  const [rows, pastRows] = await Promise.all([
    listUpcomingEvents(userId, { from, to, limit: person ? 200 : 60 }),
    withPast
      ? listUpcomingEvents(userId, { from: new Date(now.getTime() - EVENTS_WINDOW_PAST_MS), to: now, limit: 40 })
      : Promise.resolve([] as CalendarEventRow[]),
  ]);
  const linked = await relinkEvents(userId, keep(rows));
  const shown = linked.slice(0, MAX_EVENTS);
  // Started before now and not still running into the upcoming list above.
  const shownIds = new Set(shown.map((e) => e.id));
  const past = withPast
    ? (await relinkEvents(userId, keep(pastRows)))
        .filter((e) => e.startAt.getTime() < now.getTime() && !shownIds.has(e.id))
        .slice(-MAX_PAST_EVENTS)
    : [];

  // A known attendee by their contact's name — an invite often has none, or only the address.
  const ids = [
    ...new Set([...past, ...shown].flatMap((e) => e.attendees.flatMap((a) => (a.contactId ? [a.contactId] : [])))),
  ];
  const db = ids.length ? await getDb() : null;
  const found = db
    ? await db
        .select({ id: contacts.id, fullName: contacts.fullName, preferredName: contacts.preferredName, email: contacts.email })
        .from(contacts)
        .where(and(eq(contacts.userId, userId), inArray(contacts.id, ids)))
    : [];
  const byId = new Map(found.map((c) => [c.id, c]));
  // Never a handle ("dmcraver") while a real name is known; the handle still beats "a contact".
  const nameOf = (a: { name: string; email: string; contactId: string | null }) => {
    const c = a.contactId ? byId.get(a.contactId) : undefined;
    return (
      c?.preferredName?.trim() ||
      (c && !isHandle(c.fullName, c.email) ? c.fullName : null) ||
      (isHandle(a.name, a.email) ? null : a.name) ||
      c?.fullName ||
      "a contact"
    );
  };

  const dayLabel = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" });
  const lines: string[] = [];
  const byDay = new Map<string, CalendarEventRow[]>();
  for (const e of shown) {
    const d = ymdInZone(e.startAt, tz);
    byDay.set(d, [...(byDay.get(d) ?? []), e]);
  }
  // Availability needs every day in the window, meetings or not.
  const days = availability
    ? Array.from({ length: Math.min(MAX_DAYS, Math.max(1, Math.round((to.getTime() - from.getTime()) / 86_400_000))) }, (_, i) =>
        addDaysYmd(firstDay, i)
      ).filter((d) => d <= endDay)
    : [...byDay.keys()];
  const eventLine = (e: CalendarEventRow) => {
    const known = e.attendees.filter((a) => a.contactId).map(nameOf);
    const others = e.attendeeCount - known.length;
    const who = [known.join(", "), others > 0 ? `+${others} other${others === 1 ? "" : "s"}` : ""].filter(Boolean).join(", ");
    const when = e.allDay ? "all day" : `${hhmmInZone(e.startAt, tz)}${e.endAt ? `–${hhmmInZone(e.endAt, tz)}` : ""}`;
    return `- ${when} ${(e.title || "Untitled").replace(/\s+/g, " ").slice(0, 120)}${e.conferenceKind ? ` (${e.conferenceKind} call)` : ""}${who ? ` — with ${who}` : ""}`;
  };
  if (past.length) {
    lines.push("Already happened:");
    for (const e of past) {
      lines.push(`- ${dayLabel.format(e.startAt)}, ${eventLine(e).slice(2)}`);
    }
    lines.push("Coming up:");
  }
  for (const d of days) {
    const events = byDay.get(d) ?? [];
    const head = dayLabel.format(fromWallClockInput(`${d}T12:00`, tz) ?? now);
    lines.push(`${head}:${events.length ? "" : " no meetings"}`);
    for (const e of events) lines.push(eventLine(e));
    if (availability) {
      const free = freeSlots(byDay.get(d) ?? [], d, tz).map((s) => `${hhmmInZone(s.start, tz)}–${hhmmInZone(s.end, tz)}`);
      lines.push(`  Free (9:00–18:00): ${free.length ? free.join(", ") : "none"}`);
    }
  }
  if (linked.length > shown.length) lines.push(`(${linked.length - shown.length} more not shown)`);

  const people = new Map<string, string>();
  for (const e of [...past, ...shown]) for (const a of e.attendees) if (a.contactId) people.set(a.contactId, nameOf(a));
  const range = `${past.length ? "the last two days, then " : ""}${firstDay === endDay ? firstDay : `${firstDay} to ${endDay}`}`;
  const scope = person ? `meetings with "${person}"` : "meetings";
  return {
    tz,
    text: `Times are in ${tz}. The user's ${scope}, ${range}:\n${lines.length ? lines.join("\n") : "none"}`,
    people: [...people].map(([id, name]) => ({ id, name })),
    eventCount: shown.length + past.length,
  };
}
