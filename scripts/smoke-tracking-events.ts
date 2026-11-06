/**
 * The v187 standard tracking, end to end where it can be:
 *
 *   - web vitals: `recordVitals` keeps the largest value per column, drops out-of-range ones,
 *     and never writes onto a soft navigation's row (a soft nav has no LCP);
 *   - the `event` beacon kind admits only `CLIENT_EVENTS`, schema-checked, and dedupes a
 *     retried beacon;
 *   - last touch: the proxy overwrites `orbit_attr_last` on every channel-bearing landing and
 *     leaves `orbit_attr` alone; signup writes both, once;
 *   - Resend engagement: delivered / opened / clicked land on the matching outreach send,
 *     idempotently, earliest time winning;
 *   - `search_performed` is sampled to one per user per surface per 10 seconds.
 *
 * Run: npx tsx scripts/smoke-tracking-events.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { createHmac, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { NextRequest, type NextFetchEvent, type NextResponse } from "next/server";
import { getDb } from "../src/db";
import { outreachCampaigns, outreachMessages, outreachProspects, pageViews, productEvents, userSettings } from "../src/db/schema";
import { MAX_VITAL_MS, recordVitals } from "../src/lib/page-views";
import { ATTRIBUTION_COOKIE, LAST_TOUCH_COOKIE, parseAttribution, parseLastTouch } from "../src/lib/attribution-parse";
import { recordFirstTouch } from "../src/lib/attribution";
import { ensureUserSettings } from "../src/lib/user-settings";
import { errorKindOf } from "../src/lib/client-events";
import { resetSearchSampling, SEARCH_SAMPLE_MS, trackSearchPerformed } from "../src/lib/search-events";
import { checker } from "./smoke/check";

const WAITLIST = "join.orbit-tracking-smoke.example";

run(async () => {
  const t = checker();
  const db = await getDb();

  // --- web vitals --------------------------------------------------------------------------
  console.log("web vitals");
  const view = (navType: "hard" | "soft" | null) => ({
    id: randomUUID(),
    visitorHash: "smoke-vitals",
    sessionId: randomUUID(),
    userId: null,
    route: "/__smoke-vitals",
    referrerHost: null,
    utmSource: null,
    utmMedium: null,
    utmCampaign: null,
    country: null,
    region: null,
    city: null,
    device: "desktop" as const,
    isBot: false,
    navType,
  });
  const read = async (id: string) => (await db.select().from(pageViews).where(eq(pageViews.id, id)))[0];

  const first = view(null);
  await db.insert(pageViews).values(first);
  await recordVitals(first.id, { lcpMs: 1200, clsMilli: 50 });
  await recordVitals(first.id, { lcpMs: 900, inpMs: 80, clsMilli: 120 });
  await recordVitals(first.id, { lcpMs: 1200.4 });
  let row = await read(first.id);
  t.check("each vital keeps the largest value reported (monotonic, like dwell)", row?.lcpMs === 1200 && row?.inpMs === 80 && row?.clsMilli === 120, JSON.stringify({ lcp: row?.lcpMs, inp: row?.inpMs, cls: row?.clsMilli }));

  await recordVitals(first.id, { lcpMs: MAX_VITAL_MS + 1, inpMs: -1, clsMilli: Number.NaN });
  row = await read(first.id);
  t.check("out-of-range values are dropped, not clamped", row?.lcpMs === 1200 && row?.inpMs === 80 && row?.clsMilli === 120);

  const soft = view("soft");
  await db.insert(pageViews).values(soft);
  await recordVitals(soft.id, { lcpMs: 500, inpMs: 40, clsMilli: 10 });
  row = await read(soft.id);
  t.check("a soft navigation's row never gets vitals (first view only)", row?.lcpMs === null && row?.inpMs === null && row?.clsMilli === null);

  const hard = view("hard");
  await db.insert(pageViews).values(hard);
  await recordVitals(hard.id, { lcpMs: 700 });
  t.check("a hard (document) view takes them", (await read(hard.id))?.lcpMs === 700);

  // --- the event beacon kind, through the real route ----------------------------------------
  console.log("\nclient event kind");
  process.env.ANALYTICS_SALT = "smoke-salt-at-least-16-chars";
  const { POST: beacon } = await import("../src/app/api/p/v/route");
  const send = (body: Record<string, unknown>) =>
    beacon(
      new Request("https://orbit.example/api/p/v", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: "orbit.example",
          "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
          "x-forwarded-for": "203.0.113.9",
        },
        body: JSON.stringify(body),
      })
    );
  const eventsNamed = async (name: string) =>
    (await db.select().from(productEvents).where(eq(productEvents.name, name))).length;

  const beforeShown = await eventsNamed("notification_shown");
  const res = await send({ kind: "event", id: randomUUID(), name: "notification_shown", props: { kind: "due" } });
  t.check("the route answers 204", res.status === 204);
  t.check("an allow-listed client event is recorded", (await eventsNamed("notification_shown")) === beforeShown + 1);

  const retryId = randomUUID();
  const beforeError = await eventsNamed("error_shown");
  await send({ kind: "event", id: retryId, name: "error_shown", props: { where: "boundary.app", error_kind: "render" } });
  await send({ kind: "event", id: retryId, name: "error_shown", props: { where: "boundary.app", error_kind: "render" } });
  t.check("a retried beacon (same client id) records once", (await eventsNamed("error_shown")) === beforeError + 1);

  const beforeServerOnly = await eventsNamed("capture_saved");
  await send({ kind: "event", id: randomUUID(), name: "capture_saved", props: { capture_job_id: randomUUID(), source_kind: "text", people_created: 1, people_updated: 0 } });
  t.check("a server-only event name is rejected", (await eventsNamed("capture_saved")) === beforeServerOnly);
  await send({ kind: "event", id: randomUUID(), name: "made_up_event", props: {} });
  t.check("an unknown event name is rejected", (await db.select().from(productEvents).where(eq(productEvents.name, "made_up_event" as never))).length === 0);

  const beforeBad = await eventsNamed("notification_clicked");
  await send({ kind: "event", id: randomUUID(), name: "notification_clicked", props: { kind: "free text the client made up" } });
  t.check("a property outside its enum is rejected", (await eventsNamed("notification_clicked")) === beforeBad);
  await send({ kind: "event", id: randomUUID(), name: "notification_clicked", props: { kind: "due", extra: "smuggled" } });
  const clicked = await db.select().from(productEvents).where(eq(productEvents.name, "notification_clicked"));
  t.check("an unknown property is stripped, never stored", clicked.length === beforeBad + 1 && clicked.every((e) => !JSON.stringify(e.properties).includes("smuggled")));

  t.check("error kinds are coarse and never the message", errorKindOf(Object.assign(new Error("Loading chunk 42 failed"), { name: "ChunkLoadError" })) === "chunk_load" && errorKindOf(Object.assign(new Error("x"), { digest: "123" })) === "server" && errorKindOf(new Error("x")) === "render" && errorKindOf(new Error("x"), true) === "network" && errorKindOf("thrown string") === "unknown");

  // --- last touch ---------------------------------------------------------------------------
  console.log("\nlast touch");
  process.env.WAITLIST_HOST = WAITLIST;
  const { default: proxy } = await import("../src/proxy");
  const event = { waitUntil() {} } as unknown as NextFetchEvent;
  async function land(url: string, referer: string | null, cookie?: string) {
    const req = new NextRequest(url, { headers: { host: WAITLIST, ...(referer ? { referer } : {}), ...(cookie ? { cookie } : {}) } });
    const response = (await proxy(req, event)) as NextResponse;
    return {
      first: response.cookies.get(ATTRIBUTION_COOKIE)?.value ?? null,
      last: response.cookies.get(LAST_TOUCH_COOKIE)?.value ?? null,
    };
  }
  const reddit = await land(`https://${WAITLIST}/`, "https://www.reddit.com/r/crm");
  t.check("a first channel-bearing landing sets both cookies", parseAttribution(reddit.first)?.referrer === "reddit.com" && parseLastTouch(reddit.last)?.attribution.referrer === "reddit.com");

  const cookie = `${ATTRIBUTION_COOKIE}=${encodeURIComponent(reddit.first!)}; ${LAST_TOUCH_COOKIE}=${encodeURIComponent(reddit.last!)}`;
  const news = await land(`https://${WAITLIST}/?utm_source=newsletter&utm_medium=email&utm_campaign=nov`, null, cookie);
  t.check("a later channel-bearing landing overwrites last touch", parseLastTouch(news.last)?.attribution.utmSource === "newsletter");
  t.check("…and leaves first touch alone", news.first === null);

  const direct = await land(`https://${WAITLIST}/pricing`, null, cookie);
  t.check("a direct visit touches neither cookie", direct.first === null && direct.last === null);
  const roundTrip = await land(`https://${WAITLIST}/`, "https://accounts.google.com/o/oauth2", cookie);
  t.check("an OAuth round trip is not a last touch (ROUND_TRIP_HOSTS)", roundTrip.last === null);

  const user = `user_smokeLastTouch${Date.now()}`;
  await ensureUserSettings(user);
  const lastTouch = parseLastTouch(news.last)!;
  await recordFirstTouch(user, parseAttribution(reddit.first)!, "cookie", lastTouch);
  await recordFirstTouch(user, parseAttribution(news.last)!, "cookie", parseLastTouch(reddit.last));
  const [settings] = await db.select().from(userSettings).where(eq(userSettings.userId, user));
  t.check(
    "signup stores first touch AND last touch, once",
    settings?.signupReferrer === "reddit.com" &&
      settings?.lastTouchSource === "newsletter" &&
      settings?.lastTouchMedium === "email" &&
      settings?.lastTouchCampaign === "nov" &&
      settings?.lastTouchLandingPath === "/" &&
      settings?.lastTouchAt instanceof Date,
    JSON.stringify({ first: settings?.signupReferrer, last: settings?.lastTouchSource })
  );

  // --- Resend engagement --------------------------------------------------------------------
  console.log("\nResend engagement");
  const KEY = Buffer.from("smoke-tracking-resend-key-not-real");
  const SECRET = `whsec_${KEY.toString("base64")}`;
  process.env.RESEND_WEBHOOK_SECRET = SECRET;
  const { POST: resend } = await import("../src/app/api/webhooks/resend/route");
  const deliver = async (type: string, emailId: string, createdAt: string) => {
    const body = JSON.stringify({ type, created_at: createdAt, data: { email_id: emailId, to: ["prospect@example.com"] } });
    const id = `msg_${randomUUID()}`;
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = createHmac("sha256", KEY).update(`${id}.${ts}.${body}`).digest("base64");
    return resend(
      new Request("http://localhost/api/webhooks/resend", {
        method: "POST",
        headers: { "content-type": "application/json", "svix-id": id, "svix-timestamp": ts, "svix-signature": `v1,${sig}` },
        body,
      }) as never
    );
  };

  const [campaign] = await db.insert(outreachCampaigns).values({ userId: user, name: "Smoke engagement" }).returning();
  const [prospect] = await db.insert(outreachProspects).values({ campaignId: campaign.id, externalId: `p-${randomUUID()}`, fullName: "P" }).returning();
  const emailId = `re_${randomUUID()}`;
  const [message] = await db.insert(outreachMessages).values({ prospectId: prospect.id, channel: "email", body: "hi", status: "sent", deliveryId: emailId }).returning();
  const msg = async () => (await db.select().from(outreachMessages).where(eq(outreachMessages.id, message.id)))[0];

  const T1 = "2026-11-05T10:00:00.000Z";
  const T0 = "2026-11-05T09:00:00.000Z";
  const T2 = "2026-11-05T11:00:00.000Z";
  t.check("delivered is accepted", (await deliver("email.delivered", emailId, T1)).status === 200);
  await deliver("email.opened", emailId, T1);
  await deliver("email.clicked", emailId, T1);
  let m = await msg();
  t.check("delivered_at / opened_at / clicked_at are stamped", m?.deliveredAt?.toISOString() === T1 && m?.openedAt?.toISOString() === T1 && m?.clickedAt?.toISOString() === T1);

  await deliver("email.opened", emailId, T2);
  await deliver("email.delivered", emailId, T1);
  m = await msg();
  t.check("a redelivered or later event changes nothing (idempotent)", m?.openedAt?.toISOString() === T1 && m?.deliveredAt?.toISOString() === T1);

  await deliver("email.opened", emailId, T0);
  t.check("an earlier event arriving late wins (first timestamp wins)", (await msg())?.openedAt?.toISOString() === T0);

  t.check("an event for an email Orbit has no send for is still a 200", (await deliver("email.opened", `re_${randomUUID()}`, T1)).status === 200);
  delete process.env.RESEND_WEBHOOK_SECRET;

  // --- search sampling ----------------------------------------------------------------------
  console.log("\nsearch_performed sampling");
  resetSearchSampling();
  const searcher = `user_smokeSearch${Date.now()}`;
  const bucketStart = Math.ceil(Date.now() / SEARCH_SAMPLE_MS) * SEARCH_SAMPLE_MS + 5 * SEARCH_SAMPLE_MS;
  for (const [i, q] of ["a", "an", "ann", "anna"].entries()) {
    trackSearchPerformed({ userId: searcher, surface: "command_palette", query: q, resultCount: 3, now: bucketStart + i * 100 });
  }
  trackSearchPerformed({ userId: searcher, surface: "contacts_page", query: "anna", resultCount: 5000, now: bucketStart });
  trackSearchPerformed({ userId: searcher, surface: "command_palette", query: "x".repeat(200), resultCount: 1, now: bucketStart + SEARCH_SAMPLE_MS });
  trackSearchPerformed({ userId: searcher, surface: "command_palette", query: "   ", resultCount: 0, now: bucketStart + 2 * SEARCH_SAMPLE_MS });
  // `track()` writes in a detached promise outside a request; give it a beat.
  let mine: (typeof productEvents.$inferSelect)[] = [];
  for (let i = 0; i < 40; i++) {
    mine = (await db.select().from(productEvents).where(eq(productEvents.userId, searcher))).filter((e) => e.name === "search_performed");
    if (mine.length >= 3) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  const palette = mine.filter((e) => (e.properties as { surface: string }).surface === "command_palette");
  t.check("a typing burst is one event per surface per 10 s", palette.length === 2 && mine.length === 3, `got ${mine.length}`);
  const props = mine.map((e) => e.properties as { query_length: number; result_count: number });
  t.check("lengths and counts are capped; the text is never stored", props.some((p) => p.query_length === 64) && props.some((p) => p.result_count === 1000) && mine.every((e) => !JSON.stringify(e.properties).includes("anna")));

  t.done("tracking events");
});
