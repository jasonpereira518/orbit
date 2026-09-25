/**
 * Drives continuous provider sync: claim what is due, pull what changed, hand it to ingest.
 *
 * All logic lives here rather than in the route so it can be exercised without HTTP and
 * without Next — no `next/server` import, for the reason `internal-auth.ts` and
 * `cron-runs.ts` both record: importing it retains the Node event loop and hangs `tsx`.
 *
 * ## Why the work is inline rather than in `after()`
 *
 * The obvious shape — respond 200 immediately, keep syncing in `after()` — does not work.
 * Next's own documentation is explicit that `after` runs within the route's configured
 * `maxDuration`; it defers work past the response, it does not buy more time. So the run has
 * to fit a wall-clock budget and hand off over HTTP when it runs out, exactly as
 * `runImportJob` does.
 *
 * ## What must never happen
 *
 * One user's broken connection must never stop everyone else's sync. Every per-connection
 * failure is caught, recorded on that connection, and counted — never rethrown. A swallowed
 * error that becomes a number in `cron_runs.stats` is visible; one that aborts the loop is a
 * silent outage for every user after it in the queue.
 */
import {
  CalendarSyncTokenExpiredError,
  advanceCursor as advanceGoogleCalendarCursor,
  fetchCalendarPage as fetchGoogleCalendarPage,
  toNetworkEventsDecided,
  type CalendarFetchResult,
} from "@/lib/connectors/google-calendar";
import {
  advanceCursor as advanceMicrosoftCalendarCursor,
  fetchCalendarPage as fetchMicrosoftCalendarPage,
} from "@/lib/connectors/microsoft-calendar";
import {
  advanceCursor as advanceAppleCalendarCursor,
  fetchCalendarPage as fetchAppleCalendarPage,
} from "@/lib/connectors/apple-calendar";
import { appleCredentials } from "@/lib/apple";
import {
  hasContactsScope as hasGoogleContactsScope,
  hasCalendarScope as hasGoogleCalendarScope,
  getValidAccessToken as getValidGoogleAccessToken,
} from "@/lib/gmail";
import {
  hasCalendarScope as hasMicrosoftCalendarScope,
  getValidAccessToken as getValidOutlookAccessToken,
} from "@/lib/outlook";
import {
  claimDueConnections,
  disarmSync,
  markSyncResult,
  oldestDueAgeMs,
  type ClaimedConnection,
} from "@/lib/provider-connections";
import {
  enabledSourcesFor,
  saveSourceCursor,
  seedCalendarSources,
} from "@/lib/calendar-sources";
import {
  claimDueConnectorConnections,
  disarmConnectorSync,
  markConnectorSyncResult,
  markConnectorSyncSucceeded,
} from "@/lib/connectors/connections";
import { connectorById } from "@/lib/connectors/registry";
import { finalizeIngest, ingestEvents, openIngestContext } from "@/lib/ingest/events";
import { ingestPeople } from "@/lib/ingest/people";
import {
  advanceContactsCursor,
  fetchContactsPage,
  PeopleSyncTokenExpiredError,
  type ContactsSyncCursor,
} from "@/lib/connectors/google-contacts";
import type { CalendarSyncCursor, ProviderSyncCursor } from "@/db/schema";
import {
  claimDueCalendarSubscriptions,
  syncCalendarSubscription,
} from "@/lib/calendar-sync";
import { ReauthRequiredError } from "@/lib/errors";
import { deadlineAfter, deadlineReached } from "@/lib/time-budget";
import { runEventSyncPass } from "@/lib/events/sync";
import { runEnrichmentPass } from "@/lib/events/enrich-queue";
import { backfillPersonKeys } from "@/lib/events/people-store";
import { calendarEventsToCandidates } from "@/lib/events/discovery/from-calendar";
import { recordDiscoveryCandidates } from "@/lib/events/discovery/record";
import { reportAndContinue, reportError } from "@/lib/report-error";

/** Matches the import engine's budget, and leaves headroom under the 300s function ceiling. */
export const SYNC_TIME_BUDGET_MS = 4.5 * 60 * 1000;

/**
 * Ceiling on any single connection.
 *
 * A count alone cannot bound unbounded per-item work — the lesson `process-stalled` already
 * learned when ten users each free to take a 4.5-minute internal budget overran a 300s route,
 * at which point the function is killed, the `finally` never runs, and the ledger row is stuck
 * `running` forever. One calendar with thousands of events is exactly that case.
 */
export const PER_CONNECTION_BUDGET_MS = 60 * 1000;

/** Claimed per run. Four run at once, each bounded by PER_CONNECTION_BUDGET_MS. */
export const CONNECTIONS_PER_RUN = 20;

/** Connections synced in parallel. Each is a different user's calendar and ingest context. */
export const SYNC_CONCURRENCY = 4;

/**
 * Runs `worker` over `items` with at most `limit` in flight, settling every item — the
 * Promise.allSettled guarantee without starting all twenty at once. Never rejects.
 */
export async function runSettledPool<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await worker(item).catch(() => undefined);
    }
  });
  await Promise.allSettled(lanes);
}

/** ICS feeds claimed per run. Cheaper than an API sync — one HTTP GET and a parse. */
export const ICS_SUBSCRIPTIONS_PER_RUN = 10;

/** Cadence for a healthy connection. A floor, never a promise — GitHub cron lags 5-30 minutes. */
export const SYNC_INTERVAL_MS = 30 * 60 * 1000;

/**
 * The two effects a sync run has on the outside world: minting a token and calling the
 * provider. Injectable so the scheduler's own behaviour — budgets, isolation between
 * connections, how each class of failure is recorded — can be tested without a network or a
 * real Google grant. Production passes nothing and gets the real implementations.
 */
