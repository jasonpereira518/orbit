import { eq, lt, sql } from "drizzle-orm";
import { UserFacingError } from "@/lib/errors";
import { ipBucketKey, legacyIpBucketKey } from "@/lib/client-ip";
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
 *
 * NEW LIMITS AND THE `ORBIT_NEW_LIMITS` SWITCH (audit M-07, L-22, M-18; FIX_PLAN 3.3)
 *
 * The buckets and caps listed in `NEW_LIMIT_SCOPES` were added after launch and could, in
 * principle, refuse a real person doing something real. They are ENFORCED by default.
 * Setting `ORBIT_NEW_LIMITS=log` makes exactly those scopes log-and-allow instead: the bucket
 * still counts (so the log shows who would have been refused) but nothing is refused. The
 * switch never touches the older buckets above them. The numbers, and why:
 *
 *   draft            30 / 10 min  one AI draft (outreach, recruiter, follow-up, Radar by hand)
 *   brief            20 / 10 min  one model-written contact brief (not the hash/gate skips)
 *   compose          20 / 10 min  "Draft with AI" in the compose window
 *   prep             20 / 10 min  meeting talking points
 *   duplicateHints   30 / 10 min  the duplicate-review page asking the model to rank pairs
 *   dictationToken   12 /  5 min  chat-mic tokens, on top of `speechToken` (M-18)
 *   chatThreadDaily  200 / day    new chat conversations
 *   reminderDaily    500 / day    reminders a person or their agent creates
 *   importDaily      50 / day     import jobs started (files, Gmail/Outlook scans, LinkedIn)
 *   API keys         10 active    `MAX_ACTIVE_API_KEYS`, a count rather than a bucket
 *
 * The daily caps are sized so nobody using Orbit as intended meets them: they exist to stop
 * a loop, a script or a hijacked session from filling the database.
 */

/** What a bucket scope means to the person hitting it, for the error message. */
const BUCKET_LABELS: Record<string, string> = {
  chat: "chat",
  emailSend: "email send",
  emailAttachmentUpload: "attachment upload",
  capture: "capture",
  captureHandoff: "scan",
  captureParts: "capture",
  meetingChunk: "meeting transcription",
  meetingChunkClaim: "meeting transcription",
  meetingCandidates: "calendar lookup",
  calendarWindow: "calendar refresh",
  avatarResolve: "photo lookup",
  avatarFill: "photo fill",
  feedback: "feedback",
  survey: "survey",
  radarRefresh: "Radar refresh",
  knowledgeRefresh: "refresh",
  interestJoin: "sign-up",
  interestProgress: "progress check",
  pollResults: "poll results",
  interestName: "sign-up",
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
  export: "export",
  interestWelcome: "welcome email",
  // Scope strings some call sites pass verbatim (dotted / kebab). Keyed by the literal scope
  // rather than renaming the scope, which would reset those buckets' counters.
  contactForm: "contact form",
  "interest.join": "sign-up",
  "interest.name": "sign-up",
  "interest.welcome": "welcome email",
  "interest.progress": "progress check",
  "avatar.resolve": "photo lookup",
  "lifetime-confirm": "checkout check",
  "poll.vote": "vote",
  "poll.results": "results check",
  "work-history": "work-history lookup",
  "web-research": "research lookup",
  "work-history-background": "background work-history check",
  draft: "AI draft",
  brief: "brief refresh",
  compose: "AI compose",
  prep: "talking points",
  duplicateHints: "duplicate suggestions",
  dictationToken: "dictation",
  chatThreadDaily: "daily new-conversation",
  reminderDaily: "daily reminder",
  importDaily: "daily import",
  "web-search": "monthly web search",
  "web-search-all": "Orbit-wide web search",
};

