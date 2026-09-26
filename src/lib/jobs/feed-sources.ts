/**
 * Which job feeds Orbit watches, and how their URLs are built.
 *
 * Pure and DB-free. The rows in `job_feed_sources` are the runtime truth; this module is only
 * the seed and the URL shape, so rolling a season forward is an INSERT plus disabling the old
 * row — not a deploy.
 */

/**
 * The branch is `dev`, NOT `main`.
 *
 * Verified against the repository. This is the single most likely thing for somebody to
 * "correct" later, and `main` 404s — the generated listings only exist on `dev`.
 */
export const SIMPLIFY_FEED_BRANCH = "dev";

/** The machine-readable source of truth. The README tables are generated FROM this file. */
export const SIMPLIFY_LISTINGS_PATH = ".github/scripts/listings.json";

export function simplifyFeedUrl(repo: string): string {
  return `https://raw.githubusercontent.com/SimplifyJobs/${repo}/${SIMPLIFY_FEED_BRANCH}/${SIMPLIFY_LISTINGS_PATH}`;
}

export type JobFeedSeed = {
  id: string;
  label: string;
  url: string;
  /** Matched against each listing's `terms`. */
  season: string;
  enabled: boolean;
};

/**
 * Seeded with `onConflictDoNothing` on every sweep, so a fresh database works with no manual
 * step — and an operator who set `enabled = false` is never re-enabled by a deploy.
 */
export const DEFAULT_JOB_FEEDS = [
  {
    id: "simplify.summer2027",
    label: "Summer 2027 Internships (SimplifyJobs)",
    url: simplifyFeedUrl("Summer2027-Internships"),
    season: "Summer 2027",
    enabled: true,
  },
] as const satisfies readonly JobFeedSeed[];

/**
 * A feed whose file has not changed in this long has almost certainly ended its season — the
 * repo stops updating once hiring closes. The same alert is both "time to roll forward" and
 * "somebody renamed the branch", which is why it is one condition rather than two.
 */
export const FEED_STALE_DAYS = 7;

/** Refuse a body larger than this rather than truncating it. See `feed-fetch.ts`. */
export const MAX_FEED_BYTES = 24 * 1024 * 1024;

/**
 * How far back a listing's `date_updated` may be re-read.
 *
 * Contributors backdate entries and the repo's own scripts rewrite these fields, so an
 * exact-cursor comparison silently skips real edits. Three days is cheap insurance: the cost
 * is re-upserting a few hundred unchanged rows.
 */
export const FEED_SKEW_SECONDS = 3 * 24 * 60 * 60;

/**
 * A posting older than this is not "an internship dropping".
 *
 * The feed backfills, and a row that first appears today may have been posted in March. The
 * whole promise of this feature is timeliness, so an old row matching is worse than no row
 * matching — it trains people to ignore the notification.
 */
export const MAX_POSTING_AGE_DAYS = 21;
