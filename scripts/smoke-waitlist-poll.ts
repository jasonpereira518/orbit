/**
 * The waitlist page's feature poll: the option list, the star budget, how a tally becomes a
 * ranking, and (in the second half of this file) how stars are written and deduped.
 *
 * THE RULES (src/lib/waitlist-poll.ts, src/lib/waitlist-poll-votes.ts): everyone spends up to
 * BASE_STARS (+1 per friend who joined through their link, capped) across the options, stacked
 * or spread, changeable; the server counts the friends itself and refuses an over-budget
 * allocation; a vote cast before stars existed reads as the whole base budget on its pick; a
 * resolving `?me=` pass beats the cookie and absorbs the cookie's earlier stars so nobody
 * counts twice; below POLL_RESULTS_FLOOR voters the ranking carries no numbers.
 *
 * Run: npx tsx scripts/smoke-waitlist-poll.ts
 */
import "./smoke/_env";

import {
  BASE_STARS,
  MAX_FRIEND_STARS,
  POLL_OPTIONS,
  POLL_RESULTS_FLOOR,
  allocationTotal,
  applyAllocation,
  isPollOptionId,
  isVoterId,
  legacyAllocation,
  normalizeAllocation,
  rankPoll,
  starBudget,
  topPick,
} from "../src/lib/waitlist-poll";
import { eq, inArray, like, or } from "drizzle-orm";
import { getDb } from "../src/db";
import { interestListSignups, rateLimitBuckets, waitlistPollVotes } from "../src/db/schema";
import { generateUnsubscribeToken } from "../src/lib/interest-list-email";
import { RATE_LIMITS } from "../src/lib/rate-limit";
import {
  invalidatePollResults,
  readPollAllocation,
  readPollResults,
  setStarsCore,
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

/** A row a friend of `referrerId` would leave behind: a signup that joined through their link. */
async function seedFriend(referrerId: string, n: number, unsubscribed = false) {
  const db = await getDb();
  await db.insert(interestListSignups).values({
    email: `${PREFIX}f${referrerId.slice(0, 6)}-${n}@example.test`,
    unsubscribeToken: generateUnsubscribeToken(),
    shareToken: `${PREFIX}fshare-${referrerId.slice(0, 6)}-${n}`,
    welcomePlanet: "mars",
    referredById: referrerId,
    unsubscribedAt: unsubscribed ? new Date() : null,
  });
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

  console.log("\nthe star budget…");
  check("base budget is 3", BASE_STARS === 3 && starBudget(0) === 3);
  check("each friend adds a star", starBudget(1) === 4 && starBudget(5) === 8);
  check("capped at ten friends", MAX_FRIEND_STARS === 10 && starBudget(10) === 13 && starBudget(500) === 13);
  check("nonsense counts as no friends", starBudget(-3) === 3 && starBudget(Number.NaN) === 3);

  console.log("\nallocations…");
  const norm = normalizeAllocation({ [A]: 2, [B]: 0, [C]: -1, nope: 4, events: 1.5, "smart-follow-ups": "3" });
  check("keeps whole positive stars on known ids only", JSON.stringify(norm) === JSON.stringify({ [A]: 2 }), JSON.stringify(norm));
  check("junk in gives nothing out", allocationTotal(normalizeAllocation(null)) === 0 && allocationTotal(normalizeAllocation([1, 2])) === 0 && allocationTotal(normalizeAllocation("x")) === 0);
  check("prototype keys are ignored", allocationTotal(normalizeAllocation(JSON.parse('{"__proto__": 5, "constructor": 2}'))) === 0);
  check("absurd counts are clamped", (normalizeAllocation({ [A]: 1e9 })[A] ?? 0) <= 1000);
  check("total adds up", allocationTotal({ [A]: 2, [B]: 1 }) === 3);
  check("top pick is the most stars", topPick({ [A]: 1, [B]: 2 }) === B);
  check("a tie goes to the option authored first", topPick({ [B]: 2, [A]: 2 }) === A);
  check("no stars, no pick", topPick({}) === null);
  check("a legacy vote is the whole base budget on its pick", allocationTotal(legacyAllocation(B)) === BASE_STARS && legacyAllocation(B)[B] === BASE_STARS);
  check("a legacy vote for a retired option is nothing", allocationTotal(legacyAllocation("retired-option")) === 0);

  console.log("\nranking…");
  const empty = rankPoll({ counts: {}, voters: 0 });
  check("no stars: authored order", empty.options.map((o) => o.id).join() === POLL_OPTIONS.map((o) => o.id).join());
  check("no stars: total 0, numbers hidden", empty.total === 0 && !empty.showNumbers);
  check("no stars: every bar empty", empty.options.every((o) => o.bar === 0 && o.share === null));

  const few = rankPoll({ counts: { [A]: 1, [B]: 3 }, voters: 2 });
  check("ranks by stars", few.options[0].id === B && few.options[1].id === A);
  check("rank numbers are 1-based positions", few.options[0].rank === 1 && few.options[1].rank === 2);
  check("below the floor: no shares", few.options.every((o) => o.share === null) && !few.showNumbers);
  check("leader's bar is full, others relative", few.options[0].bar === 1 && Math.abs(few.options[1].bar - 1 / 3) < 1e-9);

  const tie = rankPoll({ counts: { [B]: 2, [A]: 2 }, voters: 2 });
  check("a tie keeps authored order", tie.options[0].id === A && tie.options[1].id === B);

  const full = rankPoll({ counts: { [A]: 15, [B]: 10 }, voters: POLL_RESULTS_FLOOR });
  check("at the floor: shares appear", POLL_RESULTS_FLOOR === 25 && full.showNumbers);
  check("shares are rounded percentages of the star total", full.options[0].share === 60 && full.options[1].share === 40);

  check("floor counts VOTERS: 24 hides numbers", !rankPoll({ counts: { [A]: 90 }, voters: 24 }).showNumbers);
  check("floor counts VOTERS: 25 shows numbers", rankPoll({ counts: { [A]: 90 }, voters: 25 }).showNumbers);
  check("a few voters with many stars is still hidden", !rankPoll({ counts: { [A]: 39 }, voters: 3 }).showNumbers);

  const rounded = rankPoll({ counts: { [A]: 8, [B]: 17 }, voters: 30 });
  check(
    "shares round to whole percents, larger first",
    rounded.options[0].id === B && rounded.options[0].share === 68 && rounded.options[1].share === 32
  );

  const orphan = rankPoll({ counts: { [A]: 1, "retired-option": 99 }, voters: 30 });
  check("stars on a retired option are ignored", orphan.total === 1 && orphan.options.length === POLL_OPTIONS.length);

  console.log("\noptimistic update…");
  const base = { counts: { [A]: 3 }, voters: 1 };
  const first0 = applyAllocation(base, {}, { [B]: 2, [C]: 1 });
  check("a first allocation adds its stars and a voter", first0.counts[B] === 2 && first0.counts[C] === 1 && first0.counts[A] === 3 && first0.voters === 2);
  const moved = applyAllocation({ counts: { [A]: 3, [B]: 2 }, voters: 2 }, { [A]: 2, [B]: 1 }, { [A]: 1, [C]: 2 });
  check("re-spending moves stars and keeps the voter count", moved.counts[A] === 2 && moved.counts[B] === 1 && moved.counts[C] === 2 && moved.voters === 2);
  const out = applyAllocation({ counts: { [A]: 3 }, voters: 1 }, { [A]: 3 }, {});
  check("taking every star back removes the voter", out.counts[A] === 0 && out.voters === 0);
  check("never goes negative", applyAllocation({ counts: {}, voters: 0 }, { [A]: 2 }, {}).counts[A] === 0 && applyAllocation({ counts: {}, voters: 0 }, { [A]: 2 }, {}).voters === 0);
  check("does not mutate its input", base.counts[A] === 3 && !(B in base.counts) && base.voters === 1);

  console.log("\nwriting stars…");
  await cleanup();
  const db = await getDb();
  const rowsFor = async (key: string) =>
    db.select().from(waitlistPollVotes).where(eq(waitlistPollVotes.voterKey, key));

  const first = await setStarsCore({ allocation: { [A]: 2, [B]: 1 }, voterId: V1 }, ctx("a"));
  check("a first allocation is recorded", first.ok && first.allocation[A] === 2 && first.results.counts[A] === 2 && first.results.counts[B] === 1 && first.results.voters === 1);
  check("…with the base budget for someone with no pass", first.ok && first.budget === 3);
  check("a known cookie is not re-minted", first.ok && first.newVoterId === null);
  const row1 = (await rowsFor(`cookie:${V1}`))[0];
  check("one row under the cookie key, top pick in option_id, stars stored", (await rowsFor(`cookie:${V1}`)).length === 1 && row1.optionId === A && row1.stars?.[A] === 2);

  const moved2 = await setStarsCore({ allocation: { [B]: 3 }, voterId: V1 }, ctx("a"));
  check("re-spending replaces, it does not add", moved2.ok && (moved2.results.counts[A] ?? 0) === 0 && moved2.results.counts[B] === 3 && moved2.results.voters === 1);
  check("still one row for that voter, top pick follows", (await rowsFor(`cookie:${V1}`)).length === 1 && (await rowsFor(`cookie:${V1}`))[0].optionId === B);

  await setStarsCore({ allocation: { [B]: 1 }, voterId: V2 }, ctx("b"));
  const two = await readPollResults();
  check("two voters both count", two.counts[B] === 4 && two.voters === 2);

  const over = await setStarsCore({ allocation: { [A]: 2, [B]: 2 }, voterId: V2 }, ctx("b"));
  check("more than the budget is refused with a friendly message", !over.ok && over.message.length > 0);
  check("…and did not touch the voter's stars", (await readPollAllocation({ voterId: V2 })).allocation[B] === 1);

  const minted1 = await setStarsCore({ allocation: { [C]: 3 } }, ctx("c"));
  check("no cookie: the core mints one", minted1.ok && isVoterId(minted1.newVoterId));
  if (minted1.ok && minted1.newVoterId) minted.push(minted1.newVoterId);
  check(
    "the minted id reads back its stars",
    minted1.ok && (await readPollAllocation({ voterId: minted1.newVoterId })).allocation[C] === 3
  );

  const junk = await setStarsCore({ allocation: { [C]: 1 }, voterId: "short" }, ctx("c"));
  if (junk.ok && junk.newVoterId) minted.push(junk.newVoterId);
  check("a malformed cookie is treated as absent", junk.ok && isVoterId(junk.newVoterId));

  await setStarsCore({ allocation: { [B]: 1 }, voterId: V2 }, ctx("b"));
  const votersBefore = (await readPollResults()).voters;
  const ghost = await setStarsCore({ allocation: { nope: 3 }, voterId: V2 }, ctx("b"));
  check("unknown options are stripped: nothing left means the voter is removed", ghost.ok && allocationTotal(ghost.allocation) === 0);
  check("…their row is gone", (await rowsFor(`cookie:${V2}`)).length === 0);
  check("…and they are out of the voter count", ghost.ok && ghost.results.voters === votersBefore - 1, `${votersBefore} → ${ghost.ok ? ghost.results.voters : "?"}`);

  const cleared = await setStarsCore({ allocation: {}, voterId: V1 }, ctx("a"));
  check("taking every star back deletes the row", cleared.ok && (await rowsFor(`cookie:${V1}`)).length === 0);
  const junkShape = await setStarsCore({ allocation: [1, 2, 3] as unknown, voterId: V1 }, ctx("a"));
  check("a non-object allocation is treated as empty, not a crash", junkShape.ok && allocationTotal(junkShape.allocation) === 0);

  console.log("\nlegacy votes (no stars column)…");
  await cleanup();
  await db.insert(waitlistPollVotes).values({ optionId: C, voterKey: `cookie:${V1}` });
  const legacyRes = await readPollResults();
  check("a legacy row counts as the whole base budget on its pick", legacyRes.counts[C] === BASE_STARS && legacyRes.voters === 1);
  const legacyMine = await readPollAllocation({ voterId: V1 });
  check("…and reads back as such", legacyMine.allocation[C] === BASE_STARS && legacyMine.budget === 3);
  const respend = await setStarsCore({ allocation: { [C]: 1, [A]: 2 }, voterId: V1 }, ctx("l"));
  check("a legacy voter can redistribute", respend.ok && respend.results.counts[C] === 1 && respend.results.counts[A] === 2 && respend.results.voters === 1);

  console.log("\nfriends add stars…");
  await cleanup();
  const host = await seedSignup(7);
  const at3 = await setStarsCore({ allocation: { [A]: 4 }, me: host.token }, ctx("h"));
  check("with no friends, a 4th star is refused", !at3.ok);
  check("…the budget reads as 3", (await readPollAllocation({ me: host.token })).budget === 3);
  await seedFriend(host.id, 1);
  check("one friend joins: the budget reads as 4", (await readPollAllocation({ me: host.token })).budget === 4);
  const at4 = await setStarsCore({ allocation: { [A]: 4 }, me: host.token }, ctx("h"));
  check("…and the 4th star is accepted", at4.ok && at4.budget === 4 && at4.results.counts[A] === 4);
  await seedFriend(host.id, 2, true);
  check("a friend who unsubscribed does not count", (await readPollAllocation({ me: host.token })).budget === 4);
  const claim = await setStarsCore({ allocation: { [A]: 9 }, me: host.token }, ctx("h"));
  check("a client cannot claim stars it has not earned", !claim.ok);
  const anon = await setStarsCore({ allocation: { [B]: 4 }, voterId: V2 }, ctx("i"));
  check("friend stars belong to the pass, not the browser", !anon.ok);
  const floored = await setStarsCore({ allocation: { [B]: 6 }, voterId: V2 }, { ...ctx("i"), budgetFloor: 6 });
  check("the testing seam raises the budget for one call (the localhost simulator uses it)", floored.ok && floored.budget === 6);
  check("…without changing what a real request is allowed", !(await setStarsCore({ allocation: { [B]: 6 }, voterId: V2 }, ctx("i"))).ok);

  console.log("\nsigned-up voters…");
  await cleanup();
  const s1 = await seedSignup(1);
  await setStarsCore({ allocation: { [A]: 3 }, voterId: V1 }, ctx("d"));
  check("setup: the browser spent stars anonymously first", (await readPollAllocation({ voterId: V1 })).allocation[A] === 3);

  const signed = await setStarsCore({ allocation: { [C]: 2, [B]: 1 }, me: s1.token, voterId: V1 }, ctx("d"));
  check("a resolving pass records the stars", signed.ok && signed.allocation[C] === 2);
  check("…under the signup key, with the signup id", (await rowsFor(`signup:${s1.id}`))[0]?.signupId === s1.id);
  check("…and absorbs the browser's earlier cookie stars", (await rowsFor(`cookie:${V1}`)).length === 0);
  check("…so the tally counts one voter, not two", signed.ok && (signed.results.counts[A] ?? 0) === 0 && signed.results.counts[C] === 2 && signed.results.voters === 1);
  check("a signed-up voter reads back without the cookie", (await readPollAllocation({ me: s1.token })).allocation[C] === 2);
  check("…and with a stale cookie the pass wins", (await readPollAllocation({ me: s1.token, voterId: V2 })).allocation[C] === 2);
  check("signed-up voters are never handed a cookie", signed.ok && signed.newVoterId === null);

  const s2 = await seedSignup(2);
  await setStarsCore({ allocation: { [B]: 3 }, voterId: V2 }, ctx("e"));
  check(
    "a pass with no stars of its own falls back to the browser's",
    (await readPollAllocation({ me: s2.token, voterId: V2 })).allocation[B] === 3
  );
  const stray = await setStarsCore({ allocation: { [A]: 3 }, me: "not-a-real-token", voterId: V2 }, ctx("e"));
  check("an unknown pass falls back to the cookie path", stray.ok && stray.allocation[A] === 3);
  check("…replacing that browser's stars", (await readPollAllocation({ voterId: V2 })).allocation[A] === 3);

  const odd = await setStarsCore({ allocation: { [A]: 3 }, me: 123 as unknown as string, voterId: V2 }, ctx("odd"));
  check("a non-string pass does not crash the core", odd.ok && odd.allocation[A] === 3);
  check("…and writes under the cookie key, not a signup", (await rowsFor(`cookie:${V2}`))[0]?.optionId === A);
  check("…readable by cookie", (await readPollAllocation({ voterId: V2 })).allocation[A] === 3);

  console.log("\nrate limit…");
  await cleanup();
  const rl = ctx("rl");
  let lastOk = true;
  for (let i = 0; i < RATE_LIMITS.pollVote.limit; i++) {
    lastOk = (await setStarsCore({ allocation: { [A]: 3 }, voterId: V1 }, rl)).ok;
  }
  check("writes up to the limit go through", lastOk);
  const limited = await setStarsCore({ allocation: { [B]: 3 }, voterId: V1 }, rl);
  check("the next is refused with a friendly message", !limited.ok && limited.message.length > 0);
  check("…and does not change the stars", (await readPollAllocation({ voterId: V1 })).allocation[A] === 3);

  await cleanup();
  console.log("\nall waitlist-poll checks passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
