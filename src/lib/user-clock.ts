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
