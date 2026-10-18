/**
 * Waitlist measurement: the numbers an operator reads off the waitlist must be the ones the
 * code means, and the counters added for them must carry no personal data.
 *
 * Pins:
 *   - ONE "converted" definition (linked by user id, or the address matches an account), read
 *     by both the admin roster and the broadcast sender, so the two cannot disagree;
 *   - the referral rate is live still-waiting referrals over everyone still waiting, with the
 *     numerator and denominator both exposed;
 *   - the operator's own test joins are left out of tiles and the source rollup;
 *   - an in-person event add is a source named "Event · <label>", never "admin";
 *   - a share is counted from the server with a verified token: signup id + channel and
 *     nothing else, rate limited, and silent about bad tokens;
 *   - a delivered tier email is counted, an undelivered one is not;
 *   - the pass-open counter does not count the join itself (source assertion on the hero).
 *
 * Run: npx tsx scripts/smoke-waitlist-analytics.ts
 */
import "./smoke/_env";

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { eq, like } from "drizzle-orm";
import { getDb } from "../src/db";
import { interestListSignups, productEvents, rateLimitBuckets, userSettings } from "../src/db/schema";
import { audienceFor } from "../src/lib/broadcasts";
import {
  getWaitlistStats,
  interestListSources,
  loadInterestList,
} from "../src/lib/admin-interest-list";
import { joinInterestListCore, type JoinContext } from "../src/lib/interest-list-join";
import { invalidateInterestProof } from "../src/lib/interest-list-ticket";
import { recordWaitlistShareCore } from "../src/lib/waitlist-share";
import { MIN_FILL_MS } from "../src/lib/interest-list";
import { ensureUserSettings } from "../src/lib/user-settings";
import { run } from "./smoke/_env";

const PREFIX = "smoke-wla-";
const OPERATOR = "user_smoke_wla_operator";
const ACCOUNT = "user_smoke_wla_account";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function eventsNamed(name: string, want: number, filter?: (r: typeof productEvents.$inferSelect) => boolean) {
  const db = await getDb();
  for (let i = 0; i < 60; i += 1) {
    const rows = (await db.select().from(productEvents).where(eq(productEvents.name, name))).filter((r) => (filter ? filter(r) : true));
    if (rows.length >= want) return rows;
    await new Promise((r) => setTimeout(r, 25));
  }
  return (await db.select().from(productEvents).where(eq(productEvents.name, name))).filter((r) => (filter ? filter(r) : true));
}

