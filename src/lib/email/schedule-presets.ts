/**
 * Scheduled-send choices for the composer (direct-email P4). Pure, and in the browser's own
 * zone: every `Date` here is built with local-time setters, so "8:00 tomorrow" is 8:00 on the
 * person's wall clock, DST included. The server only ever sees the resulting instant.
 */

const MORNING_HOUR = 8;

export function schedulePresets(now: Date): { tomorrowMorning: Date; mondayMorning: Date } {
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();
  // Days until the coming Monday; on a Monday that is next week's, never today's.
  const toMonday = ((8 - now.getDay()) % 7) || 7;
  return {
    tomorrowMorning: new Date(y, m, d + 1, MORNING_HOUR, 0, 0, 0),
    mondayMorning: new Date(y, m, d + toMonday, MORNING_HOUR, 0, 0, 0),
  };
}

/** `"2026-11-01"` + `"09:30"` on the local wall clock → that instant. */
export function atLocal(ymd: string, hhmm: string): Date {
  const [y, mo, d] = ymd.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  return new Date(y!, (mo ?? 1) - 1, d ?? 1, h ?? 0, mi ?? 0, 0, 0);
}

/** `"06:00"` … `"22:30"`, every half hour. */
export function timeOptions(): string[] {
  const out: string[] = [];
  for (let h = 6; h <= 22; h++) {
    for (const mi of [0, 30]) out.push(`${String(h).padStart(2, "0")}:${mi ? "30" : "00"}`);
  }
  return out;
}

function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** "around 8:00 AM tomorrow" — around, because the drain runs every few minutes. */
export function formatScheduled(d: Date, now: Date): string {
  const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(d);
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const day = sameDay(d, now)
    ? "today"
    : sameDay(d, tomorrow)
      ? "tomorrow"
      : new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" }).format(d);
  return `around ${time} ${day}`;
}
