export type ParsedCalendarEvent = {
  uid: string;
  summary: string;
  description: string;
  location: string;
  start: Date | null;
  end: Date | null;
  attendees: Array<{ name: string; email: string }>;
  organizer: { name: string; email: string } | null;
};

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

function parseIcsDate(raw: string): Date | null {
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
    const start = parseIcsDate(getProp(block, "DTSTART"));
    const end = parseIcsDate(getProp(block, "DTEND"));

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