function formatRetryAfter(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  if (sec < 3_600) return plural(Math.round(sec / 60), "minute");
  if (sec < 2 * 86_400) return plural(Math.round(sec / 3_600), "hour");
  return plural(Math.round(sec / 86_400), "day");
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
   * Any person-to-person email through the outbox (`src/lib/email/outbox.ts`) — Chat,
   * follow-ups, approved assistant drafts, recruiter replies. Outbound and sent from the user's
   * real address, so tighter than anything else here and measured over ten minutes: the shape
   * to bound is a loop or a hijacked session mailing people in bulk, not a person sending a
   * few follow-ups. The daily cap is separate and per plan (`EMAIL_RECIPIENT_DAILY_CAP`).
   */
  emailSend: { limit: 10, windowSec: 600 },
  /**
   * Upload tokens for email attachments. Each is good for one 20 MB file in Orbit's store,
   * so an unmetered route was free file hosting; ten messages' worth of attachments per window.
   */
  emailAttachmentUpload: { limit: 60, windowSec: 600 },
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
   * Reading the user's Google Calendar for the meeting about to be recorded
   * (`getMeetingCandidates`): the setup card on open, and the calendar nudge every ten
   * minutes per tab. Generous for several tabs, and tight enough that a client stuck in a
   * loop cannot burn through the account's Google quota.
   */
  meetingCandidates: { limit: 30, windowSec: 600 },
  /**
   * The app pulse re-reading the user's calendar window (`refreshUserCalendarWindows`): one
   * read per user per ten minutes however many tabs are open. Hitting it means "fresh enough".
   */
  calendarWindow: { limit: 1, windowSec: 600 },
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
  /**
   * The hourly shared-photo fill's own daily cap, so a Microlink key (which skips the shared
   * allowance above) cannot turn it into hundreds of paid calls a day.
   */
  avatarFill: { limit: 60, windowSec: 86_400 },
  /** One user's daily slice of each source, so one large network cannot drain it for all. */
  avatarSourceUser: { limit: 5, windowSec: 86_400 },
  /** People searches per user per day on Orbit's HOSTED Apollo key. Own keys are uncapped. */
  apolloSearch: { limit: 20, windowSec: 86_400 },
  /** Person matches (one Apollo credit each) per user per day on the hosted key. */
  apolloEnrich: { limit: 50, windowSec: 86_400 },
  /**
   * Web-search work-history lookups. They run on the person's own AI key, but each one is
   * several paid searches the person never clicked for — a pasted list or a refresh fans
   * out — so a day has a ceiling that no ordinary use of LinkedIn pulls comes near.
   */
  workHistoryResearch: { limit: 60, windowSec: 86_400 },
  /**
   * Web research on people outside the network (`src/lib/web-research.ts`), per user per
   * day. Cache hits are free; each miss is up to two billed searches on the account's key,
   * and on Orbit's managed key those fees are not in any credit count — this is the cap.
   */
  webResearch: { limit: 30, windowSec: 86_400 },
  /**
   * The hourly sweep's own daily allowance per account (lib/work-history-sweep.ts), keyed
   * per UTC day. Separate from `workHistoryResearch` so background re-checks can never use
   * up the lookups a person clicks for; every sweep search also counts against that one,
   * so the two together still stop at its 60. Was 20: at two searches each that was most of
   * the web-search bill (Oct 2026), spent on contacts nobody had opened.
   */
  workHistoryBackground: { limit: 4, windowSec: 86_400 },
  /**
   * Web SEARCHES (not calls) per account per calendar month, every feature and key together
   * (`src/lib/web-search-budget.ts`). Keyed by month, so the window only has to outlast one.
   */
  webSearchMonthly: { limit: 300, windowSec: 31 * 86_400 },
  /**
   * Web searches across every account per UTC day: half of Anthropic's $190 monthly pool
   * ($95) at $10 per 1,000, paced so a burst cannot spend the month early. See
   * `WEB_SEARCH_DAILY_CEILING`, which smoke-rate-limit keeps this equal to.
   */
  webSearchDaily: { limit: 306, windowSec: 86_400 },
  /** `/contact`: sends on Orbit's own Resend key. Per IP, shared across instances. */
  contactForm: { limit: 3, windowSec: 600 },
  /**
   * `submitFeedback`: a form post carrying up to three screenshots. Generous per
   * submission, tight per window — this is the largest row a user can create directly,
   * and nobody has anything to say five times in five minutes.
   */
  feedback: { limit: 5, windowSec: 300 },
  /** The micro-survey prompt: a handful of tiny writes per person, once in a long while. */
  survey: { limit: 20, windowSec: 3600 },
  // Each refresh re-scores the whole network and may write up to five AI lines on the
  // account's own key. The nightly pass does this anyway; three an hour is plenty by hand.
  radarRefresh: { limit: 3, windowSec: 600 },
  /**
   * `/api/knowledge/refresh`: rebuilding one person's brief on the Knowledge page — a model
   * call on the account's own key, made when a dossier opens on a stale brief or a goal was
   * added since it was judged. Sized for clicking through a list of people after adding a
   * goal, and no more: past it the dossier simply shows what is on file.
   */
  knowledgeRefresh: { limit: 30, windowSec: 300 },
  /**
   * `joinInterestList`: ten submits per ten minutes per IP. Replaces the action's old
   * per-instance Map, which never held across instances. Loose on purpose — several friends
   * behind one NAT clicking one link is the normal case, not an attack. A script probing
   * whether addresses are on the list is what this is for.
   */
  interestJoin: { limit: 10, windowSec: 600 },
  /**
   * `castPollVote`: the waitlist's feature poll. A vote is one upsert, so this is loose on
   * purpose — several friends behind one NAT voting is normal. What it stops is a loop
   * stuffing the tally from one address.
   */
  pollVote: { limit: 20, windowSec: 600 },
  /**
   * `/api/interest-list/progress`: the referral tracker polls it about every 20 seconds
   * while a pass is open, so one visitor is ~15 calls per five minutes. This leaves room
   * for several people behind one NAT, and stops a script sweeping share tokens.
   */
  interestProgress: { limit: 120, windowSec: 300 },
  /**
   * `/api/waitlist-poll/results`: the poll's live tallies, read about every 30 seconds while
   * the tab is visible (~10 calls per five minutes for one visitor). The answer is the
   * instance's 30 s memo, so the limit only stops a script hammering the route.
   */
  pollResults: { limit: 60, windowSec: 300 },
  /**
   * `saveInterestListName`, the join's second step. A person makes one, maybe a couple of
   * corrections' worth; the limit exists to stop a script walking guessed tokens.
   */
  interestName: { limit: 20, windowSec: 600 },
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
  /**
   * NOT a rate limit: a claim on one meeting chunk, keyed `session:seq`, taken before the chunk
   * is transcribed. Two uploads of the same seq (a retry racing a slow first attempt, or two
   * tabs draining an ended meeting) used to both reach Deepgram — the duplicate check ran
   * before the call and the unique insert only after it — so Orbit paid twice. One claim per
   * window, longer than the chunk route's 120s `maxDuration`, so the loser waits out the
   * winner and then finds the stored segment. Released on a failed transcription so a retry
   * is not held back (`releaseBucket`).
   */
  meetingChunkClaim: { limit: 1, windowSec: 150 },
  /**
   * `/api/export`: a streamed read of every table the account owns, up to a 300s function.
   * A person takes a copy now and then; a script or a retry loop re-running it is the shape
   * to stop, since each run pages through the whole network.
   */
  export: { limit: 5, windowSec: 3600 },
  /**
   * The waitlist's welcome email, across EVERY sender (keyed "global"). `interestJoin` is per
   * IP, so a flood of fresh addresses from many IPs still mails each one — from Orbit's
   * domain, at Resend's cost, to inboxes that never asked. 200 an hour is far above a real
   * launch-day hour and well inside the sending plan; past it the row and ticket still land
   * and only the mail is skipped, since the welcome is best-effort by design.
   */
  interestWelcome: { limit: 200, windowSec: 3600 },

  // ── Added for audit M-07 / L-22 / M-18. See NEW_LIMIT_SCOPES and `ORBIT_NEW_LIMITS`. ──

  /**
   * One AI-written draft: an outreach message, a recruiter note, a contact follow-up. Charged
   * per model call, except a campaign's bulk generation, which is one click and is charged
   * one unit per ten drafts (`generateOutreachDraftsBatch`).
   */
  draft: { limit: 30, windowSec: 600 },
  /**
   * A model-written contact brief. Charged only when the model is actually asked: a brief
   * whose input hash matches, or that the decision gate skips, is free. Past the limit the
   * brief on file stays (or the plain-language brief is written), the same as a refused key.
   */
  brief: { limit: 20, windowSec: 600 },
  /** Compose's "Draft with AI". A person writing email clicks it a few times per message. */
  compose: { limit: 20, windowSec: 600 },
  /** Meeting prep talking points: one per meeting opened, with room for regenerating. */
  prep: { limit: 20, windowSec: 600 },
  /**
   * The duplicate-review page ordering its pairs with the model (cached per pair). Past it the
   * page still loads, ordered by rule instead.
   */
  duplicateHints: { limit: 30, windowSec: 600 },
  /**
   * Chat-mic tokens (`/api/speech/token`), on top of the shared `speechToken`. Every mint is
   * now charged one full session to the monthly allowance until the end beacon lowers it, and
   * a dictation session reconnects at most a couple of times, so a dozen per five minutes is
   * several sessions of headroom (M-18).
   */
  dictationToken: { limit: 12, windowSec: 300 },
  /** New chat conversations per user per day (L-22). */
  chatThreadDaily: { limit: 200, windowSec: 86_400 },
  /** Reminders created by hand, through chat or by an agent, per user per day (L-22). */
  reminderDaily: { limit: 500, windowSec: 86_400 },
  /** Import jobs started per user per day (L-22). Each can carry thousands of rows. */
  importDaily: { limit: 50, windowSec: 86_400 },
} as const satisfies Record<string, BucketPolicy>;

