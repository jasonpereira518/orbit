/**
 * Server work per interaction: how many requests to Orbit's own origin one user action
 * triggers (route renders, i.e. RSC fetches, and Server Action POSTs), and how long until the
 * page settles.
 *
 *   node latency/renders.mjs --base=http://localhost:3101 [--rounds=3] [--out=...]
 *
 * Interactions:
 *   search   /contacts: type a query into the search box. Counted from the first keystroke
 *            until the network is idle; settled_ms is from the last keystroke.
 *   log      /contacts/[id]: open "Log interaction", type a note, save. Counted from the
 *            click on save.
 */
import { chromium } from "playwright";
import { chromiumExecutable, flag, writeJson } from "./lib/stats.mjs";

const BASE = flag("base", "http://localhost:3101").replace(/\/$/, "");
const ROUNDS = Number(flag("rounds", "3"));
const OUT = flag("out", `latency/results/renders-${Date.now()}.json`);
const ONLY = flag("only", "");

function track(page) {
  const seen = [];
  const onRequest = (req) => {
    const url = req.url();
    if (!url.startsWith(BASE)) return;
    const h = req.headers();
    const kind = h["next-action"] ? "action" : h["rsc"] === "1" || url.includes("_rsc=") ? "render" : null;
    if (kind) seen.push({ kind, method: req.method(), path: new URL(url).pathname + new URL(url).search.replace(/[?&]_rsc=[^&]*/, "") });
  };
  page.on("request", onRequest);
  return { seen, stop: () => page.off("request", onRequest) };
}

const summarize = (seen) => ({
  renders: seen.filter((s) => s.kind === "render").length,
  actions: seen.filter((s) => s.kind === "action").length,
  requests: seen.map((s) => `${s.kind} ${s.method} ${s.path}`),
});

async function search(page, round) {
  await page.goto(`${BASE}/contacts`, { waitUntil: "networkidle", timeout: 120_000 });
  const box = page.getByRole("searchbox", { name: "Search contacts" }).or(page.getByLabel("Search contacts")).first();
  await box.waitFor({ timeout: 60_000 });
  await page.waitForTimeout(2500); // let FreshOnArrival / pulse settle before counting
  const t = track(page);
  const term = ["hop", "chen", "acme"][round % 3];
  await box.click();
  await box.pressSequentially(term, { delay: 60 });
  const typed = Date.now();
  await page.waitForURL((u) => u.searchParams.get("q") === term, { timeout: 60_000 });
  await page.waitForLoadState("networkidle", { timeout: 60_000 });
  const settled = Date.now() - typed;
  await page.waitForTimeout(1500);
  t.stop();
  return { term, settled_ms: settled, ...summarize(t.seen) };
}

async function log(page, round) {
  await page.goto(`${BASE}/contacts`, { waitUntil: "networkidle", timeout: 120_000 });
  const row = page.locator("main li[role='link']").nth(round);
  await row.click();
  await page.waitForURL(/\/contacts\/[0-9a-f-]{36}/, { timeout: 60_000 });
  await page.waitForLoadState("networkidle", { timeout: 60_000 });
  await page.getByRole("button", { name: /log interaction|log a note|^log$/i }).first().click();
  const notes = page.getByRole("dialog").locator("textarea").first();
  await notes.waitFor({ timeout: 30_000 });
  const note = `Caught up over coffee, round ${round}, ${Date.now()}.`;
  await notes.fill(note);
  await page.waitForTimeout(2500);
  const countRows = () => page.locator("main [data-interaction-id]").count();
  const rowsBefore = await countRows();
  const t = track(page);
  const clicked = Date.now();
  await page.getByRole("dialog").getByRole("button", { name: /^(save|log)/i }).last().click();
  await page.getByRole("dialog").waitFor({ state: "detached", timeout: 60_000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 60_000 });
  const settled = Date.now() - clicked;
  // Dropping a render is only a win if the page still shows the write: the timeline must
  // gain the new interaction without a reload.
  const rowsAfter = await countRows();
  await page.waitForTimeout(1500);
  t.stop();
  return { settled_ms: settled, timeline_before: rowsBefore, timeline_after: rowsAfter, reflected: rowsAfter > rowsBefore, ...summarize(t.seen) };
}

const browser = await chromium.launch({ headless: true, executablePath: chromiumExecutable(chromium) });
const out = { base: BASE, at: new Date().toISOString(), search: [], log: [] };
try {
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  for (const [name, fn] of [["search", search], ["log", log]]) {
    if (ONLY && ONLY !== name) continue;
    await fn(page, 99).catch(() => null); // warm: compiles routes in dev, not counted
    for (let i = 0; i < ROUNDS; i++) {
      const r = await fn(page, i).catch((err) => ({ error: String(err).slice(0, 200) }));
      console.log(name, JSON.stringify(r));
      out[name].push(r);
    }
  }
  writeJson(OUT, out);
} finally {
  await browser.close();
}
