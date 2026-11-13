/**
 * How Radar reaches people (Radar revision PR 9b): same-day alerts, push, the emails, the bell
 * and the dashboard briefing.
 *
 *   - Only Today items alert, only in the person's waking hours, at most two cards a local day,
 *     and never twice for the same card.
 *   - The same-day email goes out at most once a day, only with its switch on; a refused send
 *     gives the day back. Its one-click link turns off that email and nothing else.
 *   - A push never names anyone; a subscription the push service says is gone is deleted.
 *   - The Monday email groups the week by Today and lane and counts the web finds.
 *   - The bell counts Today's moments; the briefing leads with them.
 *
 * Writes to local PGlite. Run: npx tsx scripts/smoke-radar-reach.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { eq, like } from "drizzle-orm";
import { getDb } from "../src/db";
import { pushSubscriptions, radarOpportunities, rateLimitBuckets, recommendations, userSettings } from "../src/db/schema";
import { loadNotificationPanel } from "../src/lib/notification-panel";
import { parsePushSubscription, type PushTransport } from "../src/lib/push";
import { buildRadarDigestEmail, buildRadarMomentEmail, digestSections, findsSummary } from "../src/lib/radar/digest-email";
import { radarMomentUnsubscribeUrl, unsubscribeRadarMoments, type DigestDeliver, type DigestMessage } from "../src/lib/radar/digest";
import { momentPushText, sendRadarMoments } from "../src/lib/radar/moments";
import { loadRadarBriefing } from "../src/lib/radar/page-data";
import { briefingHeadline } from "../src/lib/radar/briefing";
import { RECOMMENDATION_KINDS, type RecommendationKind } from "../src/lib/radar/types";
import { ensureUserSettings } from "../src/lib/user-settings";
import { checker } from "./smoke/check";
import { fakeUserId, insertContact, purgeUsers } from "./smoke/factories";

const t = checker();
const DAY = 86_400_000;
/** Noon UTC today: inside the window for an account on UTC. */
const NOON = new Date(new Date().toISOString().slice(0, 10) + "T12:00:00Z");

