/**
 * Outlook Calendar (Microsoft Graph), as a source of `NetworkEvent`s.
 *
 * Fetch and map only — mirrors `google-calendar.ts` exactly: no database statement here, the
 * write path stays in `src/lib/ingest/events.ts`, and the provider-agnostic shaping
 * (`toNetworkEvents`, `advanceCursor`) lives in `calendar-shared.ts` rather than being
 * reimplemented for a second source. Event-platform invites (Luma/Eventbrite/Partiful) are
 * handled the same way as Google's — `isEventPlatformInvite`/`calendarEventsToCandidates` in
 * `src/lib/events/discovery/from-calendar.ts` — by the caller in `sync-scheduler.ts`.
 *
 * It is a *scope extension*, not a new provider: the tokens come from the Outlook connection
 * Orbit already holds for Contacts (`outlook_connections`), so there is no second OAuth flow,
 * no second table, and no second callback route — just a wider scope, gated the same way
 * Google's calendar scope is (`hasOutlookCalendarScope`).
 *
 * ## Where this differs from Google Calendar
 *
 * 1. **No `self` flag on attendees.** Graph doesn't mark the calendar owner's own attendee
 *    entry, unlike Google. The owner's address is already known statically from
 *    `outlook_connections.email_address` (no OAuth profile round-trip needed), so it is passed
 *    in by the caller rather than discovered per-event.
 * 2. **`calendarView/delta` replaces `syncToken`.** Graph's delta query plays the same role:
 *    the FIRST request carries `startDateTime`/`endDateTime`; every later request is a GET of
 *    the exact `@odata.nextLink` (mid-page) or `@odata.deltaLink` (finished) URL Graph handed
 *    back, with no query params added — those links already encode everything, and Graph
 *    rejects being second-guessed the same way Google rejects `syncToken` beside a time window.
 * 3. **A 410 means the delta token expired.** Same lifecycle event as Google's syncToken
 *    expiry, same fix — drop the cursor and let the next run re-window from scratch. Not a
 *    failure; counting it as one would walk a healthy connection up the backoff ladder.
 * 4. **Times need a timezone made explicit.** Graph's `dateTime` strings carry no offset of
 *    their own; requesting `Prefer: outlook.timezone="UTC"` is what makes every timestamp in
 *    the response actually be UTC, so a bare `Z` can be appended before parsing.
 */
import type { ParsedCalendarEvent } from "@/lib/calendar-import";
import type { CalendarSyncCursor } from "@/db/schema";
import {
  CALENDAR_WINDOW_FUTURE_MS,
  CALENDAR_WINDOW_PAST_MS,
  CalendarSyncTokenExpiredError,
  type CalendarFetchResult,
} from "@/lib/connectors/calendar-shared";

export {
  CalendarSyncTokenExpiredError,
  advanceCursor,
  toNetworkEvents,
} from "@/lib/connectors/calendar-shared";
export type { CalendarFetchResult } from "@/lib/connectors/calendar-shared";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

/** One page is the API's practical maximum for a `calendarView`; a quiet calendar finishes in one request. */
const PAGE_SIZE = 250;

type GraphEmailAddress = { name?: string; address?: string };

type GraphAttendee = {
  emailAddress?: GraphEmailAddress;
  type?: "required" | "optional" | "resource";
};

type GraphDateTime = { dateTime?: string; timeZone?: string };

type GraphResponseStatus = {
  response?:
    | "none"
    | "organizer"
    | "tentativelyAccepted"
    | "accepted"
    | "declined"
    | "notResponded";
};

type GraphEvent = {
  id?: string;
  iCalUId?: string;
  isCancelled?: boolean;
  subject?: string;
  bodyPreview?: string;
  location?: { displayName?: string };
  start?: GraphDateTime;
  end?: GraphDateTime;
  attendees?: GraphAttendee[];
  organizer?: { emailAddress?: GraphEmailAddress };
  /** The signed-in user's OWN RSVP on this event — Graph reports it on the event itself,
   *  unlike Google, which reports it as a flag on the self attendee entry. */
  responseStatus?: GraphResponseStatus;
  /** Present only on a delta response's removed entries; the rest of the event body is absent. */
  "@removed"?: { reason?: string };
};

/**
 * Graph's own RSVP vocabulary, translated to the PARTSTAT-style vocabulary
 * `rsvpFromParticipation` (`src/lib/events/attendance.ts`) already understands from Google/ICS
 * — one vocabulary for "what did the user say" regardless of source.
 */
function selfResponseOf(status: GraphResponseStatus | undefined): string | null {
  switch (status?.response) {
    case "accepted":
    case "organizer":
      return "ACCEPTED";
    case "tentativelyAccepted":
      return "TENTATIVE";
    case "declined":
      return "DECLINED";
    case "notResponded":
      return "NEEDS-ACTION";
    default:
      return null;
  }
}

