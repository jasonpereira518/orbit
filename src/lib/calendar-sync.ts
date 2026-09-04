import { and, eq, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { calendarSubscriptions } from "@/db/schema";
import { parseIcsEvents, type ParsedCalendarEvent } from "@/lib/calendar-import";
import { classifyCalendarEvent, counterpartsOf } from "@/lib/calendar-classify";
import { calendarExternalIdBase } from "@/lib/ingest/external-id";
import {
  finalizeIngest,
  ingestEvents,
  openIngestContext,
  type NetworkEvent,
} from "@/lib/ingest/events";
import type { ReminderInsert } from "@/lib/import-engine";

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

async function fetchIcs(url: string) {
  const res = await fetch(url, {
    headers: {
      Accept: "text/calendar, text/plain, */*",
      "User-Agent": "OrbitNetworkingTracker/1.0",
    },
    // Avoid Next fetch caching of private calendar feeds
    cache: "no-store",
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(icsFetchErrorMessage(url, res.status));
  }
  const text = await res.text();
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

  const networkEvents: NetworkEvent[] = [];
  for (const event of windowed) {
    if (!event.start) continue;
    const classification = classifyCalendarEvent(event, selfEmails);
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

  const ctx = await openIngestContext(userId, {
    source,
    createsContacts: true,
    // `calendarAdapter`'s figure: an attendee list makes a name-only match strong evidence.
    matchConfidence: 0.6,
    reminders: createFollowUps ? postMeetingReminder : undefined,
  });
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
 * A nudge two days after a meeting that has already happened.
 *
 * The description embeds the event uid on purpose: ingest dedupes reminders on
 * `(contactId, description)`, so this is what makes a re-sync of the same calendar reproduce
 * a byte-identical candidate that gets filtered out rather than inserted again.
 */
function postMeetingReminder(
  event: NetworkEvent,
  contactId: string,
  userId: string
): ReminderInsert[] {
  const now = Date.now();
  const eventAt = event.timestamp.getTime();
  // Only for meetings that have happened, and only recently enough to still be worth a nudge.
  if (eventAt > now) return [];
  if ((now - eventAt) / 86400000 > 21) return [];

  const due = new Date(eventAt + 2 * 86400000);
  if (due.getTime() < now) due.setTime(now + 2 * 86400000);

  // `externalIdBase` is `cal:<uid>`; the uid is what the old writer put in the description.
  const uid = event.externalIdBase.replace(/^cal:/, "");
  return [
    {
      userId,
      contactId,
      title: `Follow up after ${event.summary || "meeting"}`,
      description: `You met with them. Event ${uid}`,
      dueDate: due,
      status: "pending",
      reminderType: "post_meeting",
      actionKind: "follow_up",
      createdBy: "calendar_sync",
    },
  ];
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
    const events = parseIcsEvents(ics);
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
      results.push({
        id: sub.id,
        error: err instanceof Error ? err.message : "Sync failed",
      });
    }
  }

  return results;
}
