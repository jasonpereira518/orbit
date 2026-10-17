/**
 * HTTP latency for the route handlers and the page documents: p50 / p95 / p99 for a single
 * user making requests one after another, and again under light concurrent load.
 *
 *   node latency/api.mjs --base=http://localhost:3001 --key-file=latency/.data/tier-5000.api-key
 *        [--n=30] [--concurrency=5] [--only=health,mcp] [--out=latency/results/x/api.json]
 *
 * Every target is a request a real client makes: page documents (full HTML, streamed), the
 * MCP tools (Claude/ChatGPT connector), the extension API, the public /api/v1, avatars,
 * capture job polling. Server Actions are not HTTP-addressable by name (Next mints opaque
 * ids), so their cost is measured in-process by latency/server-ops.ts instead.
 *
 * Reports, per target:
 *   ttfb   headers received (for documents: the shell flushed)
 *   total  body fully read (for documents: the last streamed Suspense boundary)
 * The server must run in demo mode with EXTENSION_DEV_SECRET=latency and
 * EXTENSION_DEV_USER_ID=demo-user for the extension routes to answer.
 */
import { readFileSync } from "node:fs";
import { flag, percentile, r0, sleep, writeJson } from "./lib/stats.mjs";

const BASE = flag("base", "http://localhost:3001").replace(/\/$/, "");
const N = Number(flag("n", "30"));
const CONC = Number(flag("concurrency", "5"));
const ONLY = (flag("only", "") || "").split(",").filter(Boolean);
const OUT = flag("out", `latency/results/api-${Date.now()}.json`);
const KEY_FILE = flag("key-file", "");
/**
 * The authenticated routes are rate limited per user (src/lib/rate-limit.ts: `mcp` and
 * `apiRead` 120/min; src/lib/extension/http.ts has its own per-minute window), and a 429 is
 * a fast response that would pass for a good p50. Limited groups get fewer samples per
 * target (--n-limited) and a pause whenever the next target would overflow the window.
 */
const N_LIMITED = Number(flag("n-limited", "10"));
const LIMITS = { mcp: Number(flag("limit-mcp", "120")), v1: Number(flag("limit-v1", "120")), ext: Number(flag("limit-ext", "60")) };
const groupOf = (name) => (name.includes(" mcp ") ? "mcp" : name.includes(" v1 ") ? "v1" : name.includes(" ext ") ? "ext" : null);
const windowLog = {};
async function budget(group, calls) {
  if (!group) return;
  const now = Date.now();
  const log = ((windowLog[group] ??= []).filter((t) => now - t < 61_000));
  if (log.length + calls > LIMITS[group]) {
    const wait = Math.max(1000, 61_000 - (now - log[0]));
    console.log(`pausing ${Math.ceil(wait / 1000)} s for the ${group} rate-limit window (${LIMITS[group]}/min)`);
    await sleep(wait);
    log.length = 0;
  }
  for (let i = 0; i < calls; i++) log.push(Date.now());
  windowLog[group] = log;
}
const API_KEY = KEY_FILE ? readFileSync(KEY_FILE, "utf8").trim() : "";

