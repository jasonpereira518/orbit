/**
 * Guards the traffic analytics pipeline: `page_views`, its ingest helpers, and the
 * aggregates behind `/admin/analytics`.
 *
 * Five of these assertions exist because the failure they catch is SILENT. A route with no
 * pattern lands in "/unknown" and just stops being reported. A contact id reaching `route`
 * poisons a table nobody reads row-by-row. A dwell of NULL summed as zero drags every
 * median down without ever looking wrong. None of it shows up in a rendered page.
 *
 * Run: npx tsx scripts/smoke-admin-analytics.ts
 */
import "./smoke/_env";

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import { billingEvents, contacts, pageViews, userSettings } from "../src/db/schema";
import {
  ROUTE_PATTERNS,
  UNKNOWN_ROUTE,
  isTrackedPath,
  normalizeRoute,
} from "../src/lib/analytics-routes";
import { isBotUserAgent } from "../src/lib/analytics-bots";
import {
  analyticsEnabled,
  deviceFromUserAgent,
  hashVisitor,
} from "../src/lib/analytics-visitor";
import { MAX_DWELL_MS, prunePageViews, recordDwell, recordPageView } from "../src/lib/page-views";
import {
  deviceBreakdown,
  geoBreakdown,
  sourceBreakdown,
  topRoutes,
  trafficTotals,
  trafficTrend,
  acquisitionFunnel,
  formatRate,
  accountTraffic,
  topAccountsByTraffic,
} from "../src/lib/admin-analytics";
import { startQueryCount, stopQueryCount, capturedQueries } from "../src/lib/query-counter";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

// --- 1. Route coverage --------------------------------------------------------------
//
// Walks src/app the way smoke-public-routes.ts does. A page added without a pattern in
// ROUTE_PATTERNS disappears from the traffic report and nothing else complains.

const APP_DIR = "src/app";

function appRoutes(dir = APP_DIR, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry.startsWith("_") || entry === "api") continue;
      const segment = entry.startsWith("(") && entry.endsWith(")") ? "" : `/${entry}`;
      out.push(...appRoutes(full, prefix + segment));
    } else if (entry === "page.tsx") {
      out.push(prefix === "" ? "/" : prefix);
    }
  }
  return out;
}

console.log("route coverage");
const routes = appRoutes();
check("found pages under src/app", routes.length > 20, `saw ${routes.length}`);

for (const route of routes) {
  // Admin is deliberately untracked; it must not need a pattern.
  if (!isTrackedPath(route.replace(/\[\[?\.{3}[^\]]+\]?\]/g, "x").replace(/\[[^\]]+\]/g, "x"))) continue;
  // Substitute a plausible value for each dynamic segment, as a real request would carry.
  const concrete = route
    .replace(/\[\[?\.{3}[^\]]+\]?\]/g, "factor-one")
    .replace(/\[[^\]]+\]/g, randomUUID());
  const got = normalizeRoute(concrete);
  check(
    `${route} -> a known pattern`,
    got !== UNKNOWN_ROUTE,
    `normalizeRoute(${concrete}) = ${got}; add a pattern to ROUTE_PATTERNS`
  );
}

// --- 2. No raw identifiers ever reach the column ------------------------------------

