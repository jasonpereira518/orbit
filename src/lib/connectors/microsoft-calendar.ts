/**
 * Microsoft Graph calendar, as a source of `NetworkEvent`s.
 *
 * Fetch and map only — mirrors `google-calendar.ts` exactly: no database statement of any
 * kind, so it can be tested against recorded fixtures with no database at all, and the
 * write path stays in exactly one place (`src/lib/ingest/events.ts`).
 *
 * It is a *scope extension*, not a new provider: the tokens come from the Outlook
 * connection Orbit already holds for Contacts, so there is no second OAuth flow, no second
 * table, and no second callback route. What there is, unavoidably, is a capability probe —
 * see `hasCalendarScope` in `outlook.ts`.
 *
 * ## The three ways an incremental calendar sync goes wrong (same three as Google's)
 *
 * 1. **Adopting a delta cursor from the wrong page.** Graph returns `@odata.deltaLink` only
 *    on the *final* page of a `delta` run (`@odata.nextLink` on every page before it).
 *    Persisting the delta link early means every event on pages not yet read is skipped
 *    forever, silently, because the next run starts from a link that claims it is current.
 * 2. **Combining a stored `deltaLink` with a fresh time window.** Graph's delta endpoint
 *    encodes its own window in the link itself; sending `startDateTime`/`endDateTime`
 *    alongside a re-fetch of that link is invalid. The window belongs only to the very
 *    first request of a fresh sync.
 * 3. **Treating an expired delta link as a failure.** Graph returns 410 Gone for one, the
 *    same signal Google gives for an expired `syncToken`. It means "start over", not "this
 *    connection is broken" — counting it as a failure would walk a healthy connection up
 *    the backoff ladder and eventually disarm it.
 */
import type { ParsedCalendarEvent } from "@/lib/calendar-import";
import {
  CalendarSyncTokenExpiredError,
  CALENDAR_WINDOW_FUTURE_MS,
  CALENDAR_WINDOW_PAST_MS,
  toNetworkEvents,
  type CalendarFetchResult,
} from "@/lib/connectors/google-calendar";
import type { CalendarSyncCursor } from "@/db/schema";

export { CalendarSyncTokenExpiredError, toNetworkEvents };

const CALENDAR_VIEW_DELTA_API =
  "https://graph.microsoft.com/v1.0/me/calendarView/delta";

type GraphAttendee = {
  emailAddress?: { name?: string; address?: string };
  type?: "required" | "optional" | "resource";
};

type GraphDateTimeTz = { dateTime?: string; timeZone?: string };

type GraphEvent = {
  id?: string;
  iCalUId?: string;
  subject?: string;
  bodyPreview?: string;
  location?: { displayName?: string };
  start?: GraphDateTimeTz;
  end?: GraphDateTimeTz;
  attendees?: GraphAttendee[];
  organizer?: { emailAddress?: { name?: string; address?: string } };
  "@removed"?: { reason?: string };
};

