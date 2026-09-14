/**
 * Google Calendar, as a source of `NetworkEvent`s.
 *
 * Fetch and map only — this module issues no database statement of any kind. That is what
 * lets it be tested against recorded fixtures with no database at all, and it keeps the
 * write path in exactly one place (`src/lib/ingest/events.ts`).
 *
 * It is a *scope extension*, not a new provider: the tokens come from the Google connection
 * Orbit already holds for Gmail and Contacts, so there is no second OAuth flow, no second
 * table, and no second callback route. What there is, unavoidably, is a capability probe —
 * see `hasCalendarScope`.
 *
 * ## The three ways an incremental calendar sync goes wrong
 *
 * 1. **Taking `nextSyncToken` from the wrong page.** Google returns it only on the *final*
 *    page of a run. Persisting it earlier means every event on the pages you had not read yet
 *    is skipped forever, silently, because the next run starts from a token that claims you
 *    are up to date.
 * 2. **Combining `syncToken` with a time window.** Google rejects `syncToken` sent alongside
 *    `timeMin`/`timeMax`/`q`/`orderBy` with a 400. The window belongs to the first full fetch
 *    and to nothing else.
 * 3. **Treating a 410 as a failure.** An expired `syncToken` is a normal, expected part of the
 *    lifecycle — Google expires them on its own schedule. It means "start over", not "this
 *    connection is broken", and counting it as a failure would walk a perfectly healthy
 *    connection up the backoff ladder and eventually disarm it.
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
  CALENDAR_WINDOW_FUTURE_MS,
  CALENDAR_WINDOW_PAST_MS,
  CalendarSyncTokenExpiredError,
  advanceCursor,
  toNetworkEvents,
} from "@/lib/connectors/calendar-shared";
export type { CalendarFetchResult } from "@/lib/connectors/calendar-shared";

const CALENDAR_API = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

/** One page is the API's maximum, so a quiet calendar finishes in a single request. */
const PAGE_SIZE = 250;

type GoogleAttendee = {
  email?: string;
  displayName?: string;
  self?: boolean;
  resource?: boolean;
  responseStatus?: string;
};

type GoogleEvent = {
  id?: string;
  iCalUID?: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: GoogleAttendee[];
  organizer?: { email?: string; displayName?: string; self?: boolean };
  /** Where the event came from, when another app created it — a Luma or Partiful page. */
  source?: { url?: string; title?: string };
  /**
   * Google's own privacy switch. False means the organiser chose to hide the guest list from
   * guests, and the API still returns it to the calendar owner — so honouring it is on us.
   */
  guestsCanSeeOtherGuests?: boolean;
  /** Set when Google truncated the guest list; what came back is not the whole room. */
  attendeesOmitted?: boolean;
};

type GoogleEventsPage = {
  items?: GoogleEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
};

