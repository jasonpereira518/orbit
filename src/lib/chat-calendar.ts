/**
 * The user's upcoming meetings as a block in the chat prompt — so "what's on tomorrow?" or
 * "when do I next see Priya?" is answered in one pass from the stored calendar window, with
 * no research round. Preparing for a meeting still goes to research (`meeting_context`).
 */
import { addDaysYmd, ymdInZone } from "@/lib/reminder-due-bucket";
import { fromWallClockInput } from "@/lib/events/wall-clock";
import { listUpcomingEvents, relinkEvents, type CalendarEventRow } from "@/lib/calendar-events";
import { hhmmInZone, userTimeZone } from "@/lib/meeting-context";
import { freeSlots } from "@/lib/calendar-free";
import type { ParsedQuery } from "@/lib/chat-retrieval";

/** The mirror holds two weeks; a question about further out gets what there is. */
const MAX_DAYS = 14;
const DEFAULT_DAYS = 7;
const MAX_EVENTS = 15;

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
  tzOverride?: string
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
  const rows = await listUpcomingEvents(userId, { from, to, limit: person ? 200 : 60 });
  const linked = await relinkEvents(
    userId,
    (person ? rows.filter((e) => e.attendees.some((a) => attendeeMatches(a.name, person))) : rows).filter(
      (e) => e.selfResponse !== "declined"
    )
  );
  const shown = linked.slice(0, MAX_EVENTS);

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
  for (const d of days) {
    const events = byDay.get(d) ?? [];
    const head = dayLabel.format(fromWallClockInput(`${d}T12:00`, tz) ?? now);
    lines.push(`${head}:${events.length ? "" : " no meetings"}`);
    for (const e of events) {
      const known = e.attendees.filter((a) => a.contactId).map((a) => a.name || "a contact");
      const others = e.attendeeCount - known.length;
      const who = [known.join(", "), others > 0 ? `+${others} other${others === 1 ? "" : "s"}` : ""].filter(Boolean).join(", ");
      const when = e.allDay ? "all day" : `${hhmmInZone(e.startAt, tz)}${e.endAt ? `–${hhmmInZone(e.endAt, tz)}` : ""}`;
      lines.push(
        `- ${when} ${(e.title || "Untitled").replace(/\s+/g, " ").slice(0, 120)}${e.conferenceKind ? ` (${e.conferenceKind} call)` : ""}${who ? ` — with ${who}` : ""}`
      );
    }
    if (availability) {
      const free = freeSlots(byDay.get(d) ?? [], d, tz).map((s) => `${hhmmInZone(s.start, tz)}–${hhmmInZone(s.end, tz)}`);
      lines.push(`  Free (9:00–18:00): ${free.length ? free.join(", ") : "none"}`);
    }
  }
  if (linked.length > shown.length) lines.push(`(${linked.length - shown.length} more not shown)`);

  const people = new Map<string, string>();
  for (const e of shown) for (const a of e.attendees) if (a.contactId) people.set(a.contactId, a.name || "a contact");
  const range = firstDay === endDay ? firstDay : `${firstDay} to ${endDay}`;
  const scope = person ? `meetings with "${person}"` : "meetings";
  return {
    tz,
    text: `Times are in ${tz}. The user's ${scope}, ${range}:\n${lines.length ? lines.join("\n") : "none"}`,
    people: [...people].map(([id, name]) => ({ id, name })),
    eventCount: shown.length,
  };
}
