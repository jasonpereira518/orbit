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
import { INTEREST_LIST_COUNT_FLOOR, MIN_FILL_MS } from "../src/lib/interest-list";
import { planetForSignupNumber } from "../src/lib/welcome-planets";
import { joinInterestListCore, type JoinContext } from "../src/lib/interest-list-join";
import type { EmailLinks } from "../src/lib/interest-list-email";

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
  // Counts are asserted as deltas: the smoke PGlite directory is shared, so rows this
  // script did not write can already be there.
  const before = (await readInterestProof()).count;
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
  check("proof counts every row", proof.count === before + 4, String(proof.count));
  check("next planet follows the count", proof.nextPlanet === planetForSignupNumber(before + 5));
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
  check("proof is memoised inside the window", memo1.count === memo2.count && memo2.count === before + 4);
  invalidateInterestProof();
  const memo3 = await getInterestProof();
  check("invalidation refreshes the proof", memo3.count === before + 5, String(memo3.count));
  await db.delete(interestListSignups).where(eq(interestListSignups.email, `${PREFIX}r5@example.test`));
}

async function joinPath() {
  console.log("\njoin path…");
  const db = await getDb();
  // Delta baseline, for the same reason as in `readModel`.
  const before = (await readInterestProof()).count;
  const sent: Array<{ email: string; links: EmailLinks }> = [];
  const ctx = (ip: string): JoinContext => ({
    ip: `smoke-${ip}`,
    attribution: { referrer: "reddit.com", utmSource: "reddit", utmMedium: null, utmCampaign: null, landingPath: "/interest" },
    sendWelcome: async (email, _unsub, _planet, links) => {
      sent.push({ email, links });
    },
  });
  const base = { website: "", elapsedMs: MIN_FILL_MS + 10 };
  const rowFor = async (email: string) =>
    (await db.select().from(interestListSignups).where(eq(interestListSignups.email, email)))[0];

  // --- new join
  const a = await joinInterestListCore({ ...base, email: `${PREFIX}A@Example.test` }, ctx("a"));
  check("new join is ok", a.ok);
  if (!a.ok) return;
  const rowA = await rowFor(`${PREFIX}a@example.test`);
  check("email is normalised on insert", Boolean(rowA));
  check("ticket carries the stored share token", rowA?.shareToken === a.ticket.shareToken);
  check("ticket planet matches the stored one", rowA?.welcomePlanet === a.ticket.planet);
  check("attribution is stored", rowA?.utmSource === "reddit" && rowA.landingPath === "/interest");
  check("welcome sent once with both links", sent.length === 1 && sent[0]!.links.ticketUrl.includes(`me=${a.ticket.shareToken}`) && sent[0]!.links.shareUrl.includes(`ref=${a.ticket.shareToken}`));

  // --- duplicate: same ticket, no second mail, still one row
  const a2 = await joinInterestListCore({ ...base, email: `${PREFIX}a@example.test` }, ctx("a"));
  check("duplicate is ok", a2.ok);
  check("duplicate returns the same ticket", a2.ok && a2.ticket.shareToken === a.ticket.shareToken && a2.ticket.number === a.ticket.number);
  check("duplicate sends nothing", sent.length === 1);
  check("duplicate creates no row", (await db.select().from(interestListSignups).where(like(interestListSignups.email, `${PREFIX}a@%`))).length === 1);

  // --- referral: B joins through A's link
  const b = await joinInterestListCore({ ...base, email: `${PREFIX}b@example.test`, ref: a.ticket.shareToken }, ctx("b"));
  check("referred join is ok", b.ok);
  const rowB = await rowFor(`${PREFIX}b@example.test`);
  check("referred row points at the referrer", rowB?.referredById === rowA?.id);
  const a3 = await joinInterestListCore({ ...base, email: `${PREFIX}a@example.test` }, ctx("a"));
  check("referrer now has one moon", a3.ok && a3.ticket.moons === 1, a3.ok ? String(a3.ticket.moons) : "not ok");
  check("referred ticket is the next number", b.ok && a.ok && b.ticket.number === a.ticket.number + 1);

  // --- self-referral and unknown ref
  const c = await joinInterestListCore({ ...base, email: `${PREFIX}c@example.test`, ref: "no-such-token" }, ctx("c"));
  check("unknown ref still joins", c.ok);
  check("unknown ref stores no referrer", (await rowFor(`${PREFIX}c@example.test`))?.referredById === null);
  // Rejoining with your own token must never credit yourself (the branch is unreachable
  // for an active row, but an unsubscribed one rejoins through the update path).
  await db.update(interestListSignups).set({ unsubscribedAt: new Date(), followUpSentAt: new Date() }).where(eq(interestListSignups.email, `${PREFIX}c@example.test`));
  const cTicket = c.ok ? c.ticket : null;
  const c2 = await joinInterestListCore({ ...base, email: `${PREFIX}c@example.test`, ref: cTicket!.shareToken }, ctx("c"));
  const rowC = await rowFor(`${PREFIX}c@example.test`);
  check("rejoin reactivates and re-arms the follow-up", c2.ok && rowC?.unsubscribedAt === null && rowC.followUpSentAt === null);
  check("rejoin keeps the planet and token", rowC?.welcomePlanet === cTicket!.planet && rowC?.shareToken === cTicket!.shareToken);
  check("rejoin never credits a referrer", rowC?.referredById === null);
  check("rejoin sends the welcome again", sent.filter((s) => s.email === `${PREFIX}c@example.test`).length === 2);

  // --- legacy row without a share token gets one on the next submit
  await db.insert(interestListSignups).values({ email: `${PREFIX}legacy@example.test`, unsubscribeToken: generateUnsubscribeToken(), welcomePlanet: "saturn" });
  const legacy = await joinInterestListCore({ ...base, email: `${PREFIX}legacy@example.test` }, ctx("legacy"));
  const rowL = await rowFor(`${PREFIX}legacy@example.test`);
  check("legacy row is minted a share token", legacy.ok && Boolean(rowL?.shareToken) && legacy.ticket.shareToken === rowL?.shareToken);
  check("legacy mint sends no mail", !sent.some((s) => s.email === `${PREFIX}legacy@example.test`));

  // --- honeypot, too fast: ok, plausible ticket, no row
  const rowsBefore = (await db.select().from(interestListSignups)).length;
  const bot = await joinInterestListCore({ ...base, website: "http://spam", email: `${PREFIX}bot@example.test` }, ctx("bot"));
  const fast = await joinInterestListCore({ ...base, elapsedMs: 10, email: `${PREFIX}fast@example.test` }, ctx("fast"));
  check("honeypot answers ok with a ticket", bot.ok && bot.ticket.number > 0 && bot.ticket.shareToken.length > 10);
  check("too-fast answers ok with a ticket", fast.ok && fast.ticket.moons === 0);
  check("neither writes a row", (await db.select().from(interestListSignups)).length === rowsBefore);
  check("fake tokens resolve to nothing", bot.ok && (await getTicketByShareToken(bot.ticket.shareToken)) === null);

  // --- invalid email is the one visible error
  const bad = await joinInterestListCore({ ...base, email: "not-an-email" }, ctx("bad"));
  check("a bad address is refused with the form's copy", !bad.ok && bad.message === "That address doesn't look right.");

  // --- rate limit: the eleventh submit from one IP gets a fake ticket and no row
  for (let i = 1; i <= 10; i += 1) {
    const r = await joinInterestListCore({ ...base, email: `${PREFIX}rl${i}@example.test` }, ctx("rl"));
    check(`submit ${i} of 10 lands`, r.ok && Boolean(await rowFor(`${PREFIX}rl${i}@example.test`)));
  }
  const eleventh = await joinInterestListCore({ ...base, email: `${PREFIX}rl11@example.test` }, ctx("rl"));
  check("eleventh submit still answers ok", eleventh.ok);
  check("eleventh submit writes no row", (await rowFor(`${PREFIX}rl11@example.test`)) === undefined);

  // --- the proof memo was invalidated by the inserts
  const proof = await getInterestProof();
  check("proof reflects the joins", proof.count >= before + 8, String(proof.count));
}

async function main() {
  await cleanup();
  await readModel();
  await joinPath();
  await cleanup();
  console.log("\ninterest-list join: all checks passed");
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => null);
  process.exit(1);
});
