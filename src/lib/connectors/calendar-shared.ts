/**
 * The provider-agnostic half of calendar sync: shaping already-fetched events for ingest, and
 * folding one page's outcome into a cursor. Neither function knows or cares whether the events
 * came from Google or Microsoft Graph — that split is what lets `google-calendar.ts` and
 * `outlook-calendar.ts` be "a fetcher and a mapper" each, sharing everything else.
 *
 * Extracted from `google-calendar.ts` when the Outlook connector was added, rather than having
 * `outlook-calendar.ts` import from a file named after its sibling provider.
 */
import type { ParsedCalendarEvent } from "@/lib/calendar-import";
import {
  classifyCalendarEvent,
  counterpartsOf,
  groupEventParticipants,
  type EventClassification,
} from "@/lib/calendar-classify";
import { calendarExternalIdBase } from "@/lib/ingest/external-id";
import type { NetworkEvent } from "@/lib/ingest/events";
import type { CalendarSyncCursor } from "@/db/schema";

/**
 * How far back the FIRST sync reaches, and how far forward.
 *
 * Deliberately the ongoing-sync window (90 days back), not `CALENDAR_BACKFILL_DAYS` (730).
 * `windowCalendarEvents`' own comment warns that a consumer which does not pass its own
 * lookback silently inherits the two-year one — which on a first sync of a busy calendar is
 * thousands of events fetched to discover a handful of new contacts.
 */
export const CALENDAR_WINDOW_PAST_MS = 90 * 86400000;
export const CALENDAR_WINDOW_FUTURE_MS = 60 * 86400000;

/** Raised for an expired sync cursor (Google's 410, Graph's expired deltaLink). Callers must
 *  reset the cursor and start over, NOT count it as a failure — see each connector's header. */
export class CalendarSyncTokenExpiredError extends Error {
  constructor(provider: "google" | "microsoft") {
    super(
      provider === "google"
        ? "Google Calendar syncToken expired (410) — full resync required"
        : "Outlook Calendar delta link expired (410) — full resync required"
    );
    this.name = "CalendarSyncTokenExpiredError";
  }
}

export type CalendarFetchResult = {
  events: ParsedCalendarEvent[];
  /** Present only on the last page of a run. */
  nextSyncToken: string | null;
  nextPageToken: string | null;
  /** Cancelled/removed events, counted and skipped. */
  tombstones: number;
  /** The calendar owner's own address(es), used to filter self out of the guest list. */
  selfEmails: string[];
};

/**
 * Keep the events that represent a real relationship touch, and shape them for ingest.
 *
 * The judgement of what counts is `classifyCalendarEvent`'s, unchanged — a standup, a
 * dentist appointment and a focus block are not networking, and that logic already exists and
 * is already tested. This function's only opinions are which identifier to key on and how to
 * phrase the note.
 */
export function toNetworkEvents(
  events: ParsedCalendarEvent[],
  selfEmails: string[]
): NetworkEvent[] {
  const out: NetworkEvent[] = [];
  for (const event of events) {
    if (!event.start) continue;
    const classification = classifyCalendarEvent(event, selfEmails);
    if (!classification.keep || classification.kind === "group_event") continue;

    const people = counterpartsOf(event, selfEmails);
    if (people.length === 0) continue;

    out.push({
      externalIdBase: calendarExternalIdBase(event.uid),
      type: "meeting",
      timestamp: event.start,
      participants: people.map((p) => ({
        name: p.name || null,
        email: p.email || null,
      })),
      summary: event.summary || null,
      notes: [
        event.summary ? `Meeting: ${event.summary}` : "Calendar meeting",
        event.location ? `Location: ${event.location}` : "",
        event.description ? event.description.slice(0, 500) : "",
      ]
        .filter(Boolean)
        .join("\n"),
    });
  }
  return out;
}

/** One panel/webinar/talk worth staging as a reviewable roster, not an auto-created contact. */
export type GroupEventCandidate = {
  event: ParsedCalendarEvent;
  classification: EventClassification;
  hostedBySelf: boolean;
  organizer: { name: string; email: string } | null;
  attendees: Array<{ name: string; email: string }>;
};

/**
 * Pick out `group_event`-classified events for the roster-review write path.
 *
 * Kept separate from `toNetworkEvents` because these never reach `ingestEvents` — per the
 * existing Events feature's policy, nobody becomes a contact from a panel/webinar roster
 * without a human clicking "connect" (`event_attendees.contact_id`).
 */
export function toGroupEventCandidates(
  events: ParsedCalendarEvent[],
  selfEmails: string[]
): GroupEventCandidate[] {
  const out: GroupEventCandidate[] = [];
  for (const event of events) {
    if (!event.start) continue;
    const classification = classifyCalendarEvent(event, selfEmails);
    if (classification.kind !== "group_event") continue;

    const { hostedBySelf, organizer, attendees } = groupEventParticipants(event, selfEmails);
    // Nothing to show a human either way — no organizer to attribute the event to and no
    // attendees to roster.
    if (!hostedBySelf && !organizer && attendees.length === 0) continue;

    out.push({ event, classification, hostedBySelf, organizer, attendees });
  }
  return out;
}

/**
 * Fold one page's outcome into the cursor to persist.
 *
 * The `nextSyncToken` is only ever adopted once `nextPageToken` is absent — that is the
 * mechanical expression of the "took the token from the wrong page" failure mode both
 * connectors' headers describe. While paging continues, the previous `syncToken` is retained
 * so an interrupted run resumes rather than restarting.
 */
export function advanceCursor(
  previous: CalendarSyncCursor | null,
  page: CalendarFetchResult
): CalendarSyncCursor {
  if (page.nextPageToken) {
    return { ...(previous ?? {}), pageToken: page.nextPageToken };
  }
  return {
    syncToken: page.nextSyncToken ?? previous?.syncToken ?? null,
    pageToken: null,
  };
}
