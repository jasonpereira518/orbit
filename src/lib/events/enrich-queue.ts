/**
 * Reading the public pages of events nobody asked us to read yet.
 *
 * Discovery creates events from a calendar line or an email subject: a title, a time, a link.
 * Everything that makes the card worth looking at — the real name, the venue, the cover, the
 * host line-up — is on the page behind that link, and there is no user sitting there to press
 * Refresh. So the pass claims a few events at a time and reads them.
 *
 * ## Being a good citizen is the hard part
 *
 * `enrichEventFromUrl` is rate-limited per user because a user can point it anywhere. This
 * path is different and in one way worse: nobody is misbehaving, and yet the morning after a
 * big conference a thousand users' calendars sprout links to the same host at once. A
 * per-user limit cannot see that shape at all.
 *
 * Four bounds, each covering a different failure:
 *
 *   - `maxFetches` per pass — the invocation has other work to do.
 *   - `perUser` — one person's calendar import cannot monopolise a pass.
 *   - A pause between two requests to the SAME host, so we never burst.
 *   - A global per-host bucket (`eventHostFetch`), which is the only one that sees the
 *     thundering herd above.
 *
 * And the queue itself only ever holds events worth reading: `claimDueEnrichments` prefers
 * what is coming up, because a page for next week's event changes and a page for a party in
 * 2023 does not.
 *
 * No `next/*` imports: this runs from a cron POST with no request.
 */
import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { deadlineReached } from "@/lib/time-budget";
import { RATE_LIMITS, consumeBucket, isRateLimitedError } from "@/lib/rate-limit";
import { enrichEvent } from "@/lib/events/enrich";
import { persistEventCover } from "@/lib/events/cover";
import { attendedEventFilter } from "@/lib/events/store";
import type { FetchPageDeps } from "@/lib/events/guarded-fetch";

/** How long a claimed event is off-limits to another pass. */
const LEASE_MS = 10 * 60 * 1000;
/** Give up after this many reads; the event keeps whatever the discovery source knew. */
const MAX_ATTEMPTS = 3;
/** Politeness gap between two requests to one host inside a single pass. */
const SAME_HOST_GAP_MS = 1_000;

export type EnrichQueueStats = {
  claimed: number;
  enriched: number;
  failed: number;
  /** Skipped because the host had been read too often lately, across all users. */
  hostThrottled: number;
};

