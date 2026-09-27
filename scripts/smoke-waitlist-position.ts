/**
 * The waitlist's line: who goes first, and how friends move you up.
 *
 * THE RULES (src/lib/interest-list-ticket.ts, `lineSql`): only people still waiting count;
 * a person's score is their join rank less SPOTS_PER_REFERRAL for each still-waiting friend
 * they referred, and the line is that score, ties to whoever has more referrals. So one
 * friend moves you up exactly 5 places, two friends 10, and nobody goes above first. The
 * referrer hears about it on the join that takes them to a tier (1, 3, 5, 10 friends), once
 * each. A friend who leaves (or bounces, which the Resend webhook records the same way)
 * stops counting.
 *
 * The admin roster reads the same line (`readStandings`), so it is checked against the
 * pass here: two readings of one rule must agree.
 *
 * Run: npx tsx scripts/smoke-waitlist-position.ts
 */
import "./smoke/_env";

import { eq, like } from "drizzle-orm";
import { getDb } from "../src/db";
import { interestListSignups, rateLimitBuckets } from "../src/db/schema";
import { generateUnsubscribeToken } from "../src/lib/interest-list-email";
import {
  getProgressByShareToken,
  getTicketByShareToken,
  invalidateInterestProof,
  readStandings,
} from "../src/lib/interest-list-ticket";
import {
  MIN_FILL_MS,
  REFERRAL_TIERS,
  SPOTS_PER_REFERRAL,
  referralLine,
  spotsEarned,
  tierFor,
} from "../src/lib/interest-list";
import { joinInterestListCore, type JoinContext } from "../src/lib/interest-list-join";

const PREFIX = "smoke-line-";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function cleanup() {
  const db = await getDb();
  await db.delete(interestListSignups).where(like(interestListSignups.email, `${PREFIX}%`));
  await db.delete(rateLimitBuckets).where(like(rateLimitBuckets.bucket, "interest.join:smoke-line-%"));
  invalidateInterestProof();
}

