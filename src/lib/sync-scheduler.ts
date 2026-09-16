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
  advanceCursor,
  toNetworkEvents,
  type CalendarFetchResult,
} from "@/lib/connectors/calendar-shared";
import { fetchCalendarPage } from "@/lib/connectors/google-calendar";
import { fetchOutlookCalendarPage } from "@/lib/connectors/outlook-calendar";
import { hasCalendarScope, getValidAccessToken as getValidGoogleAccessToken } from "@/lib/gmail";
import {
  hasOutlookCalendarScope,
  getValidAccessToken as getValidOutlookAccessToken,
} from "@/lib/outlook";
import {
  claimDueConnections,
  disarmSync,
  markSyncResult,
  type ClaimedConnection,
  type SyncProvider,
} from "@/lib/provider-connections";
import { finalizeIngest, ingestEvents, openIngestContext } from "@/lib/ingest/events";
import { classifyCalendarEvent } from "@/lib/calendar-classify";
import {
  pruneOldCalendarEvents,
  toStorageRow,
  upsertCalendarEvents,
} from "@/lib/calendar-events-store";
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

/** Claimed per run. Small because each one can take up to a minute. */
export const CONNECTIONS_PER_RUN = 5;

/** ICS feeds claimed per run. Cheaper than an API sync — one HTTP GET and a parse. */
export const ICS_SUBSCRIPTIONS_PER_RUN = 10;

/** Cadence for a healthy connection. A floor, never a promise — GitHub cron lags 5-30 minutes. */
export const SYNC_INTERVAL_MS = 30 * 60 * 1000;

/** How long a `calendar_events` row survives before the sweep at the end of a pass drops it. */
export const CALENDAR_EVENTS_RETENTION_MS = 365 * 86400000;

/**
 * The two effects a sync run has on the outside world, per provider: minting a token and
 * calling the calendar API. Injectable so the scheduler's own behaviour — budgets, isolation
 * between connections, how each class of failure is recorded — can be tested without a
 * network or a real Google/Microsoft grant. Production passes nothing and gets the real
 * implementations.
 */
export type SyncDeps = {
  google: {
    getAccessToken: typeof getValidGoogleAccessToken;
    fetchPage: typeof fetchCalendarPage;
  };
  microsoft: {
    getAccessToken: typeof getValidOutlookAccessToken;
    fetchPage: typeof fetchOutlookCalendarPage;
  };
  /**
   * How the enrichment pass reads an event's public page.
   *
   * Injectable for the same reason the two above are, and with a sharper edge: without it a
   * smoke test that seeds an event with a URL makes a real outbound request to whatever host
   * the fixture named. A test suite that quietly fetches lu.ma is both slow and rude.
   */
  eventPageFetch?: typeof fetch;
};

const DEFAULT_DEPS: SyncDeps = {
  google: { getAccessToken: getValidGoogleAccessToken, fetchPage: fetchCalendarPage },
  microsoft: { getAccessToken: getValidOutlookAccessToken, fetchPage: fetchOutlookCalendarPage },
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
  contactsCreated: number;
  interactionsLogged: number;
  /** `calendar_events` rows dropped past their retention window this pass. */
  calendarEventsPruned: number;
  /** Luma/Eventbrite. Named apart from the calendar counters so one pass reports both. */
  eventConnectionsClaimed: number;
  eventConnectionsSynced: number;
  eventConnectionsFailed: number;
  eventRostersFetched: number;
  /** Events found in a calendar or feed rather than added by hand. */
  discoveryCreated: number;
  discoveryAttached: number;
  /** Reports refused because the user had already dismissed or deleted that event. */
  discoverySuppressed: number;
  /** Background reads of discovered events' public pages. */
  enrichFetched: number;
  enrichFailed: number;
  budgetExhausted: boolean;
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
    contactsCreated: 0,
    interactionsLogged: 0,
    calendarEventsPruned: 0,
    eventConnectionsClaimed: 0,
    eventConnectionsSynced: 0,
    eventConnectionsFailed: 0,
    eventRostersFetched: 0,
    discoveryCreated: 0,
    discoveryAttached: 0,
    discoverySuppressed: 0,
    enrichFetched: 0,
    enrichFailed: 0,
    budgetExhausted: false,
  };
}

/**
 * Fold one fetched page into ingest, discovery, and the raw calendar-context store.
 *
 * Shared between Google and Outlook because neither provider matters past this point — both
 * hand back the same `CalendarFetchResult` shape, and everything from here on is
 * `calendar-shared.ts`'s classification or the discovery pipeline's, not provider mechanics.
 */