export type SyncDeps = {
  getAccessToken: typeof getValidGoogleAccessToken;
  fetchPage: typeof fetchGoogleCalendarPage;
  /**
   * How a contacts page is read. Optional and defaulted for the same reason the Microsoft
   * pair is: a test that seeds only a calendar-scoped connection never reaches it.
   */
  fetchContactsPage?: typeof fetchContactsPage;
  /**
   * The Microsoft pair. Optional, defaulting to the real implementations, so a test that only
   * seeds Google connections (every one that predates Outlook calendar sync) need not stub a
   * provider it never claims. The Google pair keeps its original names for the same reason:
   * renaming them would mean editing every test that builds a `SyncDeps`.
   */
  getMicrosoftAccessToken?: typeof getValidOutlookAccessToken;
  fetchMicrosoftPage?: typeof fetchMicrosoftCalendarPage;
  /**
   * The Apple half. No token minter — a CalDAV app-specific password is decrypted straight
   * from `apple_connections`, not refreshed like an OAuth token — so only the fetch itself is
   * injectable.
   */
  fetchApplePage?: typeof fetchAppleCalendarPage;
  /**
   * Wall-clock source for the Apple per-connection budget, checked BETWEEN calendars in
   * `syncAppleCalendar`'s fan-out. Defaults to `Date.now`. Injectable so a smoke test can force
   * mid-run budget exhaustion deterministically — a real 60-second wait has no place in a smoke
   * suite, and racing real elapsed time against a tiny budget would be flaky by construction.
   */
  budgetClock?: () => number;
  /**
   * How the enrichment pass reads an event's public page.
   *
   * Injectable for the same reason the two above are, and with a sharper edge: without it a
   * smoke test that seeds an event with a URL makes a real outbound request to whatever host
   * the fixture named. A test suite that quietly fetches lu.ma is both slow and rude.
   */
  eventPageFetch?: typeof fetch;
  /**
   * How a claimed connection's `connector_id` becomes a manifest.
   *
   * Injectable because no manifest in the registry has a `sync` yet — P0 ships the dispatch
   * and none of the connectors it dispatches to — so without this seam the only branch of
   * this family reachable from a test is the "unregistered connector" one, and the whole
   * point of dispatching by manifest (a sync runs, a throwing sync costs one failure and
   * nothing more, a clean return is recorded) would ship unexercised. Production passes
   * nothing and gets the registry.
   */
  resolveConnector?: typeof connectorById;
};

const DEFAULT_DEPS: SyncDeps = {
  getAccessToken: getValidGoogleAccessToken,
  fetchPage: fetchGoogleCalendarPage,
  getMicrosoftAccessToken: getValidOutlookAccessToken,
  fetchMicrosoftPage: fetchMicrosoftCalendarPage,
  fetchApplePage: fetchAppleCalendarPage,
  resolveConnector: connectorById,
};

export type SyncRunStats = {
  claimed: number;
  icsClaimed: number;
  icsSynced: number;
  icsFailed: number;
  synced: number;
  failed: number;
  skippedNoScope: number;
  eventsIngested: number;
  /** Calendar events the decision model (Jev) skipped or kept against the rules' call. */
  calendarSkippedByDecision: number;
  calendarKeptByDecision: number;
  contactsCreated: number;
  interactionsLogged: number;
  /**
   * Google Contacts address-book sync. `contactsCreated` above counts the people this
   * creates too — it is the run's total across every source — so these are the address
   * book's own detail, not a second total.
   */
  addressBookSeen: number;
  addressBookMatched: number;
  addressBookBlockedByPlan: number;
  /** Deleted in Google, counted and skipped — Orbit does not delete on a provider signal. */
  addressBookTombstones: number;
  /** Entries with no usable name, counted and skipped. */
  addressBookNameless: number;
  /** Luma/Eventbrite. Named apart from the calendar counters so one pass reports both. */
  eventConnectionsClaimed: number;
  eventConnectionsSynced: number;
  eventConnectionsFailed: number;
  eventRostersFetched: number;
  /** Connections claimed from `connector_connections` — every connector but Google/Outlook. */
  connectorClaimed: number;
  connectorSynced: number;
  connectorFailed: number;
  /** Events found in a calendar or feed rather than added by hand. */
  discoveryCreated: number;
  discoveryAttached: number;
  /** Reports refused because the user had already dismissed or deleted that event. */
  discoverySuppressed: number;
  /** Background reads of discovered events' public pages. */
  enrichFetched: number;
  enrichFailed: number;
  budgetExhausted: boolean;
  /** How overdue the oldest due connection was when the run started; null when none. */
  oldestDueAgeMs: number | null;
};

function emptyRunStats(): SyncRunStats {
  return {
    claimed: 0,
    icsClaimed: 0,
    icsSynced: 0,
    icsFailed: 0,
    synced: 0,
    failed: 0,
    skippedNoScope: 0,
    eventsIngested: 0,
    calendarSkippedByDecision: 0,
    calendarKeptByDecision: 0,
    contactsCreated: 0,
    interactionsLogged: 0,
    addressBookSeen: 0,
    addressBookMatched: 0,
    addressBookBlockedByPlan: 0,
    addressBookTombstones: 0,
    addressBookNameless: 0,
    eventConnectionsClaimed: 0,
    eventConnectionsSynced: 0,
    eventConnectionsFailed: 0,
    eventRostersFetched: 0,
    connectorClaimed: 0,
    connectorSynced: 0,
    connectorFailed: 0,
    discoveryCreated: 0,
    discoveryAttached: 0,
    discoverySuppressed: 0,
    enrichFetched: 0,
    enrichFailed: 0,
    budgetExhausted: false,
    oldestDueAgeMs: null,
  };
}

/**
 * Reads one page of calendar entries for Luma/Partiful/Eventbrite invites, shared by all three
 * calendar passes so a platform invite sitting in an Outlook or iCloud calendar is found too —
 * this used to run on the Google pass alone, which meant it was the only one ever found.
 *
 * `source` is always `"gcal"` regardless of which provider fetched the page: it is a discovery
 * SOURCE tag (`DiscoverySource`), not a calendar-provider tag, and its only visible effect is
 * the badge text `DISCOVERY_LABEL` renders — "Found in your calendar", which already reads as
 * provider-agnostic. Inventing `"outlook_cal"`/`"apple_cal"` variants would need new copy and a
 * new `DiscoveryCandidate.sourceRef` prefix for no behavioural gain.
 *
 * Never allowed to fail the calendar sync: a discovery error must not cost the user their
 * meeting history, and the cursor has not advanced yet when this runs.
 */
