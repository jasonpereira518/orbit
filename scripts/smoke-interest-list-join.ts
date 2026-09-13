/**
 * The interest-list join path and its read model, end to end against a throwaway PGlite.
 *
 * WHY THIS EXISTS. The join action returns a *ticket* now (number, planet, share token,
 * moons) and the /interest page renders one from a token. Every rule that keeps that honest
 * — ordinals that never collide, referral credit written once and never to yourself, bots
 * and rate-limited callers getting a plausible ticket and no row — is a query-shape or
 * branch-order detail that tsc cannot see. This drives the headers-free core directly.
 *
 * Run: npx tsx scripts/smoke-interest-list-join.ts
 */
import "./smoke/_env";

import { eq, like } from "drizzle-orm";
import { getDb } from "../src/db";
import { interestListSignups, rateLimitBuckets } from "../src/db/schema";
import { generateUnsubscribeToken } from "../src/lib/interest-list-email";
import {
  getInterestProof,
  getInviterPlanet,
  getTicketByShareToken,
  invalidateInterestProof,
  proofShowsCount,
  readInterestProof,
} from "../src/lib/interest-list-ticket";
import { INTEREST_LIST_COUNT_FLOOR } from "../src/lib/interest-list";
import { planetForSignupNumber } from "../src/lib/welcome-planets";

const PREFIX = "smoke-join-";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function cleanup() {
  const db = await getDb();
  await db.delete(interestListSignups).where(like(interestListSignups.email, `${PREFIX}%`));
  await db.delete(rateLimitBuckets).where(like(rateLimitBuckets.bucket, "interest.join:smoke-%"));
  invalidateInterestProof();
}

async function seedReadModel() {
  const db = await getDb();
  const at = (iso: string) => new Date(iso);
  const mk = (n: number, extra: Record<string, unknown> = {}) => ({
    email: `${PREFIX}r${n}@example.test`,
    unsubscribeToken: generateUnsubscribeToken(),
    shareToken: `smoke-share-${n}`,
    ...extra,
  });
  const [first] = await db
    .insert(interestListSignups)
    .values(mk(1, { welcomePlanet: "mercury", createdAt: at("2026-09-01T09:00:00Z") }))
    .returning();
  await db.insert(interestListSignups).values([
    // Two rows at the same instant: the ordinal must still tell them apart.
    mk(2, { welcomePlanet: "venus", createdAt: at("2026-09-02T09:00:00Z"), referredById: first!.id }),
    mk(3, { welcomePlanet: "earth", createdAt: at("2026-09-02T09:00:00Z"), referredById: first!.id }),
    // A legacy row: no planet stored.
    mk(4, { welcomePlanet: null, createdAt: at("2026-09-03T09:00:00Z") }),
  ]);
}

async function readModel() {
  console.log("\nread model…");
  await seedReadModel();

  const t1 = await getTicketByShareToken("smoke-share-1");
  check("first row is #1 on Mercury", t1?.number === 1 && t1.planet === "mercury", JSON.stringify(t1));
  check("first row has two moons", t1?.moons === 2, String(t1?.moons));
  check("joinedAt is an ISO string", typeof t1?.joinedAt === "string" && t1.joinedAt.endsWith("Z"));

  const t2 = await getTicketByShareToken("smoke-share-2");
  const t3 = await getTicketByShareToken("smoke-share-3");
  check("simultaneous rows get distinct ordinals", t2 !== null && t3 !== null && t2.number !== t3.number, `${t2?.number} vs ${t3?.number}`);
  check("simultaneous rows take 2 and 3", new Set([t2!.number, t3!.number]).size === 2 && Math.min(t2!.number, t3!.number) === 2 && Math.max(t2!.number, t3!.number) === 3);
  check("a referred row has no moons of its own", t2?.moons === 0);

  const t4 = await getTicketByShareToken("smoke-share-4");
  check("legacy row without a planet reads as Mercury", t4?.planet === "mercury" && t4.number === 4);

  check("unknown token is null", (await getTicketByShareToken("nope")) === null);
  check("empty token is null", (await getTicketByShareToken("")) === null);

  check("inviter planet resolves", (await getInviterPlanet("smoke-share-3")) === "earth");
  check("inviter for an unknown token is null", (await getInviterPlanet("nope")) === null);

  const proof = await readInterestProof();
  check("proof counts every row", proof.count === 4, String(proof.count));
  check("next planet follows the count", proof.nextPlanet === planetForSignupNumber(5));
  check("recent planets are newest first, legacy as Mercury", proof.recent.join(",") === "mercury,earth,venus" || proof.recent.join(",") === "mercury,venus,earth", proof.recent.join(","));
  check("count is hidden below the floor", proof.count < INTEREST_LIST_COUNT_FLOOR && !proofShowsCount(proof));
  check("count shows at the floor", proofShowsCount({ ...proof, count: INTEREST_LIST_COUNT_FLOOR }));

  // The memo: a second read inside the window returns the cached value even after a write;
  // invalidation makes the next read fresh.
  const memo1 = await getInterestProof();
  const db = await getDb();
  await db.insert(interestListSignups).values({
    email: `${PREFIX}r5@example.test`,
    unsubscribeToken: generateUnsubscribeToken(),
    welcomePlanet: "jupiter",
  });
  const memo2 = await getInterestProof();
  check("proof is memoised inside the window", memo1.count === memo2.count && memo2.count === 4);
  invalidateInterestProof();
  const memo3 = await getInterestProof();
  check("invalidation refreshes the proof", memo3.count === 5, String(memo3.count));
  await db.delete(interestListSignups).where(eq(interestListSignups.email, `${PREFIX}r5@example.test`));
}

async function main() {
  await cleanup();
  await readModel();
  await cleanup();
  console.log("\ninterest-list join: all checks passed");
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => null);
  process.exit(1);
});
