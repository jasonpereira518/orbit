/**
 * The waitlist feature poll's database half: the tally, who a `?me=` pass or a cookie is,
 * and the vote itself. The pure half (options, ranking) is `waitlist-poll.ts`.
 *
 * Server-only. Imports `@/db` and nothing from `next/*`, so the smoke can drive it outside a
 * request — the action in `actions/waitlist-poll.ts` supplies the IP and the cookie.
 *
 * IDENTITY. `voter_key` is `signup:<id>` when the visitor came in on a `?me=` pass that
 * resolves to a signup, else `cookie:<id>`. A pass beats the cookie, and casting a vote as a
 * signup deletes that browser's cookie-keyed vote in the same call, so voting before and
 * after joining cannot count twice. The two writes are not one transaction (neon-http has
 * none); the upsert lands first, so a failure between them leaves a double count, never a
 * lost vote.
 *
 * THE TALLY is a GROUP BY, memoised per instance for 30 s. A vote invalidates the memo on
 * the instance that took it, and returns a fresh read, so the voter always sees their own
 * vote; another instance lags by up to 30 s, which no visitor can act on.
 */
import { eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { interestListSignups, waitlistPollVotes } from "@/db/schema";
import { SHARE_TOKEN_MAX } from "@/lib/interest-list";
import { RATE_LIMITS, consumeBucket, isRateLimitedError } from "@/lib/rate-limit";
import {
  POLL_ERROR,
  POLL_RATE_LIMITED,
  isPollOptionId,
  isVoterId,
  type PollOptionId,
  type PollResults,
} from "@/lib/waitlist-poll";

const RESULTS_TTL_MS = 30_000;

let resultsMemo: { at: number; value: PollResults } | null = null;

export type VoteInput = { optionId: string; me?: string | null; voterId?: string | null };
export type VoteContext = { ip: string };
export type VoteResult =
  | { ok: true; choice: PollOptionId; results: PollResults; newVoterId: string | null }
  | { ok: false; message: string };

async function readResultsFresh(): Promise<PollResults> {
  const db = await getDb();
  const rows = await db
    .select({ optionId: waitlistPollVotes.optionId, n: sql<number>`count(*)::int` })
    .from(waitlistPollVotes)
    .groupBy(waitlistPollVotes.optionId);
  const counts: Record<string, number> = {};
  for (const row of rows) if (isPollOptionId(row.optionId)) counts[row.optionId] = row.n;
  return { counts };
}

export async function readPollResults(): Promise<PollResults> {
  if (resultsMemo && Date.now() - resultsMemo.at < RESULTS_TTL_MS) return resultsMemo.value;
  const value = await readResultsFresh();
  resultsMemo = { at: Date.now(), value };
  return value;
}

export function invalidatePollResults() {
  resultsMemo = null;
}

/** The signup a share token belongs to, or null for anything that is not a live token. */
async function signupIdForToken(token: string | null | undefined): Promise<string | null> {
  if (!token || token.length > SHARE_TOKEN_MAX) return null;
  const db = await getDb();
  const [row] = await db
    .select({ id: interestListSignups.id })
    .from(interestListSignups)
    .where(eq(interestListSignups.shareToken, token))
    .limit(1);
  return row?.id ?? null;
}

/**
 * What this visitor has already voted for, or null. A signup's own vote wins; failing that,
 * the browser's cookie vote (someone who voted, then joined, has not voted again yet).
 */
export async function readPollChoice(who: {
  me?: string | null;
  voterId?: string | null;
}): Promise<PollOptionId | null> {
  const signupId = await signupIdForToken(who.me);
  const signupKey = signupId ? `signup:${signupId}` : null;
  const cookieKey = isVoterId(who.voterId) ? `cookie:${who.voterId}` : null;
  const keys = [signupKey, cookieKey].filter((k): k is string => k !== null);
  if (keys.length === 0) return null;

  const db = await getDb();
  const rows = await db
    .select({ voterKey: waitlistPollVotes.voterKey, optionId: waitlistPollVotes.optionId })
    .from(waitlistPollVotes)
    .where(inArray(waitlistPollVotes.voterKey, keys));
  const mine = rows.find((r) => r.voterKey === signupKey) ?? rows.find((r) => r.voterKey === cookieKey);
  return mine && isPollOptionId(mine.optionId) ? mine.optionId : null;
}

/** What the page needs to render the poll: the tally and this visitor's choice. */
export async function getPollInitial(who: {
  me?: string | null;
  voterId?: string | null;
}): Promise<{ results: PollResults; choice: PollOptionId | null }> {
  const [results, choice] = await Promise.all([readPollResults(), readPollChoice(who)]);
  return { results, choice };
}

export async function castVoteCore(input: VoteInput, ctx: VoteContext): Promise<VoteResult> {
  const { optionId } = input;
  if (!isPollOptionId(optionId)) return { ok: false, message: POLL_ERROR };

  // A limiter that cannot count must not fail open into the write.
  try {
    await consumeBucket("poll.vote", ctx.ip, RATE_LIMITS.pollVote);
  } catch (err) {
    if (isRateLimitedError(err)) return { ok: false, message: POLL_RATE_LIMITED };
    console.error("[waitlist-poll] limiter failed", err);
    return { ok: false, message: POLL_ERROR };
  }

  try {
    const db = await getDb();
    const signupId = await signupIdForToken(input.me);
    const cookieId = isVoterId(input.voterId) ? input.voterId : null;

    let voterKey: string;
    let newVoterId: string | null = null;
    if (signupId) {
      voterKey = `signup:${signupId}`;
    } else {
      newVoterId = cookieId ? null : crypto.randomUUID();
      voterKey = `cookie:${cookieId ?? newVoterId}`;
    }

    await db
      .insert(waitlistPollVotes)
      .values({ optionId, voterKey, signupId })
      .onConflictDoUpdate({
        target: waitlistPollVotes.voterKey,
        set: { optionId, signupId, updatedAt: new Date() },
      });

    // A signed-up voter's earlier anonymous vote from this browser is theirs: absorb it.
    if (signupId && cookieId) {
      await db.delete(waitlistPollVotes).where(eq(waitlistPollVotes.voterKey, `cookie:${cookieId}`));
    }

    invalidatePollResults();
    return { ok: true, choice: optionId, results: await readPollResults(), newVoterId };
  } catch (err) {
    console.error("[waitlist-poll] vote failed", err);
    return { ok: false, message: POLL_ERROR };
  }
}
