/**
 * A query budget per admin screen.
 *
 * WHY THIS EXISTS. The console's screens were, between them, issuing roughly a hundred and
 * fifty database statements — `/admin` alone ran the six-query roster twice, concurrently,
 * and the data-protection sweep asked one question per table in a strictly sequential loop
 * of twenty-five. On Neon HTTP every statement is its own HTTPS request, so a serial loop
 * is a serial chain of network round trips.
 *
 * None of that was visible. It is the kind of cost that is invisible in local development
 * (PGlite is in-process, so twenty-five round trips are twenty-five function calls) and
 * only shows up as "the console feels slow" in production. So the fix needs a test, or the
 * next panel added to Health quietly reintroduces the loop.
 *
 * WHAT IT ASSERTS is a ceiling, not an exact count — an exact count would fail on every
 * legitimate new panel and quickly get deleted. The budgets have headroom; blowing through
 * one means something structural changed, not that a panel was added.
 *
 * THE SECOND ASSERTION is the one that actually caught a bug: that the roster runs ONCE
 * per render. React `cache()` only memoises inside a render, so in a route handler, a
 * script, or a test it is a passthrough — the screens share the promise explicitly instead,
 * and this proves they still do.
 *
 * Run: npx tsx scripts/smoke-admin-perf.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { userSettings } from "../src/db/schema";
import { ensureUserSettings } from "../src/lib/user-settings";
import { renderDeep } from "./lib/render-tree";

const PREFIX = "smoke-perf-";
const ALL = [`${PREFIX}a`, `${PREFIX}b`, `${PREFIX}c`];

/** Generous on purpose: a ceiling that catches structural regressions, not new panels. */
const BUDGET: Record<string, number> = {
  "/admin": 24,
  "/admin/health": 26,
  "/admin/funnel": 28,
  "/admin/product": 26,
  "/admin/billing": 18,
};

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function cleanup() {
  const db = await getDb();
  await db.delete(userSettings).where(inArray(userSettings.userId, ALL));
}

type PgHandle = { query: (...a: unknown[]) => Promise<unknown> };

async function main() {
  await cleanup();
  await getDb();
  for (const id of ALL) await ensureUserSettings(id);

  // The PGlite client hangs off `globalThis` (see `globalForDb` in src/db/index.ts), which
  // is the only seam available for counting statements without threading a counter through
  // the driver. Neon is not exercised here — the COUNT is what this file is about, and it
  // is the same either way.
  const handle = (globalThis as unknown as { orbitPglite?: PgHandle }).orbitPglite;
  if (!handle) throw new Error("no PGlite handle: this suite must run against local dev");

  const seen: string[] = [];
  const original = handle.query.bind(handle);
  handle.query = (async (...args: unknown[]) => {
    seen.push(String(args[0]).replace(/\s+/g, " "));
    return original(...args);
  }) as PgHandle["query"];

  const screens: Array<[string, () => Promise<unknown>]> = [
    [
      "/admin",
      async () => renderDeep((await import("../src/app/(admin)/admin/page")).default()),
    ],
    [
      "/admin/health",
      async () =>
        renderDeep((await import("../src/app/(admin)/admin/health/page")).default()),
    ],
    [
      "/admin/funnel",
      async () =>
        renderDeep(
          await (
            await import("../src/app/(admin)/admin/funnel/page")
          ).default({ searchParams: Promise.resolve({}) })
        ),
    ],
    [
      "/admin/product",
      async () =>
        renderDeep((await import("../src/app/(admin)/admin/product/page")).default()),
    ],
    [
      "/admin/billing",
      async () =>
        renderDeep((await import("../src/app/(admin)/admin/billing/page")).default()),
    ],
  ];

  const counts = new Map<string, number>();
  const statements = new Map<string, string[]>();

  for (const [name, run] of screens) {
    seen.length = 0;
    await run();
    counts.set(name, seen.length);
    statements.set(name, [...seen]);
  }

  for (const [name, budget] of Object.entries(BUDGET)) {
    const n = counts.get(name) ?? 0;
    check(
      `${name} stays within ${budget} queries (used ${n})`,
      n > 0 && n <= budget,
      `${n} queries`
    );
  }

  /* ------------------------------------------------------------------ no duplicates */

  // The roster is six aggregate scans and two independent callers want it on the front
  // page. Its `user_settings` select is the cheapest of the six to identify and the one
  // that was measurably running twice.
  const rosterSignature = (s: string) =>
    s.includes('from "user_settings"') && s.includes('"profile_image_url"');

  for (const screen of ["/admin", "/admin/billing"]) {
    const hits = (statements.get(screen) ?? []).filter(rosterSignature).length;
    check(
      `${screen} loads the roster exactly once (ran ${hits})`,
      hits === 1,
      `${hits} roster queries`
    );
  }

  // Same story for the lifetime count: the page shows it and `lifetimeOffer` needs it to
  // decide whether the introductory price still applies.
  // Tight on purpose. A looser "mentions lifetime_purchased_at and count(" matched
  // `paidFeatureUsage`, whose CTE also names the column — and reported a duplicate that
  // was never there.
  const lifetimeSignature = (s: string) =>
    s.startsWith('select count(*) from "user_settings"') &&
    s.includes("lifetime_purchased_at");
  for (const screen of ["/admin", "/admin/billing"]) {
    const hits = (statements.get(screen) ?? []).filter(lifetimeSignature).length;
    check(`${screen} counts lifetime purchases at most once (ran ${hits})`, hits <= 1);
  }

  /* --------------------------------------------------------- the sweep is one query */

  // `orphanRows` used to ask one question per table, sequentially. Twenty-five tables
  // carry a `user_id`, so a regression here is a twenty-five-fold one.
  const health = statements.get("/admin/health") ?? [];
  const orphanQueries = health.filter(
    (s) => s.includes("NOT EXISTS") && s.includes("user_settings s")
  ).length;
  check(
    `the orphan sweep is a single statement (ran ${orphanQueries})`,
    orphanQueries <= 1,
    health.filter((s) => s.includes("NOT EXISTS")).length + " anti-joins seen"
  );

  handle.query = original;
  await cleanup();
  console.log("\nAll admin performance checks passed.");
  console.log(
    "  " +
      [...counts.entries()].map(([k, v]) => `${k}=${v}`).join("  ")
  );
}

main()
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error(e);
    await cleanup().catch(() => {});
    process.exit(1);
  });
