/**
 * Reply detection for campaign email: a message FROM the person, in the user's own mailbox,
 * since the send — sender and date only, never a body. Plus the manual outcome path, which no
 * longer touches the person's `selected` status and can change an outcome that is already set.
 * Run: npx tsx scripts/smoke-outreach-replies.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { eq, sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import * as schema from "../src/db/schema";
import { encrypt } from "../src/lib/crypto";
import { gmailReplyQuery, outlookReplyFilter, repliedSince } from "../src/lib/email/inbox-threads";
import { GOOGLE_SCOPES } from "../src/lib/google-scopes";
import { MICROSOFT_SCOPES } from "../src/lib/microsoft-scopes";
import { canSeeRepliesForUser, checkCampaignRepliesForUser, setMessageOutcomeForUser, type ReplyLookup } from "../src/lib/outreach-replies";
import { followUpDue } from "../src/lib/outreach-followups";
import { addProspectsForUser } from "../src/lib/outreach-people";
import { FOLLOW_UP_AFTER_DAYS, REPLY_CHECKS_PER_PASS, REPLY_CHECK_WINDOW_DAYS } from "../src/lib/outreach-types";
import { purgeUserData } from "../src/lib/user-data";

const USER = "smoke-outreach-replies-user";
const OTHER = "smoke-outreach-replies-other";
const NOW = new Date("2026-10-26T12:00:00.000Z");
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);
const OPTS = { skipRevalidate: true, skipEmbedding: true, skipSummary: true, skipCloseness: true } as const;

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function rejects(fn: () => Promise<unknown>, substring?: string) {
  try {
    await fn();
    return false;
  } catch (err) {
    return !substring || (err instanceof Error && err.message.includes(substring));
  }
}

async function reset() {
  for (const id of [USER, OTHER]) await purgeUserData(id, { keepSettings: false }).catch(() => {});
}

async function msg(id: string) {
  const db = await getDb();
  return (await db.query.outreachMessages.findFirst({ where: eq(schema.outreachMessages.id, id) }))!;
}

async function prospect(id: string) {
  const db = await getDb();
  return (await db.query.outreachProspects.findFirst({ where: eq(schema.outreachProspects.id, id) }))!;
}

async function resetThrottle(campaignId: string) {
  const db = await getDb();
  await db.execute(sql`DELETE FROM rate_limit_buckets WHERE bucket = ${`outreach-reply-check:${USER}:${campaignId}`}`);
}

/** An outbox row, the way a settled send leaves it. */
async function outboxRow(userId: string, provider: "gmail" | "outlook" | "demo", to: string) {
  const db = await getDb();
  const [row] = await db
    .insert(schema.emailSends)
    .values({
      userId,
      provider,
      fromEmail: "me@x.org",
      to: [to],
      subject: "Hi",
      bodyText: "Hello",
      origin: "outreach",
      status: "sent",
      sendAt: NOW,
      rfcMessageId: `<${crypto.randomUUID()}@orbit.mail>`,
    })
    .returning();
  return row!.id;
}

/** The message as the send hook leaves it: `sent`, `sent_at`, and the outbox row's id as text. */
async function markSent(messageId: string, deliveryId: string | null, sentAt: Date) {
  const db = await getDb();
  await db
    .update(schema.outreachMessages)
    .set({ status: "sent", sentAt, deliveryId })
    .where(eq(schema.outreachMessages.id, messageId));
}

/** One person with one drafted-then-sent first message; returns the prospect and message ids. */
async function sentPerson(opts: {
  campaignId: string;
  name: string;
  email: string | null;
  sentAt: Date;
  provider?: "gmail" | "outlook" | "demo";
  deliveryId?: string | null;
  userId?: string;
}) {
  const db = await getDb();
  const userId = opts.userId ?? USER;
  await addProspectsForUser(userId, opts.campaignId, [
    { fullName: opts.name, company: "Acme", ...(opts.email ? { email: opts.email } : {}), origin: "manual" },
  ]);
  const p = (await db.query.outreachProspects.findMany({ where: eq(schema.outreachProspects.campaignId, opts.campaignId) })).find(
    (r) => r.fullName === opts.name
  )!;
  const [m] = await db
    .insert(schema.outreachMessages)
    .values({ prospectId: p.id, channel: "email", subject: "Hi", body: "Hello", stepIndex: 0 })
    .returning();
  const delivery =
    opts.deliveryId !== undefined ? opts.deliveryId : await outboxRow(userId, opts.provider ?? "gmail", opts.email ?? "none@x.org");
  await markSent(m!.id, delivery, opts.sentAt);
  return { prospectId: p.id, messageId: m!.id };
}