/** Active (unrevoked) API keys and MCP URLs per account (L-22). Counted, not bucketed. */
export const MAX_ACTIVE_API_KEYS = 10;

/** The scopes `ORBIT_NEW_LIMITS=log` softens. Never add a pre-existing scope here. */
export const NEW_LIMIT_SCOPES: ReadonlySet<string> = new Set([
  "draft",
  "brief",
  "compose",
  "prep",
  "duplicateHints",
  "dictationToken",
  "chatThreadDaily",
  "reminderDaily",
  "importDaily",
  "apiKeyCap",
]);

/**
 * True when `ORBIT_NEW_LIMITS=log`: the new limits count and log but never refuse. Read per
 * call, so flipping the variable on the host takes effect without a code change.
 */
export function newLimitsLogOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ORBIT_NEW_LIMITS?.trim().toLowerCase() === "log";
}

/**
 * Whether a refusal on `scope` should be logged and let through instead. Exported so the
 * count-based caps (API keys) follow the same switch.
 */
export function softenedLimit(scope: string, key: string, detail: string): boolean {
  if (!NEW_LIMIT_SCOPES.has(scope) || !newLimitsLogOnly()) return false;
  console.warn(`[orbit:rate-limit] ORBIT_NEW_LIMITS=log allowed scope=${scope} key=${key} ${detail}`);
  return true;
}

