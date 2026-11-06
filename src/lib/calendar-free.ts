/**
 * When the user is free on one day: the gaps between their meetings inside working hours.
 * Pure — the stored calendar window in, gaps out — so chat, the `upcoming_meetings` tool and
 * MCP all answer "when am I free?" the same way.
 */
import { fromWallClockInput } from "@/lib/events/wall-clock";

type BusyEvent = { startAt: Date; endAt: Date | null; allDay: boolean; selfResponse: string | null };

export type FreeSlot = { start: Date; end: Date };

/**
 * Gaps of at least `minMinutes` between `from` and `to` on `day` (YYYY-MM-DD, in `tz`).
 * Declined meetings don't count; all-day events don't either — they are holidays and
 * trips as often as they are busy blocks, and Orbit cannot tell which.
 * ponytail: fixed 9:00–18:00 working hours; a setting when someone's day differs.
 */
export function freeSlots(
  events: BusyEvent[],
  day: string,
  tz: string,
  opts: { from?: string; to?: string; minMinutes?: number } = {}
): FreeSlot[] {
  const dayStart = fromWallClockInput(`${day}T${opts.from ?? "09:00"}`, tz);
  const dayEnd = fromWallClockInput(`${day}T${opts.to ?? "18:00"}`, tz);
  if (!dayStart || !dayEnd || dayEnd <= dayStart) return [];
  const minMs = (opts.minMinutes ?? 30) * 60_000;
  const busy = events
    .filter((e) => !e.allDay && e.selfResponse !== "declined")
    .map((e) => [Math.max(e.startAt.getTime(), dayStart.getTime()), Math.min((e.endAt ?? e.startAt).getTime(), dayEnd.getTime())] as const)
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  const out: FreeSlot[] = [];
  let cursor = dayStart.getTime();
  for (const [s, e] of busy) {
    if (s - cursor >= minMs) out.push({ start: new Date(cursor), end: new Date(s) });
    cursor = Math.max(cursor, e);
  }
  if (dayEnd.getTime() - cursor >= minMs) out.push({ start: new Date(cursor), end: dayEnd });
  return out;
}
