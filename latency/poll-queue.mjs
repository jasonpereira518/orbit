/**
 * What occupies a tab's Server Action queue while a capture extraction runs.
 *
 *   node latency/poll-queue.mjs --base=http://localhost:3101 [--seconds=12] [--out=...]
 *
 * Next runs a tab's Server Actions one at a time, so any click that calls an action waits
 * for whatever action is in flight. This pastes a note on /capture, presses "Extract people",
 * and for `seconds` records every request the page makes to Orbit:
 *   actions          Server Action POSTs (the queue a click would wait in)
 *   action_busy_ms   total time an action was in flight: the window a click lands behind one
 *   poll_routes      capture-status polls sent as plain fetches (they do not hold the queue)
 *   reviewed         the review screen arrived (the poll is what brings it)
 * Needs latency/mock-providers.mjs for the extraction itself.
 */
import { chromium } from "playwright";
import { chromiumExecutable, flag, writeJson } from "./lib/stats.mjs";

const BASE = flag("base", "http://localhost:3101").replace(/\/$/, "");
const SECONDS = Number(flag("seconds", "12"));
const ROUNDS = Number(flag("rounds", "2"));
const OUT = flag("out", `latency/results/poll-queue-${Date.now()}.json`);
const NOTES = "Coffee with Priya Natarajan and Marcus Webb at the summit. Priya runs platform at Northwind and is hiring two staff engineers in Q1. Marcus is leaving Globex to start something in fintech. Also met Elena Rossi (recruiter at Initech) and Tom Okafor.";

async function once(browser) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${BASE}/capture`, { waitUntil: "networkidle", timeout: 120_000 });
  // A previous run's capture may still be waiting for review: start a new one.
  const startOver = page.getByRole("button", { name: "Start over" });
  if (await startOver.isVisible().catch(() => false)) {
    await startOver.click();
    const confirm = page.getByRole("alertdialog").getByRole("button").last();
    if (await confirm.isVisible({ timeout: 2000 }).catch(() => false)) await confirm.click();
  }
  const box = page.locator("textarea").first();
  await box.waitFor({ timeout: 60_000 });
  await box.fill(NOTES);
  const started = new Map();
  const done = [];
  page.on("request", (r) => {
    if (!r.url().startsWith(BASE)) return;
    const h = r.headers();
    const kind = h["next-action"] ? "action" : /\/api\/capture\/jobs\/[^/]+\/status/.test(r.url()) ? "poll_route" : null;
    if (kind) started.set(r, { kind, t: Date.now() });
  });
  page.on("requestfinished", (r) => {
    const s = started.get(r);
    if (s) done.push({ kind: s.kind, ms: Date.now() - s.t });
  });
  await page.getByRole("button", { name: "Extract people" }).click();
  await page.waitForTimeout(SECONDS * 1000);
  // The poll is what moves the page on: the review must have arrived through it.
  const reviewed = await page.getByText(/^\d+ of \d+$/i).first().isVisible().catch(() => false);
  if (flag("shot", "")) await page.screenshot({ path: flag("shot", "") });
  const actions = done.filter((d) => d.kind === "action");
  const polls = done.filter((d) => d.kind === "poll_route");
  await context.close();
  return {
    reviewed,
    actions: actions.length,
    action_busy_ms: actions.reduce((a, d) => a + d.ms, 0),
    poll_routes: polls.length,
    poll_route_ms: polls.reduce((a, d) => a + d.ms, 0),
  };
}

const browser = await chromium.launch({ headless: true, executablePath: chromiumExecutable(chromium) });
try {
  await once(browser).catch(() => null); // warm: compiles routes in dev
  const rows = [];
  for (let i = 0; i < ROUNDS; i++) {
    const r = await once(browser).catch((err) => ({ error: String(err).slice(0, 200) }));
    console.log(JSON.stringify(r));
    rows.push(r);
  }
  writeJson(OUT, { base: BASE, seconds: SECONDS, at: new Date().toISOString(), rows });
} finally {
  await browser.close();
}