console.log("\nidentifier containment");
const uuid = randomUUID();
for (const path of [
  `/contacts/${uuid}`,
  `/events/${uuid}`,
  `/outreach/${uuid}`,
  `/recruiters/${uuid}`,
  `/capture/${uuid}`,
]) {
  const got = normalizeRoute(path);
  check(`${path} carries no id through`, !got.includes(uuid), `got ${got}`);
}
check(
  "static beats dynamic at the same depth",
  normalizeRoute("/contacts/new") === "/contacts/new" &&
    normalizeRoute("/recruiters/compose") === "/recruiters/compose",
  `${normalizeRoute("/contacts/new")} / ${normalizeRoute("/recruiters/compose")}`
);
check("unrecognised paths collapse to one bucket", normalizeRoute("/nope/x") === UNKNOWN_ROUTE);
check("admin is not tracked", !isTrackedPath("/admin") && !isTrackedPath("/admin/analytics"));
check("api is not tracked", !isTrackedPath("/api/track"));
check("marketing is tracked", isTrackedPath("/") && isTrackedPath("/pricing"));
check(
  "every pattern is itself a tracked path",
  ROUTE_PATTERNS.every((p) => isTrackedPath(p.replace(/\[.*$/, "")) || p === "/")
);

// --- 3. Visitor hashing --------------------------------------------------------------

console.log("\nvisitor identity");
const savedSalt = process.env.ANALYTICS_SALT;
delete process.env.ANALYTICS_SALT;
check("disabled without a salt", !analyticsEnabled());
let threw = false;
try {
  hashVisitor("1.2.3.4", "Mozilla/5.0");
} catch {
  threw = true;
}
check("refuses to hash unsalted rather than degrading", threw);

process.env.ANALYTICS_SALT = "smoke-salt-at-least-16-chars";
check("enabled with a salt", analyticsEnabled());

const day1 = new Date("2026-09-06T10:00:00Z");
const day1Late = new Date("2026-09-06T23:59:00Z");
const day2 = new Date("2026-09-07T00:01:00Z");
const h1 = hashVisitor("1.2.3.4", "UA", day1);
check("stable within a UTC day", h1 === hashVisitor("1.2.3.4", "UA", day1Late));
check("rotates across the UTC day boundary", h1 !== hashVisitor("1.2.3.4", "UA", day2));
check("differs by ip", h1 !== hashVisitor("5.6.7.8", "UA", day1));
check("differs by user agent", h1 !== hashVisitor("1.2.3.4", "OTHER", day1));
check("stores no ip in the digest", !h1.includes("1.2.3.4") && /^[0-9a-f]{64}$/.test(h1));

// --- 4. Bots and devices -------------------------------------------------------------

console.log("\nbot + device classification");
for (const ua of [
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  "HeadlessChrome/120.0.0.0",
  "python-requests/2.31.0",
  "curl/8.4.0",
  "Mozilla/5.0 AppleWebKit Chrome-Lighthouse",
]) {
  check(`bot: ${ua.slice(0, 32)}`, isBotUserAgent(ua));
}
check("empty agent counts as a bot", isBotUserAgent("") && isBotUserAgent(null));
const realChrome =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const realIphone =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
check("a real browser is not a bot", !isBotUserAgent(realChrome) && !isBotUserAgent(realIphone));
check("desktop detected", deviceFromUserAgent(realChrome) === "desktop");
check("mobile detected", deviceFromUserAgent(realIphone) === "mobile");
check(
  "tablet detected",
  deviceFromUserAgent(
    "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1"
  ) === "tablet"
);

async function main() {
  // --- 5. Aggregates against real rows -------------------------------------------------

  console.log("\naggregates");

  const db = await getDb();
  const now = new Date();
  const ago = (mins: number) => new Date(now.getTime() - mins * 60_000);

  // `scripts/run-smoke.ts` gives the WHOLE SUITE one shared PGlite directory, so this
  // script sees whatever ran before it. No other script writes page_views, so clearing it
  // makes the traffic assertions exact; the account-based funnel stages below cannot do
  // the same — half the suite creates users — and are asserted as deltas instead.
  await db.delete(pageViews);

  /**
   * Three sessions, hand-built so every derived number has a known answer:
   *   s1  visitor A, 3 views over 10 minutes, last view dwelt 30s  -> 630s, not a bounce
   *   s2  visitor B, 1 view, no dwell recorded                     ->   0s, a bounce
   *   s3  visitor A (same day), 2 views over 4 minutes             -> 240s, not a bounce
   * Plus one bot row that must never appear in any total.
   */
  const s1 = randomUUID();
  const s2 = randomUUID();
  const s3 = randomUUID();
  const visitorA = hashVisitor("10.0.0.1", "UA-A", now);
  const visitorB = hashVisitor("10.0.0.2", "UA-B", now);
  const lastOfS1 = randomUUID();

  const base = {
    userId: null,
    referrerHost: null,
    utmSource: null,
    utmMedium: null,
    utmCampaign: null,
    country: null,
    region: null,
    city: null,
    device: "desktop" as const,
    isBot: false,
  };

  await db.insert(pageViews).values([
    { ...base, id: randomUUID(), visitorHash: visitorA, sessionId: s1, route: "/", createdAt: ago(20), country: "US", region: "California", city: "San Francisco", referrerHost: "news.ycombinator.com" },
    { ...base, id: randomUUID(), visitorHash: visitorA, sessionId: s1, route: "/pricing", createdAt: ago(15), country: "US", region: "California", city: "San Francisco" },
    { ...base, id: lastOfS1, visitorHash: visitorA, sessionId: s1, route: "/interest", createdAt: ago(10), country: "US", region: "California", city: "San Francisco" },
    { ...base, id: randomUUID(), visitorHash: visitorB, sessionId: s2, route: "/", createdAt: ago(30), country: "GB", region: "England", city: "London", utmCampaign: "launch", utmSource: "twitter" },
    { ...base, id: randomUUID(), visitorHash: visitorA, sessionId: s3, route: "/dashboard", createdAt: ago(9), userId: "user_x", device: "mobile" },
    { ...base, id: randomUUID(), visitorHash: visitorA, sessionId: s3, route: "/contacts/[id]", createdAt: ago(5), userId: "user_x", device: "mobile" },
    { ...base, id: randomUUID(), visitorHash: hashVisitor("10.0.0.9", "bot", now), sessionId: randomUUID(), route: "/", createdAt: ago(2), isBot: true },
  ]);

  // The exit beacon landing on the last view of s1.
  await recordDwell(lastOfS1, 30_000);

  const totals = await trafficTotals("30d");
  check("views exclude bots", totals.views === 6, `got ${totals.views}`);
  check("bot views are counted separately", totals.botViews === 1, `got ${totals.botViews}`);
  check("sessions counted", totals.sessions === 3, `got ${totals.sessions}`);
  check(
    "visitor-days collapse one visitor's two sessions",
    totals.visitorDays === 2,
    `got ${totals.visitorDays} (visitor A twice in a day is ONE visitor-day)`
  );
  check("signed-in views split out", totals.signedInViews === 2, `got ${totals.signedInViews}`);
  check(
    "one-view session is a bounce",
    totals.bouncedSessions === 1,
    `got ${totals.bouncedSessions}`
  );
  // s1 = 600s span + 30s dwell = 630; s2 = 0; s3 = 240. Median of [0, 240, 630] is 240.
  check(
    "median session duration includes the exit dwell",
    totals.medianSessionSeconds === 240,
    `got ${totals.medianSessionSeconds}, expected 240 from [0, 240, 630]`
  );

  const trend = await trafficTrend("day", 7);
  check("trend is gap-filled to the bucket count", trend.length === 7, `got ${trend.length}`);
  check(
    "trend totals agree with the headline",
    trend.reduce((a, p) => a + p.views, 0) === totals.views,
    `${trend.reduce((a, p) => a + p.views, 0)} vs ${totals.views}`
  );

  const routesOut = await topRoutes("30d");
  const home = routesOut.find((r) => r.route === "/");
  check("top routes ranks by views", routesOut[0]?.views === 2, `got ${routesOut[0]?.views}`);
  check("home counted twice, bot excluded", home?.views === 2, `got ${home?.views}`);
  const interest = routesOut.find((r) => r.route === "/interest");
  check(
    "median dwell reported in seconds",
    interest?.medianDwellSeconds === 30,
    `got ${interest?.medianDwellSeconds}`
  );
  const pricing = routesOut.find((r) => r.route === "/pricing");
  check(
    "a route with no dwell reports null, not zero",
    pricing?.medianDwellSeconds === null,
    `got ${pricing?.medianDwellSeconds}`
  );

  const geo = await geoBreakdown("30d");
  check("countries rolled up", geo.countries.length === 2, `got ${geo.countries.length}`);
  check(
    "US country total sums its cities",
    geo.countries.find((c) => c.country === "US")?.views === 3
  );
  check("cities broken out", geo.cities.some((c) => c.city === "San Francisco"));
  check("regions broken out", geo.regions.some((r) => r.region === "England"));

  const sources = await sourceBreakdown("30d");
  check("referrer captured", sources.referrers[0]?.label === "news.ycombinator.com");
  check("campaign captured", sources.campaigns[0]?.label === "launch");

  const devices = await deviceBreakdown("30d");
  check(
    "devices split",
    devices.find((d) => d.device === "mobile")?.views === 2 &&
      devices.find((d) => d.device === "desktop")?.views === 4,
    JSON.stringify(devices)
  );

  // --- 6. Dwell clamping ---------------------------------------------------------------

  console.log("\ndwell handling");
  const clampId = randomUUID();
  await recordPageView({ ...base, id: clampId, visitorHash: visitorA, sessionId: randomUUID(), route: "/graph" });
  await recordDwell(clampId, 99 * 60 * 60_000);
  const clamped = await db.query.pageViews.findFirst({ where: (t, { eq }) => eq(t.id, clampId) });
  check("absurd dwell is clamped", clamped?.dwellMs === MAX_DWELL_MS, `got ${clamped?.dwellMs}`);

  await recordDwell(clampId, 5_000);
  const notShrunk = await db.query.pageViews.findFirst({ where: (t, { eq }) => eq(t.id, clampId) });
  check(
    "a smaller later beacon cannot shrink a recorded dwell",
    notShrunk?.dwellMs === MAX_DWELL_MS,
    `got ${notShrunk?.dwellMs}`
  );

  // The tab-switch case, and the reason dwell is monotonic rather than write-once. The
  // beacon reports its running total on every departure: 10s when they switch away, then
  // 45s when they finally leave. Keeping the first would record 10s for a 45-second read.
  const resumeId = randomUUID();
  await recordPageView({ ...base, id: resumeId, visitorHash: visitorA, sessionId: randomUUID(), route: "/pricing" });
  await recordDwell(resumeId, 10_000);
  await recordDwell(resumeId, 45_000);
  const resumed = await db.query.pageViews.findFirst({ where: (t, { eq }) => eq(t.id, resumeId) });
  check(
    "time resumed after a tab switch extends the dwell",
    resumed?.dwellMs === 45_000,
    `got ${resumed?.dwellMs}, expected 45000 — a visitor who came back and kept reading`
  );

  // Beacons are fire-and-forget over the network and can land out of order.
  const raceId = randomUUID();
  await recordPageView({ ...base, id: raceId, visitorHash: visitorA, sessionId: randomUUID(), route: "/pricing" });
  await recordDwell(raceId, 60_000);
  await recordDwell(raceId, 20_000);
  const raced = await db.query.pageViews.findFirst({ where: (t, { eq }) => eq(t.id, raceId) });
  check(
    "an out-of-order beacon cannot truncate the measurement",
    raced?.dwellMs === 60_000,
    `got ${raced?.dwellMs}`
  );

  const dupeId = randomUUID();
  await recordPageView({ ...base, id: dupeId, visitorHash: visitorA, sessionId: s1, route: "/chat" });
  await recordPageView({ ...base, id: dupeId, visitorHash: visitorA, sessionId: s1, route: "/chat" });
  const afterDupe = await trafficTotals("30d");
  check(
    "a retried beacon does not double-count",
    afterDupe.views === 10,
    `got ${afterDupe.views}, expected 10 (6 + /graph + 2 dwell fixtures + one /chat)`
  );

  // --- 7. Retention ---------------------------------------------------------------------

  console.log("\nretention");
  await db.insert(pageViews).values({
    ...base,
    id: randomUUID(),
    visitorHash: visitorA,
    sessionId: randomUUID(),
    route: "/",
    createdAt: new Date(now.getTime() - 200 * 86_400_000),
  });
  const pruned = await prunePageViews(now);
  check("prunes past the retention window", pruned === 1, `got ${pruned}`);
  const afterPrune = await trafficTotals("90d");
  check("recent rows survive the prune", afterPrune.views === 10, `got ${afterPrune.views}`);

  // --- 7b. The funnel ------------------------------------------------------------------

  console.log("\nacquisition funnel");
  const before = await acquisitionFunnel("30d");
  const nowIso = new Date();
  await db.insert(userSettings).values([
    // Signed up, did nothing.
    { userId: "fun_idle", email: "idle@example.com", createdAt: nowIso },
    // Signed up and added a contact -> activated, never paid.
    { userId: "fun_active", email: "active@example.com", createdAt: nowIso },
    // Bought Lifetime. This is the trap: a lifetime purchase moves NO recurring revenue,
    // so a paid test written only as `mrr_delta_cents > 0` scores it zero.
    {
      userId: "fun_lifetime",
      email: "lifetime@example.com",
      createdAt: nowIso,
      lifetimePurchasedAt: nowIso,
      onboardingCompletedAt: nowIso,
    },
    // Ordinary subscriber, visible through the ledger.
    { userId: "fun_sub", email: "sub@example.com", createdAt: nowIso, onboardingCompletedAt: nowIso },
  ]);
  await db.insert(contacts).values({
    userId: "fun_active",
    fullName: "Someone",
  });
  await db.insert(billingEvents).values({
    source: "stripe",
    eventId: `evt_${randomUUID()}`,
    kind: "new",
    userId: "fun_sub",
    amountCents: 500,
    mrrDeltaCents: 500,
    effectiveAt: nowIso,
  });

  const funnel = await acquisitionFunnel("30d");
  const stage = (label: string) => funnel.find((s) => s.label === label);
  const delta = (label: string) =>
    (stage(label)?.count ?? 0) - (before.find((s) => s.label === label)?.count ?? 0);

  check("funnel starts from traffic", (stage("Unique visitors")?.count ?? 0) > 0);
  // Visitor A hit BOTH /pricing and /interest on the same day; visitor B hit neither.
  // One, not two: the stage counts visitor-days with intent, not pages with intent. If
  // this ever reads 2, the funnel has started counting views and every rate below it is
  // inflated.
  check(
    "intent stage de-duplicates a visitor across intent pages",
    stage("Reached pricing or interest")?.count === 1,
    `got ${stage("Reached pricing or interest")?.count}`
  );
  check("accounts counted", delta("Created an account") === 4, `delta ${delta("Created an account")}`);
  check(
    "activation mirrors isOnboarded, not the bare column",
    delta("Activated") === 3,
    `delta ${delta("Activated")}; fun_active has a contact but no timestamp`
  );
  check(
    "paid counts a Lifetime purchase as well as MRR",
    delta("Paid") === 2,
    `delta ${delta("Paid")}; a mrr_delta_cents-only test would say 1`
  );
  check(
    "every stage after the first carries a denominator",
    funnel.slice(1).every((s) => s.of != null)
  );

  check("a small denominator withholds the percentage", formatRate(9, 14) === "9 of 14");
  check(
    "a usable denominator shows one",
    formatRate(30, 100) === "30 of 100 (30%)",
    formatRate(30, 100)
  );
  check("the first stage is a bare count", formatRate(412, null) === "412");

  // --- 7bb. Per-account traffic ----------------------------------------------------------

  console.log("\nper-account traffic");

  const acctSession = randomUUID();
  const acctVisitor = hashVisitor("10.0.0.7", "UA-ACCT", now);
  const acctLast = randomUUID();
  await db.insert(pageViews).values([
    { ...base, id: randomUUID(), visitorHash: acctVisitor, sessionId: acctSession, userId: "acct_user", route: "/dashboard", createdAt: ago(40) },
    { ...base, id: randomUUID(), visitorHash: acctVisitor, sessionId: acctSession, userId: "acct_user", route: "/graph", createdAt: ago(38) },
    { ...base, id: acctLast, visitorHash: acctVisitor, sessionId: acctSession, userId: "acct_user", route: "/graph", createdAt: ago(35) },
    // A second account, quieter, so the ranking has something to order.
    { ...base, id: randomUUID(), visitorHash: acctVisitor, sessionId: randomUUID(), userId: "acct_other", route: "/dashboard", createdAt: ago(20) },
    // Anonymous traffic must not be attributed to anybody.
    { ...base, id: randomUUID(), visitorHash: visitorB, sessionId: randomUUID(), route: "/pricing", createdAt: ago(18) },
  ]);
  await recordDwell(acctLast, 60_000);

  const acct = await accountTraffic("acct_user", "30d");
  check("counts only that account's views", acct.views === 3, `got ${acct.views}`);
  check("groups them into one session", acct.sessions === 1, `got ${acct.sessions}`);
  check("counts distinct days seen", acct.activeDays === 1, `got ${acct.activeDays}`);
  check(
    "session duration spans first to last plus the exit dwell",
    acct.medianSessionSeconds === 360,
    `got ${acct.medianSessionSeconds}, expected 300s span + 60s dwell`
  );
  check("sums measured time on page", acct.totalDwellSeconds === 60, `got ${acct.totalDwellSeconds}`);
  check(
    "reports how thin the dwell sample is",
    Math.abs(acct.dwellCoverage - 1 / 3) < 0.001,
    `got ${acct.dwellCoverage}; 1 of 3 views has a measurement`
  );
  check("ranks their most-opened route first", acct.routes[0]?.route === "/graph", acct.routes[0]?.route);
  check("first and last seen are populated", acct.firstSeen != null && acct.lastSeen != null);

  const empty = await accountTraffic("acct_nobody", "30d");
  check(
    "an account with no traffic reads as zero, not as a crash",
    empty.views === 0 && empty.sessions === 0 && empty.medianSessionSeconds === null && empty.routes.length === 0
  );

  const ranked = await topAccountsByTraffic("30d");
  check("ranks accounts by views", ranked[0]?.userId === "acct_user", ranked[0]?.userId);
  check("includes the quieter account", ranked.some((r) => r.userId === "acct_other"));
  // Derived rather than hardcoded: the ranking must account for exactly the signed-in
  // rows and no others. A literal total here would only be re-asserting the fixture.
  const attributed = rowsOf<{ n: number }>(
    await db.execute(
      `SELECT count(*)::int AS n FROM page_views WHERE user_id IS NOT NULL AND is_bot = false` as never
    )
  )[0]?.n;
  check(
    "anonymous traffic is never attributed to an account",
    ranked.every((r) => r.userId != null) &&
      ranked.reduce((a, r) => a + r.views, 0) === attributed,
    `ranked ${ranked.reduce((a, r) => a + r.views, 0)} vs ${attributed} signed-in rows: ${JSON.stringify(ranked.map((r) => [r.userId, r.views]))}`
  );

  // --- 7c. The pages actually render ----------------------------------------------------
  //
  // The console is unreachable in a browser without Clerk keys and an ADMIN_USER_IDS entry
  // (proxy.ts 404s /admin outright in demo mode), so calling the page functions directly is
  // the only local way to prove the element trees build. Same technique, and the same
  // limits, as scripts/smoke-admin-render.ts: client components appear as elements rather
  // than DOM, so this catches a throwing loader or a bad prop shape, not a broken hover.
  //
  // Both pages are callable here precisely because neither gates itself — the gate lives in
  // (admin)/layout.tsx, and smoke-admin-gate.ts owns that half.

  console.log("\npage render");

  function textOf(node: unknown, out: string[] = []): string[] {
    if (node == null || typeof node === "boolean") return out;
    if (typeof node === "string" || typeof node === "number") {
      out.push(String(node));
      return out;
    }
    if (Array.isArray(node)) {
      for (const child of node) textOf(child, out);
      return out;
    }
    const el = node as { props?: Record<string, unknown>; label?: unknown };
    // A row object handed to MiniBars/TrendBars, not a React element. Without this the
    // walk stops at the panel title and every data-bearing assertion below passes
    // vacuously.
    if (!el.props && typeof el.label === "string") {
      out.push(el.label);
      return out;
    }
    if (el.props) {
      for (const [key, value] of Object.entries(el.props)) {
        if (["children", "value", "label", "title", "subtitle", "hint", "rows"].includes(key)) {
          textOf(value, out);
        }
      }
    }
    return out;
  }

  const { default: TrafficPage } = await import(
    "../src/app/(admin)/admin/analytics/page"
  );
  const { default: FunnelPage } = await import(
    "../src/app/(admin)/admin/analytics/funnel/page"
  );

  // Some traffic to render, since the fixtures above were cleaned up by the funnel block.
  await db.insert(pageViews).values([
    { ...base, id: randomUUID(), visitorHash: visitorA, sessionId: s1, route: "/pricing", createdAt: ago(12), country: "US", region: "California", city: "San Francisco", referrerHost: "news.ycombinator.com" },
    { ...base, id: randomUUID(), visitorHash: visitorB, sessionId: s2, route: "/", createdAt: ago(8), country: "GB", region: "England", city: "London" },
    // Signed in, so the "most active accounts" panel has a row to draw.
    { ...base, id: randomUUID(), visitorHash: visitorA, sessionId: s1, route: "/dashboard", createdAt: ago(6), userId: "render_acct" },
  ]);

  const traffic = await TrafficPage({ searchParams: Promise.resolve({}) });
  const trafficText = textOf(traffic).join(" | ");
  check("the traffic page renders without throwing", traffic != null);
  check("it labels the count as visitor-days, never as people", trafficText.includes("Visitor-days"), trafficText.slice(0, 400));
  check(
    "it says the visitor figure is not a headcount",
    trafficText.includes("not a headcount"),
    trafficText.slice(0, 400)
  );
  check("it names the session measure honestly", trafficText.includes("first pageview to last"));
  check("it lists a country", trafficText.includes("US"), trafficText.slice(0, 600));
  check("it lists a referrer", trafficText.includes("news.ycombinator.com"));

  check(
    "it lists the most active accounts by name",
    trafficText.includes("Most active accounts"),
    trafficText.slice(-400)
  );

  const ranged = await TrafficPage({ searchParams: Promise.resolve({ range: "7d" }) });
  check("an explicit range renders", ranged != null);
  const bogus = await TrafficPage({ searchParams: Promise.resolve({ range: "../../etc" }) });
  check("an unrecognised range falls back rather than reaching SQL", bogus != null);

  const funnelPage = await FunnelPage({ searchParams: Promise.resolve({}) });
  const funnelText = textOf(funnelPage).join(" | ");
  check("the funnel page renders without throwing", funnelPage != null);
  check("it names every stage", funnelText.includes("Unique visitors") && funnelText.includes("Paid"));
  check(
    "it warns these are not one group of people",
    funnelText.includes("These are not one group of people."),
    funnelText.slice(0, 400)
  );
  check("it explains the Lifetime caveat", funnelText.includes("Paid includes Lifetime."));

  // With the salt removed the page must say so, rather than showing an empty table that
  // looks identical to "nobody visited".
  delete process.env.ANALYTICS_SALT;
  const offPage = await TrafficPage({ searchParams: Promise.resolve({}) });
  const offText = textOf(offPage).join(" | ");
  check(
    "with no salt the page says tracking is off, not that traffic is zero",
    offText.includes("ANALYTICS_SALT is not set"),
    offText.slice(0, 300)
  );
  process.env.ANALYTICS_SALT = "smoke-salt-at-least-16-chars";

  // --- 8. Query budget -------------------------------------------------------------------
  //
  // The overview issues these together. No admin page is budgeted today; this is the first,
  // so a future panel added carelessly shows up here rather than in a slow page.

  console.log("\nquery budget");
  startQueryCount();
  await Promise.all([
    trafficTotals("30d"),
    trafficTrend("day", 30),
    topRoutes("30d"),
    geoBreakdown("30d"),
    sourceBreakdown("30d"),
    deviceBreakdown("30d"),
  ]);
  stopQueryCount();
  const statements = capturedQueries().length;
  check(
    `overview aggregates stay within budget (${statements} statements)`,
    statements <= 10,
    `${statements} statements; the page loads them in one Promise.all`
  );

  // Leave the shared database as we found it. 111 other scripts run against this same
  // PGlite directory, and several of them count users.
  const fixtureUsers = ["fun_idle", "fun_active", "fun_lifetime", "fun_sub"];
  await db.delete(pageViews);
  await db.delete(contacts).where(inArray(contacts.userId, fixtureUsers));
  await db.delete(billingEvents).where(inArray(billingEvents.userId, fixtureUsers));
  await db.delete(userSettings).where(inArray(userSettings.userId, fixtureUsers));

  if (savedSalt === undefined) delete process.env.ANALYTICS_SALT;
  else process.env.ANALYTICS_SALT = savedSalt;

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);

}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