type GraphDeltaPage = {
  value?: GraphEvent[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
};

/**
 * Parse a Graph `dateTime`/`timeZone` pair into a `Date`.
 *
 * Requests are sent with `Prefer: outlook.timezone="UTC"` (see `fetchCalendarPage` below),
 * so Graph returns every `dateTime` already in UTC with `timeZone: "UTC"` — that sidesteps
 * needing a Windows-timezone-name conversion table entirely. When `timeZone` is `"UTC"` the
 * `dateTime` string carries no offset, so `+ "Z"` is appended before parsing.
 */
function parseWhen(when: GraphDateTimeTz | undefined): Date | null {
  const raw = when?.dateTime;
  if (!raw) return null;
  const iso = when?.timeZone === "UTC" && !/[zZ]|[+-]\d\d:\d\d$/.test(raw) ? `${raw}Z` : raw;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Map one Graph event onto the shared parsed shape, so `classifyCalendarEvent` and
 * `counterpartsOf` (via `toNetworkEvents`) can be reused verbatim rather than reimplemented
 * for a second provider.
 *
 * `iCalUId` — never `id` — is the identity, exactly like Google's `iCalUID`: it is what
 * lets a user with both an ICS subscription and this connector end up with one interaction
 * per meeting instead of two.
 */
export function toParsedEvent(raw: GraphEvent): ParsedCalendarEvent | null {
  const uid = raw.iCalUId || raw.id;
  if (!uid) return null;
  return {
    uid,
    summary: raw.subject || "",
    // Graph's plain-text preview — cheap, like Google's `description` field usage. The
    // full HTML `body.content` is deliberately never fetched or parsed here.
    description: raw.bodyPreview || "",
    location: raw.location?.displayName || "",
    start: parseWhen(raw.start),
    end: parseWhen(raw.end),
    attendees: (raw.attendees || [])
      // Graph's equivalent of Google's room/equipment exclusion.
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
  };
}

export type FetchPageOptions = {
  accessToken: string;
  cursor: CalendarSyncCursor | null;
  /**
   * Graph has no per-attendee "self" flag like Google's `attendee.self`, so the caller
   * supplies the connection's own address and it is returned directly as `selfEmails`.
   */
  ownerEmail: string;
  now?: Date;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
};

/**
 * Fetch one page of events.
 *
 * A fresh sync (no `syncToken`) windows the calendarView/delta call with
 * `startDateTime`/`endDateTime`. An incremental run (cursor has a `syncToken`, which here
 * holds a full `deltaLink` URL) refetches that URL directly — no date params, per failure
 * mode 2 above. Either way pagination follows `@odata.nextLink` (also a full URL), and the
 * final page's `@odata.deltaLink` becomes the next `syncToken`.
 */
export async function fetchCalendarPage(opts: FetchPageOptions): Promise<CalendarFetchResult> {
  const { accessToken, cursor, ownerEmail } = opts;
  const now = opts.now ?? new Date();
  const doFetch = opts.fetchImpl ?? fetch;

  let url: string;
  if (cursor?.pageToken) {
    // Mid-run: always a full `@odata.nextLink` URL, valid regardless of how the run started.
    url = cursor.pageToken;
  } else if (cursor?.syncToken) {
    // Incremental: the stored `@odata.deltaLink` URL, refetched as-is.
    url = cursor.syncToken;
  } else {
    const start = new Date(now.getTime() - CALENDAR_WINDOW_PAST_MS).toISOString();
    const end = new Date(now.getTime() + CALENDAR_WINDOW_FUTURE_MS).toISOString();
    const params = new URLSearchParams({
      startDateTime: start,
      endDateTime: end,
    });
    url = `${CALENDAR_VIEW_DELTA_API}?${params}`;
  }

  const res = await doFetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      // Every event comes back already normalized to UTC — see `parseWhen`'s comment.
      Prefer: 'outlook.timezone="UTC"',
    },
  });

  if (res.status === 410) throw new CalendarSyncTokenExpiredError();
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Microsoft Calendar ${res.status}: ${body.slice(0, 200)}`);
  }

  const page = (await res.json()) as GraphDeltaPage;
  const items = page.value || [];

  const events: ParsedCalendarEvent[] = [];
  let tombstones = 0;

  for (const raw of items) {
    if (raw["@removed"]) {
      // A deleted/removed event in a delta response is a tombstone — Graph's equivalent of
      // Google's `status === "cancelled"`. Counted, not acted on: `interactions` has no
      // soft delete, and a meeting that genuinely happened is still evidence.
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
    selfEmails: [ownerEmail.toLowerCase()],
  };
}

/**
 * Fold one page's outcome into the cursor to persist.
 *
 * Same logic as Google's `advanceCursor`, adapted to Graph's URL-vs-token distinction: the
 * `deltaLink`-derived `syncToken` is only ever adopted once `nextLink` is absent — the
 * mechanical expression of failure mode 1 above. While paging continues, the previous
 * `syncToken` (the last deltaLink) is retained so an interrupted run resumes rather than
 * restarting.
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
