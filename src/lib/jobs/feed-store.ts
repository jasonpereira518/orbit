/**
 * Getting one feed's listings into `job_postings`, and keeping the cursor that makes the
 * next run cheap.
 *
 * ## Incremental on `date_updated`, never `date_posted`
 *
 * A posting can be flipped `active: false`, have its URL corrected, or lose its sponsorship
 * note without `date_posted` moving — and those are exactly the changes worth re-reading.
 * The cursor is therefore the maximum `date_updated` this source has ever ingested, less a
 * skew allowance, because contributors backdate entries and the repo's own scripts rewrite
 * the field. Re-upserting a few hundred unchanged rows is the price, and it is cheap.
 *
 * This is what makes everything downstream affordable: the database cost of a run is
 * O(changed), not O(feed).
 *
 * ## The store is scoped to its source's season
 *
 * A listing whose `terms` do not name the source's season is not stored at all. The feed is
 * season-specific by construction (the repository is "Summer2027-Internships"), so this
 * normally rejects nothing — but a feed that starts carrying next year's roles would
 * otherwise quietly fill the table with postings no matcher will ever look at. The count is
 * returned rather than swallowed, so "the season string stopped matching" shows up as every
 * row being skipped instead of as silence.
 */
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { jobFeedSources, jobPostings, type JobFeedSource, type JobFeedStatus } from "@/db/schema";
import { DEFAULT_JOB_FEEDS, FEED_SKEW_SECONDS } from "@/lib/jobs/feed-sources";
import { jobCompanyBucketKey, jobCompanyKeys } from "@/lib/jobs/company-match";
import type { NormalisedListing } from "@/lib/jobs/listing-schema";

/** Rows per `INSERT`. Large enough to be few round trips, small enough to stay under
 *  Postgres's bind-parameter ceiling with ~16 columns a row. */
const UPSERT_CHUNK = 400;

/**
 * Seed the configured feeds.
 *
 * `onConflictDoNothing`, so a fresh database works with no manual step — and an operator who
 * set `enabled = false` on a source is never re-enabled by a deploy. Only the id is the
 * contract; label, URL and season are editable in place afterwards.
 */
export async function seedJobFeeds(): Promise<void> {
  const db = await getDb();
  await db
    .insert(jobFeedSources)
    .values(DEFAULT_JOB_FEEDS.map((f) => ({ ...f })))
    .onConflictDoNothing({ target: jobFeedSources.id });
}

export async function listEnabledFeeds(): Promise<JobFeedSource[]> {
  const db = await getDb();
  return db.query.jobFeedSources.findMany({ where: eq(jobFeedSources.enabled, true) });
}

export type IngestStats = {
  /** Listings the parse accepted, before any of the filters below. */
  considered: number;
  /** Already at or behind the cursor, allowing for skew. */
  skippedStale: number;
  /** `terms` named a different season. */
  skippedSeason: number;
  upserted: number;
  /** The new cursor: the largest `date_updated` actually written. */
  maxDateUpdated: number;
  /** True when the wall-clock budget ran out with candidates left. */
  truncated: boolean;
};

export type IngestOptions = {
  /** Epoch ms after which no further chunk is started. See `truncated`. */
  deadline?: number;
  now?: Date;
};

function matchesSeason(listing: NormalisedListing, season: string): boolean {
  // An entry with no terms at all is kept: `terms` is optional in the feed's own schema,
  // and dropping a real posting over a missing field is the worse error.
  if (!listing.terms.length) return true;
  const want = season.trim().toLowerCase();
  return listing.terms.some((t) => t.trim().toLowerCase() === want);
}

/**
 * Upsert one feed's listings.
 *
 * Takes an ITERABLE rather than an array on purpose: if this file ever outgrows
 * `JSON.parse`, the documented degradation path is a streaming reader handed to this same
 * function, not an ingest rewrite. Candidates ARE collected into an array internally, and
 * that is load-bearing — they have to be sorted by `date_updated` ascending so that a run
 * cut short by `deadline` leaves the cursor at the last row it actually wrote, with every
 * unprocessed row still ahead of it. Advancing the cursor past unread rows would lose them
 * permanently, which is the one failure this whole module has to avoid.
 */
