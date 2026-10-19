/**
 * The waitlist join path and its read model, end to end against a throwaway PGlite.
 *
 * WHY THIS EXISTS. The join action returns a *ticket* (join number, place in line,
 * referrals, planet, share token) and the waitlist page renders one from a token. Every
 * rule that keeps that honest — ordinals that never collide, referral credit written once and never to yourself, bots
 * and rate-limited callers getting a plausible ticket and no row — is a query-shape or
 * branch-order detail that tsc cannot see. This drives the headers-free core directly.
 *
 * Run: npx tsx scripts/smoke-interest-list-join.ts
 */
import "./smoke/_env";

import { eq, like } from "drizzle-orm";
import { getDb } from "../src/db";
import { errorEvents, interestListSignups, productEvents, rateLimitBuckets } from "../src/db/schema";
import { generateUnsubscribeToken } from "../src/lib/interest-list-email";
import {
  getInterestProof,
  getInviterPlanet,
  getTicketByShareToken,
  invalidateInterestProof,
  proofShowsCount,
  readInterestProof,
} from "../src/lib/interest-list-ticket";
import {
  INTEREST_LIST_COUNT_FLOOR,
  MIN_FILL_MS,
  buildShareUrl,
  slugFromEmail,
} from "../src/lib/interest-list";
import { joinInterestListCore, saveInterestListNameCore, type JoinContext } from "../src/lib/interest-list-join";
import { backfillInterestListTokens, hashInterestToken, withRevealedTokens } from "../src/lib/interest-list-tokens";
import { decrypt } from "../src/lib/crypto";
import type { EmailLinks } from "../src/lib/interest-list-email";
import { RATE_LIMITS } from "../src/lib/rate-limit";
import { isBotRequest, setBotCheckForTests } from "../src/lib/bot-check";
import { joinInterestList, saveInterestListName } from "../src/actions/interest-list";