run(async () => {
  const db = await getDb();
  const ALL = fakeUserId("reach-all");
  const NOMAIL = fakeUserId("reach-nomail");
  const FAIL = fakeUserId("reach-fail");
  const OFF = fakeUserId("reach-off");
  const users = [ALL, NOMAIL, FAIL, OFF];
  try {
    await db.delete(rateLimitBuckets).where(like(rateLimitBuckets.bucket, "%reach-%"));
    for (const u of users) {
      await ensureUserSettings(u);
      await db
        .update(userSettings)
        .set({ email: `${u}@example.com`, radarDigestTz: "UTC", radarEnabledAt: u === OFF ? null : new Date(NOON.getTime() - 10 * DAY), radarLastRunAt: NOON, radarPaused: 0, radarMomentEmailEnabled: u === NOMAIL ? 0 : 1 })
        .where(eq(userSettings.userId, u));
    }
    const card = async (userId: string, n: number, kind: RecommendationKind, bucket: "today" | "soon", score: number) => {
      const c = (await insertContact(db, userId, n, { fullName: `Person ${userId.slice(-4)}-${n}` }))!;
      const [row] = await db
        .insert(recommendations)
        .values({ userId, contactId: c.id, kind, score, bucket, expiresAt: new Date(Date.now() + 30 * DAY), inputsHash: `h${n}`, reasons: [{ code: "x", label: `Reason ${n}`, points: 30 }] })
        .returning();
      return { id: row!.id, name: c.fullName };
    };
    const a1 = await card(ALL, 1, "follow_up", "today", 90);
    const a2 = await card(ALL, 2, "prep", "today", 80);
    const a3 = await card(ALL, 3, "heads_up", "today", 70);
    await card(ALL, 4, "reconnect", "soon", 95);
    await card(ALL, 5, "introduce", "soon", 40);
    await card(NOMAIL, 1, "follow_up", "today", 50);
    await card(FAIL, 1, "follow_up", "today", 50);
    await card(OFF, 1, "follow_up", "today", 50);
    await db.insert(radarOpportunities).values({ userId: ALL, kind: "event", title: "Climate Meetup", url: "https://example.com/e", startsAt: new Date(Date.now() + 5 * DAY), expiresAt: new Date(Date.now() + 5 * DAY), dedupeKey: "e1" });

    const subs = [
      { userId: ALL, endpoint: `https://push.example.com/${ALL}/keep`, p256dh: "BKeep", auth: "aKeep" },
      { userId: ALL, endpoint: `https://push.example.com/${ALL}/gone`, p256dh: "BGone", auth: "aGone" },
      { userId: NOMAIL, endpoint: `https://push.example.com/${NOMAIL}/nomail`, p256dh: "BNm", auth: "aNm" },
    ];
    await db.insert(pushSubscriptions).values(subs);

    const pushed: { endpoint: string; payload: { title: string; body: string; url: string } }[] = [];
    const push: PushTransport = async (target, payload) => {
      pushed.push({ endpoint: target.endpoint, payload: JSON.parse(payload) });
      return { statusCode: target.endpoint.endsWith("/gone") ? 410 : 201 };
    };
    const mails: DigestMessage[] = [];
    const deliver: DigestDeliver = async (m) => {
      mails.push(m);
      return m.to.startsWith(FAIL) ? { ok: false, error: "refused" } : { ok: true };
    };
    const reports: string[] = [];
    const report = async (f: { userId: string }) => void reports.push(f.userId);
    const mailsTo = (u: string) => mails.filter((m) => m.to.startsWith(u));
    // The cards that went out, once each however many devices they reached.
    const cardsPushed = (ids: string[]) => ids.filter((id) => pushed.some((p) => p.payload.url.includes(id)));

    console.log("same-day alerts");
    await sendRadarMoments(new Date(NOON.getTime() - 6 * 3600_000), { push, deliver, report });
    t.check("nothing goes out before the person's waking hours", pushed.length === 0 && mails.length === 0);

    await sendRadarMoments(NOON, { push, deliver, report });
    const first = cardsPushed([a1.id, a2.id, a3.id]);
    t.check("the best two Today cards alert, and no more", first.join() === [a1.id, a2.id].join(), first.join());
    t.check("each to every device the person turned push on for", pushed.filter((p) => p.payload.url.includes(a1.id)).length === 2);
    t.check("a push names nobody", pushed.every((p) => !/Person /.test(`${p.payload.title} ${p.payload.body}`)));
    const left = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, ALL));
    t.check("a subscription the push service calls gone is deleted", left.length === 1 && left[0]!.endpoint.endsWith("/keep"));
    t.check("one same-day email, with both cards", mailsTo(ALL).length === 1 && mailsTo(ALL)[0]!.html.includes(a1.name) && mailsTo(ALL)[0]!.html.includes(a2.name));
    t.check("its subject counts and names nobody", mailsTo(ALL)[0]!.subject === "2 things on Radar won’t keep" && !mailsTo(ALL)[0]!.subject.includes("Person"));
    t.check("it carries its own one-click link", mailsTo(ALL)[0]!.unsubscribeUrl.includes("kind=moment"));
    t.check("with the email off, the push still goes and no email", pushed.some((p) => p.endpoint.endsWith("/nomail")) && mailsTo(NOMAIL).length === 0);
    t.check("an account with Radar off gets nothing", mailsTo(OFF).length === 0);

    const before = pushed.length;
    await sendRadarMoments(new Date(NOON.getTime() + 3 * 3600_000), { push, deliver, report });
    t.check("later the same day: the cap holds, nothing new", pushed.length === before && mailsTo(ALL).length === 1);

    const [failRow] = await db.select().from(userSettings).where(eq(userSettings.userId, FAIL));
    t.check("a refused email gives the day back, and is reported once", failRow?.radarMomentLastDay === null && reports.filter((r) => r === FAIL).length === 1, String(failRow?.radarMomentLastDay));

    await sendRadarMoments(new Date(NOON.getTime() + DAY), { push, deliver, report });
    const nextDay = pushed.slice(before).filter((p) => p.endpoint.includes(ALL));
    t.check("the next day only the card not yet alerted goes out", nextDay.length === 1 && nextDay[0]!.payload.url.includes(a3.id), nextDay.map((p) => p.payload.url).join());
    t.check("and a new day may bring one more email", mailsTo(ALL).length === 2 && mailsTo(ALL)[1]!.subject === "1 thing on Radar won’t keep");

    console.log("\nunsubscribe and push input");
    const token = new URL(radarMomentUnsubscribeUrl(ALL)).searchParams.get("token");
    t.check("the same-day link turns that email off", await unsubscribeRadarMoments(token));
    const [allRow] = await db.select().from(userSettings).where(eq(userSettings.userId, ALL));
    t.check("and leaves the Monday email alone", allRow?.radarMomentEmailEnabled === 0 && allRow.radarDigestEnabled === 1);
    const neverSent = fakeUserId("reach-never");
    users.push(neverSent);
    await ensureUserSettings(neverSent);
    t.check("a link for an account never sent one does nothing", !(await unsubscribeRadarMoments(new URL(radarMomentUnsubscribeUrl(neverSent)).searchParams.get("token"))));
    t.check("a forged token does nothing", !(await unsubscribeRadarMoments("not-a-token")));

    // Shaped like a browser's PushSubscription.toJSON() (an 87-char P-256 key, a 22-char auth
    // secret, both base64url) but built here, so no secret-shaped literal sits in the repo.
    const good = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: `B${"A".repeat(86)}`, auth: "a".repeat(22) } };
    t.check("a real browser subscription is accepted", parsePushSubscription(good) !== null);
    t.check("a plain-http endpoint is refused", parsePushSubscription({ ...good, endpoint: "http://fcm.googleapis.com/x" }) === null);
    t.check("a local endpoint is refused", parsePushSubscription({ ...good, endpoint: "https://127.0.0.1/x" }) === null);
    t.check("keys that aren't base64url are refused", parsePushSubscription({ ...good, keys: { p256dh: "<script>", auth: "x" } }) === null);
    t.check("every kind has push text that opens its card", RECOMMENDATION_KINDS.every((k) => momentPushText({ id: "id1", kind: k }).url === "/radar?focus=id1"));

    console.log("\nthe emails");
    const people = [
      { id: "1", name: "Marcus", kind: "follow_up" as const, company: null, line: "Asked for your deck", hasDraft: true, today: true },
      { id: "2", name: "Priya", kind: "heads_up" as const, company: "Stripe", line: "New role", hasDraft: false },
      { id: "3", name: "Tom", kind: "introduce" as const, company: null, line: "Hiring", hasDraft: false },
    ];
    t.check("the Monday email groups by Today, then lane", digestSections(people).map((sec) => sec.title).join(",") === "Today,Follow up,Connect");
    const finds = { events: 2, people: 1, programs: 0, nextEvent: { title: "Climate Meetup", startsAt: "2026-11-20T18:00:00Z" } };
    t.check("and counts the finds in one line", findsSummary(finds) === "Climate Meetup · Fri, Nov 20 · + 1 more event, 1 person to meet", findsSummary(finds) ?? "");
    const monday = buildRadarDigestEmail({ people, total: 3, drafts: 1, finds }, { appUrl: "https://orbit.example", unsubscribeUrl: "https://orbit.example/u" });
    const order = ["Today", "Follow up", "Connect", "Opportunities"].map((h) => monday.html.indexOf(`>${h}</td>`));
    t.check("its sections appear in order", order.every((i, n) => i > 0 && (n === 0 || i > order[n - 1]!)), order.join());
    const escaped = buildRadarMomentEmail([{ id: "x", name: "<b>Eve</b>", kind: "follow_up", line: "a & b", hasDraft: false }], { appUrl: "https://o", unsubscribeUrl: "https://o/u" });
    t.check("the same-day email escapes what it shows", escaped.html.includes("&lt;b&gt;Eve&lt;/b&gt;") && !escaped.html.includes("<b>Eve</b>"));

    console.log("\nthe bell and the briefing");
    const panel = await loadNotificationPanel(ALL, new Date(), { withAlerts: false, radar: true });
    t.check("the bell counts Today's moments", panel.radar?.today === 3 && (panel.radar?.todayNames.length ?? 0) === 2, JSON.stringify(panel.radar));
    const briefing = await loadRadarBriefing(ALL);
    t.check("the briefing leads with Today", briefing.today === 3 && briefing.top.every((r) => r.bucket === "today"), briefing.top.map((r) => r.bucket).join());
    t.check("and counts the week by lane, finds included", briefing.lanes.followUp === 4 && briefing.lanes.connect === 1 && briefing.lanes.opportunities === 1, JSON.stringify(briefing.lanes));
    t.check("its headline says what won't keep", briefingHeadline(3) === "Three things won’t keep today" && briefingHeadline(0, 4) === "4 moves on this week’s plan");
  } finally {
    await purgeUsers(db, users);
    await db.delete(rateLimitBuckets).where(like(rateLimitBuckets.bucket, "%reach-%"));
  }

  t.done("radar reach");
});