async function processCalendarPage(
  ctx: Awaited<ReturnType<typeof openIngestContext>>,
  page: CalendarFetchResult,
  userId: string,
  discoverySource: "gcal" | "outlook",
  storageProvider: "google" | "microsoft",
  stats: SyncRunStats
): Promise<void> {
  const events = toNetworkEvents(page.events, page.selfEmails);
  if (events.length > 0) {
    const ingested = await ingestEvents(ctx, events);
    stats.eventsIngested += ingested.eventsSeen;
    stats.contactsCreated += ingested.contactsCreated;
    stats.interactionsLogged += ingested.interactionsLogged;
  }

  // The same page, read for a different question: which of these are Luma/Partiful/
  // Eventbrite invites rather than meetings? `classifyCalendarEvent` has already refused
  // those above, so the two readings cannot double-count one entry.
  //
  // Never allowed to fail the calendar sync: a discovery error must not cost the user their
  // meeting history, and the cursor has not advanced yet.
  try {
    const discovered = await recordDiscoveryCandidates(
      userId,
      calendarEventsToCandidates(page.events, page.selfEmails, discoverySource)
    );
    stats.discoveryCreated += discovered.created;
    stats.discoveryAttached += discovered.attached;
    stats.discoverySuppressed += discovered.suppressed;
  } catch {
    // Swallowed deliberately — see above.
  }

  // Every non-cancelled event, classified or not — the raw material for "what's on my
  // calendar" chat context. Independent of the two paths above: an ordinary internal meeting
  // touches neither a contact nor a discovered-event row, but still belongs here.
  const rows = page.events
    .filter((e) => e.start)
    .map((e) => toStorageRow(e, classifyCalendarEvent(e, page.selfEmails).kind));
  if (rows.length > 0) await upsertCalendarEvents(userId, storageProvider, rows);
}

/**
 * Sync one Google connection's calendar, paging until the provider says it is done or the
 * per-connection budget runs out.
 */
async function syncGoogleCalendar(
  conn: ClaimedConnection,
  stats: SyncRunStats,
  now: Date,
  deps: SyncDeps["google"]
): Promise<void> {
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

  let cursor = conn.syncCursor?.calendar ?? null;
  const deadline = deadlineAfter(PER_CONNECTION_BUDGET_MS);

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

    await processCalendarPage(ctx, page, conn.userId, "gcal", "google", stats);
    cursor = advanceCursor(cursor, page);

    // No more pages: the run is complete and `cursor` now holds the fresh syncToken.
    if (!page.nextPageToken) break;

    // Out of time mid-chain. Persisting `pageToken` (which `advanceCursor` just did) is what
    // makes the next run resume here rather than restart, and `next_sync_at = now` makes it
    // immediately due.
    if (deadlineReached(deadline)) {
      await finalizeIngest(ctx);
      await markSyncResult(conn.provider, conn.id, {
        ok: true,
        cursor: { calendar: cursor },
        nextSyncAt: now,
      });
      return;
    }
  }

  await finalizeIngest(ctx);
  await markSyncResult(conn.provider, conn.id, {
    ok: true,
    cursor: { calendar: cursor },
    nextSyncAt: new Date(now.getTime() + SYNC_INTERVAL_MS),
  });
}

/**
 * Sync one Outlook connection's calendar. Structurally identical to `syncGoogleCalendar` —
 * the only differences are which token/fetcher get called and that the owner's address is
 * passed in explicitly (Graph has no per-attendee "self" flag; Outlook already knows its own
 * address statically from `outlook_connections.email_address`).
 */
async function syncOutlookCalendar(
  conn: ClaimedConnection,
  stats: SyncRunStats,
  now: Date,
  deps: SyncDeps["microsoft"]
): Promise<void> {
  const accessToken = await deps.getAccessToken(conn.userId);
  const ctx = await openIngestContext(conn.userId, {
    source: "outlook_calendar",
    createsContacts: true,
  });

  let cursor = conn.syncCursor?.calendar ?? null;
  const deadline = deadlineAfter(PER_CONNECTION_BUDGET_MS);

  for (;;) {
    let page;
    try {
      page = await deps.fetchPage({
        accessToken,
        cursor,
        selfEmail: conn.emailAddress,
        now,
      });
    } catch (err) {
      if (err instanceof CalendarSyncTokenExpiredError) {
        cursor = null;
        continue;
      }
      throw err;
    }

    await processCalendarPage(ctx, page, conn.userId, "outlook", "microsoft", stats);
    cursor = advanceCursor(cursor, page);

    if (!page.nextPageToken) break;

    if (deadlineReached(deadline)) {
      await finalizeIngest(ctx);
      await markSyncResult(conn.provider, conn.id, {
        ok: true,
        cursor: { calendar: cursor },
        nextSyncAt: now,
      });
      return;
    }
  }

  await finalizeIngest(ctx);
  await markSyncResult(conn.provider, conn.id, {
    ok: true,
    cursor: { calendar: cursor },
    nextSyncAt: new Date(now.getTime() + SYNC_INTERVAL_MS),
  });
}