async function recordCalendarEventDiscovery(
  conn: ClaimedConnection,
  stats: SyncRunStats,
  page: Pick<CalendarFetchResult, "events" | "selfEmails">,
  where: string
): Promise<void> {
  try {
    const discovered = await recordDiscoveryCandidates(
      conn.userId,
      calendarEventsToCandidates(page.events, page.selfEmails, "gcal")
    );
    stats.discoveryCreated += discovered.created;
    stats.discoveryAttached += discovered.attached;
    stats.discoverySuppressed += discovered.suppressed;
  } catch (err) {
    // Swallowed deliberately — see above — but reported (throttled), not silent.
    reportError(err, { where, userId: conn.userId, level: "warning" });
  }
}

/**
 * Sync one Google connection's calendar, paging until the provider says it is done or the
 * per-connection budget runs out.
 */
async function syncGoogleCalendar(
  conn: ClaimedConnection,
  stats: SyncRunStats,
  now: Date,
  deps: SyncDeps,
  startCursor: CalendarSyncCursor | null,
  deadline: number
): Promise<{ cursor: CalendarSyncCursor | null; exhausted: boolean }> {
  // Idempotent, and cheap when there is nothing to do: a connection made before per-calendar
  // sync shipped gains its `calendar_sources` row right here, carrying over whatever cursor
  // already sat on `conn.syncCursor` — the migration this whole task exists to not get wrong.
  await seedCalendarSources(conn.userId);
  const source = (await enabledSourcesFor(conn.id))[0];
  if (!source) {
    // The user disabled their only calendar. Nothing to fetch, but the connection itself is
    // healthy — hand back what we were given and let `syncGoogleConnection` record the
    // result, rather than treating "nothing enabled" as a fault. This function never writes
    // the connection's result itself: `sync_cursor` is one jsonb column shared with the
    // contacts phase, and `syncGoogleConnection` is the single writer of it.
    return { cursor: startCursor, exhausted: false };
  }

  const accessToken = await deps.getAccessToken(conn.userId);
  const ctx = await openIngestContext(conn.userId, {
    source: "google_calendar",
    // A meeting is evidence the user knows this person, so calendar sync populates the
    // network. This is the same choice the ICS subscription already makes, and the opposite
    // of the one-shot file import, which is annotate-only.
    createsContacts: true,
    // No `matchConfidence` override: this source CREATES contacts, so it takes the default
    // DUPLICATE_MERGE_CONFIDENCE (0.85). It used to pass 0.6 — the bare-full-name tier —
    // which meant two different people who happened to share a full name were merged into
    // one contact by the next sync, silently and permanently. Name+company and name+title
    // still fold; a name on its own now becomes a review suggestion instead.
    // `calendarAdapter` keeps 0.6 because it only annotates and never creates or merges.
  });

  // The cursor now lives on the `calendar_sources` row; falling back to the connection's own
  // (pre-migration) cursor — `startCursor`, read off `conn.syncCursor?.calendar` by the caller —
  // covers the one pass where `seedCalendarSources` just created the row and carried it over.
  // `source.syncCursor` and `startCursor` agree in that case, so this is a belt-and-suspenders
  // read, not a real fork in behaviour.
  let cursor = source.syncCursor ?? startCursor;

  for (;;) {
    let page;
    try {
      page = await deps.fetchPage({ accessToken, cursor, now });
    } catch (err) {
      if (err instanceof CalendarSyncTokenExpiredError) {
        // Expected lifecycle event, not a fault: drop both cursors and start the windowed
        // fetch again. Explicitly NOT counted as a failure — doing so would walk a healthy
        // connection up the backoff ladder and eventually disarm it.
        cursor = null;
        continue;
      }
      throw err;
    }

    const decided = await toNetworkEventsDecided(ctx.engines, page.events, page.selfEmails);
    const events = decided.events;
    stats.calendarSkippedByDecision += decided.skippedByDecision;
    stats.calendarKeptByDecision += decided.keptByDecision;
    if (events.length > 0) {
      const ingested = await ingestEvents(ctx, events);
      stats.eventsIngested += ingested.eventsSeen;
      stats.contactsCreated += ingested.contactsCreated;
      stats.interactionsLogged += ingested.interactionsLogged;
    }

    // The same page, read for a different question: which of these are Luma/Partiful/
    // Eventbrite invites rather than meetings? `classifyCalendarEvent` has already refused
    // those above, so the two readings cannot double-count one entry.
    await recordCalendarEventDiscovery(conn, stats, page, "job.sync.gcal-discovery");

    cursor = advanceGoogleCalendarCursor(cursor, page);

    // No more pages: the run is complete and `cursor` now holds the fresh syncToken.
    if (!page.nextPageToken) break;

    // Out of time mid-chain. Persisting `pageToken` (which `advanceCursor` just did) is what
    // makes the next run resume here rather than restart, and `next_sync_at = now` makes it
    // immediately due.
    if (deadlineReached(deadline)) {
      await finalizeIngest(ctx);
      await saveSourceCursor(source.id, cursor, now);
      return { cursor, exhausted: true };
    }
  }

  await finalizeIngest(ctx);
  await saveSourceCursor(source.id, cursor, now);
  return { cursor, exhausted: false };
}

/**
 * Sync one Google connection's contacts, paging until the address book is exhausted or the
 * per-connection budget runs out.
 *
 * Its own ingest context, not the calendar phase's: `IngestOptions.source` is written to the
 * rows these create, and a contact that arrived from the address book did not arrive from a
 * meeting. The duplicate index is therefore built twice per connection per run — the honest
 * price of two truthful provenance labels.
 */
