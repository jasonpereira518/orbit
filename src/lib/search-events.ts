import { eventId } from "@/lib/product-event-ids";
import { track } from "@/lib/product-events";
import {
  SEARCH_QUERY_LENGTH_CAP,
  SEARCH_RESULT_COUNT_CAP,
  type SEARCH_SURFACES,
} from "@/lib/product-event-schemas";

/**
 * `search_performed`, from the server path that answered a search. Never the query text: its
 * length and the result count, both capped.
 *
 * SAMPLED, because the callers are type-ahead: the command palette asks after a 140ms pause
 * and the contacts page re-renders on each `?q=` change, so one search typed is several
 * requests. The event id is deterministic per (user, surface, 10-second bucket), so a typing
 * burst is ONE event (the first query of the burst wins `ON CONFLICT DO NOTHING`), and the
 * in-memory map skips the repeat inserts on this instance. `track()` writes in `after()`, so
 * none of this is on the request path.
 */
export const SEARCH_SAMPLE_MS = 10_000;

const lastBucket = new Map<string, number>();
const LAST_BUCKET_MAX = 5000;

export function trackSearchPerformed(input: {
  userId: string;
  surface: (typeof SEARCH_SURFACES)[number];
  query: string;
  resultCount: number;
  now?: number;
}): void {
  const length = input.query.trim().length;
  if (length === 0) return;
  const bucket = Math.floor((input.now ?? Date.now()) / SEARCH_SAMPLE_MS);
  const key = `${input.userId}|${input.surface}`;
  if (lastBucket.get(key) === bucket) return;
  if (lastBucket.size >= LAST_BUCKET_MAX) lastBucket.clear();
  lastBucket.set(key, bucket);
  try {
    track(
      "search_performed",
      {
        surface: input.surface,
        query_length: Math.min(length, SEARCH_QUERY_LENGTH_CAP),
        result_count: Math.min(Math.max(0, Math.round(input.resultCount)), SEARCH_RESULT_COUNT_CAP),
      },
      {
        userId: input.userId,
        surface: input.surface === "api" ? "api" : "web",
        id: eventId("search_performed", input.userId, input.surface, bucket),
      }
    );
  } catch {
    // Telemetry never fails a search.
  }
}

/** Test seam. */
export function resetSearchSampling() {
  lastBucket.clear();
}