/**
 * A per-account cap (L-22): "you've made N of these today". A `UserFacingError`, so server
 * actions (`asActionResult`, `friendlyError`) show its words; `routeError` answers it 429.
 */
export class CapReachedError extends UserFacingError {
  /** How `routeError` tells it from a plain `UserFacingError` (class names do not survive minifying). */
  readonly code = "cap_reached" as const;
  readonly retryAfterSec: number | null;
  readonly scope: string;
  constructor(scope: string, message: string, retryAfterSec: number | null = null) {
    super(message);
    this.scope = scope;
    this.retryAfterSec = retryAfterSec;
  }
}

export function isCapReachedError(err: unknown): err is CapReachedError {
  return err instanceof CapReachedError;
}

/**
 * Count one creation against a daily cap; throws `CapReachedError` past it. The caps are the
 * `*Daily` entries of `RATE_LIMITS`, so they share the bucket table, its window and its prune.
 */
export async function consumeDailyCap(
  scope: "chatThreadDaily" | "reminderDaily" | "importDaily",
  userId: string
): Promise<void> {
  try {
    await consumeBucket(scope, userId, RATE_LIMITS[scope]);
  } catch (err) {
    if (!isRateLimitedError(err)) throw err;
    const label = BUCKET_LABELS[scope] ?? scope;
    throw new CapReachedError(
      scope,
      `You've reached the ${label} limit (${RATE_LIMITS[scope].limit}). Try again tomorrow.`,
      err.retryAfterSec
    );
  }
}

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
    // A post-launch limit under `ORBIT_NEW_LIMITS=log`: counted, logged, allowed.
    if (softenedLimit(scope, key, `count=${count} limit=${policy.limit}`)) return { remaining: 0 };
    const elapsed = row?.windowStartedAt
      ? Math.floor((Date.now() - row.windowStartedAt.getTime()) / 1000)
      : 0;
    throw new RateLimitedError(scope, Math.max(1, policy.windowSec - elapsed));
  }
  return { remaining: Math.max(0, policy.limit - count) };
}