function parseWhen(when: GoogleEvent["start"]): Date | null {
  const raw = when?.dateTime || when?.date;
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Map one Google event onto the shape the existing ICS pipeline already understands, so
 * `classifyCalendarEvent` and `counterpartsOf` can be reused verbatim rather than
 * reimplemented for a second source.
 *
 * `iCalUID` — never `id` — is the identity. It is the same string as the `UID` in an .ics
 * export of the same calendar, which is what lets a user who has both an ICS subscription and
 * this connector end up with one interaction per meeting instead of two.
 */
export function toParsedEvent(raw: GoogleEvent): ParsedCalendarEvent | null {
  const uid = raw.iCalUID || raw.id;
  if (!uid) return null;
  return {
    uid,
    summary: raw.summary || "",
    description: raw.description || "",
    location: raw.location || "",
    start: parseWhen(raw.start),
    end: parseWhen(raw.end),
    attendees: (raw.attendees || [])
      // Meeting rooms and equipment are attendees as far as the API is concerned.
      .filter((a) => !a.resource)
      .map((a) => ({ name: a.displayName || "", email: a.email || "" }))
      .filter((a) => a.name || a.email),
    organizer: raw.organizer
      ? { name: raw.organizer.displayName || "", email: raw.organizer.email || "" }
      : null,
    url: raw.source?.url || null,
    status: raw.status || null,
    // Two ways the guest list is not ours to keep: the organiser hid it, or Google itself
    // truncated it. Either way, storing what we happen to have been handed would be storing
    // other people's contact details they did not agree to share with this room.
    guestsVisible: raw.guestsCanSeeOtherGuests !== false && raw.attendeesOmitted !== true,
    selfResponse: (raw.attendees || []).find((a) => a.self)?.responseStatus ?? null,
  };
}

/**
 * Who Google says is the calendar owner.
 *
 * Strictly better than the ICS path's user-typed `selfEmail`: the API marks the owner with
 * `self: true` on their own attendee entry, so there is nothing for the user to get wrong and
 * no alias to miss.
 */
export function selfEmailsFrom(raw: GoogleEvent): string[] {
  const found: string[] = [];
  for (const attendee of raw.attendees || []) {
    if (attendee.self && attendee.email) found.push(attendee.email.toLowerCase());
  }
  if (raw.organizer?.self && raw.organizer.email) found.push(raw.organizer.email.toLowerCase());
  // The organizer is usually also listed as a self attendee, so the raw list repeats.
  return [...new Set(found)];
}

export type FetchPageOptions = {
  accessToken: string;
  cursor: CalendarSyncCursor | null;
  now?: Date;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
};

/**
 * Fetch one page of events.
 *
 * Incremental when the cursor carries a `syncToken`, windowed otherwise. Never both — see
 * failure mode 2 in this file's header.
 */
export async function fetchCalendarPage(opts: FetchPageOptions): Promise<CalendarFetchResult> {
  const { accessToken, cursor } = opts;
  const now = opts.now ?? new Date();
  const doFetch = opts.fetchImpl ?? fetch;

  const params = new URLSearchParams({
    singleEvents: "true",
    maxResults: String(PAGE_SIZE),
    // Without this an incremental run cannot learn that an event was deleted or declined.
    showDeleted: "true",
  });

  if (cursor?.syncToken) {
    params.set("syncToken", cursor.syncToken);
  } else {
    params.set("timeMin", new Date(now.getTime() - CALENDAR_WINDOW_PAST_MS).toISOString());
    params.set("timeMax", new Date(now.getTime() + CALENDAR_WINDOW_FUTURE_MS).toISOString());
  }
  // A page token is valid with either mode and must survive a time-budget stop, or a long
  // first sync restarts from the beginning every run and never reaches its last page.
  if (cursor?.pageToken) params.set("pageToken", cursor.pageToken);

  const res = await doFetch(`${CALENDAR_API}?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (res.status === 410) throw new CalendarSyncTokenExpiredError("google");
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Google Calendar ${res.status}: ${body.slice(0, 200)}`);
  }

  const page = (await res.json()) as GoogleEventsPage;
  const items = page.items || [];

  const events: ParsedCalendarEvent[] = [];
  const selfEmails = new Set<string>();
  let tombstones = 0;

  for (const raw of items) {
    for (const email of selfEmailsFrom(raw)) selfEmails.add(email);
    if (raw.status === "cancelled") {
      // Counted, not acted on. `interactions` has no soft delete, so removing rows on a
      // provider signal is a materially bigger decision than this connector should make on
      // its own — and a cancelled meeting that genuinely happened is still evidence.
      tombstones++;
      continue;
    }
    const parsed = toParsedEvent(raw);
    if (parsed) events.push(parsed);
  }

  return {
    events,
    nextSyncToken: page.nextSyncToken ?? null,
    nextPageToken: page.nextPageToken ?? null,
    tombstones,
    selfEmails: [...selfEmails],
  };
}
