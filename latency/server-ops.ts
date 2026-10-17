/**
 * Server-side cost of every hot read path, in-process, at one data tier.
 *
 *   ORBIT_PGLITE_DIR=latency/.data/tier-5000 npx tsx latency/server-ops.ts --tier 5000 \
 *        [--out latency/results/x/server-ops-5000.json] [--only dashboard,graph]
 *
 * Per operation (the same method as scripts/dev/efficiency-bench.ts, extended to every
 * page loader, search shape, MCP tool and extension route, and run per tier):
 *   statements  SQL statements issued (drizzle logger; raw neon calls are not counted)
 *   kb          size of what the loader returns (what a page/route must then serialise)
 *   cpu_ms      median wall time over 7 warm runs on PGlite (no network: pure CPU + WASM)
 *   depth       sequential round trips: (wall time with ORBIT_SIM_DB_LATENCY_MS=25 on every
 *               statement − cpu_ms) / 25, so CPU-heavy ops are not read as deep ones. On neon-http each statement is one HTTPS round
 *               trip, so production latency ≈ depth × RTT + cpu.
 *   est_ms_rtt8 / est_ms_rtt40   depth × 8 ms (same-region Neon) / depth × 40 ms (cross-region)
 *               + cpu_ms: the production estimate the plan's budgets are checked against.
 *
 * The semantic arm runs the JS cosine fallback locally (PGlite has no pgvector), so its
 * cpu_ms is the fallback's, not HNSW's; the statement count and depth are the same.
 */
import { and, eq, sql } from "drizzle-orm";
import { getDb, closeDb } from "../src/db";
import { contacts } from "../src/db/schema";
import { capturedQueries, startQueryCount, stopQueryCount } from "../src/lib/query-counter";

const env = process.env as Record<string, string | undefined>;
env.NODE_ENV = "development";
env.ORBIT_DEMO_DATA = "off";
env.EXTENSION_DEV_SECRET = "latency";
env.EXTENSION_DEV_USER_ID = "demo-user";
if (!env.ORBIT_PGLITE_DIR) throw new Error("ORBIT_PGLITE_DIR is required");

const USER = "demo-user";
const LATENCY_MS = 25;
const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const TIER = flag("tier", "?");
const OUT = flag("out", `latency/results/server-ops-${TIER}.json`);
const ONLY = (flag("only", "") || "").split(",").filter(Boolean);
/** Ops to leave out by name substring, e.g. --skip duplicates (28 s at 5k, O(n²); see LATENCY_PLAN DB-16). */
const SKIP = (flag("skip", "") || "").split(",").filter(Boolean);

type Op = { name: string; group: string; run: () => Promise<unknown> };

const plainBytes = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (x instanceof Map ? [...x] : x instanceof Set ? [...x] : x))?.length ?? 0;
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
async function time(fn: () => Promise<unknown>) { const t = performance.now(); const value = await fn(); return { ms: performance.now() - t, value }; }

/** A deterministic query vector, the shape the mock provider and the seed produce. */
function fakeEmbedding(seed: number): number[] {
  const out = new Array<number>(1536); let x = (seed * 2654435761 + 12345) >>> 0; let norm = 0;
  for (let d = 0; d < 1536; d++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; out[d] = (x / 0xffffffff) * 2 - 1; norm += out[d] * out[d]; }
  norm = Math.sqrt(norm); return out.map((v) => Math.round((v / norm) * 1e4) / 1e4);
}