const PREFIX = "smoke-join-";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function cleanup() {
  const db = await getDb();
  await db.delete(interestListSignups).where(like(interestListSignups.email, `${PREFIX}%`));
  await db.delete(rateLimitBuckets).where(like(rateLimitBuckets.bucket, "interest.join:smoke-%"));
  await db.delete(rateLimitBuckets).where(like(rateLimitBuckets.bucket, "interest.name:smoke-%"));
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
  const beforeProof = await readInterestProof();
  const before = beforeProof.count;
  await seedReadModel();

  const t1 = await getTicketByShareToken("smoke-share-1");
  check("first row is #1 on Mercury", t1?.number === 1 && t1.planet === "mercury", JSON.stringify(t1));
  check("first row has two referrals", t1?.referrals === 2, String(t1?.referrals));
  check("two referrals are two referrals", t1?.referrals === 2);
  check("joinedAt is an ISO string", typeof t1?.joinedAt === "string" && t1.joinedAt.endsWith("Z"));

  const t2 = await getTicketByShareToken("smoke-share-2");
  const t3 = await getTicketByShareToken("smoke-share-3");
  check("simultaneous rows get distinct ordinals", t2 !== null && t3 !== null && t2.number !== t3.number, `${t2?.number} vs ${t3?.number}`);
  check("simultaneous rows take 2 and 3", new Set([t2!.number, t3!.number]).size === 2 && Math.min(t2!.number, t3!.number) === 2 && Math.max(t2!.number, t3!.number) === 3);
  check("a referred row has no referrals of its own", t2?.referrals === 0);
  check(
    "place in line follows join order",
    t1!.position < Math.min(t2!.position, t3!.position) && Math.max(t2!.position, t3!.position) < (await getTicketByShareToken("smoke-share-4"))!.position,
    `${t1?.position}, ${t2?.position}, ${t3?.position}`
  );

  const t4 = await getTicketByShareToken("smoke-share-4");
  check("legacy row without a planet reads as Mercury", t4?.planet === "mercury" && t4.number === 4);

  check("unknown token is null", (await getTicketByShareToken("nope")) === null);
  check("empty token is null", (await getTicketByShareToken("")) === null);

  check("inviter planet resolves", (await getInviterPlanet("smoke-share-3")) === "earth");
  check("inviter for an unknown token is null", (await getInviterPlanet("nope")) === null);

  const proof = await readInterestProof();
  check("proof counts everyone waiting", proof.count === before + 4, String(proof.count));
  check("total counts every row ever", proof.total === beforeProof.total + 4, String(proof.total));
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
  const sent: Array<{ email: string; links: EmailLinks; position: number | null }> = [];
  const ctx = (ip: string): JoinContext => ({
    ip: `smoke-${ip}`,
    attribution: { referrer: "reddit.com", utmSource: "reddit", utmMedium: null, utmCampaign: null, landingPath: "/interest" },
    sendWelcome: async (email, _unsub, _planet, links, position) => {
      sent.push({ email, links, position });
    },
    sendTier: async () => undefined,
  });
  const base = { website: "", elapsedMs: MIN_FILL_MS + 10 };
  // Tokens are stored hashed and encrypted (audit L-05); read them back the way the app does.
  const rowFor = async (email: string) => {
    const row = (await db.select().from(interestListSignups).where(eq(interestListSignups.email, email)))[0];
    return row ? withRevealedTokens(row) : row;
  };

  // --- new join
  const a = await joinInterestListCore({ ...base, email: `${PREFIX}A@Example.test` }, ctx("a"));
  check("new join is ok", a.ok);
  if (!a.ok) return;
  check("a new address is not returning", a.returning === false);
  const rowA = await rowFor(`${PREFIX}a@example.test`);
  check("email is normalised on insert", Boolean(rowA));
  check("ticket carries the stored share token", rowA?.shareToken === a.ticket.shareToken);
  const rawA = (await db.select().from(interestListSignups).where(eq(interestListSignups.email, `${PREFIX}a@example.test`)))[0];
  check("no token is stored in plaintext (L-05)", rawA?.shareToken === null && rawA?.unsubscribeToken === null);
  check("…each is stored as its hash and its ciphertext", rawA?.shareTokenHash === hashInterestToken(a.ticket.shareToken) && decrypt(rawA!.shareTokenEncrypted!) === a.ticket.shareToken && Boolean(rawA?.unsubscribeTokenHash) && decrypt(rawA!.unsubscribeTokenEncrypted!) === rowA?.unsubscribeToken);
  check("ticket planet matches the stored one", rowA?.welcomePlanet === a.ticket.planet);
  check("attribution is stored", rowA?.utmSource === "reddit" && rowA.landingPath === "/interest");
  check("welcome states the place in line", sent[0]?.position === a.ticket.position, String(sent[0]?.position));
  check("welcome sent once with both links", sent.length === 1 && sent[0]!.links.ticketUrl.includes(`me=${a.ticket.shareToken}`) && sent[0]!.links.shareUrl.endsWith(`/waitlist/${a.ticket.referralSlug}`));

  // --- duplicate: same ticket, no second mail, still one row
  const a2 = await joinInterestListCore({ ...base, email: `${PREFIX}a@example.test` }, ctx("a"));
  check("duplicate is ok", a2.ok);
  check("a recognised address is returning, so the form skips the name step", a2.ok && a2.returning === true);
  check("duplicate returns the same ticket", a2.ok && a2.ticket.shareToken === a.ticket.shareToken && a2.ticket.number === a.ticket.number);
  check("duplicate sends nothing", sent.length === 1);
  check("duplicate creates no row", (await db.select().from(interestListSignups).where(like(interestListSignups.email, `${PREFIX}a@%`))).length === 1);

  // --- referral: B joins through A's link
  const b = await joinInterestListCore({ ...base, email: `${PREFIX}b@example.test`, ref: a.ticket.shareToken }, ctx("b"));
  check("referred join is ok", b.ok);
  const rowB = await rowFor(`${PREFIX}b@example.test`);
  check("referred row points at the referrer", rowB?.referredById === rowA?.id);
  const a3 = await joinInterestListCore({ ...base, email: `${PREFIX}a@example.test` }, ctx("a"));
  check("referrer now has one referral", a3.ok && a3.ticket.referrals === 1, a3.ok ? String(a3.ticket.referrals) : "not ok");
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
  check("rejoin puts them back in line", c2.ok && rowC?.unsubscribedAt === null);
  check(
    "rejoin keeps the original join time",
    c2.ok && cTicket !== null && c2.ticket.joinedAt === cTicket.joinedAt
  );
  check("rejoin keeps the planet and token", rowC?.welcomePlanet === cTicket!.planet && rowC?.shareToken === cTicket!.shareToken);
  check("rejoin never credits a referrer", rowC?.referredById === null);
  check("rejoin sends the welcome again", sent.filter((s) => s.email === `${PREFIX}c@example.test`).length === 2);

  // --- legacy row without a share token gets one on the next submit
  await db.insert(interestListSignups).values({ email: `${PREFIX}legacy@example.test`, unsubscribeToken: generateUnsubscribeToken(), welcomePlanet: "saturn" });
  const legacy = await joinInterestListCore({ ...base, email: `${PREFIX}legacy@example.test` }, ctx("legacy"));
  const rowL = await rowFor(`${PREFIX}legacy@example.test`);
  check("legacy row is minted a share token", legacy.ok && Boolean(rowL?.shareToken) && legacy.ticket.shareToken === rowL?.shareToken);
  check("legacy mint sends no mail", !sent.some((s) => s.email === `${PREFIX}legacy@example.test`));

  // --- a pre-v177 row with plaintext tokens: links keep working before and after the backfill
  const oldShare = "smoke-plaintext-share-token-0001";
  const oldUnsub = generateUnsubscribeToken();
  await db.insert(interestListSignups).values({ email: `${PREFIX}plain@example.test`, unsubscribeToken: oldUnsub, shareToken: oldShare, welcomePlanet: "mars" });
  check("a plaintext share token still opens its pass", (await getTicketByShareToken(oldShare)) !== null);
  const plainRejoin = await joinInterestListCore({ ...base, email: `${PREFIX}plain@example.test` }, ctx("plain"));
  check("…and a returning join hands back that same token", plainRejoin.ok && plainRejoin.ticket.shareToken === oldShare);
  let moved = 0;
  for (let i = 0; i < 50; i++) {
    const n = await backfillInterestListTokens();
    moved += n;
    if (n === 0) break;
  }
  const rawPlain = (await db.select().from(interestListSignups).where(eq(interestListSignups.email, `${PREFIX}plain@example.test`)))[0];
  check("the backfill moves plaintext rows to hash + ciphertext", moved >= 1 && rawPlain?.shareToken === null && rawPlain?.unsubscribeToken === null && rawPlain?.shareTokenHash === hashInterestToken(oldShare));
  check("…keeping the token values, so the old pass link still opens", (await getTicketByShareToken(oldShare)) !== null);
  check("…and the old unsubscribe link still finds its row", withRevealedTokens(rawPlain!).unsubscribeToken === oldUnsub && rawPlain?.unsubscribeTokenHash === hashInterestToken(oldUnsub));
  await backfillInterestListTokens();
  const rePlain = (await db.select().from(interestListSignups).where(eq(interestListSignups.email, `${PREFIX}plain@example.test`)))[0];
  check("a second backfill leaves it as it was", rePlain?.shareTokenEncrypted === rawPlain?.shareTokenEncrypted && rePlain?.shareToken === null);

  // --- honeypot: ok, plausible ticket, no row
  const rowsBefore = (await db.select().from(interestListSignups)).length;
  const bot = await joinInterestListCore({ ...base, website: "http://spam", email: `${PREFIX}bot@example.test` }, ctx("bot"));
  check("honeypot answers ok with a ticket", bot.ok && bot.ticket.number > 0 && bot.ticket.shareToken.length > 10);
  check("honeypot writes no row", (await db.select().from(interestListSignups)).length === rowsBefore);
  check("a bot never looks returning, so it cannot be told from a new join", bot.ok && bot.returning === false);
  check("fake tokens resolve to nothing", bot.ok && (await getTicketByShareToken(bot.ticket.shareToken)) === null);
  const fast = await joinInterestListCore({ ...base, elapsedMs: 10, email: `${PREFIX}fast@example.test` }, ctx("fast"));
  check("instant submit still lands a real row", fast.ok && Boolean(await rowFor(`${PREFIX}fast@example.test`)));

  // --- invalid email is the one visible error
  const bad = await joinInterestListCore({ ...base, email: "not-an-email" }, ctx("bad"));
  check("a bad address is refused with the form's copy", !bad.ok && bad.message === "That address doesn't look right.");

  // --- rate limit: the eleventh submit from one IP gets a fake ticket and no row
  const limitedFrom = Date.now() - 1_000;
  for (let i = 1; i <= 10; i += 1) {
    const r = await joinInterestListCore({ ...base, email: `${PREFIX}rl${i}@example.test` }, ctx("rl"));
    check(`submit ${i} of 10 lands`, r.ok && Boolean(await rowFor(`${PREFIX}rl${i}@example.test`)));
  }
  const eleventh = await joinInterestListCore({ ...base, email: `${PREFIX}rl11@example.test` }, ctx("rl"));
  check("eleventh submit still answers ok", eleventh.ok);
  check("eleventh submit writes no row", (await rowFor(`${PREFIX}rl11@example.test`)) === undefined);
  // The human the limiter dropped is COUNTED, with nothing about them (audit D6).
  // (Earlier smokes sharing this database may have left the same event behind.)
  const limitedSince = new Date(limitedFrom);
  let limited = [] as Array<typeof productEvents.$inferSelect>;
  for (let i = 0; i < 60 && limited.length === 0; i += 1) {
    limited = (await db.select().from(productEvents).where(eq(productEvents.name, "waitlist_join_limited"))).filter((e) => e.occurredAt >= limitedSince);
    if (limited.length === 0) await new Promise((r) => setTimeout(r, 25));
  }
  check("a rate-limited join is counted as waitlist_join_limited", limited.length === 1 && limited[0]?.properties.reason === "rate_limited");
  check(
    "…as a system event, with no user, session, address or IP",
    limited[0]?.actor === "system" &&
      limited[0]?.userId === null &&
      limited[0]?.sessionId === null &&
      !JSON.stringify(limited[0]).includes("rl11") &&
      Object.keys(limited[0]?.properties ?? {}).join() === "reason"
  );

  // --- the proof memo was invalidated by the inserts
  const proof = await getInterestProof();
  check("proof reflects the joins", proof.count >= before + 8, String(proof.count));
}