async function syncGoogleContacts(
  conn: ClaimedConnection,
  stats: SyncRunStats,
  deps: SyncDeps,
  startCursor: ContactsSyncCursor | null,
  deadline: number
): Promise<{ cursor: ContactsSyncCursor | null; exhausted: boolean }> {
  const accessToken = await deps.getAccessToken(conn.userId);
  const ctx = await openIngestContext(conn.userId, {
    source: "google_contacts",
    // Someone in the user's own address book is someone they know. Same judgement the
    // calendar phase makes, and the opposite of the one-shot file import, which is a review
    // screen precisely because a file is somebody else's list.
    createsContacts: true,
  });

  let cursor = startCursor;

  for (;;) {
    let page;
    try {
      page = await (deps.fetchContactsPage ?? fetchContactsPage)({ accessToken, cursor });
    } catch (err) {
      if (err instanceof PeopleSyncTokenExpiredError) {
        // Expected lifecycle event, not a fault — Google expires these on its own schedule.
        // Drop the cursor and read the book again; explicitly NOT a failure, because counting
        // it would walk a healthy connection up the backoff ladder and eventually disarm it.
        cursor = null;
        continue;
      }
      throw err;
    }

    stats.addressBookTombstones += page.tombstones;
    stats.addressBookNameless += page.nameless;
    if (page.people.length > 0) {
      const ingested = await ingestPeople(ctx, page.people);
      stats.addressBookSeen += ingested.seen;
      stats.contactsCreated += ingested.created;
      stats.addressBookMatched += ingested.matched;
      stats.addressBookBlockedByPlan += ingested.blockedByPlan;
    }

    cursor = advanceContactsCursor(cursor, page);

    // No more pages: `cursor` now holds the fresh syncToken and the next run is a delta.
    if (!page.nextPageToken) break;

    // Out of time mid-book. `advanceContactsCursor` has kept the pageToken, so the next run
    // resumes here rather than starting the whole address book again.
    if (deadlineReached(deadline)) {
      await finalizeIngest(ctx);
      return { cursor, exhausted: true };
    }
  }

  await finalizeIngest(ctx);
  return { cursor, exhausted: false };
}

/**
 * Sync everything one Google connection is entitled to, then record the result ONCE.
 *
 * The single write is the point. `sync_cursor` is one jsonb column holding a key per
 * capability, and the schema's own comment records what happens when two consumers each
 * write their own key over the whole object: the other one's position is silently erased,
 * twice an hour, forever. So the phases return their cursors and this function merges them
 * into the claimed value — anything it does not know about survives untouched.
 *
 * Calendar runs first because meetings are the stronger signal and the budget is shared: if
 * a first sync of a huge address book exhausts it, the user still got their meetings.
 */
async function syncGoogleConnection(
  conn: ClaimedConnection,
  stats: SyncRunStats,
  now: Date,
  deps: SyncDeps,
  caps: { wantsCalendar: boolean; wantsContacts: boolean }
): Promise<void> {
  const deadline = deadlineAfter(PER_CONNECTION_BUDGET_MS);
  let cursor: ProviderSyncCursor = { ...(conn.syncCursor ?? {}) };
  let exhausted = false;

  if (caps.wantsCalendar) {
    // The calendar cursor is NOT merged back into `cursor`: it lives on the `calendar_sources`
    // row now, and `syncGoogleCalendar` has already saved it there. Whatever `calendar` key the
    // connection still carries is the pre-migration value, left in place as the fallback read.
    const result = await syncGoogleCalendar(conn, stats, now, deps, cursor.calendar ?? null, deadline);
    exhausted = result.exhausted;
  }

  // Skipped when the calendar phase already spent the budget: its cursor is saved either
  // way (on its source row), and `nextSyncAt = now` below makes the next run pick contacts up immediately.
  if (caps.wantsContacts && !exhausted) {
    const result = await syncGoogleContacts(conn, stats, deps, cursor.contacts ?? null, deadline);
    cursor = { ...cursor, contacts: result.cursor };
    exhausted = result.exhausted;
  }

  await markSyncResult(conn.provider, conn.id, {
    ok: true,
    cursor,
    nextSyncAt: exhausted ? now : new Date(now.getTime() + SYNC_INTERVAL_MS),
  });
}

/**
 * Sync one Microsoft connection's calendar. Mirrors `syncGoogleCalendar` exactly — same
 * budget/deadline/cursor/error handling structure, same calendar_sources migration at the top —
 * calling the Outlook token getter and the microsoft-calendar connector's
 * `fetchCalendarPage`/`advanceCursor` instead.
 */
