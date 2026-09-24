/**
 * The waitlist's line: who goes first, and how friends move you up.
 *
 * THE RULES (src/lib/interest-list-ticket.ts, `lineSql`): only people still waiting count;
 * anyone with FRONT_WAVE_REFERRALS still-waiting friends is in the front wave, and the
 * front wave goes first; join order decides within and behind it. The referrer hears
 * about it exactly once, on the join that takes them to the line. A friend who leaves (or
 * bounces, which the Resend webhook records the same way) stops counting.
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
  getTicketByShareToken,
  invalidateInterestProof,
  readStandings,
} from "../src/lib/interest-list-ticket";
import { FRONT_WAVE_REFERRALS, MIN_FILL_MS, frontWaveLine } from "../src/lib/interest-list";
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
  // Three early rows, far in the past so nothing another smoke wrote sits between them.
  const seed = (n: number, iso: string) => ({
    email: `${PREFIX}seed${n}@example.test`,
    unsubscribeToken: generateUnsubscribeToken(),
    shareToken: `${PREFIX}share-${n}`,
    welcomePlanet: "earth",
    createdAt: new Date(iso),
  });
  await db.insert(interestListSignups).values([
    seed(1, "2020-01-01T00:00:00Z"),
    seed(2, "2020-01-02T00:00:00Z"),
    seed(3, "2020-01-03T00:00:00Z"),
  ]);
  const pos = async (n: number) => (await getTicketByShareToken(`${PREFIX}share-${n}`))!.position;
  const [p1, p2, p3] = [await pos(1), await pos(2), await pos(3)];
  check("earlier joiners stand earlier", p1 < p2 && p2 < p3, `${p1}, ${p2}, ${p3}`);
  check("consecutive joiners stand next to each other", p2 === p1 + 1 && p3 === p2 + 1);

  console.log("\nthe front wave…");
  const frontWaveMail: string[] = [];
  const ctx = (ip: string): JoinContext => ({
    ip: `smoke-line-${ip}`,
    attribution: null,
    sendWelcome: async () => undefined,
    sendFrontWave: async (email) => {
      frontWaveMail.push(email);
    },
  });
  const base = { website: "", elapsedMs: MIN_FILL_MS + 10 };
  const join = (name: string, ref?: string) =>
    joinInterestListCore({ ...base, email: `${PREFIX}${name}@example.test`, ref }, ctx(name));

  // Seed 3 recruits friends one at a time.
  const ref3 = `${PREFIX}share-3`;
  for (let i = 1; i < FRONT_WAVE_REFERRALS; i += 1) {
    await join(`friend${i}`, ref3);
  }
  const almost = await getTicketByShareToken(ref3);
  check(
    `${FRONT_WAVE_REFERRALS - 1} friends is not yet the front wave`,
    almost?.referrals === FRONT_WAVE_REFERRALS - 1 && !almost.frontWave && almost.position === p3
  );
  check("no front-wave mail before the line is crossed", frontWaveMail.length === 0);

  await join(`friend${FRONT_WAVE_REFERRALS}`, ref3);
  const inFront = await getTicketByShareToken(ref3);
  check(`${FRONT_WAVE_REFERRALS} friends is the front wave`, inFront?.frontWave === true && inFront.referrals === FRONT_WAVE_REFERRALS);
  check("the front wave goes ahead of earlier joiners", inFront!.position < (await pos(1)), `${inFront?.position} vs ${await pos(1)}`);
  check("everyone it passed moved back one", (await pos(1)) === p1 + 1 && (await pos(2)) === p2 + 1);
  check(
    "the referrer is told exactly once",
    frontWaveMail.length === 1 && frontWaveMail[0] === `${PREFIX}seed3@example.test`,
    frontWaveMail.join(",")
  );
  check("the pass says so", frontWaveLine(inFront!.referrals) === "You're in the front wave.");

  await join("friend-extra", ref3);
  check("a fourth friend is not news", frontWaveMail.length === 1);

  console.log("\nleaving…");
  // Two friends leave: the referrer drops back out of the front wave, to their join-order place.
  await db
    .update(interestListSignups)
    .set({ unsubscribedAt: new Date() })
    .where(like(interestListSignups.email, `${PREFIX}friend1@%`));
  await db
    .update(interestListSignups)
    .set({ unsubscribedAt: new Date() })
    .where(like(interestListSignups.email, `${PREFIX}friend2@%`));
  const dropped = await getTicketByShareToken(ref3);
  check("friends who left stop counting", dropped?.referrals === FRONT_WAVE_REFERRALS - 1, String(dropped?.referrals));
  check("below the line again, back in join order", dropped?.frontWave === false && dropped.position === p3, String(dropped?.position));

  // Seed 1 leaves: everyone behind moves up, and their own pass stops resolving.
  await db.update(interestListSignups).set({ unsubscribedAt: new Date() }).where(eq(interestListSignups.email, `${PREFIX}seed1@example.test`));
  check("someone who left has no pass", (await getTicketByShareToken(`${PREFIX}share-1`)) === null);
  check("the people behind them move up", (await pos(2)) === p2 - 1 && (await pos(3)) === p3 - 1);

  console.log("\nthe admin roster agrees…");
  const standings = await readStandings();
  for (const n of [2, 3]) {
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
  }
  const [left] = await db
    .select({ id: interestListSignups.id })
    .from(interestListSignups)
    .where(eq(interestListSignups.email, `${PREFIX}seed1@example.test`));
  check("the roster gives someone who left no place", !standings.has(left!.id));

  await cleanup();
  console.log("\nwaitlist line: all checks passed");
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => null);
  process.exit(1);
});
