/**
 * "Now" on the USER's clock, for prompts and for day math that runs on the server.
 *
 * The server runs in UTC, so `new Date()` plus `getDay()` / `isoDay()` there names the UTC
 * day: a US user writing notes at 9pm is already "tomorrow". Two ways out, both here:
 *
 * - `promptNow` — the one line every model is told, so "next Friday" and "this morning"
 *   resolve against the user's day and clock.
 * - `userDayAnchor` — the user's calendar day as local noon in THIS runtime's zone. Hand it to
 *   the existing server-local helpers (`resolveRelativeDate`, `isoDay`, `getDay`) and they
 *   answer in the user's day without being rewritten, whatever zone the server runs in.
 *
 * Pure: imported by client and server alike.
 */
import { isoDayToLocalNoon } from "@/lib/dates";
import { fromWallClockInput } from "@/lib/events/wall-clock";
import { ymdInZone } from "@/lib/reminder-due-bucket";

function partsInZone(now: Date, tz: string) {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      weekday: "long",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(now)
      .map((x) => [x.type, x.value])
  ) as Record<string, string>;
}

/** "Wednesday 2026-10-28 14:05" on the user's wall clock. */
export function nowInZone(now: Date, tz: string): string {
  const p = partsInZone(now, tz);
  return `${p.weekday} ${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** The user's weekday name ("Sunday") in `tz`. */
export function weekdayInZone(now: Date, tz: string): string {
  return partsInZone(now, tz).weekday ?? "";
}

/**
 * The line a prompt carries so the model knows when "now" is for this user:
 * `Today is Sunday, November 8, 2026 (2026-11-08). Local time 10:57 PM, America/New_York.`
 * `time: false` drops the clock — for prompts whose output is cached (a clock in the prompt
 * changes the cache key every minute) or that only need the day.
 */
export function promptNow(tz: string, now: Date = new Date(), opts: { time?: boolean } = {}): string {
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(now);
  const line = `Today is ${day} (${ymdInZone(now, tz)}).`;
  if (opts.time === false) return line;
  const clock = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(now);
  return `${line} Local time ${clock}, ${tz}.`;
}

/** The user's calendar day as local noon in this runtime — see the header. */
export function userDayAnchor(tz: string, now: Date = new Date()): Date {
  return isoDayToLocalNoon(ymdInZone(now, tz));
}

/** The instant the user's current day began (their local midnight). */
export function startOfUserDay(tz: string, now: Date = new Date()): Date {
  return fromWallClockInput(`${ymdInZone(now, tz)}T00:00`, tz) ?? now;
}

/** What a draft may do with `promptNow`'s clock: fit the greeting, never quote it. */
export const LOCAL_TIME_RULE =
  "Use the local day and time only to fit the greeting and sign-off (no \"good morning\" at night, \"have a good weekend\" on a Friday); never state the date or time itself.";

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** Days since the epoch for a "YYYY-MM-DD" — calendar arithmetic with no zone in it. */
const dayNumber = (ymd: string) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
};

/**
 * A date or time as a person says it, on the user's clock: "today at 3 PM", "tomorrow",
 * "Friday", "next Monday at 10:30 AM", "yesterday", "last Thursday", "on December 4"
 * (with the year when it isn't this one). Weeks run Monday to Sunday: a day later this week is
 * just its name, a day in the following week is "next …". Null for anything not an ISO date.
 * Voice reads these instead of raw timestamps (Cosmo).
 */
export function spokenWhen(value: string, tz: string, now: Date = new Date()): string | null {
  const dayOnly = ISO_DAY.test(value);
  if (!dayOnly && !ISO_TIME.test(value)) return null;
  const at = dayOnly ? null : new Date(value);
  if (at && Number.isNaN(at.getTime())) return null;
  const ymd = dayOnly ? value : ymdInZone(at!, tz);
  const today = ymdInZone(now, tz);
  const diff = dayNumber(ymd) - dayNumber(today);
  const weekday = WEEKDAYS[(((dayNumber(ymd) + 4) % 7) + 7) % 7]; // 1970-01-01 was a Thursday
  // Monday-start weeks: the Monday of today's week, as a day number.
  const todayDow = (((dayNumber(today) + 4) % 7) + 7) % 7;
  const weekStart = dayNumber(today) - ((todayDow + 6) % 7);
  const target = dayNumber(ymd);
  const [y, m, d] = ymd.split("-").map(Number);
  let day: string;
  if (diff === 0) day = "today";
  else if (diff === 1) day = "tomorrow";
  else if (diff === -1) day = "yesterday";
  else if (diff > 1 && target < weekStart + 7) day = weekday;
  else if (diff > 1 && target < weekStart + 14) day = `next ${weekday}`;
  else if (diff < -1 && target >= weekStart) day = `on ${weekday}`;
  else if (diff < -1 && target >= weekStart - 7) day = `last ${weekday}`;
  else day = `on ${MONTHS[m - 1]} ${d}${String(y) === today.slice(0, 4) ? "" : `, ${y}`}`;
  if (!at) return day;
  const clock = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" })
    .format(at)
    .replace(":00", "");
  return `${day} at ${clock}`;
}

/**
 * A tool result with a spoken twin beside every ISO date in it (`startIso` gains
 * `startIso_spoken: "next Monday at 10 AM"`), so a voice model never reads out a timestamp.
 * Bounded: objects six deep; arrays and plain values pass through otherwise unchanged.
 */
export function withSpokenDates(value: unknown, tz: string, now: Date = new Date(), depth = 0): unknown {
  if (depth > 6 || !value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => withSpokenDates(v, tz, now, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = withSpokenDates(v, tz, now, depth + 1);
    if (typeof v === "string") {
      const spoken = spokenWhen(v, tz, now);
      if (spoken) out[`${k}_spoken`] = spoken;
    }
  }
  return out;
}
