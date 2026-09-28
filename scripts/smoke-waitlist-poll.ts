/**
 * The waitlist page's feature poll: the option list, how a tally becomes a ranking, and (in
 * the second half of this file) how a vote is written and deduped.
 *
 * THE RULES (src/lib/waitlist-poll.ts, src/lib/waitlist-poll-votes.ts): one vote per voter,
 * changeable; a resolving `?me=` pass beats the cookie and absorbs the cookie's earlier
 * vote so nobody counts twice; below POLL_RESULTS_FLOOR total votes the ranking carries no
 * numbers.
 *
 * Run: npx tsx scripts/smoke-waitlist-poll.ts
 */
import "./smoke/_env";

import {
  POLL_OPTIONS,
  POLL_RESULTS_FLOOR,
  applyVote,
  isPollOptionId,
  isVoterId,
  rankPoll,
} from "../src/lib/waitlist-poll";
import { eq, inArray, like, or } from "drizzle-orm";
import { getDb } from "../src/db";
import { interestListSignups, rateLimitBuckets, waitlistPollVotes } from "../src/db/schema";
import { generateUnsubscribeToken } from "../src/lib/interest-list-email";
import { RATE_LIMITS } from "../src/lib/rate-limit";
import {
  castVoteCore,
  invalidatePollResults,
  readPollChoice,
  readPollResults,
} from "../src/lib/waitlist-poll-votes";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const [A, B, C] = POLL_OPTIONS.map((o) => o.id);

const PREFIX = "smoke-poll-";
const minted: string[] = [];

async function cleanup() {
  const db = await getDb();
  const signups = await db
    .select({ id: interestListSignups.id })
    .from(interestListSignups)
    .where(like(interestListSignups.email, `${PREFIX}%`));
  const ids = signups.map((s) => s.id);
  const keys = minted.map((id) => `cookie:${id}`);
  await db
    .delete(waitlistPollVotes)
    .where(
      or(
        like(waitlistPollVotes.voterKey, `cookie:${PREFIX}%`),
        ids.length ? inArray(waitlistPollVotes.signupId, ids) : undefined,
        keys.length ? inArray(waitlistPollVotes.voterKey, keys) : undefined
      )
    );
  await db.delete(interestListSignups).where(like(interestListSignups.email, `${PREFIX}%`));
  await db.delete(rateLimitBuckets).where(like(rateLimitBuckets.bucket, `poll.vote:${PREFIX}%`));
  invalidatePollResults();
}

async function seedSignup(n: number) {
  const db = await getDb();
  const [row] = await db
    .insert(interestListSignups)
    .values({
      email: `${PREFIX}s${n}@example.test`,
      unsubscribeToken: generateUnsubscribeToken(),
      shareToken: `${PREFIX}share-${n}`,
      welcomePlanet: "earth",
    })
    .returning();
  return { id: row.id, token: `${PREFIX}share-${n}` };
}

const ctx = (n: string) => ({ ip: `${PREFIX}ip-${n}` });
const V1 = `${PREFIX}voter-one-0000`;
const V2 = `${PREFIX}voter-two-0000`;

