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
 * 2. **Confusing a permanent rejection with a stale cursor.** `fetchChanges`'s FALLBACK path
 *    (the ctag probe, the time-range query) is not wrapped in the client's own sync-collection
 *    resync handling, and either of its two bare requests can still raise
 *    `CalDavStaleSyncTokenError` OR `CalDavRejectedError` directly (`client.ts`'s own doc
 *    comment: "a 4xx can surface as either one"). Only the former is RFC 6578's actual resync
 *    precondition — the CalDAV equivalent of Google's 410 / Graph's 410, "start over," which
 *    is why it alone is folded into the shared `CalendarSyncTokenExpiredError`. A bare
 *    `CalDavRejectedError` reaching this point means the server looked at this exact request to
 *    this exact calendar and refused it — a deleted calendar, a revoked share — which is not a
 *    cursor problem and must propagate as a real, counted failure, exactly like Microsoft's
 *    connector lets every non-410 4xx through as a plain `Error`. Folding both into "reset the
 *    cursor, no failure counted" would have the scheduler quietly resync forever against a
 *    calendar it can never actually read.
 * 3. **Losing a revoked app-specific password in the retry ladder.** `CalDavAuthError` (401) is
 *    translated to `ReauthRequiredError` here, which the scheduler treats as non-retryable — so
 *    a revoked password disarms sync immediately instead of burning six retries against a
 *    connection that can never succeed again.
 */
import { parseIcsEvents, type ParsedCalendarEvent } from "@/lib/calendar-import";
import { expandEvent, parseRRule } from "@/lib/recurrence";
import {
  CalDavAuthError,
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
    if (err instanceof CalDavStaleSyncTokenError) {
      // RFC 6578's own resync precondition, escaping from the fallback path's ctag PROPFIND or
      // time-range REPORT rather than the sync-collection probe (which already retries this
      // itself) — see failure mode 2 above. Means "start over," not a failure.
      throw new CalendarSyncTokenExpiredError();
    }
    // A `CalDavRejectedError` here (and everything else — network faults, an oversized body)
    // is a real fault, not a cursor problem, and propagates as-is so the scheduler counts it
    // toward its own retry and backoff ladder — see failure mode 2 above.
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
