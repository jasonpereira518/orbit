/**
 * The Luma / Eventbrite sync pass.
 *
 * Rides inside `runSyncPass` in `src/lib/sync-scheduler.ts`, so it inherits the existing
 * every-15-minutes GitHub Actions schedule (`.github/workflows/ops.yml` -> `POST
 * /api/sync/run`, Bearer `$CRON_SECRET`) and the single `sync.run` ledger row. No new cron,
 * no new route, no new secret.
 *
 * ## The rule that keeps the plan cap honest
 *
 * This pass writes `events` and `event_attendees` and **never calls `ingestEvents`**. Nobody
 * becomes a contact from a background sync. The connector fills the roster; the human picks
 * who they actually spoke to (`src/lib/events/connect.ts`).
 *
 * That is not squeamishness about automation — it is the difference between a feature and a
 * liability. A 900-person conference synced overnight would otherwise consume a free user's
 * entire contact allowance while they slept, and every one of those contacts would be someone
 * they had never met.
 *
 * ## Failure isolation
 *
 * One user's broken connection is caught, recorded and counted — never rethrown. A single
 * expired Luma key must not stop the pass before it reaches everyone else, which is the same
 * rule `runSyncPass` already follows for calendars.
 */
import { deadlineAfter, deadlineReached } from "@/lib/time-budget";
import {
  claimDueEventConnections,
  markEventSyncResult,
  markNeedsReauth,
  type ClaimedEventConnection,
} from "@/lib/events/connections";
import {
  LumaAuthError,
  listCalendarEvents,
  listEventGuests,
} from "@/lib/events/connectors/luma";
import {
  EventbriteAuthError,
  listEventAttendees,
  listOrganizationEvents,
} from "@/lib/events/connectors/eventbrite";
import { upsertProviderEvent, upsertProviderAttendees } from "@/lib/events/provider-writes";
import { IcsFeedGoneError, syncIcsFeed } from "@/lib/events/discovery/from-ics-feed";
import type { FetchPageDeps } from "@/lib/events/guarded-fetch";
import type { ProviderAttendee, ProviderEvent, ProviderPage } from "@/lib/events/types";

/** Matches `CONNECTIONS_PER_RUN` in the calendar scheduler. */
const CONNECTIONS_PER_RUN = 5;
const PER_CONNECTION_BUDGET_MS = 60_000;
const PASS_BUDGET_MS = 240_000;
/** A guest list of a few thousand is plausible; an unbounded loop is not. */
const MAX_PAGES = 20;

export type EventSyncStats = {
  claimed: number;
  synced: number;
  failed: number;
  eventsUpserted: number;
  attendeesUpserted: number;
};

async function drain<T>(
  first: (cursor: string | null) => Promise<ProviderPage<T>>,
  deadline: number
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result: ProviderPage<T> = await first(cursor);
    items.push(...result.items);
    cursor = result.nextCursor;
    // Checked after appending so a budget stop keeps everything already fetched.
    if (!cursor || deadlineReached(deadline)) break;
  }
  return items;
}

/**
 * A personal calendar feed: everything the user registered for, hosted or not.
 *
 * The counterpart to `syncHostApi` below, and the more valuable half for most people — a host
 * API can only ever see the events you RUN. Feeds create and update events and never touch a
 * roster, because an iCal feed carries no guests.
 */
async function syncFeed(
  conn: ClaimedEventConnection,
  stats: EventSyncStats,
  deps?: FetchPageDeps
): Promise<void> {
  if (!conn.secret) {
    await markNeedsReauth(conn.id, "That calendar link could not be read. Reconnect to fix.");
    stats.failed++;
    return;
  }

  const discovered = await syncIcsFeed(conn.userId, conn.secret, conn.provider, deps);
  stats.eventsUpserted += discovered.created + discovered.attached;
  await markEventSyncResult(conn.id, { ok: true, cursor: null });
  stats.synced++;
}

