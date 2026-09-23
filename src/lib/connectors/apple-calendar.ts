/**
 * iCloud (CalDAV) calendar, as a source of `NetworkEvent`s.
 *
 * Fetch and map only — mirrors `google-calendar.ts` / `microsoft-calendar.ts` exactly: no
 * database statement of any kind, so it can be tested against stubbed CalDAV responses with no
 * database at all, and the write path stays in exactly one place (`src/lib/ingest/events.ts`).
 *
 * Unlike the other two connectors, this is a genuinely new provider — the app-specific password
 * (`CalDavCredentials`, Task 8's connect flow) is Apple's own, not a scope extension of an
 * existing OAuth connection. All the CalDAV transport, host pinning, and cursor grammar
 * (sync-token vs. ctag) live in `src/lib/caldav/client.ts` (Task 5); this module's whole job is
 * translating that client's shapes into what the scheduler already knows how to drive.
 *
 * ## Three ways this boundary goes wrong
 *
 * 1. **Never expanding a recurring master.** Google and Microsoft expand recurrences
 *    server-side; CalDAV sends the master VEVENT plus its RRULE and leaves expansion to the
 *    caller. Returning the master alone would record a weekly 1:1 once, at its first
 *    occurrence, and never again.
 * 2. **Confusing a client-side "give up" with a fault.** `fetchChanges` already resyncs once on
 *    its own for a stale sync-token, but the FALLBACK path's own two requests (the ctag probe,
 *    the time-range query) are not wrapped in that recovery and can still raise
 *    `CalDavRejectedError` or `CalDavStaleSyncTokenError` directly — the module doc comment on
 *    `client.ts` warns a 4xx can surface as either one, so both must be caught here. Read as an
 *    ordinary error, either would count as a failure and walk a healthy connection up the
 *    scheduler's backoff ladder; read correctly, they mean the same thing Google's 410 and
 *    Graph's 410 mean — start over — so both are folded into the shared
 *    `CalendarSyncTokenExpiredError`, which the scheduler already knows resets the cursor rather
 *    than counting a failure.
 * 3. **Losing a revoked app-specific password in the retry ladder.** `CalDavAuthError` (401) is
 *    translated to `ReauthRequiredError` here, which the scheduler treats as non-retryable — so
 *    a revoked password disarms sync immediately instead of burning six retries against a
 *    connection that can never succeed again.
 */
import { parseIcsEvents, type ParsedCalendarEvent } from "@/lib/calendar-import";
import { expandEvent, parseRRule } from "@/lib/recurrence";
import {
  CalDavAuthError,
  CalDavRejectedError,
  CalDavStaleSyncTokenError,
  fetchChanges,
  type CalDavCredentials,
} from "@/lib/caldav/client";
import {
  CalendarSyncTokenExpiredError,
  CALENDAR_WINDOW_FUTURE_MS,
  CALENDAR_WINDOW_PAST_MS,
  toNetworkEvents,
  type CalendarFetchResult,
} from "@/lib/connectors/google-calendar";
import { ReauthRequiredError } from "@/lib/errors";
import type { CalendarSyncCursor } from "@/db/schema";

export { CalendarSyncTokenExpiredError, toNetworkEvents };

export type FetchPageOptions = {
  creds: CalDavCredentials;
  calendarUrl: string;
  cursor: CalendarSyncCursor | null;
  /**
   * CalDAV has no per-attendee "self" flag, like Graph and unlike Google's `attendee.self`, so
   * the caller supplies the connection's own address and it is returned directly as
   * `selfEmails`.
   */
  ownerEmail: string;
  now?: Date;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
};

/**
 * Fetch one page of events.
 *
 * "One page" is generous: CalDAV has no pagination at the client layer (see `client.ts`) — a
 * `sync-collection` REPORT or a `calendar-query` REPORT returns its whole result set in a single
 * round trip, so `nextPageToken` is always null here. The recurrence window is the same rolling
 * 90-days-back/60-days-forward shape the other two connectors use, computed independently of
 * whatever window (if any) `fetchChanges` itself sent to Apple — an incremental
 * `sync-collection` run is unbounded by date, so a recurring master it returns still needs
 * expanding against SOME window, and this is the one every connector agrees on.
 */
export async function fetchCalendarPage(opts: FetchPageOptions): Promise<CalendarFetchResult> {
  const { creds, calendarUrl, cursor, ownerEmail } = opts;
  const now = opts.now ?? new Date();
  const fetchImpl = opts.fetchImpl ?? fetch;

  const window = {
    from: new Date(now.getTime() - CALENDAR_WINDOW_PAST_MS),
    to: new Date(now.getTime() + CALENDAR_WINDOW_FUTURE_MS),
  };

  let changes: { icsDocuments: string[]; nextSyncToken: string | null; tombstones: number };
  try {
    changes = await fetchChanges(creds, calendarUrl, cursor, window, { fetchImpl });
  } catch (err) {
    if (err instanceof CalDavAuthError) {
      // A revoked app-specific password — see failure mode 3 above.
      throw new ReauthRequiredError(err.message);
    }
    if (err instanceof CalDavRejectedError || err instanceof CalDavStaleSyncTokenError) {
      // The client's own one-shot resync already gave up (or never applies — a rejected ctag
      // probe or time-range query isn't covered by it at all) — see failure mode 2 above.
      throw new CalendarSyncTokenExpiredError();
    }
    throw err;
  }

  const events: ParsedCalendarEvent[] = [];
  for (const icsDocument of changes.icsDocuments) {
    for (const parsed of parseIcsEvents(icsDocument)) {
      const rule = parsed.rrule ? parseRRule(parsed.rrule) : null;
      // A null/unsupported rule, or a master with no start, comes back unchanged (see
      // `expandEvent`'s own doc comment) — so this is safe to call unconditionally.
      events.push(...expandEvent(parsed, rule, window, { exDates: parsed.exDates ?? undefined }));
    }
  }

  return {
    events,
    nextSyncToken: changes.nextSyncToken,
    nextPageToken: null,
    tombstones: changes.tombstones,
    selfEmails: [ownerEmail.toLowerCase()],
  };
}

/**
 * Fold one page's outcome into the cursor to persist.
 *
 * Structurally identical to Google's and Microsoft's `advanceCursor` — `nextPageToken` is
 * checked first even though this connector never produces one itself, so the shared contract
 * (never adopt a sync cursor while a page remains) holds regardless of which connector a caller
 * is looking at. `nextSyncToken` here is whatever `fetchChanges` returned: a real WebDAV-Sync
 * token, or a `ctag:<probedAt>:<value>` fallback cursor — `client.ts` decides which, and this
 * function round-trips it opaquely either way.
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