async function namePath() {
  console.log("\nname step…");
  const db = await getDb();
  const ctx: JoinContext = {
    ip: "smoke-name",
    attribution: null,
    sendWelcome: async () => undefined,
    sendTier: async () => undefined,
  };
  // Tokens are stored hashed and encrypted (audit L-05); read them back the way the app does.
  const rowFor = async (email: string) => {
    const row = (await db.select().from(interestListSignups).where(eq(interestListSignups.email, email)))[0];
    return row ? withRevealedTokens(row) : row;
  };
  const joined = await joinInterestListCore(
    { email: `${PREFIX}name@example.test`, website: "", elapsedMs: MIN_FILL_MS + 10 },
    ctx
  );
  if (!joined.ok) throw new Error("name-step join failed");
  const token = joined.ticket.shareToken;
  check("a fresh join has no name yet", (await rowFor(`${PREFIX}name@example.test`))?.firstName === null);

  const bad = await saveInterestListNameCore({ shareToken: token, firstName: "  ", lastName: "Lovelace" }, ctx);
  check("a blank first name is the visible error", !bad.ok);
  check("a rejected name writes nothing", (await rowFor(`${PREFIX}name@example.test`))?.firstName === null);

  const saved = await saveInterestListNameCore({ shareToken: token, firstName: "  Ada ", lastName: " Lovelace" }, ctx);
  const named = await rowFor(`${PREFIX}name@example.test`);
  check("a name saves, trimmed", saved.ok && named?.firstName === "Ada" && named.lastName === "Lovelace");

  // The share token is also the public ?ref= link: a second write must not rename anyone.
  const again = await saveInterestListNameCore({ shareToken: token, firstName: "Mallory", lastName: "X" }, ctx);
  const still = await rowFor(`${PREFIX}name@example.test`);
  check("a second save answers ok", again.ok);
  check("a second save never overwrites", still?.firstName === "Ada" && still.lastName === "Lovelace");

  const unknown = await saveInterestListNameCore({ shareToken: "no-such-token", firstName: "A", lastName: "B" }, ctx);
  check("an unknown token answers ok, like a real one", unknown.ok);

  await db
    .update(interestListSignups)
    .set({ unsubscribedAt: new Date(), firstName: null, lastName: null })
    .where(eq(interestListSignups.email, `${PREFIX}name@example.test`));
  await saveInterestListNameCore({ shareToken: token, firstName: "Ghost", lastName: "Writer" }, ctx);
  check("someone who left gets no name written", (await rowFor(`${PREFIX}name@example.test`))?.firstName === null);
}