type GraphEventsPage = {
  value?: GraphEvent[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
};

/** Graph's `dateTime` has no offset of its own; UTC is only true because of the `Prefer` header. */
function parseWhen(when: GraphDateTime | undefined): Date | null {
  const raw = when?.dateTime;
  if (!raw) return null;
  const iso = raw.endsWith("Z") ? raw : `${raw}Z`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Map one Graph event onto the shape the shared calendar pipeline already understands, so
 * `classifyCalendarEvent`/`counterpartsOf`/`isEventPlatformInvite` are reused verbatim rather
 * than reimplemented for a second source.
 *
 * `iCalUId` — never `id` — is the identity, for the same cross-source reason Google's
 * connector keys on `iCalUID`: it is the value that would also appear in an .ics export of
 * this same calendar.
 */
export function toParsedEvent(raw: GraphEvent): ParsedCalendarEvent | null {
  const uid = raw.iCalUId || raw.id;
  if (!uid) return null;
  return {
    uid,
    summary: raw.subject || "",
    description: raw.bodyPreview || "",
    location: raw.location?.displayName || "",
    start: parseWhen(raw.start),
    end: parseWhen(raw.end),
    attendees: (raw.attendees || [])
      // Meeting rooms are attendees as far as the API is concerned, same as Google's `resource`.
      .filter((a) => a.type !== "resource")
      .map((a) => ({
        name: a.emailAddress?.name || "",
        email: a.emailAddress?.address || "",
      }))
      .filter((a) => a.name || a.email),
    organizer: raw.organizer?.emailAddress
      ? {
          name: raw.organizer.emailAddress.name || "",
          email: raw.organizer.emailAddress.address || "",
        }
      : null,
    status: raw.isCancelled ? "CANCELLED" : "CONFIRMED",
    selfResponse: selfResponseOf(raw.responseStatus),
    // Left unset, unlike Google's `source.url`: Graph has no equivalent field carrying a
    // platform's own event link. `isEventPlatformInvite`'s fallback — scanning the location,
    // subject and body for a Luma/Eventbrite/Partiful URL — still applies via those fields.
  };
}

export type FetchPageOptions = {
  accessToken: string;
  cursor: CalendarSyncCursor | null;
  /** The calendar owner's own address — known statically, never inferred from the response. */
  selfEmail: string;
  now?: Date;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
};

/**
 * Fetch one page of events.
 *
 * Incremental when the cursor carries a link (either `syncToken` holding a `deltaLink` or
 * `pageToken` holding a `nextLink`), windowed otherwise. The link, once present, is fetched
 * verbatim — see failure mode 2 in this file's header.
 */
export async function fetchOutlookCalendarPage(
  opts: FetchPageOptions
): Promise<CalendarFetchResult> {
  const { accessToken, cursor, selfEmail } = opts;
  const now = opts.now ?? new Date();
  const doFetch = opts.fetchImpl ?? fetch;

  let url: string;
  if (cursor?.pageToken) {
    url = cursor.pageToken;
  } else if (cursor?.syncToken) {
    url = cursor.syncToken;
  } else {
    const params = new URLSearchParams({
      startDateTime: new Date(now.getTime() - CALENDAR_WINDOW_PAST_MS).toISOString(),
      endDateTime: new Date(now.getTime() + CALENDAR_WINDOW_FUTURE_MS).toISOString(),
      $top: String(PAGE_SIZE),
      $select:
        "id,iCalUId,isCancelled,subject,bodyPreview,location,start,end,attendees,organizer,responseStatus",
    });
    url = `${GRAPH_BASE}/me/calendarView/delta?${params}`;
  }

  const res = await doFetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      // Makes every `dateTime` in the response actually be UTC, per this file's header.
      Prefer: 'outlook.timezone="UTC"',
    },
  });

  if (res.status === 410) throw new CalendarSyncTokenExpiredError("microsoft");
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Outlook Calendar ${res.status}: ${body.slice(0, 200)}`);
  }

  const page = (await res.json()) as GraphEventsPage;
  const items = page.value || [];

  const events: ParsedCalendarEvent[] = [];
  let tombstones = 0;

  for (const raw of items) {
    if (raw["@removed"] || raw.isCancelled) {
      // Counted, not acted on — same reasoning as Google's `status === "cancelled"`:
      // `interactions` has no soft delete, and a cancelled meeting that genuinely happened is
      // still evidence.
      tombstones++;
      continue;
    }
    const parsed = toParsedEvent(raw);
    if (parsed) events.push(parsed);
  }

  return {
    events,
    nextSyncToken: page["@odata.deltaLink"] ?? null,
    nextPageToken: page["@odata.nextLink"] ?? null,
    tombstones,
    selfEmails: [selfEmail],
  };
}
