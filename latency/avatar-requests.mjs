/**
 * Avatar requests per /contacts visit: a cold browser cache, then a repeat visit in the same
 * context, counting `/api/avatars/*` responses that reached the server vs. came from cache.
 *
 *   node latency/avatar-requests.mjs --base=http://localhost:3101 [--out=...]
 *
 * Needs contacts with durable (Blob-host) photos to mean anything; the seed's inline photos
 * were always served with a cache header. Blob URLs resolve to a closed local port (this
 * sandbox cannot reach the store), so the count is about Orbit's own route, not a third party.
 */
import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import { chromiumExecutable, flag, writeJson } from "./lib/stats.mjs";

const BASE = flag("base", "http://localhost:3101").replace(/\/$/, "");
/** The dev server's log: its `GET /api/avatars/...` lines are the function calls that ran. */
const LOG = flag("log", "");
const serverHits = () => (LOG ? (readFileSync(LOG, "utf8").match(/GET \/api\/avatars\/\S+ (\d{3})/g) ?? []) : []);
const OUT = flag("out", `latency/results/avatar-requests-${Date.now()}.json`);

async function newContext(browser) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 2400 } });
  return context;
}

async function visit(context, page) {
  const hits = [];
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  cdp.on("Network.responseReceived", (e) => {
    if (e.response.url.includes("/api/avatars/")) hits.push({ status: e.response.status, cached: Boolean(e.response.fromDiskCache || e.response.fromMemoryCache) });
  });
  const before = serverHits().length;
  const t = Date.now();
  await page.goto(`${BASE}/contacts`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.waitForSelector("main li[role='link'] [data-slot='avatar']", { timeout: 120_000 });
  await page.waitForLoadState("networkidle", { timeout: 120_000 });
  await page.waitForTimeout(3000); // the dev server logs a request after it finishes
  await cdp.detach();
  const network = hits.filter((h) => !h.cached);
  const served = serverHits().slice(before);
  return { ms: Date.now() - t, server_calls: LOG ? served.length : null, server_redirects: LOG ? served.filter((l) => / 30\d$/.test(l)).length : null, avatar_responses: hits.length, from_cache: hits.length - network.length, to_server: network.length, redirects_to_server: network.filter((h) => h.status >= 300 && h.status < 400).length };
}

// Blob photos resolve to a closed local port (fails fast). Not `context.route()`: request
// interception turns the browser's HTTP cache off, which is the very thing being measured.
const browser = await chromium.launch({ headless: true, executablePath: chromiumExecutable(chromium), args: ["--host-resolver-rules=MAP *.blob.vercel-storage.com 127.0.0.1:9"] });
try {
  const warm = await newContext(browser);
  await visit(warm, await warm.newPage()); // compiles the route in dev; not counted
  await warm.close();
  const context = await newContext(browser);
  const page = await context.newPage();
  const first = await visit(context, page);
  const repeat = await visit(context, page);
  const out = { base: BASE, at: new Date().toISOString(), first, repeat };
  console.log(JSON.stringify(out));
  writeJson(OUT, out);
} finally {
  await browser.close();
}
