/**
 * Which calendar events to offer when the user is about to record a meeting.
 *
 * Pure — no database, no network — so `scripts/smoke-meeting-calendar.ts` can drive it with
 * recorded fixtures. The live read (token, request) is `getMeetingCandidates` in
 * `src/actions/meetings.ts`; the mapping Orbit already trusts for background calendar sync
 * (`toParsedEvent`, `counterpartsOf`) is reused here rather than reimplemented.
 *
 * Nothing in here is stored: a suggestion exists for as long as the setup card is on screen.
 */
import { counterpartsOf } from "@/lib/calendar-classify";
import { selfEmailsFrom, toParsedEvent } from "@/lib/connectors/google-calendar";

type RawGoogleEvent = Parameters<typeof toParsedEvent>[0];

export type MeetingCandidate = {
  id: string;
  title: string;
  startIso: string;
  endIso: string | null;
  /** Everyone but the calendar owner. Empty when the organiser hid the guest list. */
  attendees: { name: string; email: string }[];
};

/** The setup form takes at most this many names (`parseAttendees`). */
const MAX_ATTENDEES = 50;

/** "priya.raman" → "Priya Raman": counterpartsOf falls back to the email's local part. */
function prettyName(name: string, email: string): string {
  const clean = name.trim();
  if (clean && !(email && clean === email.split("@")[0])) return clean;
  return clean
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Timed, not-declined events with someone else on them, ordered by what is most likely the
 * meeting about to be recorded: one in progress, then the soonest upcoming, then the most
 * recently started.
 *
 * All-day events and solo blocks (focus time, reminders) are never meetings. An event whose
 * guest list is hidden still counts — there is someone else on it, we just must not read the
 * names — and is offered with a title and no attendees.
 */
export function meetingCandidatesFrom(items: RawGoogleEvent[], now: Date, max = 4): MeetingCandidate[] {
  const nowMs = now.getTime();
  const ranked: { c: MeetingCandidate; rank: number; distance: number }[] = [];

  for (const raw of items) {
    if (raw.status === "cancelled") continue;
    if (!raw.start?.dateTime) continue; // all-day
    if ((raw.attendees ?? []).filter((a) => !a.resource).length < 2) continue; // only the owner
    const parsed = toParsedEvent(raw);
    if (!parsed?.start || !parsed.summary.trim()) continue;
    if (parsed.selfResponse === "declined") continue;

    const people =
      parsed.guestsVisible === false ? [] : counterpartsOf(parsed, selfEmailsFrom(raw)).slice(0, MAX_ATTENDEES);
    const start = parsed.start.getTime();
    const end = parsed.end?.getTime() ?? start;
    ranked.push({
      c: {
        id: parsed.uid,
        title: parsed.summary.trim().slice(0, 200),
        startIso: parsed.start.toISOString(),
        endIso: parsed.end?.toISOString() ?? null,
        attendees: people.map((p) => ({ name: prettyName(p.name, p.email), email: p.email })),
      },
      rank: start <= nowMs && nowMs <= end ? 0 : start > nowMs ? 1 : 2,
      distance: Math.abs(start - nowMs),
    });
  }

  return ranked
    .sort((a, b) => a.rank - b.rank || a.distance - b.distance)
    .slice(0, max)
    .map((r) => r.c);
}