async function main() {
  console.log("options…");
  check("at least four options", POLL_OPTIONS.length >= 4);
  check("ids are unique", new Set(POLL_OPTIONS.map((o) => o.id)).size === POLL_OPTIONS.length);
  check(
    "no label names the product",
    POLL_OPTIONS.every((o) => !/orbit/i.test(o.label) && !/orbit/i.test(o.blurb))
  );
  check("a listed id is valid", isPollOptionId(A));
  check("an unknown id is not", !isPollOptionId("nope"));
  check("prototype keys are not", !isPollOptionId("__proto__") && !isPollOptionId("constructor"));
  check("non-strings are not", !isPollOptionId(undefined) && !isPollOptionId(3));
  check("voter ids: uuid ok", isVoterId("3f1c2b4e-9a7d-4e0a-8b1c-2d3e4f5a6b7c"));
  check("voter ids: too short rejected", !isVoterId("short"));
  check("voter ids: odd characters rejected", !isVoterId("aaaaaaaaaaaaaaaa'; drop"));

  console.log("\nranking…");
  const empty = rankPoll({ counts: {} });
  check("no votes: authored order", empty.options.map((o) => o.id).join() === POLL_OPTIONS.map((o) => o.id).join());
  check("no votes: total 0, numbers hidden", empty.total === 0 && !empty.showNumbers);
  check("no votes: every bar empty", empty.options.every((o) => o.bar === 0 && o.share === null));

  const few = rankPoll({ counts: { [A]: 1, [B]: 3 } });
  check("ranks by count", few.options[0].id === B && few.options[1].id === A);
  check("rank numbers are 1-based positions", few.options[0].rank === 1 && few.options[1].rank === 2);
  check("below the floor: no shares", few.options.every((o) => o.share === null) && !few.showNumbers);
  check("leader's bar is full, others relative", few.options[0].bar === 1 && Math.abs(few.options[1].bar - 1 / 3) < 1e-9);

  const tie = rankPoll({ counts: { [B]: 2, [A]: 2 } });
  check("a tie keeps authored order", tie.options[0].id === A && tie.options[1].id === B);

  const full = rankPoll({ counts: { [A]: 15, [B]: 10 } });
  check("at the floor: shares appear", POLL_RESULTS_FLOOR === 25 && full.showNumbers);
  check("shares are rounded percentages of the total", full.options[0].share === 60 && full.options[1].share === 40);

  const below = rankPoll({ counts: { [A]: 12, [B]: 12 } });
  const atFloor = rankPoll({ counts: { [A]: 12, [B]: 13 } });
  check("floor boundary: 24 votes hides numbers", below.total === 24 && !below.showNumbers);
  check("floor boundary: 25 votes shows numbers", atFloor.total === 25 && atFloor.showNumbers);

  const rounded = rankPoll({ counts: { [A]: 8, [B]: 17 } });
  check(
    "shares round to whole percents, larger first",
    rounded.options[0].id === B && rounded.options[0].share === 68 && rounded.options[1].share === 32
  );

  const orphan = rankPoll({ counts: { [A]: 1, "retired-option": 99 } });
  check("votes for a retired option are ignored", orphan.total === 1 && orphan.options.length === POLL_OPTIONS.length);

  console.log("\noptimistic update…");
  const base = { counts: { [A]: 1 } };
  check("first vote adds one", applyVote(base, null, B).counts[B] === 1 && applyVote(base, null, B).counts[A] === 1);
  const moved = applyVote({ counts: { [A]: 1, [B]: 2 } }, A, C);
  check("changing a vote moves it", moved.counts[A] === 0 && moved.counts[C] === 1 && moved.counts[B] === 2);
  check("never goes negative", applyVote({ counts: {} }, A, B).counts[A] === 0);
  check("does not mutate its input", base.counts[A] === 1 && !(B in base.counts));

  console.log("\ncasting votes…");
  await cleanup();
  const db = await getDb();
  const rowsFor = async (key: string) =>
    db.select().from(waitlistPollVotes).where(eq(waitlistPollVotes.voterKey, key));

  const first = await castVoteCore({ optionId: A, voterId: V1 }, ctx("a"));
  check("a first vote is recorded", first.ok && first.choice === A && first.results.counts[A] === 1);
  check("a known cookie is not re-minted", first.ok && first.newVoterId === null);
  check("one row under the cookie key", (await rowsFor(`cookie:${V1}`)).length === 1);

  const moved2 = await castVoteCore({ optionId: B, voterId: V1 }, ctx("a"));
  check(
    "changing a vote moves it, not adds it",
    moved2.ok && (moved2.results.counts[A] ?? 0) === 0 && moved2.results.counts[B] === 1
  );
  check("still one row for that voter", (await rowsFor(`cookie:${V1}`)).length === 1);

  await castVoteCore({ optionId: B, voterId: V2 }, ctx("b"));
  check("two voters both count", (await readPollResults()).counts[B] === 2);

  const minted1 = await castVoteCore({ optionId: C }, ctx("c"));
  check("no cookie: the core mints one", minted1.ok && isVoterId(minted1.newVoterId));
  if (minted1.ok && minted1.newVoterId) minted.push(minted1.newVoterId);
  check(
    "the minted id reads back its vote",
    minted1.ok && (await readPollChoice({ voterId: minted1.newVoterId })) === C
  );

  const junk = await castVoteCore({ optionId: C, voterId: "short" }, ctx("c"));
  if (junk.ok && junk.newVoterId) minted.push(junk.newVoterId);
  check("a malformed cookie is treated as absent", junk.ok && isVoterId(junk.newVoterId));

  const bad = await castVoteCore({ optionId: "nope", voterId: V2 }, ctx("b"));
  check("an unknown option is refused", !bad.ok);
  check("…and did not touch the voter's row", (await readPollChoice({ voterId: V2 })) === B);

  console.log("\nsigned-up voters…");
  await cleanup();
  const s1 = await seedSignup(1);
  await castVoteCore({ optionId: A, voterId: V1 }, ctx("d"));
  check("setup: the browser voted anonymously first", (await readPollChoice({ voterId: V1 })) === A);

  const signed = await castVoteCore({ optionId: C, me: s1.token, voterId: V1 }, ctx("d"));
  check("a resolving pass records the vote", signed.ok && signed.choice === C);
  check("…under the signup key, with the signup id", (await rowsFor(`signup:${s1.id}`))[0]?.signupId === s1.id);
  check("…and absorbs the browser's earlier cookie vote", (await rowsFor(`cookie:${V1}`)).length === 0);
  check("…so the tally counts one, not two", signed.ok && (signed.results.counts[A] ?? 0) === 0 && signed.results.counts[C] === 1);
  check("a signed-up voter reads back without the cookie", (await readPollChoice({ me: s1.token })) === C);
  check("…and with a stale cookie the pass wins", (await readPollChoice({ me: s1.token, voterId: V2 })) === C);
  check("signed-up voters are never handed a cookie", signed.ok && signed.newVoterId === null);

  const s2 = await seedSignup(2);
  await castVoteCore({ optionId: B, voterId: V2 }, ctx("e"));
  check(
    "a pass with no vote of its own falls back to the browser's",
    (await readPollChoice({ me: s2.token, voterId: V2 })) === B
  );
  const stray = await castVoteCore({ optionId: A, me: "not-a-real-token", voterId: V2 }, ctx("e"));
  check("an unknown pass falls back to the cookie path", stray.ok && stray.choice === A);
  check("…moving that browser's vote", (await readPollChoice({ voterId: V2 })) === A);

  const odd = await castVoteCore(
    { optionId: A, me: 123 as unknown as string, voterId: V2 },
    ctx("odd")
  );
  check("a non-string pass does not crash the core", odd.ok && odd.choice === A);
  check("…and votes under the cookie key, not a signup", (await rowsFor(`cookie:${V2}`))[0]?.optionId === A);
  check("…readable by cookie", (await readPollChoice({ voterId: V2 })) === A);

  console.log("\nrate limit…");
  await cleanup();
  const rl = ctx("rl");
  let lastOk = true;
  for (let i = 0; i < RATE_LIMITS.pollVote.limit; i++) {
    lastOk = (await castVoteCore({ optionId: A, voterId: V1 }, rl)).ok;
  }
  check("votes up to the limit go through", lastOk);
  const over = await castVoteCore({ optionId: B, voterId: V1 }, rl);
  check("the next is refused with a friendly message", !over.ok && over.message.length > 0);
  check("…and does not change the vote", (await readPollChoice({ voterId: V1 })) === A);

  await cleanup();
  console.log("\nall waitlist-poll checks passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