async function main() {
  await cleanup();
  const db = await getDb();

  console.log("line order…");
  // Twelve early rows, far in the past so nothing another smoke wrote sits between them.
  const seed = (n: number) => ({
    email: `${PREFIX}seed${n}@example.test`,
    unsubscribeToken: generateUnsubscribeToken(),
    shareToken: `${PREFIX}share-${n}`,
    welcomePlanet: "earth",
    createdAt: new Date(Date.UTC(2020, 0, n)),
  });
  const SEEDS = 12;
  await db.insert(interestListSignups).values(Array.from({ length: SEEDS }, (_, i) => seed(i + 1)));
  const pos = async (n: number) => (await getTicketByShareToken(`${PREFIX}share-${n}`))!.position;
  const first = await pos(1);
  const before = await Promise.all(Array.from({ length: SEEDS }, (_, i) => pos(i + 1)));
  check(
    "with no referrals, the line is join order",
    before.every((p, i) => p === first + i),
    before.join(",")
  );

  console.log("\nfriends move you up…");
  const tierMail: Array<{ email: string; tier: string }> = [];
  const ctx = (ip: string): JoinContext => ({
    ip: `smoke-line-${ip}`,
    attribution: null,
    sendWelcome: async () => undefined,
    sendTier: async (email, _leave, _planet, _links, tier) => {
      tierMail.push({ email, tier: tier.id });
    },
  });
  const base = { website: "", elapsedMs: MIN_FILL_MS + 10 };
  const join = (name: string, ref?: string) =>
    joinInterestListCore({ ...base, email: `${PREFIX}${name}@example.test`, ref }, ctx(name));

  // The last seed recruits. They start twelfth; five spots per friend.
  const last = SEEDS;
  const refLast = `${PREFIX}share-${last}`;
  const start = first + last - 1;
  check("the recruiter starts last of the seeds", (await pos(last)) === start);

  await join("friend1", refLast);
  const one = await getTicketByShareToken(refLast);
  check("one friend, one referral", one?.referrals === 1);
  check(
    `one friend moves you up exactly ${SPOTS_PER_REFERRAL} places`,
    one?.position === start - SPOTS_PER_REFERRAL,
    `${one?.position} vs ${start - SPOTS_PER_REFERRAL}`
  );
  check(
    "a tie goes to the referrer, so the person they landed on moves back one",
    (await pos(last - SPOTS_PER_REFERRAL)) === start - SPOTS_PER_REFERRAL + 1
  );
  check("people ahead of the landing spot are untouched", (await pos(1)) === first);
  check(
    "the first friend is announced as the move-up tier",
    tierMail.length === 1 && tierMail[0].tier === "move-up" && tierMail[0].email === `${PREFIX}seed${last}@example.test`,
    JSON.stringify(tierMail)
  );

  await join("friend2", refLast);
  const two = await getTicketByShareToken(refLast);
  check("two friends move you up 10", two?.position === start - 2 * SPOTS_PER_REFERRAL, String(two?.position));
  check("the second friend is not news", tierMail.length === 1);

  await join("friend3", refLast);
  const three = await getTicketByShareToken(refLast);
  check("nobody goes above first", three?.position === first, `${three?.position} vs ${first}`);
  check(
    "three friends unlock priority beta, announced once",
    tierMail.length === 2 && tierMail[1].tier === "priority-beta",
    JSON.stringify(tierMail)
  );
  check("the people it passed moved back one", (await pos(1)) === first + 1);

  for (const n of [4, 5, 6, 7, 8, 9, 10]) await join(`friend${n}`, refLast);
  check(
    "each tier is announced exactly once: 1, 3, 5, 10 friends",
    tierMail.map((m) => m.tier).join() === "move-up,priority-beta,early-access,founding",
    tierMail.map((m) => m.tier).join()
  );
  await join("friend11", refLast);
  check("an eleventh friend is not news", tierMail.length === 4);
  const ten = await getTicketByShareToken(refLast);
  check("eleven friends counted", ten?.referrals === 11, String(ten?.referrals));
  check("the tier table reads the same count", tierFor(ten!.referrals).current.id === "founding");
  check("the pass line names the top tier", referralLine(10).includes("founding member"));
  check("spots earned are five a friend", spotsEarned(3) === 3 * SPOTS_PER_REFERRAL);
  check("tiers are 0, 1, 3, 5, 10", REFERRAL_TIERS.map((t) => t.at).join() === "0,1,3,5,10");

  console.log("\nleaving…");
  // Ten friends leave: one is left, and the recruiter is five places up from their join rank again.
  for (let n = 2; n <= 11; n += 1) {
    await db
      .update(interestListSignups)
      .set({ unsubscribedAt: new Date() })
      .where(like(interestListSignups.email, `${PREFIX}friend${n}@%`));
  }
  const dropped = await getTicketByShareToken(refLast);
  check("friends who left stop counting", dropped?.referrals === 1, String(dropped?.referrals));
  check(
    "one friend left: back to five places up",
    dropped?.position === start - SPOTS_PER_REFERRAL,
    String(dropped?.position)
  );

  // Seed 1 leaves: everyone behind moves up, and their own pass stops resolving.
  const beforeLeaving = { p2: await pos(2), last: await pos(last) };
  await db.update(interestListSignups).set({ unsubscribedAt: new Date() }).where(eq(interestListSignups.email, `${PREFIX}seed1@example.test`));
  check("someone who left has no pass", (await getTicketByShareToken(`${PREFIX}share-1`)) === null);
  check(
    "the people behind them move up",
    (await pos(2)) === beforeLeaving.p2 - 1 && (await pos(last)) === beforeLeaving.last - 1
  );

  console.log("\nthe admin roster agrees…");
  const standings = await readStandings();
  for (const n of [2, last]) {
    const [row] = await db
      .select({ id: interestListSignups.id })
      .from(interestListSignups)
      .where(eq(interestListSignups.shareToken, `${PREFIX}share-${n}`));
    const pass = await getTicketByShareToken(`${PREFIX}share-${n}`);
    const standing = standings.get(row!.id);
    check(
      `seed ${n}: roster and pass give the same place`,
      standing?.position === pass?.position && standing?.referrals === pass?.referrals,
      `${standing?.position} vs ${pass?.position}`
    );
    check(
      `seed ${n}: the roster's join rank is the place with no referrals`,
      n === last ? standing!.joinRank > standing!.position : standing?.joinRank === standing?.position,
      `${standing?.joinRank} vs ${standing?.position}`
    );
  }
  const [left] = await db
    .select({ id: interestListSignups.id })
    .from(interestListSignups)
    .where(eq(interestListSignups.email, `${PREFIX}seed1@example.test`));
  check("the roster gives someone who left no place", !standings.has(left!.id));

  console.log("\nthe tracker's poll…");
  const pass2 = await getTicketByShareToken(`${PREFIX}share-2`);
  const snapshot = await getProgressByShareToken(`${PREFIX}share-2`);
  check(
    "progress answers the pass's own count and place",
    snapshot?.referrals === pass2?.referrals && snapshot?.position === pass2?.position,
    JSON.stringify(snapshot)
  );
  check("progress for someone who left is nothing", (await getProgressByShareToken(`${PREFIX}share-1`)) === null);
  check("progress for a made-up token is nothing", (await getProgressByShareToken(`${PREFIX}nobody`)) === null);
  check("progress for an empty token is nothing", (await getProgressByShareToken("")) === null);

  await cleanup();
  console.log("\nwaitlist line: all checks passed");
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => null);
  process.exit(1);
});
