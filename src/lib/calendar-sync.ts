import { and, eq, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { calendarSubscriptions } from "@/db/schema";
import { parseIcsEvents, type ParsedCalendarEvent } from "@/lib/calendar-import";
import { counterpartsOf } from "@/lib/calendar-classify";
import { expandIcsEvents, seriesUidOf } from "@/lib/recurrence";
import { decideCalendarEvents } from "@/lib/decisions/calendar";
import { calendarEventsToCandidates } from "@/lib/events/discovery/from-calendar";
import { recordDiscoveryCandidates } from "@/lib/events/discovery/record";
import { calendarExternalIdBase } from "@/lib/ingest/external-id";
import {
  finalizeIngest,
  ingestEvents,
  openIngestContext,
  type NetworkEvent,
} from "@/lib/ingest/events";
import type { ReminderInsert } from "@/lib/import-engine";
import { reportError } from "@/lib/report-error";
import { ERROR_SOURCES } from "@/lib/error-events";
import { EventPageError, guardedFetchText } from "@/lib/events/guarded-fetch";

const SYNC_WINDOW_PAST_MS = 90 * 86400000;
const SYNC_WINDOW_FUTURE_MS = 60 * 86400000;
export const CALENDAR_SYNC_STALE_MS = 30 * 60 * 1000;

export type CalendarSyncStats = {
  scanned: number;
  matched: number;
  created: number;
  updated: number;
  contactsCreated: number;
  skipped: number;
};

function meetingNote(event: ParsedCalendarEvent) {
  return [
    event.summary ? `Meeting: ${event.summary}` : "Calendar meeting",
    event.location ? `Location: ${event.location}` : "",
    event.description ? event.description.slice(0, 500) : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** A private feed of a busy calendar runs to a few MB; bounded so one cannot exhaust memory. */
const MAX_ICS_BYTES = 10_000_000;

const ICS_CONTENT_TYPES = [
  "text/calendar",
  "text/plain",
  "text/x-vcalendar",
  "application/ics",
  "application/x-ics",
  "application/octet-stream",
] as const;

/**
 * Fetch a subscribed feed. The URL is the user's, and the scheduler re-fetches it with
 * nobody watching, so it goes through `guardedFetchText`: the SSRF guard on every redirect
 * hop, a timeout, and a body cap. A plain `fetch` with `redirect: "follow"` let a feed at
 * `https://attacker/x` 302 to the metadata address or a private host, and echoed the
 * status back in the error.
 *
 * Rows saved before feeds were https-only are upgraded rather than failed.
 */
async function fetchIcs(rawUrl: string) {
  const url = rawUrl.replace(/^(?:webcal|http):\/\//i, "https://");
  let text: string;
  try {
    const page = await guardedFetchText(url, {
      accept: "text/calendar, text/plain;q=0.9, */*;q=0.1",
      contentTypes: ICS_CONTENT_TYPES,
      maxBytes: MAX_ICS_BYTES,
      onOverflow: "error",
      timeoutMs: 20_000,
      wrongTypeMessage: "URL did not return a valid ICS calendar feed",
      errorSource: ERROR_SOURCES.eventProviderSync,
    });
    text = page.text;
  } catch (error) {
    const status = error instanceof EventPageError && /returned (\d{3})/.exec(error.message);
    if (status) throw new Error(icsFetchErrorMessage(url, Number(status[1])));
    throw error;
  }
  if (!/BEGIN:VCALENDAR/i.test(text) && !/BEGIN:VEVENT/i.test(text)) {
    throw new Error("URL did not return a valid ICS calendar feed");
  }
  return text;
}

function icsFetchErrorMessage(url: string, status: number) {
  const isGoogle =
    /calendar\.google\.com/i.test(url) || /google\.com\/calendar/i.test(url);
  const isPublicGoogle = isGoogle && /\/public\/basic\.ics/i.test(url);

  if (status === 404 || status === 403) {
    if (isPublicGoogle) {
      return "Google returned an error for this public calendar link. Use the Secret address in iCal format from Calendar settings → Integrate calendar (…/private-…/basic.ics), not the public address.";
    }
    if (isGoogle) {
      return `Google Calendar feed returned ${status}. Confirm you pasted the Secret address in iCal format, and that the calendar still exists. Public links only work if the calendar is shared publicly.`;
    }
    return `Calendar feed returned ${status}. Check that the ICS URL is still valid and accessible.`;
  }

  return `Calendar feed returned ${status}`;
}


/**
 * Turn parsed calendar events into `NetworkEvent`s and write them through the shared ingest
 * path.
 *
 * This replaced a per-(event, person) writer that cost roughly six statements each — a
 * `findFirst` on interactions, an insert-or-update, a contacts update, an inline
 * `upsertContactEmbedding` (an AI round trip, per row), and a reminders `findFirst`. That is
 * precisely the shape the import engine exists to eliminate, and it is now three statements
 * per batch regardless of size.
 *
 * Two behaviours the old writer had are preserved deliberately, because dropping either would
 * be a silent regression:
 *
 *   - It CREATES contacts (`createsContacts: true`). A meeting is evidence you know someone.
 *     This is the opposite of the one-shot file import, which is annotate-only so that
 *     uploading a calendar cannot push a free user over their contact limit.
 *   - It creates post-meeting follow-ups, now through ingest's `reminders` hook so they are
 *     deduped in bulk instead of one existence check per person.
 *
 * The embedding it used to write inline is now the batch backfill's job: `ingestEvents` flags
 * `embedding_stale_at`, and `PENDING_MEETINGS` in `embedding-backfill.ts` claims
 * `calendar_sync` rows. Those two facts are load-bearing together — see that predicate's
 * comment, which records what happened the last time one calendar source was left out of it.
 */
export async function applyNetworkingEvents(
  userId: string,
  events: ParsedCalendarEvent[],
  options?: {
    selfEmails?: string[];
    createFollowUps?: boolean;
    source?: string;
  }
): Promise<CalendarSyncStats> {
  const selfEmails = options?.selfEmails || [];
  const createFollowUps = options?.createFollowUps !== false;
  const source = options?.source || "calendar_sync";

  const now = Date.now();
  const windowed = events.filter((e) => {
    if (!e.start) return false;
    const t = e.start.getTime();
    return t >= now - SYNC_WINDOW_PAST_MS && t <= now + SYNC_WINDOW_FUTURE_MS;
  });

  // Platform invites are events, not meetings, and they leave this path entirely.
  //
  // This is what gives Apple Calendar (and every other ICS feed) the same discovery Google
  // Calendar gets, without a second implementation: the classifier below already refuses
  // these, so without the hand-off they would simply be dropped on the floor.
  try {
    const candidates = calendarEventsToCandidates(windowed, selfEmails, "ics");
    if (candidates.length > 0) await recordDiscoveryCandidates(userId, candidates);
  } catch (err) {
    // Never allowed to fail the calendar import that triggered it; reported (throttled).
    reportError(err, { where: "job.calendar.discovery", userId, level: "warning" });
  }

  const ctx = await openIngestContext(userId, {
    source,
    createsContacts: true,
    // No `matchConfidence` override: this source CREATES contacts, so it takes the default
    // DUPLICATE_MERGE_CONFIDENCE (0.85). It used to pass 0.6 — the bare-full-name tier —
    // which meant two different people who happened to share a full name were merged into
    // one contact by the next sync, silently and permanently. Name+company and name+title
    // still fold; a name on its own now becomes a review suggestion instead.
    // `calendarAdapter` keeps 0.6 because it only annotates and never creates or merges.
    //
    // `reminders` is set below, once `networkEvents` exists: `seriesFollowUpEligibility` needs
    // the whole batch to pick each series' one eligible occurrence, not just the single event a
    // per-event callback sees.
  });
  // The decision model reads every event the rules would keep before any becomes a contact
  // (decisions/calendar.ts), so the context — which carries the account's engines — opens
  // first. Without Jev the rules decide exactly as before.
  const { decided } = await decideCalendarEvents(ctx.engines, windowed, selfEmails);
  const networkEvents: NetworkEvent[] = [];
  for (const { event, classification } of decided) {
    if (!event.start) continue;
    if (!classification.keep) continue;
    const people = counterpartsOf(event, selfEmails);
    if (people.length === 0) continue;
    networkEvents.push({
      externalIdBase: calendarExternalIdBase(event.uid),
      type: "meeting",
      timestamp: event.start,
      participants: people.map((p) => ({ name: p.name || null, email: p.email || null })),
      summary: event.summary || null,
      notes: meetingNote(event),
    });
  }

  if (createFollowUps) {
    ctx.options.reminders = makePostMeetingReminder(seriesFollowUpEligibility(networkEvents));
  }

  const ingested = await ingestEvents(ctx, networkEvents);
  await finalizeIngest(ctx);

  return {
    scanned: windowed.length,
    matched: ingested.contactsMatched,
    created: ingested.interactionsLogged,
    updated: 0,
    contactsCreated: ingested.contactsCreated,
    skipped: windowed.length - networkEvents.length,
  };
}

/**
 * Which occurrence of each series is allowed to PRODUCE a post-meeting follow-up in THIS batch:
 * the `externalIdBase` of its most recent PAST occurrence (ties broken by whichever is seen
 * last), subject to `postMeetingReminder`'s own 21-day rule. This governs which occurrence is
 * even considered within one sync; `makePostMeetingReminder`'s series-keyed description is what
 * additionally makes the series get at most one follow-up EVER, across every sync that follows —
 * see that function's own comment.
 *
 * `isOccurrenceUid` alone (skip every synthesized occurrence, keep only the series' bare-uid
 * master) is not sufficient: the ICS expansion window is 90 days back, so a series whose
 * DTSTART is more than 90 days old never EMITS its master occurrence at all — every occurrence
 * this function sees for that series carries a suffixed, "occurrence" uid, and the old
 * `isOccurrenceUid` check suppressed every one of them. That satisfies "at most one per series"
 * only in the degenerate, zero-follow-ups sense.
 *
 * A non-recurring event is its own series of one (`seriesUidOf` returns its uid unchanged), so
 * it is trivially always the "most recent" — and only — member of its series, which is what
 * keeps this behaving exactly as before for the non-recurring case.
 */
function seriesFollowUpEligibility(events: NetworkEvent[]): Set<string> {
  const now = Date.now();
  const bestPerSeries = new Map<string, { externalIdBase: string; timestamp: number }>();
  for (const event of events) {
    const timestamp = event.timestamp.getTime();
    if (timestamp > now) continue; // only a PAST occurrence can anchor a follow-up
    const uid = event.externalIdBase.replace(/^cal:/, "");
    const seriesUid = seriesUidOf(uid);
    const current = bestPerSeries.get(seriesUid);
    if (!current || timestamp >= current.timestamp) {
      bestPerSeries.set(seriesUid, { externalIdBase: event.externalIdBase, timestamp });
    }
  }
  return new Set([...bestPerSeries.values()].map((v) => v.externalIdBase));
}

/**
 * A nudge two days after a meeting that has already happened.
 *
 * The description embeds the SERIES uid, not the occurrence uid, and that is what makes this
 * one follow-up per series EVER, not just within one sync batch. Ingest dedupes reminders on
 * `(contactId, description)` against every row already in the table, so a byte-identical
 * description is what lets a later sync's candidate be filtered out rather than inserted again.
 * An ICS subscription resyncs every 30 minutes, and `seriesFollowUpEligibility` picks a new
 * "most recent past occurrence" each time one advances — so keying the description on the
 * OCCURRENCE uid (the previous shape of this function) meant every sync where that eligible
 * occurrence changed minted a byte-DIFFERENT description, and nothing ever pruned the old one:
 * a daily standup accrued a new live reminder every day (up to ~21 at once), a weekly 1:1 one a
 * week forever — the exact pile the eligibility set exists to prevent, just accrued across
 * syncs instead of within one. Keying on `seriesUidOf(uid)` instead makes the SAME series
 * produce the SAME description on every sync, so only the first ever gets past the dedupe check,
 * regardless of which occurrence within the series happens to be eligible when it runs.
 */
function makePostMeetingReminder(eligible: Set<string>) {
  return function postMeetingReminder(
    event: NetworkEvent,
    contactId: string,
    userId: string
  ): ReminderInsert[] {
    if (!eligible.has(event.externalIdBase)) return [];

    // `externalIdBase` is `cal:<uid>`.
    const uid = event.externalIdBase.replace(/^cal:/, "");
    const now = Date.now();
    const eventAt = event.timestamp.getTime();
    // Only for meetings that have happened, and only recently enough to still be worth a nudge.
    if (eventAt > now) return [];
    if ((now - eventAt) / 86400000 > 21) return [];

    const due = new Date(eventAt + 2 * 86400000);
    if (due.getTime() < now) due.setTime(now + 2 * 86400000);

    return [
      {
        userId,
        contactId,
        title: `Follow up after ${event.summary || "meeting"}`,
        description: `You met with them. Event ${seriesUidOf(uid)}`,
        dueDate: due,
        status: "pending",
        reminderType: "post_meeting",
        actionKind: "follow_up",
        createdBy: "calendar_sync",
      },
    ];
  };
}

export async function syncCalendarSubscription(
  userId: string,
  subscriptionId: string
): Promise<CalendarSyncStats> {
  const db = await getDb();
  const sub = await db.query.calendarSubscriptions.findFirst({
    where: and(
      eq(calendarSubscriptions.id, subscriptionId),
      eq(calendarSubscriptions.userId, userId)
    ),
  });
  if (!sub) throw new Error("Calendar subscription not found");
  if (!sub.enabled) throw new Error("Calendar subscription is disabled");

  try {
    const ics = await fetchIcs(sub.icsUrl);
    const parsed = parseIcsEvents(ics);
    // Same window `applyNetworkingEvents` filters to below (SYNC_WINDOW_PAST_MS /
    // SYNC_WINDOW_FUTURE_MS) — expansion must not manufacture occurrences that filter would
    // have dropped anyway, and must not miss ones just inside it.
    const now = Date.now();
    const window = {
      from: new Date(now - SYNC_WINDOW_PAST_MS),
      to: new Date(now + SYNC_WINDOW_FUTURE_MS),
    };
    // Groups by uid first, so a RECURRENCE-ID override VEVENT replaces the occurrence it
    // overrides in place rather than surfacing as a second, independent event — see
    // `expandIcsEvents`'s own comment.
    const events = expandIcsEvents(parsed, window);
    const stats = await applyNetworkingEvents(userId, events, {
      selfEmails: sub.selfEmail ? [sub.selfEmail] : [],
      createFollowUps: true,
      source: "calendar_sync",
    });

    await db
      .update(calendarSubscriptions)
      .set({
        lastSyncedAt: new Date(),
        lastSyncStatus: "ok",
        lastSyncError: null,
        lastSyncStats: stats,
        updatedAt: new Date(),
      })
      .where(eq(calendarSubscriptions.id, sub.id));

    return stats;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Sync failed";
    await db
      .update(calendarSubscriptions)
      .set({
        lastSyncedAt: new Date(),
        lastSyncStatus: "error",
        lastSyncError: message,
        updatedAt: new Date(),
      })
      .where(eq(calendarSubscriptions.id, sub.id));
    throw err;
  }
}

/**
 * Claim ICS subscriptions that are due, across ALL users, for the scheduler.
 *
 * This is what makes an ICS subscription actually ongoing. Until now the only thing that
 * synced one was `syncDueCalendarSubscriptions` firing from `after()` on the `/imports` and
 * `/reminders` page renders — so a user who subscribed a calendar and then never opened
 * either page never synced again, and the feature quietly did nothing for exactly the people
 * who had finished setting it up.
 *
 * The claim rides on `last_synced_at` rather than a lease column: setting it in the same
 * statement that selects makes the row not-due for the next `CALENDAR_SYNC_STALE_MS`, which
 * is both the claim and the schedule. A single statement takes its row locks atomically, so
 * two concurrent runs cannot both take the same subscription — the same argument the import
 * engine's row claim makes.
 *
 * The tradeoff, stated plainly: a subscription whose sync then fails has already had its
 * timestamp moved, so it waits out the stale window before retrying instead of retrying
 * immediately. For a polled ICS URL that is the behaviour you want anyway — a dead URL should
 * not be re-fetched every fifteen minutes.
 */
export async function claimDueCalendarSubscriptions(
  limit: number,
  now: Date = new Date()
): Promise<Array<{ id: string; userId: string }>> {
  const db = await getDb();
  const staleBefore = new Date(now.getTime() - CALENDAR_SYNC_STALE_MS);
  const claimed = await db.execute(sql`
    UPDATE calendar_subscriptions
       SET last_synced_at = ${now}, updated_at = ${now}
     WHERE id IN (
       SELECT id FROM calendar_subscriptions
        WHERE enabled = 1
          AND (last_synced_at IS NULL OR last_synced_at < ${staleBefore})
        ORDER BY last_synced_at NULLS FIRST
        LIMIT ${limit}
     )
    RETURNING id, user_id
  `);
  return rowsOf<{ id: string; user_id: string }>(claimed).map((r) => ({
    id: r.id,
    userId: r.user_id,
  }));
}

export async function syncDueCalendarSubscriptions(userId: string) {
  const db = await getDb();
  const subs = await db.query.calendarSubscriptions.findMany({
    where: and(
      eq(calendarSubscriptions.userId, userId),
      eq(calendarSubscriptions.enabled, 1)
    ),
  });

  const due = subs.filter((s) => {
    if (!s.lastSyncedAt) return true;
    return Date.now() - s.lastSyncedAt.getTime() >= CALENDAR_SYNC_STALE_MS;
  });

  const results: Array<{ id: string; stats?: CalendarSyncStats; error?: string }> =
    [];

  for (const sub of due) {
    try {
      const stats = await syncCalendarSubscription(userId, sub.id);
      results.push({ id: sub.id, stats });
    } catch (err) {
      reportError(err, { where: "job.calendar.sync-due", userId, level: "warning", extra: { subscriptionId: sub.id } });
      results.push({
        id: sub.id,
        error: err instanceof Error ? err.message : "Sync failed",
      });
    }
  }

  return results;
}
