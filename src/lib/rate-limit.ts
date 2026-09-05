import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { rateLimitBuckets } from "@/db/schema";

/**
 * Fixed-window rate limiting, per (scope, key), kept in Postgres.
 *
 * Nothing but the extension API was limited: a signed-up user could drive unbounded chat
 * and capture calls through server actions, and the avatar route would resolve LinkedIn
 * photos as fast as a page could ask. Production AI runs on the user's own key, so the
 * cost being bounded here is Orbit's database and its third-party quotas (Microlink,
 * Unavatar), not inference spend.
 *
 * One statement per check — an upsert whose CASE resets the window when it has expired,
 * the same shape `src/lib/extension/http.ts` already used. Memory would be cheaper but a
 * serverless instance's memory is neither shared nor durable.
 */

export class RateLimitedError extends Error {
  readonly retryAfterSec: number;

  constructor(retryAfterSec: number, message = "Too many requests in a row. Give it a moment and try again.") {
    super(message);
    this.name = "RateLimitedError";
    this.retryAfterSec = retryAfterSec;
  }
}

export function isRateLimitedError(err: unknown): err is RateLimitedError {
  return err instanceof RateLimitedError;
}

export type BucketPolicy = { limit: number; windowSec: number };

/** Standard budgets, so call sites read as intent rather than numbers. */
export const RATE_LIMITS = {
  /** `askNetwork` / `/api/chat`: a full retrieval plus a model completion per call. */
  chat: { limit: 20, windowSec: 60 },
  /** Capture parsing, media ingestion and confirmation: each is a model call. */
  capture: { limit: 30, windowSec: 60 },
  /** On-demand LinkedIn photo resolution in `/api/avatars/[contactId]` (Microlink quota). */
  avatarResolve: { limit: 30, windowSec: 60 },
  /**
   * `submitFeedback`: a form post carrying up to three screenshots. Generous per
   * submission, tight per window — this is the largest row a user can create directly,
   * and nobody has anything to say five times in five minutes.
   */
  feedback: { limit: 5, windowSec: 300 },
  /**
   * Public API reads. Generous — a read is one or two indexed queries — but bounded, because
   * these endpoints are reachable by anyone holding a key and a polling integration with a
   * misconfigured interval is the normal failure mode, not an attack.
   */
  apiRead: { limit: 120, windowSec: 60 },
  /** Public API writes. */
  apiWrite: { limit: 60, windowSec: 60 },
  /** Event ingestion. Fewer, because each request carries a batch of up to 500 events. */
  apiIngest: { limit: 30, windowSec: 60 },
  /** MCP tool calls. An agent can loop far faster than a person can click. */
  mcp: { limit: 60, windowSec: 60 },
  /** One provider sync run per connection per window — see `sync-scheduler.ts`. */
  providerSync: { limit: 4, windowSec: 3600 },
} as const satisfies Record<string, BucketPolicy>;

/**
 * Count one request against `scope:key`; throws `RateLimitedError` past `limit` within the
 * window. Returns how many are left. Never fails open on a DB error — a limiter that
 * cannot count should not silently allow — but the caller decides what a throw means.
 */
export async function consumeBucket(
  scope: string,
  key: string,
  policy: BucketPolicy
): Promise<{ remaining: number }> {
  const db = await getDb();
  const bucket = `${scope}:${key}`;
  const expired = sql`now() - ${rateLimitBuckets.windowStartedAt} > interval '${sql.raw(String(policy.windowSec))} seconds'`;

  const [row] = await db
    .insert(rateLimitBuckets)
    .values({ bucket, windowStartedAt: new Date(), count: 1 })
    .onConflictDoUpdate({
      target: rateLimitBuckets.bucket,
      set: {
        windowStartedAt: sql`CASE WHEN ${expired} THEN now() ELSE ${rateLimitBuckets.windowStartedAt} END`,
        count: sql`CASE WHEN ${expired} THEN 1 ELSE ${rateLimitBuckets.count} + 1 END`,
      },
    })
    .returning();

  const count = row?.count ?? 1;
  if (count > policy.limit) {
    const elapsed = row?.windowStartedAt
      ? Math.floor((Date.now() - row.windowStartedAt.getTime()) / 1000)
      : 0;
    throw new RateLimitedError(Math.max(1, policy.windowSec - elapsed));
  }
  return { remaining: Math.max(0, policy.limit - count) };
}