async function syncMicrosoftCalendar(
  conn: ClaimedConnection,
  stats: SyncRunStats,
  now: Date,
  deps: SyncDeps
): Promise<void> {
  await seedCalendarSources(conn.userId);
  const source = (await enabledSourcesFor(conn.id))[0];
  if (!source) {
    await markSyncResult(conn.provider, conn.id, {
      ok: true,
      cursor: conn.syncCursor,
      nextSyncAt: new Date(now.getTime() + SYNC_INTERVAL_MS),
    });
    return;
  }

  const accessToken = await (deps.getMicrosoftAccessToken ?? getValidOutlookAccessToken)(conn.userId);
  const ctx = await openIngestContext(conn.userId, {
    source: "microsoft_calendar",
    // Same business decision as the Google path — see its comment above.
    createsContacts: true,
  });

  let cursor = source.syncCursor ?? conn.syncCursor?.calendar ?? null;
  const deadline = deadlineAfter(PER_CONNECTION_BUDGET_MS);

  for (;;) {
    let page;
    try {
      page = await (deps.fetchMicrosoftPage ?? fetchMicrosoftCalendarPage)({
        accessToken,
        cursor,
        ownerEmail: conn.emailAddress,
        now,
      });
    } catch (err) {
      if (err instanceof CalendarSyncTokenExpiredError) {
        // Expected lifecycle event, not a fault — see failure mode 3 in
        // `microsoft-calendar.ts`'s header comment.
        cursor = null;
        continue;
      }
      throw err;
    }

    const decided = await toNetworkEventsDecided(ctx.engines, page.events, page.selfEmails);
    const events = decided.events;
    stats.calendarSkippedByDecision += decided.skippedByDecision;
    stats.calendarKeptByDecision += decided.keptByDecision;
    if (events.length > 0) {
      const ingested = await ingestEvents(ctx, events);
      stats.eventsIngested += ingested.eventsSeen;
      stats.contactsCreated += ingested.contactsCreated;
      stats.interactionsLogged += ingested.interactionsLogged;
    }

    // Same discovery pass Google's calendar gets — see `recordCalendarEventDiscovery`'s own
    // header comment for why a platform invite sitting in Outlook is found this way too.
    await recordCalendarEventDiscovery(conn, stats, page, "job.sync.outlook-discovery");

    cursor = advanceMicrosoftCalendarCursor(cursor, page);

    if (!page.nextPageToken) break;

    if (deadlineReached(deadline)) {
      await finalizeIngest(ctx);
      await saveSourceCursor(source.id, cursor, now);
      await markSyncResult(conn.provider, conn.id, {
        ok: true,
        cursor: conn.syncCursor,
        nextSyncAt: now,
      });
      return;
    }
  }

  await finalizeIngest(ctx);
  await saveSourceCursor(source.id, cursor, now);
  await markSyncResult(conn.provider, conn.id, {
    ok: true,
    cursor: conn.syncCursor,
    nextSyncAt: new Date(now.getTime() + SYNC_INTERVAL_MS),
  });
}

/**
 * Sync one iCloud connection. Unlike Google and Microsoft, a connection covers several
 * calendars, so the claim stays at the connection and the loop fans out over its enabled
 * sources — checking the remaining budget BETWEEN calendars, so a five-calendar account
 * degrades by syncing fewer of them this pass rather than by overrunning the function.
 * Oldest-synced calendar first (by `lastSyncedAt`, nulls — never synced — treated as oldest of
 * all), so no calendar can starve behind a busy one forever.
 *
 * Each calendar's own network round trip is bounded — CalDAV requests go through
 * `fetchChanges`, whose transport carries a `CALDAV_TIMEOUT_MS` (45s) timeout per hop, so a
 * hung request cannot itself stall this loop indefinitely. What is NOT bounded is the LOCAL
 * cost once a response comes back: `expandEvent` caps a single recurring master's blow-up at
 * `MAX_OCCURRENCES`, but nothing caps how many masters/singletons one calendar's
 * `sync-collection` answer can contain, or the total events `ingestEvents` then processes in
 * one call. A calendar with a pathological number of events in the rolling window can still
 * make this pass's total wall-clock exceed `SYNC_TIME_BUDGET_MS`, in the worst case toward the
 * 300s function ceiling. Capping that safely — without silently dropping events a shorter pass
 * would otherwise have delivered — needs its own cursor-aware design (there is no
 * page-token-shaped way to resume a CalDAV response mid-list); this is a known, documented gap
 * rather than a guess at one.
 *
 * A calendar-level failure (a deleted calendar, a revoked share — `CalDavRejectedError`, see
 * `apple-calendar.ts`'s own header — or a resync that never stabilizes, below) is caught HERE,
 * per calendar, and does not abort the fan-out: the oldest-`lastSyncedAt`-first sort exists
 * precisely so a broken calendar cannot starve its siblings, and a `break` on the first thrown
 * error would defeat that the moment the broken one sorts first. Its `lastSyncedAt` is bumped
 * (without touching its cursor) so the next pass rotates past it instead of retrying it ahead
 * of everything else, and the first error seen is kept. Once every calendar has had its turn
 * (or the budget ran out), that kept error is rethrown — surfacing to the claim block's own
 * catch in `runSyncPass`, which still counts it as a real, connection-level failure and puts
 * the connection through the normal retry/backoff/disarm ladder. That is how a permanently
 * broken calendar still eventually disarms the connection, while the healthy calendars keep
 * syncing on every pass in between.
 */