async function slugPath() {
  console.log("\nreferral slugs…");
  const db = await getDb();
  const ctx = (ip: string): JoinContext => ({
    ip: `smoke-${ip}`,
    attribution: null,
    sendWelcome: async () => undefined,
    sendTier: async () => undefined,
  });
  const base = { website: "", elapsedMs: MIN_FILL_MS + 10 };
  // Tokens are stored hashed and encrypted (audit L-05); read them back the way the app does.
  const rowFor = async (email: string) => {
    const row = (await db.select().from(interestListSignups).where(eq(interestListSignups.email, email)))[0];
    return row ? withRevealedTokens(row) : row;
  };

  check("the local part is the slug", slugFromEmail("Ada.Lovelace@example.com") === "ada.lovelace");
  check("unsafe characters are dropped", slugFromEmail("ada+list@example.com") === "adalist" && slugFromEmail("a b/c@x.y") === "abc");
  check("edge punctuation is trimmed", slugFromEmail("..ada..@x.y") === "ada");
  check("nothing usable becomes member", slugFromEmail("+++@x.y") === "member" && slugFromEmail("@x.y") === "member");
  check("reserved path names become member", slugFromEmail("privacy@x.y") === "member" && slugFromEmail("icon.png@x.y") === "member");
  check("a very long local part is capped", slugFromEmail(`${"a".repeat(80)}@x.y`).length <= 42);

  // --- a join gets a slug, and the share link uses it
  const a = await joinInterestListCore({ ...base, email: `${PREFIX}dup@one.test` }, ctx("s1"));
  if (!a.ok) throw new Error("slug join failed");
  check("the ticket carries the local part", a.ticket.referralSlug === `${PREFIX}dup`, a.ticket.referralSlug);
  check("the slug is stored", (await rowFor(`${PREFIX}dup@one.test`))?.referralSlug === a.ticket.referralSlug);
  check(
    "the share link is /waitlist/<slug>",
    buildShareUrl("https://join.example/", a.ticket) === `https://join.example/waitlist/${PREFIX}dup` &&
      buildShareUrl("https://app.example/interest", a.ticket) === `https://app.example/waitlist/${PREFIX}dup`
  );
  check("the share link no longer carries the ticket token", !buildShareUrl("https://join.example/", a.ticket).includes(a.ticket.shareToken));

  // --- two addresses, one local part
  const b = await joinInterestListCore({ ...base, email: `${PREFIX}dup@two.test` }, ctx("s2"));
  check("a second address with the same local part gets a suffix", b.ok && b.ticket.referralSlug === `${PREFIX}dup-2`, b.ok ? b.ticket.referralSlug : "not ok");
  const c = await joinInterestListCore({ ...base, email: `${PREFIX}dup@three.test` }, ctx("s3"));
  check("…and a third the next one", c.ok && c.ticket.referralSlug === `${PREFIX}dup-3`, c.ok ? c.ticket.referralSlug : "not ok");
  const a2 = await joinInterestListCore({ ...base, email: `${PREFIX}dup@one.test` }, ctx("s1"));
  check("a repeat visit keeps the same slug", a2.ok && a2.ticket.referralSlug === a.ticket.referralSlug);

  // --- a slug credits a referral, and so does an old token link
  const viaSlug = await joinInterestListCore({ ...base, email: `${PREFIX}via-slug@example.test`, ref: a.ticket.referralSlug }, ctx("s4"));
  check("a slug ref joins", viaSlug.ok);
  const rowA = await rowFor(`${PREFIX}dup@one.test`);
  check("…and credits the slug's owner", (await rowFor(`${PREFIX}via-slug@example.test`))?.referredById === rowA?.id);
  const viaUpper = await joinInterestListCore({ ...base, email: `${PREFIX}via-upper@example.test`, ref: a.ticket.referralSlug.toUpperCase() }, ctx("s5"));
  check("a slug is matched case-insensitively", viaUpper.ok && (await rowFor(`${PREFIX}via-upper@example.test`))?.referredById === rowA?.id);
  const viaToken = await joinInterestListCore({ ...base, email: `${PREFIX}via-token@example.test`, ref: a.ticket.shareToken }, ctx("s6"));
  check("a share-token ref (links already sent) still credits", viaToken.ok && (await rowFor(`${PREFIX}via-token@example.test`))?.referredById === rowA?.id);
  check("the inviter's planet resolves from a slug", (await getInviterPlanet(a.ticket.referralSlug)) !== null);
  check("an unknown slug resolves to nobody", (await getInviterPlanet("nobody-here")) === null);

  // --- a row from before slugs gets one the first time its ticket is read
  await db.insert(interestListSignups).values({
    email: `${PREFIX}legacy-slug@example.test`,
    unsubscribeToken: generateUnsubscribeToken(),
    shareToken: "smoke-legacy-slug-token",
    welcomePlanet: "mars",
  });
  check("a legacy row starts with none", (await rowFor(`${PREFIX}legacy-slug@example.test`))?.referralSlug === null);
  const legacy = await getTicketByShareToken("smoke-legacy-slug-token");
  check("reading its ticket claims one", legacy?.referralSlug === `${PREFIX}legacy-slug`, legacy?.referralSlug);
  check("…and it is stored", (await rowFor(`${PREFIX}legacy-slug@example.test`))?.referralSlug === `${PREFIX}legacy-slug`);
}

