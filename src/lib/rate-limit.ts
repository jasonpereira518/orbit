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
  /**
   * Photos posted from a phone against a scan handoff token.
   *
   * Tighter than `capture`, and deliberately measured over five minutes rather than one:
   * this is the only public write path that spends the account's AI budget, so the shape
   * to bound is a token that leaked being used to run up a bill, not a person taking a
   * burst of photos. A real scan session is a handful of pages and finishes inside the
   * token's ten-minute life.
   */
  captureHandoff: { limit: 12, windowSec: 300 },
  /**
   * One transcribed chunk of a live meeting (`/api/capture/meetings/[id]/chunks`). A
   * recording sends one about every minute; the headroom is for draining a backlog after the
   * connection comes back. Its own bucket so a long call can never starve capture's.
   */
  meetingChunk: { limit: 20, windowSec: 60 },
  /**
   * On-demand photo resolution in `/api/avatars/[contactId]`.
   *
   * Sized for the contacts list, where every photoless row visible resolves itself —
   * 30/min was sized for the old behaviour (one profile page at a time) and 429s within
   * a couple of scrolls. This bucket is a runaway-loop guard, not the quota guard:
   * each upstream source (Unavatar and Microlink are both ~25 lookups a day) is
   * protected by its own process-wide cooldown via `AvatarSourceRateLimitError`.
   */
  avatarResolve: { limit: 120, windowSec: 60 },
  /**
   * `submitFeedback`: a form post carrying up to three screenshots. Generous per
   * submission, tight per window — this is the largest row a user can create directly,
   * and nobody has anything to say five times in five minutes.
   */
  feedback: { limit: 5, windowSec: 300 },
  /**
   * `joinInterestList`: ten submits per ten minutes per IP. Replaces the action's old
   * per-instance Map, which never held across instances. Loose on purpose — several friends
   * behind one NAT clicking one link is the normal case, not an attack. A script probing
   * whether addresses are on the list is what this is for.
   */
  interestJoin: { limit: 10, windowSec: 600 },
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
  /**
   * Reading a public event page (`enrichEventFromUrl`).
   *
   * Tighter than it looks necessary because this is the one action that makes Orbit fetch an
   * address the *user* chose. `net-guard.ts` stops it reaching anything internal; this stops
   * it being used as a high-volume scanner wearing Orbit's network position.
   */
  eventEnrich: { limit: 10, windowSec: 300 },
  /**
   * Background reads of one HOST's event pages, across every user (`enrich-queue.ts`).
   *
   * Scoped to the host rather than the user because the thing being protected is different:
   * `eventEnrich` above stops one user scanning the internet through us, while this stops
   * Orbit as a whole from hammering lu.ma the morning after a big conference, when a
   * thousand users' calendars all sprout the same kind of link at once. No single user is
   * doing anything wrong in that scenario, which is exactly why a per-user bucket cannot see
   * it.
   */
  eventHostFetch: { limit: 60, windowSec: 600 },
  /**
   * The optional "why should I talk to them" line (`explainAttendee`).
   *
   * One model call each, against the user's OWN key, so the limit is about protecting them
   * from a stuck loop rather than protecting us from them — generous enough to explain every
   * name on a normal roster, tight enough that a retry storm cannot run up their bill.
   */
  eventWhy: { limit: 30, windowSec: 3600 },
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
