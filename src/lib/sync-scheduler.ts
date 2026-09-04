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
  fetchCalendarPage,
  toNetworkEvents,
} from "@/lib/connectors/google-calendar";
import { hasCalendarScope, getValidAccessToken } from "@/lib/gmail";
import {
  claimDueConnections,
  disarmSync,
  markSyncResult,
  type ClaimedConnection,
} from "@/lib/provider-connections";
import { finalizeIngest, ingestEvents, openIngestContext } from "@/lib/ingest/events";
import { ReauthRequiredError } from "@/lib/errors";
import { deadlineAfter, deadlineReached } from "@/lib/time-budget";

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

/** Cadence for a healthy connection. A floor, never a promise — GitHub cron lags 5-30 minutes. */
export const SYNC_INTERVAL_MS = 30 * 60 * 1000;

/**
 * The two effects a sync run has on the outside world: minting a token and calling the
 * provider. Injectable so the scheduler's own behaviour — budgets, isolation between
 * connections, how each class of failure is recorded — can be tested without a network or a
 * real Google grant. Production passes nothing and gets the real implementations.
 */
export type SyncDeps = {
  getAccessToken: typeof getValidAccessToken;
  fetchPage: typeof fetchCalendarPage;
};

const DEFAULT_DEPS: SyncDeps = {
  getAccessToken: getValidAccessToken,
  fetchPage: fetchCalendarPage,
};

export type SyncRunStats = {
  claimed: number;
  synced: number;
  failed: number;
  skippedNoScope: number;
  eventsIngested: number;
  contactsCreated: number;
  interactionsLogged: number;
  budgetExhausted: boolean;
};

function emptyRunStats(): SyncRunStats {
  return {
    claimed: 0,
    synced: 0,
    failed: 0,
    skippedNoScope: 0,
    eventsIngested: 0,
    contactsCreated: 0,
    interactionsLogged: 0,
    budgetExhausted: false,
  };
}

/**
 * Sync one Google connection's calendar, paging until the provider says it is done or the
 * per-connection budget runs out.
 */
async function syncGoogleCalendar(
  conn: ClaimedConnection,
  stats: SyncRunStats,
  now: Date,
  deps: SyncDeps
): Promise<void> {
  const accessToken = await deps.getAccessToken(conn.userId);
  const ctx = await openIngestContext(conn.userId, {
    source: "google_calendar",
    // A meeting is evidence the user knows this person, so calendar sync populates the
    // network. This is the same choice the ICS subscription already makes, and the opposite
    // of the one-shot file import, which is annotate-only.
    createsContacts: true,
    // `calendarAdapter`'s figure: an attendee list makes a name-only match strong evidence.
    matchConfidence: 0.6,
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

    const events = toNetworkEvents(page.events, page.selfEmails);
    if (events.length > 0) {
      const ingested = await ingestEvents(ctx, events);
      stats.eventsIngested += ingested.eventsSeen;
      stats.contactsCreated += ingested.contactsCreated;
      stats.interactionsLogged += ingested.interactionsLogged;
    }

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

  // Google only, for now. Microsoft joins by adding its provider here once Outlook's
  // calendar/mail scopes ship — the claim and result bookkeeping are already provider-agnostic.
  const claimed = await claimDueConnections("google", CONNECTIONS_PER_RUN, now);
  stats.claimed = claimed.length;

  for (const conn of claimed) {
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
      continue;
    }

    // A token minted before the calendar scope shipped is still valid for Gmail and Contacts
    // and will keep working — but every Calendar call it makes returns 403. Disarm rather
    // than retry: only the user reconnecting can fix it, and retrying forever would bury the
    // signal under backoff noise.
    if (!hasCalendarScope(conn.scopes)) {
      stats.skippedNoScope++;
      await disarmSync(
        conn.provider,
        conn.id,
        "Calendar access not granted — reconnect Google to enable calendar sync",
        now
      ).catch(() => null);
      continue;
    }

    try {
      await syncGoogleCalendar(conn, stats, now, deps);
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

  return stats;
}