export type ClaimedEnrichment = {
  id: string;
  userId: string;
  url: string;
  attempts: number;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Claim the next few events due a read, leasing them so two passes cannot fetch the same page.
 *
 * Ordered by how much the answer is likely to change: an event in the next month first, then
 * everything else by date. A dismissed event is never read — we were told it is not theirs,
 * and fetching its page anyway would be both wasteful and slightly rude — and nor is one the
 * user is only waitlisted for, whose card nobody sees.
 */
export async function claimDueEnrichments(
  limit: number,
  now: Date = new Date()
): Promise<ClaimedEnrichment[]> {
  const db = await getDb();
  const lease = new Date(now.getTime() + LEASE_MS);

  return rowsOf<{ id: string; user_id: string; url: string; enrich_attempts: number }>(
    await db.execute(sql`
      UPDATE events SET enrich_due_at = ${lease}, updated_at = now()
       WHERE id IN (
         SELECT e.id FROM events e
          WHERE e.enrich_due_at IS NOT NULL
            AND e.enrich_due_at <= ${now}
            AND ${attendedEventFilter()}
            AND e.url IS NOT NULL
            AND e.enrich_attempts < ${MAX_ATTEMPTS}
          ORDER BY
            (e.starts_at IS NOT NULL
              AND e.starts_at BETWEEN ${now}::timestamptz - interval '3 days'
                                  AND ${now}::timestamptz + interval '30 days') DESC,
            e.starts_at DESC NULLS LAST,
            e.id
          LIMIT ${limit}
       )
      RETURNING id, user_id, url, enrich_attempts
    `)
  ).map((row) => ({
    id: row.id,
    userId: row.user_id,
    url: row.url,
    attempts: row.enrich_attempts,
  }));
}

/**
 * Record the outcome.
 *
 * Success clears the queue column; failure counts the attempt and backs off, and the third
 * failure stops asking. A page that will not load is usually a page that will never load —
 * the event was taken down, the host went private — and retrying it forever would spend the
 * pass's budget on the least useful rows in the table.
 */
export async function markEnrichResult(
  eventId: string,
  result: { ok: boolean; attempts: number }
): Promise<void> {
  const db = await getDb();
  if (result.ok) {
    await db.execute(sql`
      UPDATE events SET enrich_due_at = NULL, enrich_attempts = 0, updated_at = now()
       WHERE id = ${eventId}
    `);
    return;
  }

  const attempts = result.attempts + 1;
  const retryMinutes = 30 * 2 ** result.attempts;
  await db.execute(sql`
    UPDATE events SET
      enrich_attempts = ${attempts},
      enrich_due_at = ${
        attempts >= MAX_ATTEMPTS
          ? sql`NULL`
          : sql`now() + (${retryMinutes} * interval '1 minute')`
      },
      updated_at = now()
    WHERE id = ${eventId}
  `);
}

/**
 * Fetch and store the pages of everything currently due.
 *
 * Runs LAST in `runSyncPass`, so it inherits whatever budget the calendar and provider work
 * left behind. That ordering is deliberate: those two create and update data the user is
 * waiting on, while this makes existing rows prettier.
 */
export async function runEnrichmentPass(
  options: {
    now?: Date;
    deadline?: number;
    maxFetches?: number;
    perUser?: number;
    deps?: FetchPageDeps;
    /** Injectable so the smoke test does not have to sleep a real second per host. */
    wait?: (ms: number) => Promise<void>;
  } = {}
): Promise<EnrichQueueStats> {
  const now = options.now ?? new Date();
  const maxFetches = options.maxFetches ?? 10;
  const perUser = options.perUser ?? 3;
  const wait = options.wait ?? sleep;
  const stats: EnrichQueueStats = { claimed: 0, enriched: 0, failed: 0, hostThrottled: 0 };

  await requeueUnreadEvents(now).catch(() => {});
  const claimed = await claimDueEnrichments(maxFetches, now);
  stats.claimed = claimed.length;

  const perUserCount = new Map<string, number>();
  const lastHostAt = new Map<string, number>();

  for (const item of claimed) {
    // Checked BEFORE the work, never after: a budget tested afterwards bounds nothing.
    if (options.deadline !== undefined && deadlineReached(options.deadline)) break;

    const used = perUserCount.get(item.userId) ?? 0;
    if (used >= perUser) {
      // Not a failure and not this event's fault, so it must NOT count an attempt — three
      // busy passes would otherwise exhaust the retry budget of an event we never fetched.
      // Released immediately so the next pass takes it rather than waiting out the lease.
      await requeue(item.id, 0).catch(() => {});
      continue;
    }

    const host = hostOf(item.url);
    if (host) {
      try {
        await consumeBucket("global", `eventHost:${host}`, RATE_LIMITS.eventHostFetch);
      } catch (error) {
        if (!isRateLimitedError(error)) throw error;
        stats.hostThrottled++;
        // Try again in a while. The bucket's window is ten minutes; an hour is politely past it.
        await requeue(item.id, 60).catch(() => {});
        continue;
      }
      const last = lastHostAt.get(host);
      if (last !== undefined) {
        const since = Date.now() - last;
        if (since < SAME_HOST_GAP_MS) await wait(SAME_HOST_GAP_MS - since);
      }
      lastHostAt.set(host, Date.now());
    }

    perUserCount.set(item.userId, used + 1);

    try {
      const result = await enrichEvent(item.userId, item.id, item.url, { deps: options.deps });
      await markEnrichResult(item.id, { ok: result.ok, attempts: item.attempts });
      if (result.ok) {
        stats.enriched++;
        await persistDiscoveredCover(item.id).catch(() => {});
      } else {
        stats.failed++;
      }
    } catch {
      // `enrichEvent` already records a user-facing reason on the row; the pass must not stop.
      stats.failed++;
      await markEnrichResult(item.id, { ok: false, attempts: item.attempts }).catch(() => {});
    }
  }

  return stats;
}

/**
 * Everything read before the Luma cover fix. Luma's `og:image` is a share card with the title
 * and an RSVP button printed on it, and every Luma event read before then wears one; a single
 * re-read after this date swaps in the real cover, and the date is what stops an event whose
 * page has no cover of its own from being re-read on every pass for ever.
 */
const LUMA_COVER_FIX_AT = "2026-09-13T00:00:00Z";

/** Per pass, so a large backlog drains over several passes instead of in one UPDATE. */
const REQUEUE_BATCH = 50;

/**
 * Put back on the queue the events that should have been read and never were.
 *
 * Two holes, both about the picture on the card. Discovery used to queue only the first 25
 * events of an import and leave the rest with no page read at all — so no cover, ever. And
 * Luma events read before `LUMA_COVER_FIX_AT` carry the share card as their cover.
 *
 * Only events the user is going to (`attendedEventFilter`): reading the page of an event they
 * were waitlisted for, to decorate a card they will never see, is a fetch for nothing.
 */
export async function requeueUnreadEvents(now: Date = new Date()): Promise<number> {
  const db = await getDb();
  const rows = rowsOf<{ id: string }>(
    await db.execute(sql`
      UPDATE events SET enrich_due_at = ${now}, updated_at = now()
       WHERE id IN (
         SELECT e.id FROM events e
          WHERE e.enrich_due_at IS NULL
            AND e.url IS NOT NULL
            AND e.enrich_attempts < ${MAX_ATTEMPTS}
            AND ${attendedEventFilter()}
            AND (
              (e.enriched_at IS NULL AND e.cover_image_url IS NULL)
              OR (e.cover_source_url LIKE '%lumacdn.com%/event-social/%'
                  AND e.enriched_at < ${LUMA_COVER_FIX_AT}::timestamptz)
            )
          ORDER BY e.starts_at DESC NULLS LAST
          LIMIT ${REQUEUE_BATCH}
       )
      RETURNING id
    `)
  );
  return rows.length;
}

async function requeue(eventId: string, minutes: number): Promise<void> {
  const db = await getDb();
  await db.execute(sql`
    UPDATE events SET enrich_due_at = now() + (${minutes} * interval '1 minute')
     WHERE id = ${eventId}
  `);
}

/**
 * Give a synced event the cover its provider already told us about.
 *
 * `upsertProviderEvent` writes the provider's image to `cover_source_url` and nothing ever
 * promoted it to `cover_image_url`, so every event that arrived by sync rendered as a plain
 * gradient while holding a perfectly good image URL.
 */
async function persistDiscoveredCover(eventId: string): Promise<void> {
  const db = await getDb();
  const rows = rowsOf<{ cover_source_url: string | null }>(
    await db.execute(sql`
      SELECT cover_source_url FROM events
       WHERE id = ${eventId} AND cover_image_url IS NULL AND cover_source_url IS NOT NULL
    `)
  );
  const source = rows[0]?.cover_source_url;
  if (!source) return;

  const cover = await persistEventCover(eventId, source);
  if (!cover?.url) return;
  await db.execute(sql`
    UPDATE events SET cover_image_url = ${cover.url}, cover_source_url = ${cover.sourceUrl},
                      updated_at = now()
     WHERE id = ${eventId}
  `);
}