/**
 * The global welcome cap: one bucket for every sender, so a flood of fresh addresses from
 * many IPs cannot turn the join into a mail cannon. Past it the row and the ticket still
 * land; only the mail is dropped. The bucket is real shared state, so it is put back.
 */
async function welcomeCapPath() {
  console.log("\nwelcome cap…");
  const db = await getDb();
  const bucket = "interest.welcome:global";
  const [prior] = await db.select().from(rateLimitBuckets).where(eq(rateLimitBuckets.bucket, bucket));
  const sent: string[] = [];
  const ctx: JoinContext = {
    ip: "smoke-cap",
    attribution: null,
    sendWelcome: async (email) => {
      sent.push(email);
    },
    sendTier: async () => undefined,
  };
  try {
    await db
      .insert(rateLimitBuckets)
      .values({ bucket, windowStartedAt: new Date(), count: RATE_LIMITS.interestWelcome.limit })
      .onConflictDoUpdate({
        target: rateLimitBuckets.bucket,
        set: { windowStartedAt: new Date(), count: RATE_LIMITS.interestWelcome.limit },
      });
    const r = await joinInterestListCore(
      { email: `${PREFIX}capped@example.test`, website: "", elapsedMs: MIN_FILL_MS + 10 },
      ctx
    );
    const row = (await db.select().from(interestListSignups).where(eq(interestListSignups.email, `${PREFIX}capped@example.test`)))[0];
    check("a join past the welcome cap still answers ok", r.ok);
    check("…and still lands its row", Boolean(row));
    check("…with its real ticket", r.ok && Boolean(row) && r.ticket.shareToken === withRevealedTokens(row!).shareToken);
    check("…but sends no welcome", sent.length === 0, sent.join(","));
  } finally {
    if (prior) {
      await db.update(rateLimitBuckets).set({ windowStartedAt: prior.windowStartedAt, count: prior.count }).where(eq(rateLimitBuckets.bucket, bucket));
    } else {
      await db.delete(rateLimitBuckets).where(eq(rateLimitBuckets.bucket, bucket));
    }
  }
}

