import { fromWallClockInput } from "@/lib/events/wall-clock";

export type ParsedCalendarEvent = {
  uid: string;
  summary: string;
  description: string;
  location: string;
  start: Date | null;
  end: Date | null;
  attendees: Array<{ name: string; email: string }>;
  organizer: { name: string; email: string } | null;
  /**
   * The event's own link, from the ICS `URL` property or Google's `source.url`.
   *
   * Optional because the CSV path has no such column. It matters to event discovery: a Luma
   * or Partiful feed puts the event page here, which is a far better answer than fishing a
   * link out of the description.
   */
  url?: string | null;
  /** `CONFIRMED` / `TENTATIVE` / `CANCELLED`, where the source said. */
  status?: string | null;
  /**
   * The IANA zone from a `TZID` parameter.
   *
   * Kept because a floating local time is otherwise read in the SERVER's zone — the same
   * class of bug `src/lib/events/wall-clock.ts` exists to prevent, and the reason a 7pm
   * event could display as 2am.
   */
  timezone?: string | null;
  /**
   * False when the source said the guest list is hidden from guests.
   *
   * Undefined means "not stated", which is treated as visible — an ICS feed does not carry
   * the flag, and its ATTENDEE lines are there in plain sight either way.
   */
  guestsVisible?: boolean;
};

/**
 * First connect: reach much further back. A new user's orbit is cold precisely
 * because Orbit has no history, and two years of past meetings is the
 * cheapest real evidence available.
 */
export const CALENDAR_BACKFILL_DAYS = 730;

/**
 * Windows calendar events to a lookback of `CALENDAR_BACKFILL_DAYS` through
 * the next 14 days, for the one-time calendar upload
 * (`previewCalendarImport` / `confirmCalendarImport`).
 *
 * This window is specific to that one-time backfill. If an ongoing-sync
 * consumer is ever added, it must pass its own (shorter) lookback explicitly
 * rather than reusing this function unchanged — otherwise it silently
 * inherits a two-year window instead of a recent one.
 *
 * Lives outside `src/actions/imports.ts` (a `"use server"` file) because a
 * `"use server"` module may only export async functions — plain constant
 * exports there throw at build time.
 */
export function windowCalendarEvents(
  events: ParsedCalendarEvent[]
): ParsedCalendarEvent[] {
  const now = Date.now();
  return events.filter((e) => {
    if (!e.start) return true;
    const t = e.start.getTime();
    return (
      t >= now - CALENDAR_BACKFILL_DAYS * 86400000 && t <= now + 14 * 86400000
    );
  });
}

function unfoldIcs(text: string) {
  return text.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "");
}

function unescapeIcs(value: string) {
  return value
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

/** The `TZID=` parameter off a property line, e.g. `DTSTART;TZID=America/New_York:2026…`. */
function tzidOf(block: string, name: string): string | null {
  const line = block
    .split(/\r?\n/)
    .find((candidate) => new RegExp(`^${name}[;:]`, "i").test(candidate));
  if (!line) return null;
  const hit = /;TZID=([^:;]+)/i.exec(line.slice(0, line.indexOf(":") + 1));
  return hit ? hit[1]!.trim() : null;
}

function parseIcsDate(raw: string, timezone?: string | null): Date | null {
  const value = raw.trim();
  if (!value) return null;

  // DATE only: YYYYMMDD
  if (/^\d{8}$/.test(value)) {
    const y = Number(value.slice(0, 4));
    const m = Number(value.slice(4, 6)) - 1;
    const d = Number(value.slice(6, 8));
    return new Date(Date.UTC(y, m, d));
  }

  // UTC: YYYYMMDDTHHMMSSZ
  const utc = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (utc) {
    return new Date(
      Date.UTC(
        Number(utc[1]),
        Number(utc[2]) - 1,
        Number(utc[3]),
        Number(utc[4]),
        Number(utc[5]),
        Number(utc[6])
      )
    );
  }

  // Local floating: YYYYMMDDTHHMMSS
  const local = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/);
  if (local) {
    // With a TZID this is a wall clock in a NAMED zone, and reading it in the server's zone
    // instead — which is what this did, and still does when no TZID was given — moves the
    // event by however far Vercel happens to be from the venue.
    if (timezone) {
      const wall = `${local[1]}-${local[2]}-${local[3]}T${local[4]}:${local[5]}`;
      const instant = fromWallClockInput(wall, timezone);
      if (instant) return instant;
    }
    return new Date(
      Number(local[1]),
      Number(local[2]) - 1,
      Number(local[3]),
      Number(local[4]),
      Number(local[5]),
      Number(local[6])
    );
  }

  const fallback = new Date(value);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

function parsePerson(raw: string): { name: string; email: string } {
  const emailMatch =
    raw.match(/mailto:([^;>\s]+)/i) || raw.match(/([\w.+-]+@[\w.-]+)/);
  const email = (emailMatch?.[1] || "").trim().toLowerCase();
  const cnMatch = raw.match(/CN=([^:;]+)/i);
  let name = unescapeIcs((cnMatch?.[1] || "").trim());
  if (name.startsWith('"') && name.endsWith('"')) {
    name = name.slice(1, -1);
  }
  return { name, email };
}

function getProp(block: string, name: string): string {
  const lines = block.split(/\r?\n/);
  for (const line of lines) {
    if (new RegExp(`^${name}[;:]`, "i").test(line)) {
      const colon = line.indexOf(":");
      if (colon < 0) return "";
      return unescapeIcs(line.slice(colon + 1).trim());
    }
  }
  return "";
}

function getAllPropLines(block: string, name: string): string[] {
  const lines = block.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    if (new RegExp(`^${name}[;:]`, "i").test(line)) {
      out.push(line);
    }
  }
  return out;
}

