/**
 * Sequential round trips on the hot read paths (LATENCY_PLAN.md §4, "depth assertions").
 *
 * On neon-http every statement is its own HTTPS round trip, so a page's server time is
 * roughly (statements awaited one after another) × RTT. Depth is counted exactly, not timed:
 * every statement that starts while no other is in flight begins a new round trip, and
 * statements issued together (a `Promise.all`) share one. This fails when a change adds a
 * sequential round trip to one of these paths. The ceilings are today's depths with this
 * fixture; lower one when a change removes a round trip.
 *
 * Runs against a throwaway PGlite. Run: npx tsx scripts/smoke-latency-depth.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts } from "../src/db/schema";
import { listContactsPage } from "../src/lib/contacts-page-query";
import { findAvatarBackfillCandidates, countAvatarBackfillCandidates } from "../src/lib/avatar-backfill";
import { findNameCollisions } from "../src/lib/duplicate-review";
import { scaleContactRows } from "./lib/scale-fixture";

const USER = "latency-depth-smoke-user";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/**
 * Ceilings: today's depths. Before the DB-6/DB-15 fix (the count awaited after the page, the
 * lexical arms awaited after the embedding) this meter read 2, 2 and 5 for the three
 * contacts paths.
 */
const PATHS: Array<{ name: string; max: number; run: () => Promise<unknown> }> = [
  { name: "contacts first page", max: 1, run: () => listContactsPage(USER, { limit: 50 }) },
  { name: "contacts search 'hop' (prefix)", max: 1, run: () => listContactsPage(USER, { q: "ho", limit: 50 }) },
  { name: "contacts search 'engineer at acme'", max: 3, run: () => listContactsPage(USER, { q: "engineer at acme", limit: 50 }) },
  { name: "duplicates name scan", max: 1, run: () => findNameCollisions(USER, 99) },
  {
    name: "avatar backfill probe",
    max: 1,
    run: async (): Promise<unknown> => {
      const db = await getDb();
      return Promise.all([findAvatarBackfillCandidates(db, USER, { limit: 5, skipIds: [] }), countAvatarBackfillCandidates(db, USER, [])]);
    },
  },
];

/** Wraps the local PGlite client so each run reports how many sequential round trips it made. */
function depthMeter() {
  const pg = (globalThis as { orbitPglite?: { query: (...a: unknown[]) => Promise<unknown> } }).orbitPglite;
  if (!pg) throw new Error("no local PGlite client; this smoke runs against PGlite only");
  const query = pg.query.bind(pg);
  let inFlight = 0;
  let depth = 0;
  pg.query = async (...args: unknown[]) => {
    if (inFlight === 0) depth++;
    inFlight++;
    try {
      return await query(...args);
    } finally {
      inFlight--;
    }
  };
  return {
    async measure(fn: () => Promise<unknown>) {
      depth = 0;
      await fn();
      return depth;
    },
    restore() {
      pg.query = query;
    },
  };
}

run(async () => {
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, USER));
  const rows = scaleContactRows(USER, 600, { inlineAvatarShare: 0.3, longNotesShare: 0.5 });
  for (let i = 0; i < rows.length; i += 200) await db.insert(contacts).values(rows.slice(i, i + 200));

  for (const p of PATHS) await p.run(); // warm: per-instance memos, the schema reconcile
  const meter = depthMeter();
  try {
    for (const p of PATHS) {
      const depth = await meter.measure(p.run);
      check(`${p.name}: ${depth} sequential round trips (ceiling ${p.max})`, depth <= p.max);
    }
  } finally {
    meter.restore();
    await db.delete(contacts).where(eq(contacts.userId, USER));
  }

  console.log(failures === 0 ? "\nAll latency depth checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures) process.exit(1);
});
