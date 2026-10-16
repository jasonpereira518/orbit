/**
 * Which calendar events are offered as "the meeting you're about to record": timed, with
 * someone else on them, not declined — ordered in-progress, then soonest. Pure — no
 * database, no network.
 * Run: npx tsx scripts/smoke-meeting-calendar.ts
 */
import { meetingCandidatesFrom, meetingCandidatesFromRows } from "../src/lib/meeting-calendar";

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

// ── Webinars: a call link with no guest list, or a crowd ──────────────────────────────
{
  const [w] = meetingCandidatesFrom(
    [event("webinar", "Scaling Postgres live", 3, 63, {
      attendees: [me],
      description: "Join: https://us02web.zoom.us/j/123456789?pwd=x",
    })],
    NOW
  );
  check("a solo event with a Zoom link is offered as a webinar", w?.webinar === true && w.call === "zoom", JSON.stringify(w));

  const [m] = meetingCandidatesFrom([event("meet", "Pilot sync", 3, 33, { hangoutLink: "https://meet.google.com/abc", recurringEventId: "series9" })], NOW);
  check("a Meet call with guests is a meeting, not a webinar", m?.webinar === false && m.call === "meet" && m.seriesId === "series9", JSON.stringify(m));

  const [h] = meetingCandidatesFrom([event("hiddencall", "All hands", 3, 63, { guestsCanSeeOtherGuests: false, hangoutLink: "https://meet.google.com/xyz" })], NOW);
  check("a call whose guest list is hidden is a webinar", h?.webinar === true);

  const [plain] = meetingCandidatesFrom([event("plain", "Coffee", 3, 33)], NOW);
  check("no link: no call, not a webinar", plain?.call === null && plain.webinar === false && plain.seriesId === null);
}

// --- From mirrored rows (Outlook / iCloud, no live read) ---------------------------------------
{
  const row = (id: string, title: string, startMin: number, extra: Record<string, unknown> = {}) => ({
    providerEventId: id,
    icalUid: `${id}@ical`,
    seriesId: null,
    title,
    startAt: new Date(NOW.getTime() + startMin * 60_000),
    endAt: new Date(NOW.getTime() + (startMin + 30) * 60_000),
    allDay: false,
    conferenceKind: null as string | null,
    attendees: [{ name: "dana.whitfield", email: "dana.whitfield@corp.com", contactId: null }],
    attendeeCount: 1,
    guestsHidden: false,
    selfResponse: null as string | null,
    ...extra,
  });
  const out = meetingCandidatesFromRows(
    [
      row("later", "Later", 90),
      row("now", "Pilot sync", -10, { conferenceKind: "teams" }),
      row("declined", "Declined", 5, { selfResponse: "declined" }),
      row("solo", "Focus", 5, { attendees: [], attendeeCount: 0 }),
      row("webinar", "Launch webinar", 20, { conferenceKind: "zoom", attendees: [], attendeeCount: 0, guestsHidden: true }),
    ],
    NOW
  );
  check(
    "rows: in progress first, declined and solo blocks left out",
    out.map((c) => c.eventKey).join(",") === "now,webinar,later",
    out.map((c) => c.eventKey).join(",")
  );
  check("rows: the call and pretty names carry over", out[0]?.call === "teams" && out[0].attendees[0]?.name === "Dana Whitfield");
  check("rows: a call with a hidden guest list is a webinar", out[1]?.webinar === true && out[0]?.webinar === false);
}

console.log("\nsmoke-meeting-calendar: all checks passed");