async function buildOps(): Promise<Op[]> {
  const db = await getDb();
  const { getDashboardData } = await import("../src/lib/reminders");
  const { loadGraphData } = await import("../src/lib/graph-data");
  const { loadNotificationPanel } = await import("../src/lib/notification-panel");
  const { loadAppPulse } = await import("../src/lib/app-pulse");
  const { loadKnowledgeBase } = await import("../src/lib/knowledge-base");
  const { loadKnowledgePeople } = await import("../src/lib/knowledge-people");
  const { listContactsPage } = await import("../src/lib/contacts-page-query");
  const { hybridSearchContacts } = await import("../src/lib/hybrid-search");
  const { searchMemories } = await import("../src/lib/memory-search");
  const { queryRemindersPage, queryReminderRailCounts } = await import("../src/lib/reminders-page-query");
  const { getNetworkStatsCounts: getNetworkStats, getDashboardCounts } = await import("../src/lib/dashboard-aggregates").catch(() => ({ getNetworkStatsCounts: null, getDashboardCounts: null } as never));
  const actionsContacts = await import("../src/actions/contacts");
  const actionsChat = await import("../src/actions/chat");
  const actionsGraph = await import("../src/actions/graph");
  const actionsSettings = await import("../src/actions/settings");
  const actionsDuplicates = await import("../src/actions/duplicates");
  const { POST: MCP_POST } = await import("../src/app/api/mcp/route");
  const { GET: EXT_ME } = await import("../src/app/api/extension/me/route");
  const { GET: EXT_SEARCH } = await import("../src/app/api/extension/contacts/route");
  const { POST: EXT_RESOLVE } = await import("../src/app/api/extension/resolve/route");
  const { generateApiKey } = await import("../src/lib/api/keys");
  const { findAvatarBackfillCandidates, countAvatarBackfillCandidates } = await import("../src/lib/avatar-backfill");

  const key = generateApiKey("api");
  await db.execute(sql`DELETE FROM api_keys WHERE user_id = ${USER} AND name = 'latency-ops'`);
  await db.execute(sql`INSERT INTO api_keys (user_id, name, kind, prefix, key_hash, scopes) VALUES (${USER}, 'latency-ops', 'api', ${key.prefix}, ${key.keyHash}, '["read","write"]'::jsonb)`);

  const found = await db.query.contacts.findFirst({ where: and(eq(contacts.userId, USER), eq(contacts.fullName, "Sarah Chen")), columns: { id: true, linkedinUrl: true, title: true, company: true } })
    ?? await db.query.contacts.findFirst({ where: eq(contacts.userId, USER), columns: { id: true, linkedinUrl: true, title: true, company: true } });
  // An empty account (tier "new") has no contact to sample: profile, timeline and MCP lookups
  // then run against a nil uuid, which measures the "not found" path on an empty network.
  const sample = found ?? { id: "00000000-0000-0000-0000-000000000000", linkedinUrl: null, title: null, company: null };
  const tail = (await db.query.contacts.findFirst({ where: eq(contacts.userId, USER), orderBy: (c, { desc }) => desc(c.createdAt), columns: { id: true } })) ?? sample;

  const tool = (name: string, a: Record<string, unknown>) => async () => {
    const res = await MCP_POST(new Request("https://orbit.test/api/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${key.token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: a } }) }));
    return res.text();
  };
  const ext = (handler: (req: Request) => Promise<Response>, method: string, path: string, body?: unknown) => async () => {
    const res = await handler(new Request(`https://orbit.test${path}`, { method, headers: { "content-type": "application/json", "x-orbit-dev-secret": "latency" }, body: body === undefined ? undefined : JSON.stringify(body) }));
    return res.text();
  };
  const field = (value: string | null | undefined) => (value ? { value, source: "h1", confidence: "high" } : null);
  const url = sample.linkedinUrl ?? "https://www.linkedin.com/in/sarah-chen";
  const now = () => new Date("2026-10-17T12:00:00Z");
  const q = fakeEmbedding(42);

  const ops: Op[] = [
    { group: "page", name: "dashboard bundle (getDashboardData)", run: () => getDashboardData(USER) },
    { group: "page", name: "dashboard network stats", run: () => (getNetworkStats ? getNetworkStats(USER) : Promise.resolve(null)) },
    { group: "page", name: "graph (default scope)", run: () => loadGraphData(USER, { profile: null }) },
    { group: "page", name: "graph action (getGraphData)", run: () => actionsGraph.getGraphData() },
    { group: "page", name: "contacts first page", run: () => listContactsPage(USER, { limit: 50 }) },
    { group: "page", name: "contacts page 2 (cursor)", run: async () => { const p = await listContactsPage(USER, { limit: 50 }); return p.nextCursor ? listContactsPage(USER, { limit: 50, cursor: p.nextCursor }) : p; } },
    { group: "page", name: "contacts sort=recent", run: () => listContactsPage(USER, { limit: 50, sort: "recent" as never }) },
    { group: "page", name: "contacts filter company", run: () => listContactsPage(USER, { limit: 50, company: "Acme" }) },
    { group: "page", name: "contacts filter due", run: () => listContactsPage(USER, { limit: 50, followUp: "due" }) },
    { group: "page", name: "contacts letters", run: () => actionsContacts.listContactLetters() },
    { group: "page", name: "contacts plan overview", run: () => actionsSettings.getPlanOverview() },
    { group: "page", name: "contacts duplicates count", run: () => actionsDuplicates.countDuplicates() },
    { group: "page", name: "profile: getContactForProfile", run: () => actionsContacts.getContactForProfile(sample.id) },
    { group: "page", name: "profile: timeline", run: () => actionsContacts.listContactTimelineInteractions(sample.id) },
    { group: "page", name: "profile: related contacts", run: () => actionsContacts.listRelatedContacts(sample.id) },
    { group: "page", name: "profile: tail contact (no demo data)", run: () => actionsContacts.getContactForProfile(tail.id) },
    { group: "page", name: "reminders rail counts", run: () => queryReminderRailCounts(db, USER, { tz: "UTC", inboxId: null }) },
    { group: "page", name: "reminders page today", run: () => queryRemindersPage(db, USER, { view: "today", listId: null, limit: 50, tz: "UTC" } as never, { inboxId: null }) },
    { group: "page", name: "reminders page upcoming", run: () => queryRemindersPage(db, USER, { view: "upcoming", listId: null, limit: 50, tz: "UTC" } as never, { inboxId: null }) },
    { group: "page", name: "knowledge base", run: () => loadKnowledgeBase(USER) },
    { group: "page", name: "knowledge people", run: () => loadKnowledgePeople(USER) },
    { group: "page", name: "chat threads list", run: () => actionsChat.listChatThreads() },
    { group: "page", name: "chat suggestions", run: () => actionsChat.getChatSuggestions() },
    // The two reads behind POST /api/contacts/avatar-backfill, which AppShell fires on every
    // full page load (SRV-16). Read-only: the batch's external lookups are not run.
    { group: "poll", name: "avatar backfill probe (candidates + count)", run: () => Promise.all([findAvatarBackfillCandidates(db, USER, { limit: 5, skipIds: [] }), countAvatarBackfillCandidates(db, USER, [])]) },
    { group: "poll", name: "notification panel", run: () => loadNotificationPanel(USER, now(), { withAlerts: true }) },
    { group: "poll", name: "app pulse (90s/tab)", run: () => loadAppPulse(USER, now()) },
    { group: "search", name: "contacts search 'hop' (prefix, no embedding)", run: () => listContactsPage(USER, { q: "ho", limit: 50 }) },
    { group: "search", name: "contacts search 'hopper' (hybrid)", run: () => listContactsPage(USER, { q: "hopper", limit: 50 }) },
    { group: "search", name: "contacts search 'engineer at acme' (hybrid)", run: () => listContactsPage(USER, { q: "engineer at acme", limit: 50 }) },
    { group: "search", name: "hybrid keyword only", run: () => hybridSearchContacts(USER, { query: "Acme engineer", limit: 12 }) },
    { group: "search", name: "hybrid keyword+semantic", run: () => hybridSearchContacts(USER, { query: "Acme engineer", embedding: q, limit: 12 }) },
    { group: "search", name: "hybrid semantic-heavy (nonsense keyword)", run: () => hybridSearchContacts(USER, { query: "zqxv", embedding: q, limit: 12 }) },
    { group: "search", name: "hybrid filtered (recall guard)", run: () => hybridSearchContacts(USER, { query: "engineer", embedding: q, limit: 12, filters: { companies: ["Nonexistent Co"] } as never }) },
    { group: "search", name: "memory search lexical", run: () => searchMemories(USER, { query: "hiring roadmap recruiter", limit: 8 }) },
    { group: "search", name: "memory search hybrid", run: () => searchMemories(USER, { query: "hiring roadmap recruiter", embedding: q, limit: 8 }) },
    { group: "search", name: "picker search", run: () => actionsContacts.searchContactsForPicker("hop" as never) },
    { group: "mcp", name: "mcp search_contacts", run: tool("search_contacts", { query: "Acme engineer", limit: 10 }) },
    { group: "mcp", name: "mcp get_contact", run: tool("get_contact", { contactId: sample.id }) },
    { group: "mcp", name: "mcp who_do_i_know_at", run: tool("who_do_i_know_at", { company: "Globex" }) },
    { group: "mcp", name: "mcp due_followups", run: tool("due_followups", { limit: 25 }) },
    { group: "mcp", name: "mcp get_network_overview", run: tool("get_network_overview", {}) },
    { group: "mcp", name: "mcp get_timeline", run: tool("get_timeline", { contactId: sample.id, limit: 20 }) },
    { group: "mcp", name: "mcp find_path_to", run: tool("find_path_to", { target: "Stanford" }) },
    { group: "ext", name: "ext me", run: ext(EXT_ME, "GET", "/api/extension/me") },
    { group: "ext", name: "ext search", run: ext(EXT_SEARCH, "GET", "/api/extension/contacts?q=hopper") },
    { group: "ext", name: "ext resolve", run: ext(EXT_RESOLVE, "POST", "/api/extension/resolve", { page: { schemaVersion: 1, site: "linkedin", adapterVersion: "bench", kind: "person", url, sourceUrl: url, capturedAt: "2026-01-01T00:00:00.000Z", identity: { name: field("Sarah Chen"), headline: null, title: field(sample.title), company: field(sample.company), location: null, school: null, email: null, handle: null, profileUrl: field(url), photoUrl: null }, text: { blob: "Sarah Chen", truncated: false, charCount: 10, fromSelection: false }, warnings: [] } }) },
  ];
  void getDashboardCounts;
  return ops.filter((op) => (!ONLY.length || ONLY.some((o) => op.name.includes(o) || op.group === o)) && !SKIP.some((s) => op.name.includes(s)));
}

async function measure() {
  const latency = Number(env.ORBIT_SIM_DB_LATENCY_MS) || 0;
  const db = await getDb();
  const results: Record<string, Record<string, unknown>> = {};
  const ops = await buildOps();
  for (const op of ops) {
    await db.execute(sql`DELETE FROM rate_limit_buckets`);
    await db.execute(sql`DELETE FROM extension_usage`);
    try {
      await op.run(); // warm modules and caches
      if (latency) {
        const xs: number[] = [];
        for (let i = 0; i < 3; i++) xs.push((await time(op.run)).ms);
        // Depth is computed by the parent from sim_ms and the plain pass's cpu_ms.
        results[op.name] = { group: op.group, sim_ms: Math.round(median(xs)) };
        continue;
      }
      startQueryCount();
      const first = await time(op.run);
      const statements = stopQueryCount();
      const sqlText = capturedQueries();
      const cpu: number[] = [];
      for (let i = 0; i < 7; i++) cpu.push((await time(op.run)).ms);
      results[op.name] = {
        group: op.group,
        statements,
        kb: Math.round((plainBytes(first.value) / 1024) * 10) / 10,
        cpu_ms: Math.round(median(cpu) * 10) / 10,
        // Fingerprint of the statements (first 90 chars each) so a change in shape is visible in a diff.
        sql: sqlText.map((s) => s.replace(/\s+/g, " ").slice(0, 90)),
      };
    } catch (err) {
      results[op.name] = { group: op.group, error: String(err).slice(0, 200) };
    }
    console.error(`${latency ? "latency" : "plain"} ${op.name}: ${JSON.stringify({ ...results[op.name], sql: undefined })}`);
  }
  return results;
}

async function main() {
  const { writeFileSync, readFileSync, mkdtempSync, mkdirSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { tmpdir } = await import("node:os");
  if (args.includes("--child")) {
    const out = flag("child-out", "");
    const res = await measure();
    await closeDb();
    writeFileSync(out, JSON.stringify(res));
    return;
  }
  const { spawnSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "orbit-latency-ops-"));
  const pass = (name: string, latency: number) => {
    const file = join(dir, `${name}.json`);
    const res = spawnSync("npx", ["tsx", process.argv[1], "--child", "--child-out", file, ...args], { stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, ORBIT_SIM_DB_LATENCY_MS: latency ? String(latency) : "" } });
    if (res.status !== 0) throw new Error(`${name} pass failed`);
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, Record<string, unknown>>;
  };
  const plain = pass("plain", 0);
  const slow = pass("latency", LATENCY_MS);
  const rows = Object.keys(plain).map((op) => {
    const p = plain[op]; const s = slow[op] ?? {};
    const cpu = Number(p.cpu_ms ?? 0);
    // sim_ms = cpu + depth × LATENCY_MS: the op does the same CPU work under simulated
    // latency, so the sequential round trips are what is left after the CPU time.
    const depth = s.sim_ms == null ? 0 : Math.max(0, Math.round(((Number(s.sim_ms) - cpu) / LATENCY_MS) * 10) / 10);
    return { op, ...p, ...s, depth, est_ms_rtt8: Math.round(depth * 8 + cpu), est_ms_rtt40: Math.round(depth * 40 + cpu) };
  });
  console.table(rows.map((r) => { const { sql: _sql, ...rest } = r as Record<string, unknown>; return rest; }));
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ tier: TIER, latencyMs: LATENCY_MS, at: new Date().toISOString(), rows }, null, 2));
  console.log(`wrote ${OUT}`);
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