export async function ingestListings(
  source: Pick<JobFeedSource, "id" | "season" | "lastMaxDateUpdated">,
  listings: Iterable<NormalisedListing>,
  opts: IngestOptions = {}
): Promise<IngestStats> {
  const db = await getDb();
  const now = opts.now ?? new Date();
  const floor = Math.max(0, source.lastMaxDateUpdated - FEED_SKEW_SECONDS);

  const stats: IngestStats = {
    considered: 0,
    skippedStale: 0,
    skippedSeason: 0,
    upserted: 0,
    maxDateUpdated: source.lastMaxDateUpdated,
    truncated: false,
  };

  const candidates: NormalisedListing[] = [];
  for (const listing of listings) {
    stats.considered += 1;
    if (listing.dateUpdatedUnix < floor) {
      stats.skippedStale += 1;
      continue;
    }
    if (!matchesSeason(listing, source.season)) {
      stats.skippedSeason += 1;
      continue;
    }
    candidates.push(listing);
  }
  candidates.sort((a, b) => a.dateUpdatedUnix - b.dateUpdatedUnix);

  for (let i = 0; i < candidates.length; i += UPSERT_CHUNK) {
    if (opts.deadline && Date.now() > opts.deadline) {
      stats.truncated = true;
      break;
    }
    const chunk = candidates.slice(i, i + UPSERT_CHUNK);
    const rows = chunk.map((l) => {
      // Re-derived rather than trusted from `l.companyKey`: the bucket is what the matcher
      // probes, and computing it here means a change to the bucketing rule is one backfill
      // rather than a silent mismatch between what was stored and what is looked up.
      const keys = jobCompanyKeys(l.companyName);
      return {
        sourceId: source.id,
        externalId: l.externalId,
        companyName: l.companyName,
        companyKey: keys ? jobCompanyBucketKey(keys) : l.companyKey,
        companyUrl: l.companyUrl,
        title: l.title,
        url: l.url,
        terms: l.terms,
        locations: l.locations,
        active: l.active,
        isVisible: l.isVisible,
        sponsorship: l.sponsorship,
        datePosted: l.datePosted,
        dateUpdated: l.dateUpdated,
        lastSeenAt: now,
      };
    });

    await db
      .insert(jobPostings)
      .values(rows)
      .onConflictDoUpdate({
        target: [jobPostings.sourceId, jobPostings.externalId],
        set: {
          companyName: sql`excluded.company_name`,
          companyKey: sql`excluded.company_key`,
          companyUrl: sql`excluded.company_url`,
          title: sql`excluded.title`,
          url: sql`excluded.url`,
          terms: sql`excluded.terms`,
          locations: sql`excluded.locations`,
          active: sql`excluded.active`,
          isVisible: sql`excluded.is_visible`,
          sponsorship: sql`excluded.sponsorship`,
          datePosted: sql`excluded.date_posted`,
          dateUpdated: sql`excluded.date_updated`,
          lastSeenAt: sql`excluded.last_seen_at`,
          // `first_seen_at` is deliberately absent: it is when ORBIT first saw the posting,
          // which is not something a later edit to the feed gets to change.
        },
      });

    stats.upserted += rows.length;
    // Only after the write lands. Ascending order makes this the high-water mark of what is
    // actually in the table.
    stats.maxDateUpdated = Math.max(
      stats.maxDateUpdated,
      chunk[chunk.length - 1]!.dateUpdatedUnix
    );
  }

  return stats;
}

export type FeedOutcome = {
  status: JobFeedStatus;
  error?: string | null;
  etag?: string | null;
  lastModified?: string | null;
  bytes?: number | null;
  maxDateUpdated?: number | null;
  /** True for a 200 whose body was read; false for a 304 or a failure. */
  changed: boolean;
};

/**
 * Record what happened to one feed.
 *
 * `consecutive_failures` counts rather than flags: one unreachable run is GitHub's CDN
 * having a moment, and five in a row is something an operator needs to look at. A success
 * of any kind — including a 304 — resets it, because a 304 proves the whole path works.
 */
export async function recordFeedOutcome(sourceId: string, outcome: FeedOutcome): Promise<void> {
  const db = await getDb();
  const ok = outcome.status === "ok" || outcome.status === "not_modified";
  const now = new Date();
  await db
    .update(jobFeedSources)
    .set({
      lastStatus: outcome.status,
      lastError: outcome.error?.slice(0, 500) ?? null,
      lastFetchedAt: now,
      consecutiveFailures: ok ? 0 : sql`${jobFeedSources.consecutiveFailures} + 1`,
      updatedAt: now,
      // Validators are only replaced on a 200. A failed request must not clear the ones
      // that are still valid, or every run after an outage re-downloads the whole file.
      ...(outcome.changed
        ? {
            etag: outcome.etag ?? null,
            lastModified: outcome.lastModified ?? null,
            lastChangedAt: now,
            bytesLastFetched: outcome.bytes ?? null,
          }
        : {}),
      ...(typeof outcome.maxDateUpdated === "number"
        ? { lastMaxDateUpdated: outcome.maxDateUpdated }
        : {}),
    })
    .where(eq(jobFeedSources.id, sourceId));
}