/**
 * BotID's verdict, checked in the actions before anything else. A bot gets the same answer
 * a rate-limited caller does — a plausible ticket, a quiet ok — and nothing is written.
 * The verdict is stubbed: the real one only exists on Vercel.
 */
async function botVerdictPath() {
  console.log("\nBotID verdict in the actions…");
  const db = await getDb();
  const email = `${PREFIX}botid@example.test`;
  const botRows = async () => (await db.select().from(errorEvents).where(eq(errorEvents.source, "bot.check")));
  await db.delete(errorEvents).where(eq(errorEvents.source, "bot.check"));
  setBotCheckForTests(async () => true);
  try {
    const r = await joinInterestList({ email, website: "", elapsedMs: MIN_FILL_MS + 10 });
    check("a bot's join answers ok with a ticket", r.ok && r.ticket.shareToken.length > 10);
    check("a bot's join writes no row", (await db.select().from(interestListSignups).where(eq(interestListSignups.email, email))).length === 0);
    check("a bot's ticket resolves to nothing", r.ok && (await getTicketByShareToken(r.ticket.shareToken)) === null);
    check("a bot's join is not returning", r.ok && r.returning === false);

    const joined = await joinInterestListCore(
      { email: `${PREFIX}botname@example.test`, website: "", elapsedMs: MIN_FILL_MS + 10 },
      { ip: "smoke-botname", attribution: null, sendWelcome: async () => undefined, sendTier: async () => undefined }
    );
    if (!joined.ok) throw new Error("bot name-step join failed");
    const named = await saveInterestListName({ shareToken: joined.ticket.shareToken, firstName: "Bot", lastName: "Net" });
    const row = (await db.select().from(interestListSignups).where(eq(interestListSignups.email, `${PREFIX}botname@example.test`)))[0];
    check("a bot's name step answers ok", named.ok);
    check("a bot's name step writes nothing", row?.firstName === null);
    const blocked = await botRows();
    check("two bot verdicts record one throttled \"blocked\" event", blocked.length === 1 && blocked[0].kind === "blocked", JSON.stringify(blocked.map((r) => r.kind)));
    check("…with nothing from the request in it", blocked[0]?.userId === null && blocked[0]?.message === null && Object.keys(blocked[0]?.context ?? {}).length === 0);
  } finally {
    setBotCheckForTests(null);
  }

  // The fail-open path: BotID throws (production build, no Vercel OIDC token), the request is
  // let through, and the outage leaves one throttled event.
  await db.delete(errorEvents).where(eq(errorEvents.source, "bot.check"));
  const env = process.env as Record<string, string | undefined>;
  const saved = { NODE_ENV: env.NODE_ENV, VERCEL_OIDC_TOKEN: env.VERCEL_OIDC_TOKEN };
  const log = [console.error, console.warn];
  console.error = console.warn = () => undefined;
  env.NODE_ENV = "production";
  delete env.VERCEL_OIDC_TOKEN;
  try {
    const first = await isBotRequest();
    const second = await isBotRequest();
    env.NODE_ENV = saved.NODE_ENV;
    const failed = await botRows();
    check("a BotID check that throws fails open", first === false && second === false);
    check("…and records one throttled \"check_failed\" event", failed.length === 1 && failed[0].kind === "check_failed", JSON.stringify(failed.map((r) => r.kind)));
    check("…with nothing from the request in it", failed[0]?.userId === null && failed[0]?.message === null && Object.keys(failed[0]?.context ?? {}).length === 0);
  } finally {
    [console.error, console.warn] = log;
    env.NODE_ENV = saved.NODE_ENV;
    if (saved.VERCEL_OIDC_TOKEN !== undefined) env.VERCEL_OIDC_TOKEN = saved.VERCEL_OIDC_TOKEN;
    await db.delete(errorEvents).where(eq(errorEvents.source, "bot.check"));
  }
}

async function main() {
  await cleanup();
  await readModel();
  await joinPath();
  await namePath();
  await slugPath();
  await welcomeCapPath();
  await botVerdictPath();
  await cleanup();
  console.log("\nwaitlist join: all checks passed");
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => null);
  process.exit(1);
});
