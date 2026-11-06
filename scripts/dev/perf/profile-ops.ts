/**
 * Perf audit: per-op, per-statement profile against a seeded PGlite dir (ORBIT_PGLITE_DIR).
 * Wraps the PGlite client's query() at runtime (no app code changed) to record each
 * statement's SQL, params, wall ms, row count and result bytes; then EXPLAIN (ANALYZE,
 * BUFFERS) the slowest SELECTs with their real params.
 *
 *   ORBIT_PGLITE_DIR=<seeded copy> npx tsx scripts/dev/perf/profile-ops.ts <label> <out.json> [opRegex]
 *
 * A statement's recorded ms includes time queued behind PGlite's single connection; read
 * per-statement cost from the EXPLAIN execution time, and op cost from `median_ms`.
 */
import { writeFileSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";

const env = process.env as Record<string, string | undefined>;
env.NODE_ENV = "development";
env.ORBIT_DEMO_DATA = "off";
env.EXTENSION_DEV_SECRET = "bench-secret";
env.EXTENSION_DEV_USER_ID = "demo-user";

type Stmt = { sql: string; params: unknown[]; ms: number; rows: number; bytes: number };
let recording: Stmt[] | null = null;

const U = "demo-user";
const label = process.argv[2];
const out = process.argv[3];
const filter = process.argv[4] ? new RegExp(process.argv[4]) : null;

function bytesOf(v: unknown) {
  try {
    return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? String(x) : x))?.length ?? 0;
  } catch {
    return 0;
  }
}
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function main() {
  const { getDb } = await import("../../../src/db");
  const db = await getDb();
  const g = globalThis as unknown as { orbitPglite: { query: (...a: unknown[]) => Promise<{ rows: unknown[] }> } };
  const client = g.orbitPglite;
  const rawQuery = client.query.bind(client);
  client.query = (async (...args: unknown[]) => {
    const t = performance.now();
    const res = await rawQuery(...args);
    if (recording) {
      recording.push({
        sql: String(args[0]),
        params: (args[1] as unknown[]) ?? [],
        ms: performance.now() - t,
        rows: res?.rows?.length ?? 0,
        bytes: bytesOf(res?.rows),
      });
    }
    return res;
  }) as typeof client.query;

  const { contacts } = await import("../../../src/db/schema");
  const sarah = await db.query.contacts.findFirst({
    where: and(eq(contacts.userId, U), eq(contacts.fullName, "Sarah Chen")),
    columns: { id: true },
  });
  const anyContact = sarah ?? (await db.query.contacts.findFirst({ where: eq(contacts.userId, U), columns: { id: true } }));
  const cid = anyContact?.id ?? "00000000-0000-0000-0000-000000000000";

  const { benchOps } = await import("../efficiency-bench-ops");
  let ops: { name: string; run: () => Promise<unknown> }[] = [];
  if (sarah) ops = await benchOps();

  const m = {
    contacts: await import("../../../src/actions/contacts"),
    profile: await import("../../../src/lib/contact-profile"),
    reminders: await import("../../../src/actions/reminders"),
    radar: await import("../../../src/actions/radar"),
    brand: await import("../../../src/lib/org-brand-learn"),
    dups: await import("../../../src/actions/duplicates"),
    knowledge: await import("../../../src/actions/knowledge"),
    events: await import("../../../src/actions/events"),
    chat: await import("../../../src/actions/chat"),
    settings: await import("../../../src/actions/settings"),
    imports: await import("../../../src/actions/imports"),
    stats: await import("../../../src/lib/network-stats"),
    sugg: await import("../../../src/actions/suggested-reminders"),
    ai: await import("../../../src/lib/ai-access"),
    pulse: await import("../../../src/lib/app-pulse"),
    health: await import("../../../src/lib/relationship-health-read"),
    ent: await import("../../../src/lib/entitlements"),
    vis: await import("../../../src/lib/surface-visibility"),
    graph: await import("../../../src/actions/graph"),
  };
  const extra: { name: string; run: () => Promise<unknown> }[] = [
    { name: "layout: entitlements", run: () => m.ent.getEntitlements(U) },
    { name: "layout: surface visibility", run: () => m.vis.resolveSurfaceVisibility(U) },
    { name: "layout: org brand colors", run: () => m.brand.loadOrgBrandColors(U) },
    { name: "app pulse", run: () => m.pulse.loadAppPulse(U, new Date()) },
    { name: "ai access status", run: () => m.ai.getAiAccessStatus(U) },
    { name: "dashboard: fetchDashboard (action)", run: () => m.reminders.fetchDashboard() },
    { name: "dashboard: network stats", run: () => m.stats.getNetworkStats(U) },
    { name: "graph: getGraphData (action)", run: () => m.graph.getGraphData() },
    { name: "contacts: letters", run: () => m.contacts.listContactLetters() },
    { name: "contacts: school options", run: () => m.contacts.listContactSchoolOptions() },
    { name: "contacts: count duplicates", run: () => m.dups.countDuplicates() },
    { name: "profile: getContactForProfile", run: () => m.contacts.getContactForProfile(cid) },
    { name: "profile: related contacts", run: () => m.contacts.listRelatedContacts(cid) },
    { name: "profile: stored profile", run: () => m.profile.getContactProfile(U, cid) },
    { name: "profile: relationship health", run: () => m.health.getRelationshipHealth(U, cid) },
    { name: "reminders: page", run: () => m.reminders.loadRemindersPage({ view: "today", listId: null } as never) },
    { name: "reminders: rail", run: () => m.reminders.loadReminderRail() },
    { name: "reminders: suggested", run: () => m.sugg.listSuggestedReminders() },
    { name: "radar: fetchRadar", run: () => m.radar.fetchRadar() },
    { name: "knowledge: people", run: () => m.knowledge.getKnowledgePeople() },
    { name: "events: by tab", run: () => m.events.listEventsByTab() },
    { name: "events: connections", run: () => m.events.getEventConnections() },
    { name: "events: repeat co-attendees", run: () => m.events.getRepeatCoAttendees() },
    { name: "chat: threads", run: () => m.chat.listChatThreads() },
    { name: "settings: getSettings", run: () => m.settings.getSettings() },
    { name: "imports: list", run: () => m.imports.listImports() },
  ];
  ops = [...ops, ...extra].filter((o) => !filter || filter.test(o.name));

  const results: Record<string, unknown>[] = [];
  for (const op of ops) {
    await db.execute(sql`DELETE FROM rate_limit_buckets`).catch(() => {});
    await db.execute(sql`DELETE FROM extension_usage`).catch(() => {});
    try {
      recording = [];
      const tc = performance.now();
      await op.run(); // cold: first call in this process (per-instance memos empty)
      const coldMs = performance.now() - tc;
      const coldStmts = recording.length;
      recording = [];
      const t = performance.now();
      const value = await op.run();
      const wall = performance.now() - t;
      const stmts = recording;
      recording = null;
      const cpu: number[] = [];
      for (let i = 0; i < 5; i++) {
        const t2 = performance.now();
        await op.run();
        cpu.push(performance.now() - t2);
      }
      const dbMs = stmts.reduce((s, x) => s + x.ms, 0);
      const top = [...stmts].sort((a, b) => b.ms - a.ms).slice(0, 4);
      const explained = [];
      for (const s of top) {
        if (s.ms < 5) continue;
        const isRead = /^\s*(select|with)\b/i.test(s.sql) && !/\b(insert|update|delete)\b/i.test(s.sql);
        let plan = "(write: not explained)";
        if (isRead) {
          try {
            const r = await rawQuery(`EXPLAIN (ANALYZE, BUFFERS) ${s.sql}`, s.params);
            plan = (r.rows as { "QUERY PLAN": string }[]).map((x) => x["QUERY PLAN"]).join("\n");
          } catch (e) {
            plan = `explain failed: ${(e as Error).message}`;
          }
        }
        explained.push({ ms: Math.round(s.ms * 10) / 10, rows: s.rows, kb: Math.round(s.bytes / 102.4) / 10, sql: s.sql, params: s.params, plan });
      }
      const row = {
        op: op.name,
        statements: stmts.length,
        cold_statements: coldStmts,
        cold_ms: Math.round(coldMs),
        db_ms: Math.round(dbMs),
        wall_ms: Math.round(wall),
        median_ms: Math.round(median(cpu)),
        result_kb: Math.round(bytesOf(value) / 102.4) / 10,
        rows_read: stmts.reduce((s, x) => s + x.rows, 0),
        db_kb: Math.round(stmts.reduce((s, x) => s + x.bytes, 0) / 1024),
        slowest: explained,
      };
      results.push(row);
      console.log(`${label}\t${op.name}\tstmts=${row.statements}\tdb=${row.db_ms}ms\twall=${row.wall_ms}ms\tmed=${row.median_ms}ms\tresult=${row.result_kb}KB\trows=${row.rows_read}`);
    } catch (e) {
      recording = null;
      results.push({ op: op.name, error: (e as Error).message.slice(0, 300) });
      console.log(`${label}\t${op.name}\tERROR ${(e as Error).message.slice(0, 200)}`);
    }
  }
  writeFileSync(out, JSON.stringify({ label, results }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