run(async () => {
  const db = await getDb();
  process.env.ADMIN_USER_IDS = OPERATOR;
  const row = (n: string, extra: Record<string, unknown> = {}) => ({
    email: `${PREFIX}${n}@example.test`,
    unsubscribeToken: randomUUID(),
    shareToken: `${PREFIX}share-${n}`,
    ...extra,
  });

  // A waits; B joined through A; C joined through A and left; D converted by id; E converted by
  // address; F is an in-person event add; G is the operator's own test join.
  const [a] = await db.insert(interestListSignups).values(row("a", { utmSource: "reddit" })).returning();
  const [b] = await db.insert(interestListSignups).values(row("b", { referredById: a!.id, utmSource: "reddit" })).returning();
  await db.insert(interestListSignups).values(row("c", { referredById: a!.id, unsubscribedAt: new Date() }));
  const [d] = await db.insert(interestListSignups).values(row("d", { userId: ACCOUNT, convertedAt: new Date() })).returning();
  const [e] = await db.insert(interestListSignups).values(row("e")).returning();
  const [f] = await db
    .insert(interestListSignups)
    .values(row("f", { utmSource: "admin", utmMedium: "event", utmCampaign: "Demo Day", signupEventLabel: "Demo Day" }))
    .returning();
  const [g] = await db.insert(interestListSignups).values(row("g", { utmSource: "operator-test" })).returning();
  await ensureUserSettings(OPERATOR);
  await db.update(userSettings).set({ email: g!.email }).where(eq(userSettings.userId, OPERATOR));
  await ensureUserSettings("user_smoke_wla_emailmatch");
  await db.update(userSettings).set({ email: e!.email.toUpperCase() }).where(eq(userSettings.userId, "user_smoke_wla_emailmatch"));
  invalidateInterestProof();

  console.log("one 'converted' definition, two readers…");
  const audience = (await audienceFor()).map((r) => r.id).sort();
  const asList = await loadInterestList({ page: 1, filter: "active", sort: "newest" });
  const waiting = asList.rows.map((r) => r.id).sort();
  check("the broadcast audience is exactly the console's 'waiting' set", JSON.stringify(audience) === JSON.stringify(waiting), `${audience.length} vs ${waiting.length}`);
  check("…which is A, B and the event add", JSON.stringify(audience) === JSON.stringify([a!.id, b!.id, f!.id].sort()));
  const converted = (await loadInterestList({ page: 1, filter: "converted", sort: "newest" })).rows.map((r) => r.id).sort();
  check(
    "converted = linked by user id (D) OR address matches an account (E, and the operator's G)",
    JSON.stringify(converted) === JSON.stringify([d!.id, e!.id, g!.id].sort())
  );
  check("a row linked by id is converted even with no matching email", converted.includes(d!.id));

  console.log("\nthe referral number, with its denominator…");
  const stats = await getWaitlistStats();
  check("referred counts only people still waiting (B, not the C who left)", stats.referred === 1, String(stats.referred));
  check("…over everyone still waiting, operator excluded (A, B, D, E, F)", stats.referralBase === 5, String(stats.referralBase));
  check("the operator's own test join is counted apart, not in the tiles", stats.operatorTestJoins === 1 && stats.total === 6, `${stats.operatorTestJoins}/${stats.total}`);
  check("…yet still on the roster", (await loadInterestList({ page: 1, filter: "all", sort: "newest" })).total === 7);

  console.log("\nthe acquisition rollup…");
  const sources = await interestListSources();
  const by = new Map(sources.map((s) => [s.source, s]));
  check("an event add is named for its event", by.get("Event · Demo Day")?.count === 1);
  check("there is no 'admin' channel", !by.has("admin"));
  check("the operator's test join is not a source", !by.has("operator-test") && sources.reduce((n, s) => n + s.count, 0) === 6);
  check("reddit shows A and B, with the conversions it earned", by.get("reddit")?.count === 2 && by.get("reddit")?.converted === 0);

  console.log("\nshares are counted from the server…");
  const ctx = { ip: "smoke-share-ip" };
  check("a copy of a real pass is recorded", (await recordWaitlistShareCore({ shareToken: a!.shareToken!, channel: "copy", ...ctx })) === true);
  const shared = await eventsNamed("waitlist_shared", 1);
  check("…as the signup id and the channel, nothing else", shared.length === 1 && shared[0]?.properties.signup_id === a!.id && shared[0]?.properties.channel === "copy" && Object.keys(shared[0]!.properties).sort().join() === "channel,signup_id");
  check("…with no user, session, token or address on the row", shared[0]?.userId === null && shared[0]?.sessionId === null && !JSON.stringify(shared[0]).includes(a!.shareToken!) && !JSON.stringify(shared[0]).includes("example.test"));
  check("a channel outside the list records nothing", (await recordWaitlistShareCore({ shareToken: a!.shareToken!, channel: "carrier-pigeon", ...ctx })) === false);
  check("a token that matches nothing records nothing", (await recordWaitlistShareCore({ shareToken: "nope", channel: "copy", ...ctx })) === false);
  check("a pass that has left records nothing", (await recordWaitlistShareCore({ shareToken: `${PREFIX}share-c`, channel: "copy", ...ctx })) === false);
  check("an over-long token is refused before any lookup", (await recordWaitlistShareCore({ shareToken: "x".repeat(500), channel: "copy", ...ctx })) === false);
  let accepted = 0;
  for (let i = 0; i < 60; i += 1) {
    if (await recordWaitlistShareCore({ shareToken: a!.shareToken!, channel: "linkedin", ip: "smoke-share-flood" })) accepted += 1;
  }
  check("a loop from one address is cut off by the limiter", accepted > 0 && accepted <= 40, String(accepted));
  await db.delete(rateLimitBuckets).where(like(rateLimitBuckets.bucket, "interest.share:%"));

  console.log("\ndelivered mail is counted…");
  const joinCtx = (sent: boolean): JoinContext => ({
    ip: `smoke-wla-${sent}`,
    attribution: null,
    sendWelcome: async () => sent,
    sendTier: async () => sent,
  });
  const before = (await eventsNamed("waitlist_email_sent", 0)).length;
  await joinInterestListCore({ email: `${PREFIX}h@example.test`, website: "", elapsedMs: MIN_FILL_MS + 10, ref: a!.shareToken! }, joinCtx(false));
  await new Promise((r) => setTimeout(r, 200));
  check("a welcome Resend did not accept is not counted", (await eventsNamed("waitlist_email_sent", 0)).length === before);

  // R has no friends yet; one join through R's link unlocks the first tier.
  const [r] = await db.insert(interestListSignups).values(row("r")).returning();
  await joinInterestListCore({ email: `${PREFIX}i@example.test`, website: "", elapsedMs: MIN_FILL_MS + 10, ref: r!.shareToken! }, joinCtx(true));
  const mail = await eventsNamed("waitlist_email_sent", before + 2);
  const kinds = mail.map((m) => m.properties.kind).sort().join();
  check("an accepted welcome and an accepted tier notice are each counted once", kinds === "tier,welcome", kinds);
  check("…as system events with only the kind", mail.every((m) => m.actor === "system" && Object.keys(m.properties).join() === "kind" && m.userId === null));

  console.log("\nthe pass-open counter skips the join itself…");
  const hero = readFileSync("src/components/interest/interest-hero.tsx", "utf8");
  check(
    "the hero remembers the token a join produced and does not report it as a visit",
    /joinedToken\.current\s*===\s*ticket\.shareToken/.test(hero) && /if \(!result\.returning\) joinedToken\.current = result\.ticket\.shareToken/.test(hero)
  );
  check("…and sends this tab's session id with the join, tolerating blocked storage", /sessionId:\s*readPageviewSessionId\(\)/.test(hero) && /catch/.test(readFileSync("src/lib/pageview-session.ts", "utf8")));

  await db.delete(interestListSignups).where(like(interestListSignups.email, `${PREFIX}%`));
  await db.delete(userSettings).where(eq(userSettings.userId, OPERATOR));
  await db.delete(userSettings).where(eq(userSettings.userId, "user_smoke_wla_emailmatch"));
  console.log("\nwaitlist analytics: all checks passed");
});