/**
 * Minimal VEVENT parser for calendar exports (.ics).
 * Supports SUMMARY, DESCRIPTION, LOCATION, DTSTART/DTEND, ATTENDEE, ORGANIZER, UID.
 */
export function parseIcsEvents(icsText: string): ParsedCalendarEvent[] {
  const unfolded = unfoldIcs(icsText);
  const blocks = unfolded.split(/BEGIN:VEVENT/i).slice(1);
  const events: ParsedCalendarEvent[] = [];

  for (const chunk of blocks) {
    const block = chunk.split(/END:VEVENT/i)[0] || "";
    const summary = getProp(block, "SUMMARY");
    const description = getProp(block, "DESCRIPTION");
    const location = getProp(block, "LOCATION");
    const uid = getProp(block, "UID") || `${summary}-${getProp(block, "DTSTART")}`;
    const timezone = tzidOf(block, "DTSTART");
    const start = parseIcsDate(getProp(block, "DTSTART"), timezone);
    const end = parseIcsDate(getProp(block, "DTEND"), tzidOf(block, "DTEND") ?? timezone);

    const attendees = getAllPropLines(block, "ATTENDEE")
      .map(parsePerson)
      .filter((p) => p.email || p.name);

    const organizerLine = block
      .split(/\r?\n/)
      .find((l) => /^ORGANIZER[;:]/i.test(l));
    const organizer = organizerLine ? parsePerson(organizerLine) : null;

    if (!summary && !attendees.length && !start) continue;

    events.push({
      uid,
      summary,
      description,
      location,
      start,
      end,
      attendees,
      organizer:
        organizer && (organizer.email || organizer.name) ? organizer : null,
      // The Luma and Partiful personal feeds put the event's own page here, which is a much
      // better link than anything that can be fished out of a description.
      url: getProp(block, "URL") || null,
      status: getProp(block, "STATUS") || null,
      timezone,
    });
  }

  return events;
}

export type CalendarCsvRow = {
  summary: string;
  start: Date | null;
  end: Date | null;
  description: string;
  location: string;
  attendees: string;
};

/** Best-effort Google Calendar / Outlook CSV mapping. */
export function mapCalendarCsvRow(row: Record<string, string>): CalendarCsvRow {
  const get = (...keys: string[]) => {
    for (const k of keys) {
      const found = Object.entries(row).find(
        ([key]) => key.trim().toLowerCase() === k.toLowerCase()
      );
      if (found?.[1]) return found[1].trim();
    }
    return "";
  };

  const startRaw =
    get("Start", "Start Date", "Starts", "DTSTART", "Date") +
    (get("Start Time") ? ` ${get("Start Time")}` : "");
  const endRaw =
    get("End", "End Date", "Ends", "DTEND") +
    (get("End Time") ? ` ${get("End Time")}` : "");

  const start = startRaw.trim() ? new Date(startRaw) : null;
  const end = endRaw.trim() ? new Date(endRaw) : null;

  return {
    summary: get("Subject", "Title", "Summary", "Event"),
    start: start && !Number.isNaN(start.getTime()) ? start : null,
    end: end && !Number.isNaN(end.getTime()) ? end : null,
    description: get("Description", "Notes"),
    location: get("Location"),
    attendees: get("Attendees", "Guests", "Participants"),
  };
}

/**
 * Resolved-identity key for deduping one event's people list: email if present (the
 * stronger, near-unique signal), else the normalized name. Two entries that resolve to the
 * same key are treated as the same attendee — most commonly the organizer also listed as an
 * ATTENDEE (routine in ICS exports), or the same person appearing twice with slightly
 * different casing.
 */
export function personIdentityKey(person: { name: string; email: string }): string {
  const email = person.email.trim().toLowerCase();
  if (email) return `email:${email}`;
  return `name:${person.name.trim().toLowerCase()}`;
}

/**
 * One event's people (attendees plus the organizer, if any), deduped by resolved identity.
 *
 * Without the dedupe, an event whose organizer is also listed as an ATTENDEE (routine in ICS
 * exports) would explode into two `import_job_rows` for the same person once
 * `confirmCalendarImport` (src/actions/imports.ts) turns each event into one row per
 * (event, attendee) pair — inflating `totalRows`/progress by that pair, and producing two
 * identical `calendar_event` rows whose `interactions()` output collapses safely (Postgres
 * dedupes same-key rows within one `ON CONFLICT ... DO UPDATE` insert) but whose
 * `reminders()` output does not, since the engine only dedupes reminder candidates against
 * what already exists in the table, never against each other within the same insert — see
 * `ImportAdapter.reminders`'s doc comment in `src/lib/import-engine.ts`.
 *
 * Lives here, not in `src/actions/imports.ts`, for the same reason `windowCalendarEvents`
 * does (see its own comment): it's a pure function with no DB/auth dependency, and a
 * `"use server"` module can only export async functions, which would make this untestable
 * outside a full server-action call. `scripts/smoke-parsers.ts` exercises it directly.
 */
export function peopleFromEvent(event: ParsedCalendarEvent) {
  const people: Array<{ name: string; email: string }> = [...event.attendees];
  if (event.organizer) people.push(event.organizer);
  const seen = new Set<string>();
  const deduped: Array<{ name: string; email: string }> = [];
  for (const person of people) {
    if (!person.email && !person.name) continue;
    const key = personIdentityKey(person);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(person);
  }
  return deduped;
}
