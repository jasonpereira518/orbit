/**
 * Two real times the user is free, for a draft's meeting ask ("Would Tuesday afternoon or
 * Thursday morning work?"). The house format (`@/lib/message-format`) offers two windows;
 * this makes them true instead of plausible.
 *
 * Read from the `calendar_events` mirror (two weeks ahead, so business days 2 to 8 are always
 * inside it). Only when a calendar is actually connected: an empty week on a calendar Orbit
 * cannot see is not a free one, so no calendar means no windows, and the draft offers
 * windows in words without a date.
 */
import { listUpcomingEvents } from "@/lib/calendar-events";
import { listCalendarSources } from "@/lib/calendar-sources";
import { fromWallClockInput } from "@/lib/events/wall-clock";
import { ymdInZone } from "@/lib/reminder-due-bucket";
import { viewerTimeZone } from "@/lib/viewer-time-zone";

export type BusyEvent = { startAt: Date; endAt: Date | null; allDay: boolean; selfResponse?: string | null };
export type FreeWindow = { start: Date; label: string };

const PARTS = [
  { name: "morning", from: "10:00", to: "12:00" },
  { name: "afternoon", from: "13:00", to: "17:00" },
] as const;
/** A part of a day counts as free with a gap at least this long. */
const MIN_GAP_MS = 30 * 60_000;
/** Business days ahead: not tomorrow (too soon to ask a stranger), not past day 8 (too far). */
const FIRST_BUSINESS_DAY = 2;
const LAST_BUSINESS_DAY = 8;
const DAY_MS = 86_400_000;

function weekday(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(d);
}

/** Whether [from, to) holds a gap of at least MIN_GAP_MS between the timed events. */
function hasGap(busy: BusyEvent[], from: Date, to: Date): boolean {
  const spans = busy
    .filter((e) => !e.allDay)
    .map((e) => ({ s: e.startAt.getTime(), e: (e.endAt ?? new Date(e.startAt.getTime() + 30 * 60_000)).getTime() }))
    .filter((e) => e.s < to.getTime() && e.e > from.getTime())
    .sort((a, b) => a.s - b.s);
  let cursor = from.getTime();
  for (const span of spans) {
    if (span.s - cursor >= MIN_GAP_MS) return true;
    cursor = Math.max(cursor, span.e);
  }
  return to.getTime() - cursor >= MIN_GAP_MS;
}

/**
 * Up to `count` free windows, at most one per day, soonest first, alternating morning and
 * afternoon where it can so two offers are not the same slot on two days.
 * Pure: the events and the clock are passed in.
 */
export function pickFreeWindows(events: BusyEvent[], now: Date, tz: string, count = 2): FreeWindow[] {
  const busy = events.filter((e) => e.selfResponse !== "declined");
  const out: FreeWindow[] = [];
  let businessDay = 0;
  // Stepping from today's local NOON: a day-light-saving hour can never push it across midnight.
  const todayNoon = fromWallClockInput(`${ymdInZone(now, tz)}T12:00`, tz) ?? now;
  for (let d = 1; d <= 14 && out.length < count; d++) {
    const ymd = ymdInZone(new Date(todayNoon.getTime() + d * DAY_MS), tz);
    const noon = fromWallClockInput(`${ymd}T12:00`, tz);
    if (!noon) continue;
    const name = weekday(noon, tz);
    if (name === "Saturday" || name === "Sunday") continue;
    businessDay++;
    if (businessDay < FIRST_BUSINESS_DAY) continue;
    if (businessDay > LAST_BUSINESS_DAY) break;
    // An all-day event (out of office, a holiday, a conference) takes the day.
    if (busy.some((e) => e.allDay && ymdInZone(e.startAt, tz) === ymd)) continue;

    const lastWasMorning = out.length > 0 && out[out.length - 1].label.endsWith("morning");
    const parts = lastWasMorning ? [PARTS[1], PARTS[0]] : [PARTS[0], PARTS[1]];
    for (const part of parts) {
      const from = fromWallClockInput(`${ymd}T${part.from}`, tz);
      const to = fromWallClockInput(`${ymd}T${part.to}`, tz);
      if (!from || !to || !hasGap(busy, from, to)) continue;
      const date = new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "long", day: "numeric" }).format(from);
      out.push({ start: from, label: `${name} ${date}, in the ${part.name}` });
      break;
    }
  }
  return out;
}

/**
 * Two free windows from the user's own calendar, or null when no calendar is connected or it
 * has no two free slots. Best-effort: a failed read is null, never a failed draft.
 */
export async function freeWindows(userId: string, now: Date = new Date()): Promise<string[] | null> {
  try {
    const sources = await listCalendarSources(userId);
    if (!sources.some((s) => s.enabled)) return null;
    const [tz, events] = await Promise.all([
      viewerTimeZone(userId),
      listUpcomingEvents(userId, { from: now, to: new Date(now.getTime() + 14 * DAY_MS), limit: 500 }),
    ]);
    const picked = pickFreeWindows(events, now, tz);
    return picked.length === 2 ? picked.map((w) => w.label) : null;
  } catch {
    return null;
  }
}