async function syncAppleCalendar(
  conn: ClaimedConnection,
  stats: SyncRunStats,
  now: Date,
  deps: SyncDeps
): Promise<void> {
  // Apple's connect flow (a later task) creates its own `calendar_sources` rows at connect
  // time, one per calendar the user picked — so this call is a no-op for THIS connection. It is
  // still meaningful here: it is how any Google or Outlook connection this same user also has
  // gets its row backfilled, on whichever provider's claim reaches them first.
  await seedCalendarSources(conn.userId);
  const sources = [...(await enabledSourcesFor(conn.id))].sort(
    (a, b) => (a.lastSyncedAt?.getTime() ?? 0) - (b.lastSyncedAt?.getTime() ?? 0)
  );

  if (sources.length === 0) {
    // Every calendar on this connection is disabled. Healthy connection, nothing to fetch —
    // reschedule rather than fault, same as the Google/Microsoft "nothing enabled" branch.
    await markSyncResult(conn.provider, conn.id, {
      ok: true,
      cursor: conn.syncCursor,
      nextSyncAt: new Date(now.getTime() + SYNC_INTERVAL_MS),
    });
    return;
  }

  const creds = await appleCredentials(conn.id);
  const ctx = await openIngestContext(conn.userId, {
    source: "apple_calendar",
    // Same business decision as the Google and Microsoft paths — see the Google comment above.
    createsContacts: true,
  });

  const clockNow = deps.budgetClock ?? Date.now;
  const deadline = deadlineAfter(PER_CONNECTION_BUDGET_MS, clockNow);
  let exhausted = false;
  // The first calendar-level failure this pass, if any — kept, not thrown immediately, so the
  // rest of the fan-out still gets its turn. See the function's own header comment.
  let firstError: unknown = null;

  for (const source of sources) {
    if (deadlineReached(deadline, clockNow)) {
      exhausted = true;
      stats.budgetExhausted = true;
      break;
    }

    let cursor = source.syncCursor ?? null;
    let calendarExhausted = false;
    // Bounds the `CalendarSyncTokenExpiredError` retry below to ONE reset per calendar per
    // pass — see the catch block's own comment for why an unbounded retry here is reachable
    // and dangerous in a way it is not for Google or Microsoft.
    let resyncAttempts = 0;

    try {
      for (;;) {
        let page;
        try {
          page = await (deps.fetchApplePage ?? fetchAppleCalendarPage)({
            creds,
            calendarUrl: source.calendarId,
            cursor,
            ownerEmail: conn.emailAddress,
            now,
          });
        } catch (err) {
          if (err instanceof CalendarSyncTokenExpiredError) {
            // Expected lifecycle event, not a fault — see the connector's own header comment.
            // UNLIKE Google and Microsoft, this can be raised here with `cursor` ALREADY null:
            // `apple-calendar.ts` translates a stale-token precondition from its cursor-less
            // fallback path (the ctag probe / time-range query) into this same error. An
            // unguarded `cursor = null; continue;` would then re-issue the identical
            // cursor-less request forever at network speed — hanging the whole pass (and the
            // ICS/event-connection work behind it, since `runSyncPass` awaits this) until the
            // function ceiling kills the invocation, with nothing counted along the way. A
            // second occurrence in the same pass, especially with a cursor that is already
            // null, is not the resync precondition working as intended, so it is left to
            // propagate as a real, counted failure instead of retried again.
            if (resyncAttempts >= 1) throw err;
            resyncAttempts++;
            cursor = null;
            if (deadlineReached(deadline, clockNow)) {
              calendarExhausted = true;
              exhausted = true;
              stats.budgetExhausted = true;
              break;
            }
            continue;
          }
          throw err;
        }

        const decided = await toNetworkEventsDecided(ctx.engines, page.events, page.selfEmails);
        const events = decided.events;
        stats.calendarSkippedByDecision += decided.skippedByDecision;
        stats.calendarKeptByDecision += decided.keptByDecision;
        if (events.length > 0) {
          const ingested = await ingestEvents(ctx, events);
          stats.eventsIngested += ingested.eventsSeen;
          stats.contactsCreated += ingested.contactsCreated;
          stats.interactionsLogged += ingested.interactionsLogged;
        }

        // Same discovery pass Google's and Microsoft's calendars get — see
        // `recordCalendarEventDiscovery`'s own header comment.
        await recordCalendarEventDiscovery(conn, stats, page, "job.sync.apple-discovery");

        cursor = advanceAppleCalendarCursor(cursor, page);

        // CalDAV never paginates (see `fetchCalendarPage`'s own doc comment) — `nextPageToken`
        // is always null — but the check stays structurally identical to Google's and
        // Microsoft's so this loop is not a special case to read.
        if (!page.nextPageToken) break;

        if (deadlineReached(deadline, clockNow)) {
          calendarExhausted = true;
          exhausted = true;
          stats.budgetExhausted = true;
          break;
        }
      }

      await saveSourceCursor(source.id, cursor, now);
    } catch (err) {
      // This calendar failed (a real rejection, or a resync that would not stabilize). Record
      // it, bump `lastSyncedAt` to `now` WITHOUT touching its stored cursor — so it still
      // reads as "oldest" no more than any other un-synced calendar next pass, rather than
      // sorting first again and re-failing ahead of its siblings every single time — and keep
      // going. See the function's own header comment for why this does not swallow the
      // failure: it is rethrown once the whole fan-out is done.
      if (firstError === null) firstError = err;
      await saveSourceCursor(source.id, source.syncCursor, now).catch(() => undefined);
    }

    if (calendarExhausted) break;
  }

  // Always reached now — including when a calendar failed — so contacts touched by whichever
  // calendars DID complete this pass still get their cohort/embedding follow-up, rather than
  // that follow-up being silently skipped forever because the cursor that would have re-surfaced
  // them already advanced.
  await finalizeIngest(ctx);

  if (firstError !== null) {
    // Surfaces to the claim block's own catch in `runSyncPass`, which records the connection's
    // counted failure and runs it through the normal retry/backoff/disarm ladder — the healthy
    // calendars above have already had their progress saved regardless.
    throw firstError;
  }

  await markSyncResult(conn.provider, conn.id, {
    ok: true,
    cursor: conn.syncCursor,
    nextSyncAt: exhausted ? now : new Date(now.getTime() + SYNC_INTERVAL_MS),
  });
}

/**
 * One scheduler pass.
 *
 * Returns stats rather than throwing, so a caller can always record a ledger row. The only
 * way this rejects is if claiming itself fails, which means the database is unreachable and
 * there is nothing to record anyway.
 */
