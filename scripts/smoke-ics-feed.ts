/**
 * Structural checks on the ICS writer, including a round-trip through the repo's own
 * parser. Folding and escaping bugs are silent in most calendar clients, so they need
 * a test. Run: npx tsx scripts/smoke-ics-feed.ts
 */

import { buildIcsFeed } from "../src/lib/ics";
import { parseIcsEvents } from "../src/lib/calendar-import";
import { isDateOnly } from "../src/lib/calendar-feed";
import { atLocalNoon } from "../src/lib/interaction-date";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const allDay = new Date(Date.UTC(2026, 8, 2, 0, 0, 0));
const timed = new Date(Date.UTC(2026, 8, 3, 14, 0, 0));

const body = buildIcsFeed(
  [
    {
      uid: "orbit-reminder-a@orbit.app",
      summary: "Kickoff; with, Sarah \\ Chen",
      description: "line one\nline two",
      allDay: true,
      start: allDay,
      stamp: allDay,
      alarmTrigger: "PT9H",
    },
    {
      uid: "orbit-reminder-b@orbit.app",
      summary:
        "A very long title that should definitely exceed the seventy-five octet folding limit — em dash included 🎯",
      allDay: false,
      start: timed,
      stamp: timed,
      alarmTrigger: "-PT15M",
    },
  ],
  { calendarName: "Orbit Reminders", description: "Pending reminders from Orbit" }
);

check("uses CRLF line endings", body.includes("\r\n"));
check("no bare LF outside escapes", !/[^\r]\n/.test(body));

for (const line of body.split("\r\n")) {
  const bytes = Buffer.byteLength(line, "utf8");
  if (bytes > 75) {
    throw new Error(`line exceeds 75 octets (${bytes}): ${line}`);
  }
}
check("every line folds to <= 75 octets", true);

check(
  "all-day DTSTART is a floating DATE",
  body.includes("DTSTART;VALUE=DATE:20260902")
);
check(
  "all-day DTEND is the next day",
  body.includes("DTEND;VALUE=DATE:20260903")
);
check("timed DTSTART is UTC", body.includes("DTSTART:20260903T140000Z"));

// Escaping must be the exact inverse of unescapeIcs: backslash, then ; and ,
check(
  "TEXT escaping",
  body.includes("SUMMARY:Kickoff\\; with\\, Sarah \\\\ Chen"),
  body.split("\r\n").find((l) => l.startsWith("SUMMARY:Kickoff"))
);
check("newlines escaped in DESCRIPTION", body.includes("line one\\nline two"));

check("all-day alarm fires 9h after local midnight", body.includes("TRIGGER;RELATED=START:PT9H"));
check("timed alarm fires 15m before", body.includes("TRIGGER;RELATED=START:-PT15M"));
check("marked transparent", body.includes("TRANSP:TRANSPARENT"));
check("marked private", body.includes("CLASS:PRIVATE"));
check("no timezone asserted", !body.includes("X-WR-TIMEZONE"));

const parsed = parseIcsEvents(body);
check("round-trips through parseIcsEvents", parsed.length === 2, String(parsed.length));
check(
  "UID survives round-trip",
  parsed[0].uid === "orbit-reminder-a@orbit.app",
  parsed[0].uid
);
check(
  "all-day date survives round-trip",
  Boolean(parsed[0].start?.toISOString().startsWith("2026-09-02")),
  parsed[0].start?.toISOString()
);
check(
  "timed date survives round-trip",
  parsed[1].start?.toISOString() === "2026-09-03T14:00:00.000Z",
  parsed[1].start?.toISOString()
);

// Date-only detection. Both storage conventions in this codebase must be recognized,
// or a dated commitment degrades into a spurious half-hour meeting and loses its
// 9am-local alarm. This regressed once already: extracted dates are stored via
// atLocalNoon, which is never UTC midnight outside a UTC server.
check(
  "UTC midnight counts as date-only",
  isDateOnly(new Date(Date.UTC(2026, 9, 15, 0, 0, 0)))
);
check(
  "atLocalNoon counts as date-only (whatever the server timezone)",
  isDateOnly(atLocalNoon(new Date(2026, 9, 15))),
  atLocalNoon(new Date(2026, 9, 15)).toISOString()
);
check(
  "a real appointment time is not date-only",
  !isDateOnly(new Date(Date.UTC(2026, 9, 15, 14, 30, 0)))
);

console.log("\nAll ICS feed smoke checks passed.");
