/**
 * The waitlist feature poll's database half: the tally, who a `?me=` pass or a cookie is,
 * and the stars themselves. The pure half (options, budget, ranking) is `waitlist-poll.ts`.
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
 * STARS. A voter spends up to `starBudget(referrals)` stars, `BASE_STARS` plus one per friend
 * who joined through their link. The server owns the budget: it counts the referrals itself
 * and refuses an allocation over it. A row with no `stars` (a vote cast before stars existed)
 * reads as the whole base budget on its `option_id`; `option_id` stays the voter's top pick.
 *
 * THE TALLY reads every row and sums stars in memory (a few thousand small rows at most),
 * memoised per instance for 30 s. A write invalidates the memo on the instance that took it,
 * and returns a fresh read, so the voter always sees their own stars; another instance lags by
 * up to 30 s, which no visitor can act on. The live-results poll reads the same memo.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { interestListSignups, waitlistPollVotes } from "@/db/schema";
import { SHARE_TOKEN_MAX } from "@/lib/interest-list";
import { RATE_LIMITS, consumeBucket, isRateLimitedError } from "@/lib/rate-limit";
import {
  POLL_ERROR,
  POLL_OVER_BUDGET,
  POLL_RATE_LIMITED,
  allocationTotal,
  isVoterId,
  legacyAllocation,
  normalizeAllocation,
  starBudget,
  topPick,
  type PollResults,
  type StarAllocation,
} from "@/lib/waitlist-poll";

const RESULTS_TTL_MS = 30_000;

let resultsMemo: { at: number; value: PollResults } | null = null;

export type StarsInput = { allocation: unknown; me?: string | null; voterId?: string | null };
/**
 * `budgetFloor` is a testing seam, never set from a request: the localhost simulator uses it
 * so a pretend friend can unlock a star the database has no friend row for.
 */
export type VoteContext = { ip: string; budgetFloor?: number };
export type StarsResult =
  | { ok: true; allocation: StarAllocation; budget: number; results: PollResults; newVoterId: string | null }
  | { ok: false; message: string };

/** What one stored row says its voter gave: their stars, or the legacy whole-budget vote. */
function allocationOf(row: { optionId: string; stars: Record<string, number> | null }): StarAllocation {
  const fromStars = row.stars ? normalizeAllocation(row.stars) : {};
  return allocationTotal(fromStars) > 0 ? fromStars : row.stars ? {} : legacyAllocation(row.optionId);
}

async function readResultsFresh(): Promise<PollResults> {
  const db = await getDb();
  const rows = await db
    .select({ optionId: waitlistPollVotes.optionId, stars: waitlistPollVotes.stars })
    .from(waitlistPollVotes);
  const counts: Record<string, number> = {};
  let voters = 0;
  for (const row of rows) {
    const a = allocationOf(row);
    if (allocationTotal(a) === 0) continue;
    voters++;
    for (const [id, n] of Object.entries(a)) counts[id] = (counts[id] ?? 0) + (n ?? 0);
  }
  return { counts, voters };
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
  // Public input: a non-string must never reach the query, whatever the types say.
  if (typeof token !== "string" || !token || token.length > SHARE_TOKEN_MAX) return null;
  const db = await getDb();
  const [row] = await db
    .select({ id: interestListSignups.id })
    .from(interestListSignups)
    .where(eq(interestListSignups.shareToken, token))
    .limit(1);
  return row?.id ?? null;
}

/** Friends still waiting who joined through this signup's link: what earns extra stars. */
async function referralsFor(signupId: string | null): Promise<number> {
  if (!signupId) return 0;
  const db = await getDb();
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(interestListSignups)
    .where(and(eq(interestListSignups.referredById, signupId), isNull(interestListSignups.unsubscribedAt)));
  return row?.n ?? 0;
}

/**
 * What this visitor has already given, and how many stars they may spend. A signup's own
 * stars win; failing that, the browser's cookie stars (someone who voted, then joined, has
 * not voted again yet). The budget is theirs as a signup, the base otherwise.
 */
export async function readPollAllocation(who: {
  me?: string | null;
  voterId?: string | null;
}): Promise<{ allocation: StarAllocation; budget: number }> {
  const signupId = await signupIdForToken(who.me);
  const signupKey = signupId ? `signup:${signupId}` : null;
  const cookieKey = isVoterId(who.voterId) ? `cookie:${who.voterId}` : null;
  const budget = starBudget(await referralsFor(signupId));
  const keys = [signupKey, cookieKey].filter((k): k is string => k !== null);
  if (keys.length === 0) return { allocation: {}, budget };

  const db = await getDb();
  const rows = await db
    .select({
      voterKey: waitlistPollVotes.voterKey,
      optionId: waitlistPollVotes.optionId,
      stars: waitlistPollVotes.stars,
    })
    .from(waitlistPollVotes)
    .where(inArray(waitlistPollVotes.voterKey, keys));
  const mine = rows.find((r) => r.voterKey === signupKey) ?? rows.find((r) => r.voterKey === cookieKey);
  return { allocation: mine ? allocationOf(mine) : {}, budget };
}

/** What the page needs to render the poll: the tally, this visitor's stars and their budget. */
export async function getPollInitial(who: {
  me?: string | null;
  voterId?: string | null;
}): Promise<{ results: PollResults; allocation: StarAllocation; budget: number }> {
  const [results, mine] = await Promise.all([readPollResults(), readPollAllocation(who)]);
  return { results, ...mine };
}

export async function setStarsCore(input: StarsInput, ctx: VoteContext): Promise<StarsResult> {
  const allocation = normalizeAllocation(input.allocation);

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

    // The server counts the friends itself: a client cannot claim stars it has not earned.
    const budget = Math.max(starBudget(await referralsFor(signupId)), ctx.budgetFloor ?? 0);
    if (allocationTotal(allocation) > budget) return { ok: false, message: POLL_OVER_BUDGET };

    let voterKey: string;
    let newVoterId: string | null = null;
    if (signupId) {
      voterKey = `signup:${signupId}`;
    } else {
      newVoterId = cookieId ? null : crypto.randomUUID();
      voterKey = `cookie:${cookieId ?? newVoterId}`;
    }

    const pick = topPick(allocation);
    if (!pick) {
      // Every star taken back: the voter is out of the tally altogether.
      await db.delete(waitlistPollVotes).where(eq(waitlistPollVotes.voterKey, voterKey));
    } else {
      await db
        .insert(waitlistPollVotes)
        .values({ optionId: pick, voterKey, signupId, stars: allocation as Record<string, number> })
        .onConflictDoUpdate({
          target: waitlistPollVotes.voterKey,
          set: { optionId: pick, signupId, stars: allocation as Record<string, number>, updatedAt: new Date() },
        });
    }

    // A signed-up voter's earlier anonymous vote from this browser is theirs: absorb it.
    if (signupId && cookieId) {
      await db.delete(waitlistPollVotes).where(eq(waitlistPollVotes.voterKey, `cookie:${cookieId}`));
    }

    invalidatePollResults();
    return { ok: true, allocation, budget, results: await readPollResults(), newVoterId };
  } catch (err) {
    console.error("[waitlist-poll] stars failed", err);
    return { ok: false, message: POLL_ERROR };
  }
}