async function syncHostApi(
  conn: ClaimedEventConnection,
  stats: EventSyncStats,
  passDeadline: number
): Promise<void> {
  if (!conn.secret) {
    // The credential could not be decrypted — a rotated ENCRYPTION_SECRET, or a row written
    // before one existed. Not retryable: no amount of waiting decrypts it.
    await markNeedsReauth(conn.id, "Stored credential could not be read. Reconnect to fix.");
    stats.failed++;
    return;
  }

  // One connection may have a minute, but never more of it than the pass itself has left.
  const deadline = Math.min(deadlineAfter(PER_CONNECTION_BUDGET_MS), passDeadline);
  const provider = conn.provider === "luma" ? "luma" : "eventbrite";
  const events: ProviderEvent[] =
    conn.provider === "luma"
      ? await drain((c) => listCalendarEvents(conn.secret!, c), deadline)
      : await drain(
          (c) => listOrganizationEvents(conn.secret!, conn.accountRef ?? "", c),
          deadline
        );

  for (const event of events) {
    if (deadlineReached(deadline)) break;
    // Everything a provider API can reach is an event the user HOSTS — neither Luma nor
    // Eventbrite exposes guest lists for events you merely attended. Marking the row honestly
    // is what lets the UI explain why some events have rosters and others need a paste.
    const eventId = await upsertProviderEvent(conn.userId, provider, event);
    stats.eventsUpserted++;

    const attendees: ProviderAttendee[] =
      conn.provider === "luma"
        ? await drain((c) => listEventGuests(conn.secret!, event.providerEventId, c), deadline)
        : await drain(
            (c) => listEventAttendees(conn.secret!, event.providerEventId, c),
            deadline
          );

    stats.attendeesUpserted += await upsertProviderAttendees(
      conn.userId,
      eventId,
      attendees,
      provider
    );
  }

  await markEventSyncResult(conn.id, { ok: true, cursor: null });
  stats.synced++;
}

export async function runEventSyncPass(
  now: Date = new Date(),
  options: {
    deadline?: number;
    /** How a calendar feed is fetched. Injectable so a test never reaches the network. */
    feedDeps?: FetchPageDeps;
  } = {}
): Promise<EventSyncStats> {
  const stats: EventSyncStats = {
    claimed: 0,
    synced: 0,
    failed: 0,
    eventsUpserted: 0,
    attendeesUpserted: 0,
  };
  // The caller's deadline wins when it is tighter. `runSyncPass` runs this LAST, inside its
  // own 4.5-minute budget, so a private 240s budget here could only ever overrun the function
  // ceiling the outer pass is protecting — this pass would still be draining guest lists
  // after the invocation that owns it was supposed to return.
  const ownDeadline = deadlineAfter(PASS_BUDGET_MS);
  const passDeadline =
    options.deadline !== undefined ? Math.min(options.deadline, ownDeadline) : ownDeadline;
  const claimed = await claimDueEventConnections(CONNECTIONS_PER_RUN, now);
  stats.claimed = claimed.length;

  for (const conn of claimed) {
    // Before, not after: starting a connection we cannot finish leaves it claimed and half
    // done, where its lease has to expire before anyone touches it again.
    if (deadlineReached(passDeadline)) break;
    try {
      // Dispatch on HOW this connection authenticates, not on which company it points at:
      // `luma` is a host API key and `luma_ics` a personal feed, and they share nothing but
      // a brand. `gmail` is handled in its own pass — see `from-gmail.ts`.
      if (conn.authKind === "ics") await syncFeed(conn, stats, options.feedDeps);
      else if (conn.authKind === "api_key" || conn.authKind === "oauth") {
        await syncHostApi(conn, stats, passDeadline);
      }
    } catch (error) {
      stats.failed++;
      // An auth failure is a consent problem, not a transport one. Walking it up the backoff
      // ladder would keep retrying a credential that will never work again while telling the
      // user nothing; flagging it puts a "reconnect" prompt in front of them instead.
      // A feed URL that 404s has been revoked — regenerating the link is how these platforms
      // revoke one. Same class as a dead token: retrying it every half hour says nothing.
      if (
        error instanceof LumaAuthError ||
        error instanceof EventbriteAuthError ||
        error instanceof IcsFeedGoneError
      ) {
        await markNeedsReauth(conn.id, (error as Error).message).catch(() => {});
        continue;
      }
      await markEventSyncResult(conn.id, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        retryable: true,
      }).catch(() => {});
    }
  }

  return stats;
}
