import { sql } from "drizzle-orm";
import { TIMELINE_DAILY_CONTACT_CAP } from "@/lib/timeline-cost";
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

/** What a bucket scope means to the person hitting it, for the error message. */
const BUCKET_LABELS: Record<string, string> = {
  chat: "chat",
  chatSend: "email send",
  capture: "capture",
  captureHandoff: "scan",
  captureParts: "capture",
  meetingChunk: "meeting transcription",
  avatarResolve: "photo lookup",
  feedback: "feedback",
  interestJoin: "sign-up",
  apiRead: "API read",
  apiWrite: "API write",
  apiIngest: "event import",
  mcp: "MCP tool call",
  mcpWrite: "MCP write",
  providerSync: "sync",
  eventEnrich: "link lookup",
  eventHostFetch: "event lookup",
  eventWhy: "attendee lookup",
  lifetimeConfirm: "checkout check",
  speechToken: "speech transcription",
};

function formatRetryAfter(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  return `${min} minute${min === 1 ? "" : "s"}`;
}

export class RateLimitedError extends Error {
  readonly retryAfterSec: number;
  readonly scope: string;

  constructor(scope: string, retryAfterSec: number) {
    const label = BUCKET_LABELS[scope] ?? scope;
    super(`You've hit the ${label} limit. Try again in ${formatRetryAfter(retryAfterSec)}.`);
    this.name = "RateLimitedError";
    this.scope = scope;
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
  /**
   * A chat draft sent from the user's own Gmail. Outbound and irreversible, so tighter than
   * anything else here and measured over ten minutes: the shape to bound is a loop or a
   * hijacked session mailing people in bulk from a real address, not a person sending a few
   * follow-ups. The daily cap (`CHAT_SEND_DAILY_CAP`) is counted from the claim rows.
   */
  chatSend: { limit: 10, windowSec: 600 },
  /** Capture parsing, media ingestion and confirmation: each is a model call. */
  capture: { limit: 30, windowSec: 60 },
  /**
   * The second and later parts of one capture sent in pieces (`continueJobId` on
   * `/api/capture/jobs`). A capture bigger than one 4.5MB request is several requests, and
   * charging each to `capture` would spend a twelve-page scan's budget four times over.
   * They can only extend a job the first part already paid for, so this bucket only has to
   * stop a runaway client, not price the work.
   */
  captureParts: { limit: 30, windowSec: 60 },
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
   * App-wide daily allowance per quota'd photo source (Unavatar, Microlink), keyed on the
   * source, not the user: both free tiers are ~25 lookups a day for the whole deployment,
   * and the per-Lambda cooldowns cannot see each other.
   */
  avatarSourceShared: { limit: 25, windowSec: 86_400 },
  /** One user's daily slice of each source, so one large network cannot drain it for all. */
  avatarSourceUser: { limit: 5, windowSec: 86_400 },
  /** People searches per user per day on Orbit's HOSTED Apollo key. Own keys are uncapped. */
  apolloSearch: { limit: 20, windowSec: 86_400 },
  /** Person matches (one Apollo credit each) per user per day on the hosted key. */
  apolloEnrich: { limit: 50, windowSec: 86_400 },
  /** `/contact`: sends on Orbit's own Resend key. Per IP, shared across instances. */
  contactForm: { limit: 3, windowSec: 600 },
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
  /**
   * MCP tool calls on a paid plan. An agent can loop far faster than a person can click, and
   * a single chat turn now fans out over several tools — search, then a contact, then a
   * reminder — so the ceiling is per conversation rather than per question.
   */
  mcp: { limit: 120, windowSec: 60 },
  /**
   * MCP tool calls on the free plan. Lower because the connector is free on every plan and
   * this is the one surface an unpaid account can drive continuously. Generous enough that a
   * real conversation never touches it: a person asking questions produces a handful of calls
   * a minute, and a loop producing thirty is a runaway, not a user.
   */
  mcpFree: { limit: 30, windowSec: 60 },
  /**
   * WRITE tool calls over MCP, on top of `mcp`. A write lands in the user's records, and a
   * written note is re-read by Orbit's own chat on every later question — so a looping or
   * injected agent writing fast is the shape to stop, not a person's assistant filing a few
   * notes after a meeting. Counted per call, not per request (see `handleMcpRequest`).
   */
  mcpWrite: { limit: 30, windowSec: 60 },
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
  /**
   * Model-bound LinkedIn timeline conversations per user per day (audit A6). The runner
   * keys the bucket by UTC date as well as user, so the cap resets at midnight UTC rather
   * than 24 hours after the first call; the window only guarantees no reset mid-day.
   */
  timelineBackfillDaily: { limit: TIMELINE_DAILY_CONTACT_CAP, windowSec: 86_400 },
  /**
   * The AI gate asking Stripe whether a just-opened Lifetime checkout has been paid
   * (`src/lib/lifetime-checkout.ts`). One Stripe round trip each, and only ever on a refusal
   * path, so this is a ceiling on an abandoned checkout costing a lookup per AI click.
   */
  lifetimeConfirm: { limit: 6, windowSec: 60 },
  /** One token per connection attempt; a stuck reconnect loop must not mint endlessly. */
  speechToken: { limit: 30, windowSec: 300 },
} as const satisfies Record<string, BucketPolicy>;

/**
 * Count one request against `scope:key`; throws `RateLimitedError` past `limit` within the
 * window. Returns how many are left. Never fails open on a DB error — a limiter that
 * cannot count should not silently allow — but the caller decides what a throw means.
 *
 * `cost` charges several units at once — an MCP request carrying a JSON-RPC batch of five
 * tool calls is five calls, not one request.
 */
export async function consumeBucket(
  scope: string,
  key: string,
  policy: BucketPolicy,
  cost = 1
): Promise<{ remaining: number }> {
  const units = Math.max(1, Math.floor(cost));
  const db = await getDb();
  const bucket = `${scope}:${key}`;
  const expired = sql`now() - ${rateLimitBuckets.windowStartedAt} > interval '${sql.raw(String(policy.windowSec))} seconds'`;

  const [row] = await db
    .insert(rateLimitBuckets)
    .values({ bucket, windowStartedAt: new Date(), count: units })
    .onConflictDoUpdate({
      target: rateLimitBuckets.bucket,
      set: {
        windowStartedAt: sql`CASE WHEN ${expired} THEN now() ELSE ${rateLimitBuckets.windowStartedAt} END`,
        count: sql`CASE WHEN ${expired} THEN ${units} ELSE ${rateLimitBuckets.count} + ${units} END`,
      },
    })
    .returning();

  const count = row?.count ?? units;
  if (count > policy.limit) {
    const elapsed = row?.windowStartedAt
      ? Math.floor((Date.now() - row.windowStartedAt.getTime()) / 1000)
      : 0;
    throw new RateLimitedError(scope, Math.max(1, policy.windowSec - elapsed));
  }
  return { remaining: Math.max(0, policy.limit - count) };
}