/** Replace `fetch` for one block; every call is recorded and answered by `answer`. */
async function withFetch<T>(answer: (url: string) => unknown, body: () => Promise<T>) {
  const real = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    const out = answer(url);
    if (out === "fail") throw new Error("network down");
    if (out === null) return new Response("nope", { status: 500 });
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    return { value: await body(), urls };
  } finally {
    globalThis.fetch = real;
  }
}

async function main() {
  const db = await getDb();
  await reset();
  try {
    console.log("query shapes");
    check("gmail query", gmailReplyQuery("bo@iqvia.com", new Date(1_700_000_000_000)) === "from:bo@iqvia.com after:1700000000");
    check("outlook filter escapes quotes", outlookReplyFilter("o'neil@x.org", new Date(0)).includes("'o''neil@x.org'"));
    check(
      "outlook filter filters on sender and date",
      outlookReplyFilter("bo@iqvia.com", new Date(0)) ===
        "from/emailAddress/address eq 'bo@iqvia.com' and receivedDateTime ge 1970-01-01T00:00:00.000Z"
    );

    console.log("follow-up");
    const first = (sentDaysAgo: number | null, over: Partial<Parameters<typeof followUpDue>[0]> = {}) => ({
      stepIndex: 0,
      status: "sent",
      sentAt: sentDaysAgo === null ? null : daysAgo(sentDaysAgo),
      outcome: null,
      ...over,
    });
    check("a follow-up waits a week", FOLLOW_UP_AFTER_DAYS === 7);
    check("not due at day 6", !followUpDue(first(6), false, NOW));
    check("due at day 7", followUpDue(first(7), false, NOW));
    check("…and after", followUpDue(first(30), false, NOW));
    check("no follow-up after a reply", !followUpDue(first(8, { outcome: "replied" }), false, NOW));
    check("…or a bounce", !followUpDue(first(8, { outcome: "bounced" }), false, NOW));
    check("only one follow-up", followUpDue(first(8), false, NOW) && !followUpDue(first(8), true, NOW));
    check("only a first message gets one", !followUpDue(first(8, { stepIndex: 1 }), false, NOW));
    check("only a sent message gets one", !followUpDue(first(8, { status: "copied" }), false, NOW) && !followUpDue(first(8, { status: "unsure" }), false, NOW));
    check("…with a send time", !followUpDue(first(null), false, NOW));

    console.log("repliedSince");
    check("no mailbox connected is null", (await repliedSince(USER, "gmail", "bo@iqvia.com", daysAgo(3))) === null);
    await db.insert(schema.gmailConnections).values({
      userId: USER,
      emailAddress: "me@x.org",
      accessTokenEncrypted: encrypt("gtok"),
      refreshTokenEncrypted: encrypt("r"),
      tokenExpiresAt: new Date(Date.now() + 3_600_000),
      scopes: GOOGLE_SCOPES.gmailSend,
      status: "active",
    });
    const noFetch = await withFetch(() => ({}), () => repliedSince(USER, "gmail", "bo@iqvia.com", daysAgo(3)));
    check("a send-only grant is never asked (no read scope)", noFetch.value === null && noFetch.urls.length === 0);

    await db.update(schema.gmailConnections).set({ scopes: `${GOOGLE_SCOPES.gmailSend} ${GOOGLE_SCOPES.gmailRead}` }).where(eq(schema.gmailConnections.userId, USER));
    const since = new Date(1_700_000_000_000);
    const hit = await withFetch(
      (url) => (url.includes("/messages?") ? { messages: [{ id: "g1" }] } : { internalDate: "1700000600000" }),
      () => repliedSince(USER, "gmail", "Bo@IQVIA.com", since)
    );
    check("gmail: the newest message's internalDate", hit.value?.getTime() === 1_700_000_600_000, String(hit.value));
    check(
      "gmail: lists by sender and date, one result, then reads only the date",
      hit.urls.length === 2 &&
        hit.urls[0]!.includes(`q=${encodeURIComponent("from:bo@iqvia.com after:1700000000")}`) &&
        hit.urls[0]!.includes("maxResults=1") &&
        hit.urls[1]!.includes("/messages/g1?") &&
        hit.urls[1]!.includes("fields=internalDate"),
      hit.urls.join(" | ")
    );
    const miss = await withFetch(() => ({}), () => repliedSince(USER, "gmail", "bo@iqvia.com", since));
    check("gmail: no message since is null", miss.value === null && miss.urls.length === 1);
    const down = await withFetch(() => "fail", () => repliedSince(USER, "gmail", "bo@iqvia.com", since));
    check("gmail: a network failure is null, never a throw", down.value === null);
    const refused = await withFetch(() => null, () => repliedSince(USER, "gmail", "bo@iqvia.com", since));
    check("gmail: an API error is null", refused.value === null);
    const junk = await withFetch(
      (url) => (url.includes("/messages?") ? { messages: [{ id: "g1" }] } : { internalDate: "soon" }),
      () => repliedSince(USER, "gmail", "bo@iqvia.com", since)
    );
    check("gmail: an unreadable date is null", junk.value === null);
    const bad = await withFetch(() => ({}), async () => [
      await repliedSince(USER, "gmail", "not an address", since),
      await repliedSince(USER, "gmail", 'a"b@x.org', since),
      await repliedSince(USER, "gmail", "bo@iqvia.com", new Date(Number.NaN)),
    ]);
    check("a bad address or date is never sent to the provider", bad.value.every((v) => v === null) && bad.urls.length === 0);

    check("outlook: no connection is null", (await repliedSince(USER, "outlook", "bo@iqvia.com", since)) === null);
    await db.insert(schema.outlookConnections).values({
      userId: USER,
      emailAddress: "me@corp.com",
      accessTokenEncrypted: encrypt("otok"),
      refreshTokenEncrypted: encrypt("r"),
      tokenExpiresAt: new Date(Date.now() + 3_600_000),
      scopes: MICROSOFT_SCOPES.mail,
      status: "active",
    });
    const oHit = await withFetch(() => ({ value: [{ receivedDateTime: "2026-10-20T09:30:00Z" }] }), () => repliedSince(USER, "outlook", "o'neil@x.org", since));
    check("outlook: receivedDateTime", oHit.value?.toISOString() === "2026-10-20T09:30:00.000Z", String(oHit.value));
    check(
      "outlook: OData options keep their $, the quote is doubled, one result",
      oHit.urls.length === 1 &&
        oHit.urls[0]!.includes("/messages?$filter=") &&
        oHit.urls[0]!.includes("&$top=1") &&
        oHit.urls[0]!.includes("$select=receivedDateTime") &&
        decodeURIComponent(oHit.urls[0]!).includes("'o''neil@x.org'"),
      oHit.urls.join(" | ")
    );
    const oMiss = await withFetch(() => ({ value: [] }), () => repliedSince(USER, "outlook", "bo@iqvia.com", since));
    check("outlook: nothing since is null", oMiss.value === null);
    const oDown = await withFetch(() => "fail", () => repliedSince(USER, "outlook", "bo@iqvia.com", since));
    check("outlook: a network failure is null", oDown.value === null);
    await db.delete(schema.gmailConnections).where(eq(schema.gmailConnections.userId, USER));
    await db.delete(schema.outlookConnections).where(eq(schema.outlookConnections.userId, USER));

    console.log("canSeeRepliesForUser");
    const connection = (scopes: string) => ({
      userId: USER,
      emailAddress: "me@x.org",
      accessTokenEncrypted: encrypt("tok"),
      refreshTokenEncrypted: encrypt("r"),
      tokenExpiresAt: new Date(Date.now() + 3_600_000),
      scopes,
      status: "active" as const,
    });
    check("no mailbox: no replies are seen", (await canSeeRepliesForUser(USER)) === false);
    await db.insert(schema.gmailConnections).values(connection(GOOGLE_SCOPES.gmailSend));
    check("a send-only Gmail grant can't see replies", (await canSeeRepliesForUser(USER)) === false);
    await db.update(schema.gmailConnections).set({ scopes: `${GOOGLE_SCOPES.gmailSend} ${GOOGLE_SCOPES.gmailRead}` }).where(eq(schema.gmailConnections.userId, USER));
    check("…with the read scope it can", (await canSeeRepliesForUser(USER)) === true);
    await db.update(schema.gmailConnections).set({ status: "needs_reauth" }).where(eq(schema.gmailConnections.userId, USER));
    check("…but not once the connection needs reconnecting", (await canSeeRepliesForUser(USER)) === false);
    await db.delete(schema.gmailConnections).where(eq(schema.gmailConnections.userId, USER));
    await db.insert(schema.outlookConnections).values(connection(MICROSOFT_SCOPES.mail));
    check("an Outlook connection with mail read can", (await canSeeRepliesForUser(USER)) === true);
    await db.update(schema.outlookConnections).set({ scopes: "offline_access User.Read" }).where(eq(schema.outlookConnections.userId, USER));
    check("…without mail read it can't", (await canSeeRepliesForUser(USER)) === false);
    check("someone else's mailbox doesn't count", (await canSeeRepliesForUser(OTHER)) === false);
    await db.delete(schema.outlookConnections).where(eq(schema.outlookConnections.userId, USER));

    console.log("checkCampaignRepliesForUser");
    const [c] = await db.insert(schema.outreachCampaigns).values({ userId: USER, name: "Pharma consulting" }).returning();
    const [liC] = await db.insert(schema.outreachCampaigns).values({ userId: USER, name: "LinkedIn", defaultChannel: "linkedin" }).returning();
    const [otherC] = await db.insert(schema.outreachCampaigns).values({ userId: OTHER, name: "Theirs" }).returning();
    const camp = c!.id;
    const otherCamp = otherC!.id;

    const bo = await sentPerson({ campaignId: camp, name: "Bo Li", email: "bo@iqvia.com", sentAt: daysAgo(3) });
    const cy = await sentPerson({ campaignId: camp, name: "Cy Quiet", email: "cy@acme-co.io", sentAt: daysAgo(5), provider: "outlook" });
    await sentPerson({ campaignId: camp, name: "Old Send", email: "old@x.org", sentAt: daysAgo(REPLY_CHECK_WINDOW_DAYS + 1) });
    await sentPerson({ campaignId: camp, name: "Edge Send", email: "edge@x.org", sentAt: daysAgo(REPLY_CHECK_WINDOW_DAYS - 1) });
    const done = await sentPerson({ campaignId: camp, name: "Already Marked", email: "done@x.org", sentAt: daysAgo(4) });
    await db.update(schema.outreachMessages).set({ outcome: "negative_reply" }).where(eq(schema.outreachMessages.id, done.messageId));
    await sentPerson({ campaignId: camp, name: "Demo Send", email: "demo@x.org", sentAt: daysAgo(2), provider: "demo" });
    const noEmail = await sentPerson({ campaignId: camp, name: "No Email", email: null, sentAt: daysAgo(2) });
    const draft = await sentPerson({ campaignId: camp, name: "Still A Draft", email: "draft@x.org", sentAt: daysAgo(2) });
    await db.update(schema.outreachMessages).set({ status: "draft" }).where(eq(schema.outreachMessages.id, draft.messageId));
    await sentPerson({ campaignId: camp, name: "Legacy Id", email: "legacy@x.org", sentAt: daysAgo(2), deliveryId: "re_8f3a-not-a-uuid" });
    await sentPerson({ campaignId: camp, name: "No Delivery", email: "nodelivery@x.org", sentAt: daysAgo(2), deliveryId: null });
    // Their outbox row, not mine: a message may only be looked up through the user's own send.
    const foreignSend = await outboxRow(OTHER, "gmail", "foreign@x.org");
    await sentPerson({ campaignId: camp, name: "Foreign Row", email: "foreign@x.org", sentAt: daysAgo(2), deliveryId: foreignSend });
    const linkedin = await sentPerson({ campaignId: liC!.id, name: "On LinkedIn", email: "li@x.org", sentAt: daysAgo(2) });
    await db.update(schema.outreachMessages).set({ channel: "linkedin" }).where(eq(schema.outreachMessages.id, linkedin.messageId));
    await sentPerson({ campaignId: otherCamp, name: "Their Person", email: "theirs@x.org", sentAt: daysAgo(2), userId: OTHER });

    const seen: { provider: string; addr: string; since: number }[] = [];
    const replyAt = new Date(NOW.getTime() - DAY);
    const lookup: ReplyLookup = async (_u, provider, addr, sinceDate) => {
      seen.push({ provider, addr, since: sinceDate.getTime() });
      return addr === "bo@iqvia.com" ? replyAt : null;
    };
    const seenAddrs = () => seen.map((s) => s.addr);

    const r = await checkCampaignRepliesForUser(USER, camp, { lookup, now: NOW });
    const boRow = await msg(bo.messageId);
    check("reply detected", r.replied === 1 && boRow.outcome === "replied", JSON.stringify(r));
    check("…with the date of the reply", boRow.repliedAt?.getTime() === replyAt.getTime(), String(boRow.repliedAt));
    check("…and the prospect is untouched", (await prospect(bo.prospectId)).status === "selected");
    check("a quiet person stays open", (await msg(cy.messageId)).outcome === null);
    check("the lookup gets the provider that sent it and the send time", seen.some((s) => s.addr === "cy@acme-co.io" && s.provider === "outlook" && s.since === daysAgo(5).getTime()) && seen.some((s) => s.addr === "bo@iqvia.com" && s.provider === "gmail"));
    check("old sends not checked", !seenAddrs().includes("old@x.org"));
    check("a send just inside the window is checked", seenAddrs().includes("edge@x.org"));
    check("a message with an outcome is not checked", !seenAddrs().includes("done@x.org") && (await msg(done.messageId)).outcome === "negative_reply");
    check("a draft is not checked", !seenAddrs().includes("draft@x.org"));
    check("a demo send is skipped", !seenAddrs().includes("demo@x.org"));
    check("a prospect with no email is skipped", !seenAddrs().includes("") && (await msg(noEmail.messageId)).outcome === null);
    check("a v1 delivery id that is not a uuid is skipped, not a crash", !seenAddrs().includes("legacy@x.org"));
    check("a message with no delivery id is skipped", !seenAddrs().includes("nodelivery@x.org"));
    check("another user's outbox row is not followed", !seenAddrs().includes("foreign@x.org"));
    check("a LinkedIn message is not checked", !seenAddrs().includes("li@x.org"));
    check("another user's people are never looked up", !seenAddrs().includes("theirs@x.org"));
    check("checked counts exactly the people looked up", r.checked === 3 && seen.length === 3 && !r.throttled, JSON.stringify([r, seenAddrs()]));
    check("oldest send is looked up first", seenAddrs().join() === "edge@x.org,cy@acme-co.io,bo@iqvia.com", seenAddrs().join());

    const second = await checkCampaignRepliesForUser(USER, camp, { lookup, now: NOW });
    check("throttled within 10 minutes", second.throttled && second.checked === 0 && second.replied === 0, JSON.stringify(second));
    const callsBefore = seen.length;
    await checkCampaignRepliesForUser(USER, camp, { lookup, now: NOW });
    check("a throttled pass looks nothing up", seen.length === callsBefore);

    await resetThrottle(camp);
    seen.length = 0;
    const again = await checkCampaignRepliesForUser(USER, camp, { lookup, now: NOW });
    check("a person who replied is not checked again", !seenAddrs().includes("bo@iqvia.com") && again.checked === 2, JSON.stringify([again, seenAddrs()]));

    seen.length = 0;
    const foreignPass = await checkCampaignRepliesForUser(USER, otherCamp, { lookup, skipThrottle: true, now: NOW });
    check("other tenant's campaign checks nothing", foreignPass.checked === 0 && foreignPass.replied === 0 && seen.length === 0, JSON.stringify(foreignPass));
    const asOther = await checkCampaignRepliesForUser(OTHER, camp, { lookup, skipThrottle: true, now: NOW });
    check("…and my campaign is closed to them", asOther.checked === 0 && seen.length === 0);
    const junkId = await checkCampaignRepliesForUser(USER, "not-a-uuid", { lookup, skipThrottle: true, now: NOW });
    check("a malformed campaign id checks nothing", junkId.checked === 0 && !junkId.throttled);
    await checkCampaignRepliesForUser(USER, otherCamp, { lookup, now: NOW });
    const spent = rowsOf(await db.execute(sql`SELECT 1 FROM rate_limit_buckets WHERE bucket = ${`outreach-reply-check:${USER}:${otherCamp}`}`));
    check("a campaign that isn't mine spends no throttle", spent.length === 0);

    // A manual outcome that lands while the mailbox is being read wins: the UPDATE is guarded.
    await resetThrottle(camp);
    const racer = await sentPerson({ campaignId: camp, name: "Race Person", email: "race@x.org", sentAt: daysAgo(1) });
    const racing: ReplyLookup = async (_u, _p, addr) => {
      if (addr === "race@x.org") {
        await db.update(schema.outreachMessages).set({ outcome: "bounced" }).where(eq(schema.outreachMessages.id, racer.messageId));
        return replyAt;
      }
      return null;
    };
    const raced = await checkCampaignRepliesForUser(USER, camp, { lookup: racing, now: NOW });
    check("a manual outcome in the meantime is not overwritten", raced.replied === 0 && (await msg(racer.messageId)).outcome === "bounced", JSON.stringify(raced));

    // 27 sends: one pass looks at the 25 oldest.
    const [bigC] = await db.insert(schema.outreachCampaigns).values({ userId: USER, name: "Big" }).returning();
    const big: string[] = [];
    for (let i = 0; i < REPLY_CHECKS_PER_PASS + 2; i++) {
      const name = `Big ${String(i).padStart(2, "0")}`;
      big.push(name);
      await sentPerson({ campaignId: bigC!.id, name, email: `big${i}@x.org`, sentAt: daysAgo(40 - i) });
    }
    seen.length = 0;
    const capped = await checkCampaignRepliesForUser(USER, bigC!.id, { lookup, skipThrottle: true, now: NOW });
    check("one pass looks at 25 people", capped.checked === REPLY_CHECKS_PER_PASS && seen.length === REPLY_CHECKS_PER_PASS, JSON.stringify(capped));
    check(
      "…the oldest sends first, by send time",
      seenAddrs()[0] === "big0@x.org" && seenAddrs()[REPLY_CHECKS_PER_PASS - 1] === `big${REPLY_CHECKS_PER_PASS - 1}@x.org` && !seenAddrs().includes(`big${REPLY_CHECKS_PER_PASS}@x.org`),
      seenAddrs().join()
    );
    // Demo rows must not eat the 25 slots.
    const [skewC] = await db.insert(schema.outreachCampaigns).values({ userId: USER, name: "Skew" }).returning();
    for (let i = 0; i < REPLY_CHECKS_PER_PASS; i++) {
      await sentPerson({ campaignId: skewC!.id, name: `Demo ${i}`, email: `demo${i}@x.org`, sentAt: daysAgo(50), provider: "demo" });
    }
    await sentPerson({ campaignId: skewC!.id, name: "Real One", email: "real@x.org", sentAt: daysAgo(2) });
    seen.length = 0;
    const skew = await checkCampaignRepliesForUser(USER, skewC!.id, { lookup, skipThrottle: true, now: NOW });
    check("skipped rows don't use up the pass", skew.checked === 1 && seenAddrs().join() === "real@x.org", JSON.stringify([skew, seenAddrs()]));

    // A slow mailbox: the pass stops starting batches once its budget is spent and says how many
    // people it actually looked up. Five at a time, 60ms each, against a 30ms budget: one batch.
    const [slowC] = await db.insert(schema.outreachCampaigns).values({ userId: USER, name: "Slow" }).returning();
    for (let i = 0; i < 12; i++) await sentPerson({ campaignId: slowC!.id, name: `Slow ${String(i).padStart(2, "0")}`, email: `slow${i}@x.org`, sentAt: daysAgo(30 - i) });
    seen.length = 0;
    const slow: ReplyLookup = async (_u, provider, addr, sinceDate) => {
      seen.push({ provider, addr, since: sinceDate.getTime() });
      await new Promise((resolve) => setTimeout(resolve, 60));
      return null;
    };
    const slowPass = await checkCampaignRepliesForUser(USER, slowC!.id, { lookup: slow, skipThrottle: true, now: NOW, budgetMs: 30 });
    check("a pass out of time stops after the batch it started", slowPass.checked === 5 && seen.length === 5 && !slowPass.throttled, JSON.stringify([slowPass, seenAddrs()]));
    check("…having looked up the oldest five", seenAddrs().join() === "slow0@x.org,slow1@x.org,slow2@x.org,slow3@x.org,slow4@x.org", seenAddrs().join());
    seen.length = 0;
    const fastPass = await checkCampaignRepliesForUser(USER, slowC!.id, { lookup, skipThrottle: true, now: NOW });
    check("the default budget lets a normal pass finish", fastPass.checked === 12 && seen.length === 12, JSON.stringify(fastPass));

    console.log("setMessageOutcomeForUser");
    const out = await sentPerson({ campaignId: camp, name: "Manual Outcome", email: "manual@x.org", sentAt: daysAgo(2) });
    // A contact on the timeline, so the logged outcome has somewhere to go.
    const [contact] = await db.insert(schema.contacts).values({ userId: USER, fullName: "Manual Outcome", email: "manual@x.org" }).returning();
    await db.update(schema.outreachProspects).set({ contactId: contact!.id }).where(eq(schema.outreachProspects.id, out.prospectId));
    const timeline = async () => (await db.select().from(schema.interactions).where(eq(schema.interactions.contactId, contact!.id))).length;
    // A legacy sequence follow-up waiting to go out.
    const [followUp] = await db
      .insert(schema.outreachMessages)
      .values({ prospectId: out.prospectId, channel: "email", body: "Bump", status: "scheduled", stepIndex: 1 })
      .returning();

    await setMessageOutcomeForUser(USER, out.messageId, "positive_reply", "Wants a call", OPTS);
    const o1 = await msg(out.messageId);
    check("positive reply sets the outcome and notes", o1.outcome === "positive_reply" && o1.outcomeNotes === "Wants a call");
    check("outcome change keeps the prospect selected", (await prospect(out.prospectId)).status === "selected");
    check("a reply outcome records when", o1.repliedAt != null && o1.lastActionAt != null);
    check("a reply cancels the scheduled follow-up", (await msg(followUp!.id)).status === "skipped");
    check("the outcome goes on the contact's timeline once", (await timeline()) === 1);

    await setMessageOutcomeForUser(USER, out.messageId, "negative_reply", undefined, OPTS);
    const o2 = await msg(out.messageId);
    check("an outcome that is already set can change", o2.outcome === "negative_reply");
    check("…and the prospect is still selected", (await prospect(out.prospectId)).status === "selected");
    check("…leaving notes alone when none are given", o2.outcomeNotes === "Wants a call");
    check("…keeping the first reply time", o2.repliedAt?.getTime() === o1.repliedAt?.getTime());
    check("…without a second timeline entry", (await timeline()) === 1);

    await setMessageOutcomeForUser(USER, out.messageId, "replied", null, OPTS);
    const o3 = await msg(out.messageId);
    check("replied is accepted", o3.outcome === "replied");
    check("…and null notes clear them", o3.outcomeNotes === null);

    await setMessageOutcomeForUser(USER, out.messageId, "bounced", "  ", OPTS);
    const o4 = await msg(out.messageId);
    check("a bounce is not a reply", o4.outcome === "bounced" && o4.repliedAt === null);
    check("…blank notes are none", o4.outcomeNotes === null);

    // Auto-detected first, refined by hand after.
    await setMessageOutcomeForUser(USER, bo.messageId, "positive_reply", undefined, OPTS);
    const refined = await msg(bo.messageId);
    check("refining a detected reply keeps the detected time", refined.outcome === "positive_reply" && refined.repliedAt?.getTime() === replyAt.getTime(), String(refined.repliedAt));

    const second2 = await sentPerson({ campaignId: camp, name: "Bounce First", email: "bf@x.org", sentAt: daysAgo(2) });
    const [followUp2] = await db
      .insert(schema.outreachMessages)
      .values({ prospectId: second2.prospectId, channel: "email", body: "Bump", status: "scheduled", stepIndex: 1 })
      .returning();
    await setMessageOutcomeForUser(USER, second2.messageId, "bounced", null, OPTS);
    check("a bounce leaves the scheduled follow-up alone", (await msg(followUp2!.id)).status === "scheduled");

    check("someone else's message is not found", await rejects(() => setMessageOutcomeForUser(OTHER, out.messageId, "replied", null, OPTS), "Message not found"));
    check("…and is unchanged", (await msg(out.messageId)).outcome === "bounced");
    check("a malformed message id is not found", await rejects(() => setMessageOutcomeForUser(USER, "nope", "replied", null, OPTS), "Message not found"));
    check("an outcome we don't track is refused", await rejects(() => setMessageOutcomeForUser(USER, out.messageId, "ghosted" as never, null, OPTS)));
    check("…and changes nothing", (await msg(out.messageId)).outcome === "bounced");
  } finally {
    await reset();
  }
  if (failures) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll outreach-replies checks passed.");
}

run(main);