type ProviderPlan = {
  id: SyncProvider;
  hasScope: (scopes: string | null) => boolean;
  reconnectMessage: string;
  sync: (conn: ClaimedConnection, stats: SyncRunStats, now: Date) => Promise<void>;
};

/**
 * One connection's worth of work: budget check, scope gate, sync, and outcome recording.
 * Shared across providers so Google and Microsoft cannot drift on the properties that make
 * continuous sync safe to leave unattended — a swallowed error must always become a number in
 * `stats`, never an unhandled rejection that stops the loop.
 */
async function processConnection(
  conn: ClaimedConnection,
  plan: ProviderPlan,
  stats: SyncRunStats,
  now: Date,
  deadline: ReturnType<typeof deadlineAfter>
): Promise<void> {
  // Checked BEFORE each item, never after — a budget tested after the work has already run
  // bounds nothing.
  if (deadlineReached(deadline)) {
    stats.budgetExhausted = true;
    // Release the claim so the next run picks it up immediately rather than waiting out
    // the lease.
    await markSyncResult(conn.provider, conn.id, {
      ok: true,
      cursor: conn.syncCursor,
      nextSyncAt: now,
    }).catch(() => null);
    return;
  }

  // A token minted before the calendar scope shipped is still valid for the rest of that
  // connection's grant and will keep working — but every Calendar call it makes returns 403.
  // Disarm rather than retry: only the user reconnecting can fix it, and retrying forever
  // would bury the signal under backoff noise.
  if (!plan.hasScope(conn.scopes)) {
    stats.skippedNoScope++;
    await disarmSync(conn.provider, conn.id, plan.reconnectMessage, now).catch(() => null);
    return;
  }

  try {
    await plan.sync(conn, stats, now);
    stats.synced++;
  } catch (err) {
    stats.failed++;
    // A dead grant is permanent until the user reconnects; anything else is worth retrying.
    // `getValidAccessToken` has already written `needs_reauth` (and nulled `next_sync_at`)
    // in the ReauthRequiredError case, so this only records the reason.
    const retryable = !(err instanceof ReauthRequiredError);
    await markSyncResult(conn.provider, conn.id, {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      retryable,
    }).catch(() => null);
  }
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

  const providerPlans: ProviderPlan[] = [
    {
      id: "google",
      hasScope: hasCalendarScope,
      reconnectMessage: "Calendar access not granted — reconnect Google to enable calendar sync",
      sync: (conn, s, n) => syncGoogleCalendar(conn, s, n, deps.google),
    },
    {
      id: "microsoft",
      hasScope: hasOutlookCalendarScope,
      reconnectMessage: "Calendar access not granted — reconnect Outlook to enable calendar sync",
      sync: (conn, s, n) => syncOutlookCalendar(conn, s, n, deps.microsoft),
    },
  ];

  for (const plan of providerPlans) {
    const claimed = await claimDueConnections(plan.id, CONNECTIONS_PER_RUN, now);
    stats.claimed += claimed.length;
    for (const conn of claimed) {
      await processConnection(conn, plan, stats, now, deadline);
    }
  }

  // ICS subscriptions are a third claimable source, in the same pass.
  //
  // They are the only path for Apple Calendar and any other non-Google feed, so they are kept
  // rather than deprecated — but until now nothing scheduled them: they synced only when a
  // page render happened to call `syncDueCalendarSubscriptions`, which meant a user who
  // subscribed and then stopped opening `/imports` silently stopped syncing.
  if (!deadlineReached(deadline)) {
    const subs = await claimDueCalendarSubscriptions(ICS_SUBSCRIPTIONS_PER_RUN, now).catch(
      () => []
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
      } catch {
        // The claim already moved `last_synced_at`, so a failing feed waits out the stale
        // window rather than being re-fetched every run. Counted, never rethrown — one dead
        // ICS URL must not stop the rest.
        stats.icsFailed++;
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
    } catch {
      // Never rethrown, for the same reason as everything else in this function: a failure in
      // one provider must not lose the run's ledger row for the others.
      stats.eventConnectionsFailed++;
    }
  } else {
    stats.budgetExhausted = true;
  }

  // Person keys for rows written before the column existed. A bounded slice per pass: it is
  // pure catch-up work, and the panel it feeds is simply thinner until it finishes.
  await backfillPersonKeys(2000).catch(() => 0);

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
    } catch {
      stats.enrichFailed++;
    }
  } else {
    stats.budgetExhausted = true;
  }

  // A single DELETE, cheap enough to run every pass unconditionally rather than gated on the
  // budget like everything above it.
  stats.calendarEventsPruned = await pruneOldCalendarEvents(
    new Date(now.getTime() - CALENDAR_EVENTS_RETENTION_MS)
  ).catch(() => 0);

  return stats;
}
