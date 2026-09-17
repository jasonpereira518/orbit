/**
 * One pass over every enabled job feed: fetch, parse, ingest, then match.
 *
 * The four stages are separate modules because they fail differently and are worth reading
 * separately — `feed-fetch.ts` (the network and the size cap), `listing-schema.ts` (the
 * per-entry validation), `feed-store.ts` (the upsert and the cursor) and `matcher.ts` (the
 * volume guards). This is only the order they go in and the budget they share.
 *
 * ## The budget, and why matching still runs
 *
 * The route's ceiling is 300s. A first run against a 10 MB file with an empty cursor has to
 * upsert tens of thousands of rows and can reach it, so ingest gets a deadline and stops
 * cleanly at a chunk boundary. That is safe because the cursor only ever advances to what
 * was actually written (see `ingestListings`), so the next run resumes exactly there.
 *
 * `matchJobPostings` runs whatever happened above, including on a 304 and including after a
 * truncated ingest. It reads the TABLE, not this run's listings — so postings ingested last
 * run that nobody was watching then are matched as soon as somebody opens an opportunity at
 * that company, with no backfill pass to write.
 */
import type { CronRunStatus } from "@/lib/cron-runs";
import { ERROR_SOURCES, recordErrorEvent } from "@/lib/error-events";
import type { FetchPageDeps } from "@/lib/events/guarded-fetch";
import { fetchFeedDocument, parseFeedDocument } from "@/lib/jobs/feed-fetch";
import {
  ingestListings,
  listEnabledFeeds,
  recordFeedOutcome,
  seedJobFeeds,
} from "@/lib/jobs/feed-store";
import { parseListings } from "@/lib/jobs/listing-schema";
import { matchJobPostings, type MatchStats } from "@/lib/jobs/matcher";

/**
 * Wall-clock left for ingest, out of the route's 300s.
 *
 * The remainder is headroom for the match pass and the ledger write. Matching is bounded by
 * the opportunity count rather than the feed, so it is fast — but it must not be the thing
 * that gets killed, because a run that ingests and never matches tells nobody anything.
 */
export const INGEST_BUDGET_MS = 210_000;

export type FeedSweepFeedResult = {
  sourceId: string;
  status: string;
  considered: number;
  upserted: number;
  skippedStale: number;
  skippedSeason: number;
  rejected: number;
  drift: boolean;
  truncated: boolean;
};

export type JobFeedSweepStats = {
  feeds: number;
  fetched: number;
  notModified: number;
  failed: number;
  upserted: number;
  truncated: boolean;
  match: MatchStats;
  perFeed: FeedSweepFeedResult[];
};

export type JobFeedSweepDeps = {
  fetchDeps?: FetchPageDeps;
  now?: Date;
  /** Epoch ms at which ingest stops starting new chunks. Defaults to `INGEST_BUDGET_MS`. */
  deadline?: number;
};

export async function runJobFeedSweep(deps: JobFeedSweepDeps = {}): Promise<JobFeedSweepStats> {
  const now = deps.now ?? new Date();
  const deadline = deps.deadline ?? Date.now() + INGEST_BUDGET_MS;

  await seedJobFeeds();
  const feeds = await listEnabledFeeds();

  const stats: JobFeedSweepStats = {
    feeds: feeds.length,
    fetched: 0,
    notModified: 0,
    failed: 0,
    upserted: 0,
    truncated: false,
    match: {
      watchedOpportunities: 0,
      watchedCompanies: 0,
      candidatePostings: 0,
      matchesCreated: 0,
      suggestionsCreated: 0,
      suppressed: 0,
      usersNotified: 0,
    },
    perFeed: [],
  };

  for (const feed of feeds) {
    const result: FeedSweepFeedResult = {
      sourceId: feed.id,
      status: "ok",
      considered: 0,
      upserted: 0,
      skippedStale: 0,
      skippedSeason: 0,
      rejected: 0,
      drift: false,
      truncated: false,
    };

    const fetched = await fetchFeedDocument({
      url: feed.url,
      etag: feed.etag,
      lastModified: feed.lastModified,
      deps: deps.fetchDeps,
    });

    if (fetched.kind === "not_modified") {
      stats.notModified += 1;
      result.status = "not_modified";
      await recordFeedOutcome(feed.id, { status: "not_modified", changed: false, error: null });
      stats.perFeed.push(result);
      continue;
    }

    if (fetched.kind === "failed") {
      stats.failed += 1;
      result.status = fetched.status;
      await recordFeedOutcome(feed.id, {
        status: fetched.status,
        changed: false,
        error: fetched.message,
      });
      // A 304 is the steady state and a refused host is the guard doing its job, so neither
      // reaches here. What does is worth a row: this feed is the only thing the feature
      // learns anything from, and a silent outage looks exactly like a quiet hiring season.
      await recordErrorEvent({
        source: ERROR_SOURCES.jobFeedFetch,
        kind: fetched.status,
        message: fetched.message,
        context: { sourceId: feed.id },
      }).catch(() => {});
      stats.perFeed.push(result);
      continue;
    }

    const parsed = parseFeedDocument(fetched.text);
    if ("error" in parsed) {
      // A body that arrived whole and did not parse is drift, not a network problem — and
      // the validators are deliberately NOT stored, so the next run re-downloads rather
      // than 304ing forever against a document it could never read.
      stats.failed += 1;
      result.status = "schema_drift";
      await recordFeedOutcome(feed.id, {
        status: "schema_drift",
        changed: false,
        error: parsed.error,
      });
      stats.perFeed.push(result);
      continue;
    }

    const listings = parseListings(parsed.doc);
    result.rejected = listings.rejected;
    result.drift = listings.drift;
    if (listings.drift) {
      // Individual bad rows are normal; a fifth of the file failing is a different file.
      // Same reasoning as above — no validators stored, so this re-reads next run.
      stats.failed += 1;
      result.status = "schema_drift";
      await recordFeedOutcome(feed.id, {
        status: "schema_drift",
        changed: false,
        error: `${listings.rejected} of ${listings.total} entries rejected`,
      });
      stats.perFeed.push(result);
      continue;
    }

    const ingested = await ingestListings(feed, listings.entries, { deadline, now });
    stats.fetched += 1;
    stats.upserted += ingested.upserted;
    stats.truncated ||= ingested.truncated;
    result.considered = ingested.considered;
    result.upserted = ingested.upserted;
    result.skippedStale = ingested.skippedStale;
    result.skippedSeason = ingested.skippedSeason;
    result.truncated = ingested.truncated;

    // The cursor advances either way — it is the high-water mark of what was WRITTEN, and
    // a truncated run wrote everything below it. The validators are the opposite: storing
    // them after a partial read would make the next run a 304, and the rest of the file
    // would never be seen. So a truncated run deliberately re-downloads.
    await recordFeedOutcome(feed.id, {
      status: "ok",
      changed: !ingested.truncated,
      error: null,
      etag: fetched.etag,
      lastModified: fetched.lastModified,
      bytes: fetched.bytes,
      maxDateUpdated: ingested.maxDateUpdated,
    });
    stats.perFeed.push(result);
  }

  stats.match = await matchJobPostings({ now });
  return stats;
}

/**
 * `partial` rather than `ok` whenever a feed failed or an ingest was cut short, so the
 * `cron_runs` row distinguishes "nothing to do" from "some of this did not happen". Both
 * look identical in the totals otherwise.
 */
export function sweepRunStatus(stats: JobFeedSweepStats): CronRunStatus {
  if (stats.failed > 0 || stats.truncated) return "partial";
  return "ok";
}