/** Forget `scope:key` entirely, e.g. a claim whose work failed and must be retried at once. */
export async function releaseBucket(scope: string, key: string): Promise<void> {
  const db = await getDb();
  await db.delete(rateLimitBuckets).where(sql`${rateLimitBuckets.bucket} = ${`${scope}:${key}`}`);
}

/**
 * `consumeBucket` keyed by a client IP (`ipBucketKey`). The key derivation moved to an HKDF
 * sub-key (audit L-06); a bucket an IP filled under the old one is still live for up to a
 * window, so it is read here and honoured: an IP already over the limit there stays limited.
 * The legacy bucket is only ever read, never written, so it ages out on its own.
 */
export async function consumeIpBucket(scope: string, ip: string, policy: BucketPolicy): Promise<{ remaining: number }> {
  const legacyKey = legacyIpBucketKey(ip);
  const currentKey = ipBucketKey(ip);
  if (legacyKey !== currentKey) {
    const db = await getDb();
    const [legacy] = await db
      .select({ count: rateLimitBuckets.count, windowStartedAt: rateLimitBuckets.windowStartedAt })
      .from(rateLimitBuckets)
      .where(eq(rateLimitBuckets.bucket, `${scope}:${legacyKey}`))
      .limit(1);
    if (legacy) {
      const elapsed = Math.floor((Date.now() - legacy.windowStartedAt.getTime()) / 1000);
      if (elapsed < policy.windowSec && legacy.count >= policy.limit) {
        throw new RateLimitedError(scope, Math.max(1, policy.windowSec - elapsed));
      }
    }
  }
  return consumeBucket(scope, currentKey, policy);
}

/**
 * What `scope:key` has counted in its live window, without counting anything. Zero for a
 * bucket never hit or whose window has expired — the same reset `consumeBucket` applies.
 */
export async function bucketCount(scope: string, key: string, policy: BucketPolicy): Promise<number> {
  const db = await getDb();
  const [row] = await db
    .select({ count: rateLimitBuckets.count, startedAt: rateLimitBuckets.windowStartedAt })
    .from(rateLimitBuckets)
    .where(eq(rateLimitBuckets.bucket, `${scope}:${key}`))
    .limit(1);
  if (!row || Date.now() - row.startedAt.getTime() > policy.windowSec * 1000) return 0;
  return row.count;
}

/**
 * A bucket idle this long is dead weight: `consumeBucket` resets an expired window on the
 * next hit anyway, so deleting one loses nothing. Twice the longest window in `RATE_LIMITS`
 * (the monthly web-search one, 31 days), which `smoke-housekeeping-sweeps` asserts — at the
 * old two days the prune deleted a monthly bucket mid-month and zeroed its count.
 */
export const RATE_LIMIT_BUCKET_RETENTION_MS = 62 * 24 * 60 * 60 * 1000;

/**
 * Drops long-expired buckets; nothing else ever does, so the table grows by one row per
 * (scope, key) forever. Called by the process-stalled sweep. A range scan on
 * `rate_limit_buckets_window_started_idx` (schema 176), not a sequential one.
 */
export async function pruneRateLimitBuckets(now: Date = new Date()): Promise<void> {
  const db = await getDb();
  await db
    .delete(rateLimitBuckets)
    .where(lt(rateLimitBuckets.windowStartedAt, new Date(now.getTime() - RATE_LIMIT_BUCKET_RETENTION_MS)));
}
