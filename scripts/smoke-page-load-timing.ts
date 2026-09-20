/**
 * Guards page-load timing: the `load` beacon's write (`recordLoad`), the admin read
 * (`routeLoadTimes`), and the client clock hand-off (`markNavStart` / `readNavStart`).
 *
 * Every failure here is silent in the UI. A second beacon overwriting the first, a NULL
 * counted as a fast load, or a full load pooled with in-app clicks all still render a
 * plausible-looking number on /admin/analytics — just a wrong one.
 *
 * Run: npx tsx scripts/smoke-page-load-timing.ts
 */
import "./smoke/_env";

import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { pageViews } from "../src/db/schema";
import { MAX_LOAD_MS, recordLoad } from "../src/lib/page-views";
import { routeLoadTimes } from "../src/lib/admin-analytics";
import { markNavStart, readNavStart } from "../src/lib/nav-timing";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

// Routes no real pattern produces, so the suite's shared PGlite directory cannot collide.
const ROUTE_A = "/__smoke-load-a";
const ROUTE_B = "/__smoke-load-b";

async function main() {
  const db = await getDb();
  await db.delete(pageViews).where(inArray(pageViews.route, [ROUTE_A, ROUTE_B]));

  const base = {
    visitorHash: "smoke-visitor",
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
  const view = (route: string, isBot = false) => ({
    ...base,
    id: randomUUID(),
    sessionId: randomUUID(),
    route,
    isBot,
  });

  console.log("recordLoad");
  const first = view(ROUTE_A);
  await db.insert(pageViews).values(first);
  await recordLoad(first.id, 400, "soft");
  await recordLoad(first.id, 9_000, "hard");
  const [stored] = await db.select().from(pageViews).where(eq(pageViews.id, first.id));
  check(
    "first write wins — a retry or forgery cannot replace the measurement",
    stored?.loadMs === 400 && stored?.navType === "soft",
    `got ${stored?.loadMs} / ${stored?.navType}`
  );

  const rejected = view(ROUTE_A);
  await db.insert(pageViews).values(rejected);
  await recordLoad(rejected.id, MAX_LOAD_MS + 1, "hard");
  await recordLoad(rejected.id, -5, "hard");
  await recordLoad(rejected.id, Number.NaN, "hard");
  const [unset] = await db.select().from(pageViews).where(eq(pageViews.id, rejected.id));
  check(
    "out-of-range loads are dropped, not clamped into the percentiles",
    unset?.loadMs === null,
    `got ${unset?.loadMs}`
  );

  console.log("routeLoadTimes");
  // ROUTE_A soft: 400 (above) + 100, 200, 300 → p50 of [100,200,300,400] = 250.
  // ROUTE_A hard: 3000 alone. ROUTE_B: only a bot and an unmeasured view → no row.
  for (const ms of [100, 200, 300]) {
    const v = view(ROUTE_A);
    await db.insert(pageViews).values(v);
    await recordLoad(v.id, ms, "soft");
  }
  const hard = view(ROUTE_A);
  await db.insert(pageViews).values(hard);
  await recordLoad(hard.id, 3_000, "hard");
  const bot = view(ROUTE_B, true);
  await db.insert(pageViews).values([bot, view(ROUTE_B)]);
  await recordLoad(bot.id, 50, "soft");

  const rows = (await routeLoadTimes("7d")).filter((r) => r.route === ROUTE_A || r.route === ROUTE_B);
  const soft = rows.find((r) => r.route === ROUTE_A && r.navType === "soft");
  const full = rows.find((r) => r.route === ROUTE_A && r.navType === "hard");
  check(
    "soft and hard loads are separate rows, never pooled",
    Boolean(soft) && Boolean(full),
    JSON.stringify(rows)
  );
  check(
    "percentiles count only measured views",
    soft?.samples === 4 && soft?.p50Ms === 250,
    `got samples=${soft?.samples} p50=${soft?.p50Ms}; the rejected NULL row must not count`
  );
  check("a lone hard load reports itself", full?.samples === 1 && full?.p50Ms === 3_000);
  check(
    "bots and unmeasured views produce no row",
    !rows.some((r) => r.route === ROUTE_B),
    JSON.stringify(rows.filter((r) => r.route === ROUTE_B))
  );

  console.log("nav start hand-off");
  (globalThis as unknown as { window: unknown }).window = {
    location: { href: "https://orbit.test/dashboard" },
  };
  markNavStart("/contacts?page=2");
  check("a start for the committed pathname is returned", readNavStart("/contacts") !== null);
  check(
    "a second read gets the same start (Strict Mode runs the effect twice)",
    readNavStart("/contacts") !== null
  );
  markNavStart("https://orbit.test/graph");
  check(
    "a start for a different pathname reads as a hard load",
    readNavStart("/contacts") === null
  );

  await db.delete(pageViews).where(inArray(pageViews.route, [ROUTE_A, ROUTE_B]));
}

main()
  .then(() => {
    console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
