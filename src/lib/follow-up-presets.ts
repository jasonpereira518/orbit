/**
 * The one set of quick follow-up choices: contact page, "Remind in" chips, Radar's schedule
 * menu and the bell's snooze. Resolved in the browser's time zone; the server only ever sees
 * the absolute instant, and checks it with `validateFollowUpDate`.
 *
 * Business days are Monday to Friday. Holidays are not skipped.
 * Pure and client-safe: no database, no Node APIs.
 */
import { format } from "date-fns";
import { addDaysYmd, weekdayOfYmd, ymdInZone } from "@/lib/reminder-due-bucket";

export type FollowUpPresetId = "1d" | "2d" | "next-business-day" | "next-business-week" | "2w";

export const FOLLOW_UP_PRESETS: readonly { id: FollowUpPresetId; label: string; short: string }[] = [
  { id: "1d", label: "1 day", short: "1d" },
  { id: "2d", label: "2 days", short: "2d" },
  { id: "next-business-day", label: "Next business day", short: "Next day" },
  { id: "next-business-week", label: "Next week", short: "Next wk" },
  { id: "2w", label: "2 weeks", short: "2w" },
];

const MAX_DAYS_AHEAD = 366;
const DAY_MS = 86_400_000;

const wallFormatters = new Map<string, Intl.DateTimeFormat>();
function wallParts(d: Date, tz: string) {
  let fmt = wallFormatters.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    });
    wallFormatters.set(tz, fmt);
  }
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
  return { h: Number(p.hour), m: Number(p.minute), s: Number(p.second) };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Milliseconds `tz` is ahead of UTC at instant `t`. */
function offsetAt(t: number, tz: string): number {
  const d = new Date(t);
  const ymd = ymdInZone(d, tz);
  const { h, m, s } = wallParts(d, tz);
  const asUtc = Date.parse(`${ymd}T${pad(h)}:${pad(m)}:${pad(s)}Z`);
  return asUtc - Math.floor(t / 1000) * 1000;
}

/** The instant that reads `ymd hh:mm:ss` on a wall clock in `tz`. */
function zonedInstant(ymd: string, h: number, m: number, s: number, tz: string): Date {
  const guess = Date.parse(`${ymd}T${pad(h)}:${pad(m)}:${pad(s)}Z`);
  let t = guess - offsetAt(guess, tz);
  // Second pass settles instants whose offset differs from the guess's (DST days).
  t = guess - offsetAt(t, tz);
  return new Date(t);
}

export function resolvePreset(id: FollowUpPresetId, now: Date, timeZone: string): Date {
  const today = ymdInZone(now, timeZone);
  if (id === "1d" || id === "2d" || id === "2w") {
    const days = id === "1d" ? 1 : id === "2d" ? 2 : 14;
    const { h, m, s } = wallParts(now, timeZone);
    return zonedInstant(addDaysYmd(today, days), h, m, s, timeZone);
  }
  const w = weekdayOfYmd(today);
  const ahead =
    id === "next-business-day"
      ? w === 5 ? 3 : w === 6 ? 2 : 1
      : (8 - w) % 7 || 7;
  return zonedInstant(addDaysYmd(today, ahead), 9, 0, 0, timeZone);
}

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Server side: the ISO instant a preset produced must be in the future and within a year. */
export function validateFollowUpDate(
  iso: unknown,
  now: Date
): { ok: true; date: Date } | { ok: false; message: string } {
  if (typeof iso !== "string" || iso.length > 40) return { ok: false, message: "Pick a time in the future" };
  const date = new Date(iso);
  if (Number.isNaN(date.getTime()) || date.getTime() <= now.getTime()) {
    return { ok: false, message: "Pick a time in the future" };
  }
  if (date.getTime() - now.getTime() > MAX_DAYS_AHEAD * DAY_MS) {
    return { ok: false, message: "Pick a time within the next year" };
  }
  return { ok: true, date };
}

/** Toast copy once a follow-up is booked, in the viewer's own clock. */
export function followUpSetMessage(due: Date): string {
  return `Follow-up set for ${format(due, "EEE MMM d, h:mm a")}`;
}
