/**
 * Which calendar events are offered as "the meeting you're about to record": timed, with
 * someone else on them, not declined — ordered in-progress, then soonest. Pure — no
 * database, no network.
 * Run: npx tsx scripts/smoke-meeting-calendar.ts
 */
import { meetingCandidatesFrom } from "../src/lib/meeting-calendar";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const NOW = new Date("2026-10-08T18:00:00.000Z"); // 2:00 PM New York
const at = (minutesFromNow: number) => new Date(NOW.getTime() + minutesFromNow * 60_000).toISOString();

const me = { email: "jordan@example.com", self: true, responseStatus: "accepted" };
const priya = { email: "priya.raman@acme.io", displayName: "Priya Raman", responseStatus: "accepted" };
const marcus = { email: "marcus@acme.io", displayName: "Marcus Lee", responseStatus: "needsAction" };

function event(id: string, title: string, startMin: number, endMin: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    iCalUID: `${id}@google.com`,
    summary: title,
    start: { dateTime: at(startMin) },
    end: { dateTime: at(endMin) },
    attendees: [me, priya, marcus],
    organizer: { email: "priya.raman@acme.io", displayName: "Priya Raman" },
    ...extra,
  };
}

// ── A normal meeting: title, and everyone but me ──────────────────────────────────────
{
  const [c] = meetingCandidatesFrom([event("a", "Pilot sync", 0, 30)], NOW);
  check("title carried over", c.title === "Pilot sync");
  check("owner is left out, guests kept with names and emails",
    c.attendees.length === 2 &&
      c.attendees[0].name === "Priya Raman" && c.attendees[0].email === "priya.raman@acme.io" &&
      c.attendees[1].name === "Marcus Lee",
    JSON.stringify(c.attendees));
  check("times are ISO strings", c.startIso === at(0) && c.endIso === at(30));
}

// ── What is never offered ─────────────────────────────────────────────────────────────
{
  const none = meetingCandidatesFrom(
    [
      event("allday", "Offsite", 0, 30, { start: { date: "2026-10-08" }, end: { date: "2026-10-09" } }),
      event("solo", "Focus time", 0, 60, { attendees: [me] }),
      event("noattendees", "Dentist", 0, 60, { attendees: undefined }),
      event("cancelled", "Cancelled sync", 0, 30, { status: "cancelled" }),
      event("declined", "Declined sync", 0, 30, { attendees: [{ ...me, responseStatus: "declined" }, priya] }),
      event("untitled", "   ", 0, 30),
      event("room", "Room only", 0, 30, { attendees: [me, { email: "room@res.calendar.google.com", resource: true }] }),
    ],
    NOW
  );
  check("all-day, solo, cancelled, declined, untitled and room-only events are dropped", none.length === 0, JSON.stringify(none.map((c) => c.title)));
}

// ── Ordering: now, then soonest, then most recent ─────────────────────────────────────
{
  const out = meetingCandidatesFrom(
    [
      event("past", "Earlier", -90, -60),
      event("later", "Later", 120, 150),
      event("soon", "Soon", 20, 50),
      event("now", "Now", -10, 20),
    ],
    NOW
  );
  check("in progress first, then the soonest upcoming, then the past", out.map((c) => c.title).join(",") === "Now,Soon,Later,Earlier", out.map((c) => c.title).join(","));
  check("capped", meetingCandidatesFrom(Array.from({ length: 9 }, (_, i) => event(`e${i}`, `M${i}`, i * 10, i * 10 + 5)), NOW, 3).length === 3);
}

// ── Guest list hidden by the organiser ────────────────────────────────────────────────
{
  const [c] = meetingCandidatesFrom([event("hidden", "Board prep", 5, 35, { guestsCanSeeOtherGuests: false })], NOW);
  check("a hidden guest list is not read, but the meeting is still offered", c.title === "Board prep" && c.attendees.length === 0);
}

// ── Email-only guests get a readable name ─────────────────────────────────────────────
{
  const [c] = meetingCandidatesFrom([event("emailonly", "Intro", 0, 30, { attendees: [me, { email: "dana.whitfield@corp.com" }] })], NOW);
  check("a guest with no display name is named from their email", c.attendees[0].name === "Dana Whitfield", JSON.stringify(c.attendees));
}

console.log("\nsmoke-meeting-calendar: all checks passed");