export async function runSyncPass(
  options: { now?: Date; budgetMs?: number; deps?: SyncDeps } = {}
): Promise<SyncRunStats> {
  const now = options.now ?? new Date();
  const deps = options.deps ?? DEFAULT_DEPS;
  const stats = emptyRunStats();
  const deadline = deadlineAfter(options.budgetMs ?? SYNC_TIME_BUDGET_MS);

  // Google, Microsoft and Apple all claim in the same pass — the claim and result bookkeeping
  // are provider-agnostic, so each provider is just another claim+loop block below.
  // Measured before claiming: after the claim, the rows it took are no longer "due". The lag
  // metric is the worst of the three providers, so a stalled Outlook (or iCloud) queue cannot
  // hide behind a healthy Google one.
  const [googleLagMs, microsoftLagMs, appleLagMs] = await Promise.all([
    oldestDueAgeMs("google", now).catch(() => null),
    oldestDueAgeMs("microsoft", now).catch(() => null),
    oldestDueAgeMs("apple", now).catch(() => null),
  ]);
  stats.oldestDueAgeMs =
    googleLagMs === null && microsoftLagMs === null && appleLagMs === null
      ? null
      : Math.max(googleLagMs ?? 0, microsoftLagMs ?? 0, appleLagMs ?? 0);
  const claimed = await claimDueConnections("google", CONNECTIONS_PER_RUN, now);
  stats.claimed = claimed.length;

  // A connection may START only while a full per-connection budget remains, so four lanes
  // cannot carry the run past the function ceiling. Checked before each item, never after —
  // a budget tested after the work has already run bounds nothing.
  const startCutoff = deadline - PER_CONNECTION_BUDGET_MS;

  // `stats` counters are mutated only between awaits, so lanes cannot lose an increment.
  await runSettledPool(claimed, SYNC_CONCURRENCY, async (conn) => {
    if (deadlineReached(startCutoff)) {
      stats.budgetExhausted = true;
      // Released immediately due, so the next run (or the continuation kick) picks it up
      // rather than waiting out the lease.
      await markSyncResult(conn.provider, conn.id, {
        ok: true,
        cursor: conn.syncCursor,
        nextSyncAt: now,
      }).catch(() => null);
      return;
    }

    // A token minted before a scope shipped keeps working for the scopes it does hold, but
    // every call needing the missing one returns 403. Disarm only when the connection can do
    // NOTHING for us: a contacts-only grant is still a working connection, and disarming it
    // for lacking calendar would silently stop a sync that was fine.
    const wantsCalendar = hasGoogleCalendarScope(conn.scopes);
    const wantsContacts = hasGoogleContactsScope(conn.scopes);
    if (!wantsCalendar && !wantsContacts) {
      stats.skippedNoScope++;
      await disarmSync(
        conn.provider,
        conn.id,
        "Calendar and contacts access not granted — reconnect Google to enable sync",
        now
      ).catch(() => null);
      return;
    }

    try {
      await syncGoogleConnection(conn, stats, now, deps, { wantsCalendar, wantsContacts });
      stats.synced++;
    } catch (err) {
      stats.failed++;
      // A dead grant is permanent until the user reconnects; anything else is worth retrying.
      // `getValidAccessToken` has already written `needs_reauth` (and nulled `next_sync_at`)
      // in the ReauthRequiredError case, so this only records the reason.
      const retryable = !(err instanceof ReauthRequiredError);
      // A dead grant is the person's to fix and the bell already tells them; anything else is
      // a fault worth seeing across users, which a per-row `sync_error` never is.
      if (retryable) {
        reportError(err, { where: "job.sync.gcal", userId: conn.userId, level: "warning", extra: { connectionId: conn.id } });
      }
      await markSyncResult(conn.provider, conn.id, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        retryable,
      }).catch(reportAndContinue({ where: "job.sync.mark-result", userId: conn.userId }, null));
    }
  });

  // Microsoft: the same lane as Google above — same pool, same start cutoff, same reporting.
  // Claimed after the Google pool drains, so `startCutoff` (not the claim) is what keeps the
  // combined run inside the function ceiling.
  const claimedMicrosoft = await claimDueConnections("microsoft", CONNECTIONS_PER_RUN, now);
  stats.claimed += claimedMicrosoft.length;

  await runSettledPool(claimedMicrosoft, SYNC_CONCURRENCY, async (conn) => {
    if (deadlineReached(startCutoff)) {
      stats.budgetExhausted = true;
      await markSyncResult(conn.provider, conn.id, {
        ok: true,
        cursor: conn.syncCursor,
        nextSyncAt: now,
      }).catch(() => null);
      return;
    }

    // Same reasoning as the Google branch: a token minted before the calendar scope
    // shipped is still valid for Outlook Contacts and will keep working, but every
    // Calendar call it makes returns 403.
    if (!hasMicrosoftCalendarScope(conn.scopes)) {
      stats.skippedNoScope++;
      await disarmSync(
        conn.provider,
        conn.id,
        "Calendar access not granted — reconnect Outlook to enable calendar sync",
        now
      ).catch(() => null);
      return;
    }

    try {
      await syncMicrosoftCalendar(conn, stats, now, deps);
      stats.synced++;
    } catch (err) {
      stats.failed++;
      const retryable = !(err instanceof ReauthRequiredError);
      if (retryable) {
        reportError(err, { where: "job.sync.outlook-calendar", userId: conn.userId, level: "warning", extra: { connectionId: conn.id } });
      }
      await markSyncResult(conn.provider, conn.id, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        retryable,
      }).catch(reportAndContinue({ where: "job.sync.mark-result", userId: conn.userId }, null));
    }
  });

  // Apple: the same lane shape as Google and Microsoft above, with no scope check — Apple
  // grants no scopes for a CalDAV app-specific password, so there is nothing to gate on before
  // calling the sync itself (see `apple_connections.scopes`'s own comment).
  const claimedApple = await claimDueConnections("apple", CONNECTIONS_PER_RUN, now);
  stats.claimed += claimedApple.length;

  await runSettledPool(claimedApple, SYNC_CONCURRENCY, async (conn) => {
    if (deadlineReached(startCutoff)) {
      stats.budgetExhausted = true;
      await markSyncResult(conn.provider, conn.id, {
        ok: true,
        cursor: conn.syncCursor,
        nextSyncAt: now,
      }).catch(() => null);
      return;
    }

    try {
      await syncAppleCalendar(conn, stats, now, deps);
      stats.synced++;
    } catch (err) {
      stats.failed++;
      // Same non-retryable/retryable split as Google and Microsoft. The connector maps a
      // revoked app-specific password (CalDAV 401) to `ReauthRequiredError` — see
      // `apple-calendar.ts`'s failure mode 3 — so that case disarms immediately instead of
      // burning six retries against a connection that can never succeed again. A
      // `CalDavRejectedError` (a deleted calendar, a revoked share) is anything else here: it
      // falls to `retryable = true` and rides the normal backoff ladder, same as any other
      // uncounted-as-permanent fault from Google or Microsoft.
      const retryable = !(err instanceof ReauthRequiredError);
      if (retryable) {
        reportError(err, { where: "job.sync.apple-calendar", userId: conn.userId, level: "warning", extra: { connectionId: conn.id } });
      }
      await markSyncResult(conn.provider, conn.id, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        retryable,
      }).catch(reportAndContinue({ where: "job.sync.mark-result", userId: conn.userId }, null));
    }
  });

  // ICS subscriptions are a third claimable source, in the same pass.
  //
  // They are the only path for Apple Calendar and any other non-Google feed, so they are kept
  // rather than deprecated — but until now nothing scheduled them: they synced only when a
  // page render happened to call `syncDueCalendarSubscriptions`, which meant a user who
  // subscribed and then stopped opening `/imports` silently stopped syncing.
  if (!deadlineReached(deadline)) {
    const subs = await claimDueCalendarSubscriptions(ICS_SUBSCRIPTIONS_PER_RUN, now).catch(
      reportAndContinue({ where: "job.sync.ics-claim" }, [] as Awaited<ReturnType<typeof claimDueCalendarSubscriptions>>)
    );
    stats.icsClaimed = subs.length;
    for (const sub of subs) {
      if (deadlineReached(deadline)) {
        stats.budgetExhausted = true;
        break;
      }
      try {
        await syncCalendarSubscription(sub.userId, sub.id);
        stats.icsSynced++;
      } catch (err) {
        // The claim already moved `last_synced_at`, so a failing feed waits out the stale
        // window rather than being re-fetched every run. Counted, never rethrown — one dead
        // ICS URL must not stop the rest — and reported (throttled).
        stats.icsFailed++;
        reportError(err, { where: "job.sync.ics", userId: sub.userId, level: "warning", extra: { subscriptionId: sub.id } });
      }
    }
  }

  // Luma / Eventbrite, last: the calendar work above is what actually creates contacts, so
  // it gets first call on the budget. This pass only fills rosters — nothing here becomes a
  // contact without a human saying so — and is safe to cut short and resume next run.
  if (!deadlineReached(deadline)) {
    try {
      const eventStats = await runEventSyncPass(now, {
        deadline,
        feedDeps: deps.eventPageFetch ? { fetch: deps.eventPageFetch } : undefined,
      });
      stats.eventConnectionsClaimed = eventStats.claimed;
      stats.eventConnectionsSynced = eventStats.synced;
      stats.eventConnectionsFailed = eventStats.failed;
      stats.eventRostersFetched = eventStats.attendeesUpserted;
    } catch (err) {
      // Never rethrown, for the same reason as everything else in this function: a failure in
      // one provider must not lose the run's ledger row for the others.
      stats.eventConnectionsFailed++;
      reportError(err, { where: "job.sync.event-connections" });
    }
  } else {
    stats.budgetExhausted = true;
  }

  /**
   * Family four: every connector that is not Google, Outlook, an ICS feed or an event
   * provider. Dispatch is by manifest rather than by a `switch`, so adding a connector never
   * means editing the scheduler.
   */
  if (!deadlineReached(deadline)) {
    const connections = await claimDueConnectorConnections(CONNECTIONS_PER_RUN, now).catch(
      reportAndContinue(
        { where: "job.sync.connector-claim" },
        [] as Awaited<ReturnType<typeof claimDueConnectorConnections>>
      )
    );
    stats.connectorClaimed = connections.length;
    await runSettledPool(connections, SYNC_CONCURRENCY, async (conn) => {
      if (deadlineReached(deadline - PER_CONNECTION_BUDGET_MS)) {
        stats.budgetExhausted = true;
        await markConnectorSyncResult(conn.id, {
          ok: true,
          cursor: conn.cursor,
          nextSyncAt: now,
        }).catch(() => null);
        return;
      }
      const manifest = (deps.resolveConnector ?? connectorById)(conn.connectorId);
      if (!manifest?.sync) {
        // A row can outlive the code that made it — a connector removed from the registry,
        // or one whose row was written before its sync landed. Unschedule it and say so,
        // rather than counting a failure the user cannot act on.
        await disarmConnectorSync(
          conn.id,
          "This connector is no longer available — reconnect it from Settings.",
          now
        ).catch(() => null);
        return;
      }
      try {
        await manifest.sync(conn.id);
        // The success half of the contract documented on `ConnectorManifest.sync`: a sync
        // that recorded its own result (it had a cursor, or its own cadence) has already
        // left the row `idle`, and this no-ops against the `syncing` guard. One that just
        // returned gets closed out here rather than staying leased and instantly due again.
        await markConnectorSyncSucceeded(conn.id, now).catch(
          reportAndContinue({ where: "job.sync.connector-mark" }, null)
        );
        stats.connectorSynced++;
      } catch (err) {
        stats.connectorFailed++;
        reportError(err, {
          where: "job.sync.connector",
          userId: conn.userId,
          level: "warning",
          extra: { connectionId: conn.id, connectorId: conn.connectorId },
        });
        await markConnectorSyncResult(conn.id, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          retryable: true,
        }).catch(reportAndContinue({ where: "job.sync.connector-mark" }, null));
      }
    });
  } else {
    stats.budgetExhausted = true;
  }

  // Person keys for rows written before the column existed. A bounded slice per pass: it is
  // pure catch-up work, and the panel it feeds is simply thinner until it finishes.
  await backfillPersonKeys(2000).catch(reportAndContinue({ where: "job.sync.person-keys" }, 0));

  // Reading discovered events' public pages comes LAST of all, and deliberately so: every
  // pass above creates or updates data the user is waiting on, while this one makes rows that
  // already exist better. It takes whatever budget is left and stops mid-queue without
  // consequence — the claims it did not use are simply still due next time.
  if (!deadlineReached(deadline)) {
    try {
      const enrichStats = await runEnrichmentPass({
        now,
        deadline,
        deps: deps.eventPageFetch ? { fetch: deps.eventPageFetch } : undefined,
      });
      stats.enrichFetched = enrichStats.enriched;
      stats.enrichFailed = enrichStats.failed;
    } catch (err) {
      stats.enrichFailed++;
      reportError(err, { where: "job.sync.event-enrich" });
    }
  } else {
    stats.budgetExhausted = true;
  }

  return stats;
}
