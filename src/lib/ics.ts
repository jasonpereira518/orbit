/**
 * Minimal iCalendar writer — the exact inverse of the parser in `calendar-import.ts`
 * (`unfoldIcs`, `unescapeIcs`, `parseIcsDate`). Deliberately dependency-free: the repo
 * already hand-rolls ICS parsing, and a correct writer is small.
 */

/** RFC 5545 3.3.11. Backslash MUST be escaped first or later escapes get double-hit. */
export function escapeIcsText(value: string) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/**
 * Folds to 75 octets per RFC 5545, counting UTF-8 bytes rather than JS chars — titles
 * pulled out of notes carry em-dashes and emoji, which are multi-byte.
 */
export function foldLine(line: string) {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;

  const out: string[] = [];
  let current = "";
  let currentBytes = 0;
  // Continuation lines start with a space, which itself consumes one octet.
  let limit = 75;

  for (const char of line) {
    const size = encoder.encode(char).length;
    if (currentBytes + size > limit) {
      out.push(current);
      current = char;
      currentBytes = size;
      limit = 74;
    } else {
      current += char;
      currentBytes += size;
    }
  }
  if (current) out.push(current);

  return out.map((chunk, i) => (i === 0 ? chunk : ` ${chunk}`)).join("\r\n");
}

/** YYYYMMDDTHHMMSSZ */
export function formatIcsUtc(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

/** YYYYMMDD, from UTC parts so it round-trips through `parseIcsDate`. */
export function formatIcsDate(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

export type IcsFeedEvent = {
  uid: string;
  summary: string;
  description?: string | null;
  url?: string | null;
  categories?: string | null;
  /** When true, emitted as a floating all-day event. */
  allDay: boolean;
  start: Date;
  /** Only used for timed events; defaults to start + 30 minutes. */
  end?: Date;
  stamp: Date;
  /** Minutes/hours offset for the alarm, as an RFC 5545 duration. */
  alarmTrigger?: string;
};

function addDays(d: Date, days: number) {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

function buildEvent(event: IcsFeedEvent): string[] {
  const lines: string[] = ["BEGIN:VEVENT"];
  lines.push(`UID:${event.uid}`);
  lines.push(`DTSTAMP:${formatIcsUtc(event.stamp)}`);

  if (event.allDay) {
    // Floating date: renders on the intended calendar day in every timezone, which is
    // how this feed stays correct without knowing the user's timezone.
    lines.push(`DTSTART;VALUE=DATE:${formatIcsDate(event.start)}`);
    lines.push(`DTEND;VALUE=DATE:${formatIcsDate(addDays(event.start, 1))}`);
  } else {
    const end = event.end ?? new Date(event.start.getTime() + 30 * 60_000);
    lines.push(`DTSTART:${formatIcsUtc(event.start)}`);
    lines.push(`DTEND:${formatIcsUtc(end)}`);
  }

  lines.push(`SUMMARY:${escapeIcsText(event.summary)}`);
  if (event.description) {
    lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
  }
  if (event.url) lines.push(`URL:${event.url}`);
  if (event.categories) {
    lines.push(`CATEGORIES:${escapeIcsText(event.categories)}`);
  }
  lines.push("STATUS:CONFIRMED");
  // Transparent + private so a reminder feed can't corrupt free/busy or leak detail
  // to anyone the calendar is shared with.
  lines.push("TRANSP:TRANSPARENT");
  lines.push("CLASS:PRIVATE");

  if (event.alarmTrigger) {
    lines.push("BEGIN:VALARM");
    lines.push("ACTION:DISPLAY");
    lines.push(`TRIGGER;RELATED=START:${event.alarmTrigger}`);
    lines.push(`DESCRIPTION:${escapeIcsText(event.summary)}`);
    lines.push("END:VALARM");
  }

  lines.push("END:VEVENT");
  return lines;
}

export function buildIcsFeed(
  events: IcsFeedEvent[],
  options: { calendarName: string; description?: string }
) {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Orbit//Reminders Feed//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `NAME:${escapeIcsText(options.calendarName)}`,
    `X-WR-CALNAME:${escapeIcsText(options.calendarName)}`,
  ];
  if (options.description) {
    lines.push(`X-WR-CALDESC:${escapeIcsText(options.description)}`);
  }
  // Honored by Apple and Outlook as a poll hint. Google ignores it and refreshes on
  // its own schedule (roughly 8-24h). Deliberately no X-WR-TIMEZONE — we don't know it.
  lines.push("REFRESH-INTERVAL;VALUE=DURATION:PT1H");
  lines.push("X-PUBLISHED-TTL:PT1H");

  for (const event of events) lines.push(...buildEvent(event));
  lines.push("END:VCALENDAR");

  return lines.map(foldLine).join("\r\n") + "\r\n";
}