const mcp = (name, args) => ({
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${API_KEY}` },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
});
const ext = (body) => ({
  method: body ? "POST" : "GET",
  headers: { "content-type": "application/json", "x-orbit-dev-secret": "latency" },
  body: body ? JSON.stringify(body) : undefined,
});
const v1 = () => ({ headers: { authorization: `Bearer ${API_KEY}` } });

/** name → [path, init]. Documents first, so a warm server is what the API numbers see. */
const TARGETS = {
  "doc /dashboard": ["/dashboard", {}],
  "doc /contacts": ["/contacts", {}],
  "doc /contacts?q=hopper": ["/contacts?q=hopper", {}],
  "doc /contacts/[id]": ["__contact__", {}],
  "doc /reminders": ["/reminders", {}],
  "doc /capture": ["/capture", {}],
  "doc /chat": ["/chat", {}],
  "doc /graph": ["/graph", {}],
  "doc /knowledge": ["/knowledge", {}],
  "doc /imports": ["/imports", {}],
  "doc /settings": ["/settings", {}],
  "api /api/health": ["/api/health", {}],
  "api mcp search_contacts": ["/api/mcp", mcp("search_contacts", { query: "Acme engineer", limit: 10 })],
  "api mcp who_do_i_know_at": ["/api/mcp", mcp("who_do_i_know_at", { company: "Globex" })],
  "api mcp due_followups": ["/api/mcp", mcp("due_followups", { limit: 25 })],
  "api mcp get_network_overview": ["/api/mcp", mcp("get_network_overview", {})],
  "api mcp get_contact": ["/api/mcp", "__mcp_get_contact__"],
  "api v1 contacts?q=": ["/api/v1/contacts?q=hopper&limit=20", v1()],
  "api v1 followups": ["/api/v1/followups", v1()],
  "api ext me": ["/api/extension/me", ext()],
  "api ext contacts?q=": ["/api/extension/contacts?q=hopper", ext()],
  "api avatar": ["__avatar__", {}],
  // No GET polling route exists: /api/capture/jobs is POST-only (media upload) and the client
  // polls capture jobs through a Server Action, which latency/server-ops.ts measures in-process.
  "api meetings candidates": ["/api/meetings/candidates", {}],
};

async function timed(path, init) {
  const started = performance.now();
  const res = await fetch(`${BASE}${path}`, { ...init, redirect: "manual" });
  const ttfb = performance.now() - started;
  let bytes = 0;
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
    }
  }
  return { ttfb, total: performance.now() - started, status: res.status, bytes };
}

async function firstContactId() {
  if (!API_KEY) return null;
  const res = await fetch(`${BASE}/api/v1/contacts?limit=1`, v1()).catch(() => null);
  if (!res || !res.ok) return null;
  const body = await res.json().catch(() => null);
  const row = body?.data?.contacts?.[0] ?? body?.contacts?.[0] ?? body?.items?.[0] ?? body?.data?.[0] ?? (Array.isArray(body) ? body[0] : null);
  return row?.id ?? null;
}

function stats(samples) {
  const ttfb = samples.map((s) => s.ttfb);
  const total = samples.map((s) => s.total);
  return {
    n: samples.length,
    status: [...new Set(samples.map((s) => s.status))].join(","),
    kb: r0((samples.reduce((a, s) => a + s.bytes, 0) / samples.length) / 1024),
    ttfb_p50: r0(percentile(ttfb, 50)), ttfb_p95: r0(percentile(ttfb, 95)), ttfb_p99: r0(percentile(ttfb, 99)),
    p50: r0(percentile(total, 50)), p95: r0(percentile(total, 95)), p99: r0(percentile(total, 99)),
  };
}

const contactId = await firstContactId();
const results = {};
for (const [name, [rawPath, rawInit]] of Object.entries(TARGETS)) {
  if (ONLY.length && !ONLY.some((o) => name.includes(o))) continue;
  if ((name.includes("mcp") || name.includes("v1")) && !API_KEY) continue;
  let path = rawPath;
  let init = rawInit;
  if (path === "__contact__") { if (!contactId) continue; path = `/contacts/${contactId}`; }
  if (path === "__avatar__") { if (!contactId) continue; path = `/api/avatars/${contactId}`; }
  if (init === "__mcp_get_contact__") { if (!contactId) continue; init = mcp("get_contact", { contactId }); }

  const group = groupOf(name);
  const n = group ? Math.min(N, N_LIMITED) : N;
  await budget(group, 1 + n + Math.ceil(n / CONC) * CONC);
  await timed(path, init); // warm the route (dev compiles on first hit)
  const single = [];
  for (let i = 0; i < n; i++) single.push(await timed(path, init));
  const concurrent = [];
  for (let round = 0; round < Math.ceil(n / CONC); round++) {
    concurrent.push(...(await Promise.all(Array.from({ length: CONC }, () => timed(path, init)))));
  }
  results[name] = { path, single: stats(single), concurrent: stats(concurrent) };
  console.log(name.padEnd(32), "single p50/p95", results[name].single.p50, results[name].single.p95, "| conc p50/p95", results[name].concurrent.p50, results[name].concurrent.p95, "| status", results[name].single.status);
}
writeJson(OUT, { base: BASE, n: N, concurrency: CONC, at: new Date().toISOString(), results });
