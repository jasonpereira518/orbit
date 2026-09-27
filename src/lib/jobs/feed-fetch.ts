/**
 * Reading one job feed, cheaply and without telling anybody what we are looking for.
 *
 * ## Nothing about the user leaves the machine
 *
 * This is an unauthenticated GET of a public file. There is no query string, no header and
 * no body carrying anything about anyone. The obvious "optimisation" — asking the source
 * only about the companies we actually care about — would hand a third party every user's
 * target-company list, and must not be built. The whole file comes back and the matching
 * happens here.
 *
 * ## The steady state is a header exchange
 *
 * `listings.json` is over 10 MB and changes a few times a day, while this runs hourly. So
 * the `ETag` and `Last-Modified` from the last 200 are sent back as `If-None-Match` /
 * `If-Modified-Since`, and `raw.githubusercontent.com` (Fastly-fronted) honours both — most
 * runs are a 304 and cost nothing.
 *
 * The GitHub commits API was considered as the change-detector and rejected: unauthenticated
 * `api.github.com` is 60 requests an hour PER SOURCE IP, and Vercel's egress addresses are
 * shared with other customers. That budget is not ours to spend, and exhausting it is
 * invisible until it happens.
 *
 * ## The size cap fails loudly
 *
 * `onOverflow: "error"`, not the default truncation. A truncated JSON document surfaces as a
 * `JSON.parse` column number rather than as "the file grew past the budget" — and worse, a
 * silent truncation reads downstream as "the feed shrank", which would advance the cursor
 * past listings nobody ever saw.
 *
 * ## No database
 *
 * Nothing here writes a row, including on failure — the sweep records the outcome, because
 * the sweep is the thing that already has a connection. That keeps this module drivable by
 * `scripts/smoke-job-feed-fetch.ts` in the `pure` tier with a scripted fetch, which is the
 * only way to exercise a 304, a truncated body and a wrong content type at all.
 */
import { MAX_FEED_BYTES } from "@/lib/jobs/feed-sources";
import type { JobFeedStatus } from "@/db/schema";
import { ERROR_SOURCES } from "@/lib/error-events";
import {
  EventPageError,
  guardedFetchText,
  type FetchPageDeps,
} from "@/lib/events/guarded-fetch";

/**
 * Longer than the page default for one reason: this is a 10 MB download, and 8 seconds
 * aborts it mid-body on any cold connection. Still well inside the route's 300s ceiling.
 */
export const FEED_TIMEOUT_MS = 60_000;

/**
 * `raw.githubusercontent.com` serves `.json` as `text/plain`, so both are allowed. The
 * check still earns its place — it is what stops an HTML error page or a login wall being
 * handed to `JSON.parse` and reported as malformed data.
 */
export const FEED_CONTENT_TYPES = ["application/json", "text/plain", "text/json"] as const;

export type FeedFetchOutcome =
  | {
      kind: "ok";
      text: string;
      /** Validators to store for the next conditional request. Null when the server sent none. */
      etag: string | null;
      lastModified: string | null;
      bytes: number;
    }
  | { kind: "not_modified" }
  | { kind: "failed"; status: JobFeedStatus; message: string };

export type FeedFetchInput = {
  url: string;
  /** From the last 200. Sent back as validators; absent on a first run. */
  etag?: string | null;
  lastModified?: string | null;
  deps?: FetchPageDeps;
  maxBytes?: number;
};

function conditionalHeaders(input: FeedFetchInput): Record<string, string> {
  const headers: Record<string, string> = {};
  if (input.etag) headers["if-none-match"] = input.etag;
  // Sent alongside the ETag rather than instead of it. They are not redundant: a CDN that
  // has dropped the entity tag can still answer the date, and an origin that rewrites the
  // file with identical content updates neither.
  if (input.lastModified) headers["if-modified-since"] = input.lastModified;
  return headers;
}

/**
 * Map a fetch failure onto the `job_feed_sources.last_status` vocabulary.
 *
 * Every branch is a state an operator reads off `/admin/health`, so they are distinguished
 * rather than collapsed into "failed": "the file grew past the budget" and "GitHub is
 * throwing 500s" call for completely different responses, and only one of them is ours.
 */
function statusForError(error: unknown): { status: JobFeedStatus; message: string } {
  if (error instanceof EventPageError) {
    if (error.code === "too_large") return { status: "too_large", message: error.message };
    if (error.code === "http_error") return { status: "http_error", message: error.message };
    if (error.code === "not_html") return { status: "schema_drift", message: error.message };
    return { status: "unreachable", message: error.message };
  }
  return { status: "unreachable", message: (error as Error)?.message ?? "Feed unreachable" };
}

/**
 * One conditional GET of a feed.
 *
 * Never throws: a feed being down is an ordinary outcome that the sweep records and moves
 * past, not an exception that should take the run with it.
 */
export async function fetchFeedDocument(input: FeedFetchInput): Promise<FeedFetchOutcome> {
  const maxBytes = input.maxBytes ?? MAX_FEED_BYTES;
  try {
    const res = await guardedFetchText(input.url, {
      accept: "application/json, text/plain;q=0.9, */*;q=0.1",
      contentTypes: FEED_CONTENT_TYPES,
      wrongTypeMessage: "That feed did not return JSON.",
      headers: conditionalHeaders(input),
      timeoutMs: FEED_TIMEOUT_MS,
      maxBytes,
      onOverflow: "error",
      errorSource: ERROR_SOURCES.jobFeedFetch,
      deps: input.deps,
    });

    if (res.notModified) return { kind: "not_modified" };

    return {
      kind: "ok",
      text: res.text,
      etag: res.headers.get("etag"),
      lastModified: res.headers.get("last-modified"),
      // The decoded length, not `Content-Length`: the header is optional, can lie, and is
      // absent entirely under chunked transfer. This is the number the cap acted on.
      bytes: res.text.length,
    };
  } catch (error) {
    // Returned, never thrown, and never recorded here: a feed being down is an ordinary
    // outcome the sweep writes to `job_feed_sources` and an error row, not an exception.
    return { kind: "failed", ...statusForError(error) };
  }
}

/**
 * `JSON.parse` the whole document.
 *
 * Roughly 10 MB of UTF-8 becomes ~20 MB of UTF-16 plus a 60–120 MB object graph, against a
 * 1–2 GB function: five to ten times the headroom. Streaming JSON would need a dependency
 * the repo does not have, for a problem it does not yet have.
 *
 * The degradation path is kept cheap rather than taken now: `ingestListings` accepts an
 * ITERABLE, so swapping in a streaming reader later is a change to this function and not a
 * rewrite of the ingest. Past `MAX_FEED_BYTES` the fetch above has already failed loudly.
 */
export function parseFeedDocument(text: string): { doc: unknown } | { error: string } {
  try {
    return { doc: JSON.parse(text) as unknown };
  } catch (err) {
    return { error: (err as Error)?.message?.slice(0, 200) ?? "Feed did not parse" };
  }
}
