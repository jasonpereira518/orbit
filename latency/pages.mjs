/**
 * Browser-level latency for every main page, on two device profiles.
 *
 *   node latency/pages.mjs --base=http://localhost:3001 --profile=desktop|mobile4g|both
 *        [--rounds=3] [--only=/dashboard,/contacts] [--out=latency/results/x/pages.json]
 *
 * Per page and profile, median over `--rounds` cold loads (new browser context each time,
 * caches empty):
 *   ttfb       responseStart of the navigation
 *   fcp, lcp   paint timings (PerformanceObserver, buffered)
 *   cls        sum of unexpected layout shifts until `usable`
 *   tbt        total blocking time (long tasks > 50 ms) until `usable`
 *   usable     first animation frame where React has hydrated, the page's content selector is
 *              present, and no skeleton / aria-busy / dialog spinner is visible. "Painted" is
 *              FCP; this is when a person can actually act on the page.
 *   inp        max event-timing duration for the page's main interaction (see INTERACTIONS)
 *   js_kb      transfer size of every script the page fetched (gz on the wire)
 *   requests   resource count up to `usable` + 1 s
 * Then, in the same context (warm caches, service worker installed):
 *   repeat     the same page loaded again: ttfb / usable / js_kb / requests
 * Then client-side navigation (sidebar click, measured from the click):
 *   nav        time until URL changed and no skeleton visible, for a fixed tour, plus
 *              history back / forward.
 *
 * Point it at a demo-mode server (no Clerk keys). Dev mode compiles routes on first hit,
 * so the script warms every route once before measuring; a `next dev` number is still an
 * upper bound (dev React, unminified chunks, no prefetch). See latency/README.md.
 */
import { chromium } from "playwright";
import { chromiumExecutable, flag, median, PROFILES, r0, r1, sleep, writeJson } from "./lib/stats.mjs";

const BASE = flag("base", "http://localhost:3001").replace(/\/$/, "");
const PROFILE = flag("profile", "both");
const ROUNDS = Number(flag("rounds", "3"));
const ONLY = (flag("only", "") || "").split(",").filter(Boolean);
/** Pages (and "nav") to leave out, e.g. --skip=/contacts,nav when a page is known to hang the tier. */
const SKIP = (flag("skip", "") || "").split(",").filter(Boolean);
const OUT = flag("out", `latency/results/pages-${Date.now()}.json`);
const WARM = flag("warm", "1") !== "0";

/** Page → the selector that means "the content a person came for is on screen". */
const PAGES = {
  "/dashboard": "main h1, main [data-slot='card']",
  // Contact rows are <li role="link"> with an avatar, not anchors (the only anchor is /contacts/new).
  // Rows when the account has people; the empty-state heading when it has none (tier `new`).
  "/contacts": "main li[role='link'], main [data-slot='avatar'], main h2",
  "/contacts/[id]": "main h1",
  // The capture page renders a composer, not a bare textarea: any input or the heading counts.
  "/capture": "main textarea, main form, main [contenteditable], main input, main h1",
  "/chat": "main textarea, main form",
  "/graph": ".react-flow__node, .constellation-stage, main svg, main canvas",
  "/knowledge": "main h1",
  "/reminders": "main h1",
  "/imports": "main h1",
  "/events": "main h1",
  "/meetings": "main h1",
  "/outreach": "main h1",
  "/recruiters": "main h1",
  "/radar": "main h1",
  "/settings": "main h1, h1",
  // "/onboarding" is left out: in demo mode it client-redirects to /dashboard, so it is not a page load.
  "/": "main h1, h1",
  "/pricing": "main h1, h1",
};

/** The page's main interaction for INP: a selector to click (first match) once usable. */
const INTERACTIONS = {
  "/dashboard": "nav a[href='/contacts']",
  "/contacts": "main input[type='search'], main input[placeholder*='earch']",
  "/contacts/[id]": "main button",
  "/capture": "main textarea, main [contenteditable], main input, main button",
  "/chat": "main textarea",
  "/graph": ".react-flow__pane",
  "/reminders": "main button",
  "/knowledge": "main input, main button",
  "/settings": "main button",
};

const BUSY = `[data-slot="skeleton"], [aria-busy="true"], [role="dialog"] .animate-spin`;
const NAV_TOUR = ["/contacts", "/reminders", "/dashboard", "/graph", "/chat", "/capture", "/contacts", "/dashboard"];

/** Installed before any page script so buffered entries are captured from navigation start. */
const PRELUDE = `
(() => {
  // next dev mounts its dev-tools indicator (<nextjs-portal>) bottom-left, over the mobile
  // bottom bar's first tab, so a tap there never reaches the link. Not part of any build.
  document.addEventListener("DOMContentLoaded", () => { const s = document.createElement("style"); s.textContent = "nextjs-portal{display:none!important}"; document.head.appendChild(s); });
  const m = (window.__lat = { fcp: null, lcp: null, cls: 0, lt: [], inp: 0, events: 0, usable: null, hydrated: null });
  const obs = (type, cb, opts = {}) => { try { new PerformanceObserver((l) => l.getEntries().forEach(cb)).observe({ type, buffered: true, ...opts }); } catch {} };
  obs("paint", (e) => { if (e.name === "first-contentful-paint") m.fcp = e.startTime; });
  obs("largest-contentful-paint", (e) => { m.lcp = e.startTime; });
  obs("layout-shift", (e) => { if (!e.hadRecentInput && m.usable == null) m.cls += e.value; });
  obs("longtask", (e) => { m.lt.push({ s: e.startTime, d: e.duration }); });
  obs("event", (e) => { if (e.interactionId) { m.events++; m.inp = Math.max(m.inp, e.duration); } }, { durationThreshold: 16 });
  window.__latReady = (selector) => {
    const busy = () => [...document.querySelectorAll(${JSON.stringify(BUSY)})].some((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
    // React attaches fiber keys to every element it owns; the root may be <main>, or on pages
    // without one (onboarding) a plain div, so check the first elements under <body>.
    const hydrated = () => { const els = [document.querySelector("main"), ...document.body.querySelectorAll("*")].filter(Boolean).slice(0, 120); return els.some((el) => Object.keys(el).some((k) => k.startsWith("__reactFiber"))); };
    (function poll() {
      if (m.hydrated == null && hydrated()) m.hydrated = performance.now();
      if (m.usable == null && m.hydrated != null && document.querySelector(selector) && !busy()) { m.usable = performance.now(); return; }
      requestAnimationFrame(poll);
    })();
  };
})();`;

async function newContext(browser, profile) {
  const p = PROFILES[profile];
  const context = await browser.newContext({
    viewport: p.viewport,
    isMobile: p.mobile,
    hasTouch: p.mobile,
    deviceScaleFactor: p.deviceScaleFactor ?? 1,
    serviceWorkers: "allow",
    ignoreHTTPSErrors: true,
  });
  await context.addInitScript(PRELUDE);
  return context;
}

async function throttle(page, profile) {
  const p = PROFILES[profile];
  const cdp = await page.context().newCDPSession(page);
  if (p.network) {
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", { offline: false, ...p.network });
  }
  if (p.cpuRate > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: p.cpuRate });
  return cdp;
}

async function resources(page) {
  return page.evaluate(() => {
    const rs = performance.getEntriesByType("resource");
    const nav = performance.getEntriesByType("navigation")[0];
    const js = rs.filter((r) => r.initiatorType === "script" || /\.js(\?|$)/.test(r.name));
    const sum = (xs, k) => xs.reduce((a, r) => a + (r[k] || 0), 0);
    return {
      requests: rs.length + 1,
      js_kb: Math.round((sum(js, "transferSize") + (nav?.transferSize || 0) * 0) / 1024),
      js_decoded_kb: Math.round(sum(js, "decodedBodySize") / 1024),
      css_kb: Math.round(sum(rs.filter((r) => /\.css(\?|$)/.test(r.name)), "transferSize") / 1024),
      html_kb: Math.round((nav?.transferSize || 0) / 1024),
      total_kb: Math.round((sum(rs, "transferSize") + (nav?.transferSize || 0)) / 1024),
      ttfb: nav ? nav.responseStart : null,
      dcl: nav ? nav.domContentLoadedEventEnd : null,
      load: nav ? nav.loadEventEnd : null,
    };
  });
}

async function measureLoad(page, path, selector, interaction) {
  // Generous limits: a page that takes 30 s+ to answer (e.g. /contacts at 5,000 contacts in
  // next dev) is a measurement, not an error.
  await page.goto(`${BASE}${path}`, { waitUntil: "commit", timeout: 180_000 });
  await page.evaluate((s) => window.__latReady(s), selector);
  const t0 = Date.now();
  while (Date.now() - t0 < 120_000) {
    const usable = await page.evaluate(() => window.__lat?.usable ?? null).catch(() => null);
    if (usable != null) break;
    await sleep(50);
  }
  // Let late resources and LCP settle, then take the page's main interaction for INP.
  await sleep(1000);
  const m = await page.evaluate(() => window.__lat);
  const res = await resources(page);
  let inp = null;
  if (interaction) {
    const el = page.locator(interaction).first();
    if (await el.count()) {
      try {
        await el.click({ timeout: 5000, trial: false, noWaitAfter: true });
        await sleep(600);
        const after = await page.evaluate(() => window.__lat).catch(() => null);
        inp = after?.events ? after.inp : null;
      } catch {}
    }
  }
  const tbt = (m.lt || []).filter((t) => m.usable == null || t.s < m.usable).reduce((a, t) => a + Math.max(0, t.d - 50), 0);
  return {
    ttfb: r0(res.ttfb), fcp: r0(m.fcp), lcp: r0(m.lcp), cls: r1(m.cls * 1000) / 1000, tbt: r0(tbt),
    hydrated: r0(m.hydrated), usable: r0(m.usable), inp: r0(inp),
    js_kb: res.js_kb, js_decoded_kb: res.js_decoded_kb, css_kb: res.css_kb, total_kb: res.total_kb, requests: res.requests,
    dcl: r0(res.dcl), load: r0(res.load),
  };
}

function medianOf(rows) {
  const out = {};
  for (const k of Object.keys(rows[0] ?? {})) {
    const xs = rows.map((r) => r[k]).filter((x) => typeof x === "number");
    out[k] = xs.length ? (Number.isInteger(xs[0]) ? r0(median(xs)) : r1(median(xs))) : null;
  }
  return out;
}

/**
 * A contact profile path: the profile page everyone opens. The contacts list renders rows as
 * <li role="link">, not anchors, so the dashboard's contact links (uuid hrefs) are the source;
 * an empty account has none and the profile page is skipped.
 */
async function firstContactPath(context) {
  const page = await context.newPage();
  try {
    for (const path of ["/dashboard", "/contacts"]) {
      await page.goto(`${BASE}${path}`, { waitUntil: "load" });
      await page.waitForSelector("main", { timeout: 20_000 }).catch(() => null);
      await sleep(1500);
      const href = await page.evaluate(() => [...document.querySelectorAll("a[href^='/contacts/']")].map((a) => a.getAttribute("href")).find((h) => /^\/contacts\/[0-9a-f-]{36}$/.test(h)) ?? null).catch(() => null);
      if (href) return href;
    }
    return null;
  } finally {
    await page.close();
  }
}

async function clickNav(page, path) {
  // Only a visible link counts: at phone width the sidebar is collapsed and only the bottom
  // bar's few entries can be tapped, so a page with no visible link reports `missing_link`
  // for that profile instead of failing the run.
  // Prefer a link inside a <nav> (sidebar or bottom bar): a visible logo/header link to the
  // same path may sit under an overlay and never receive the tap.
  let link = null;
  for (const sel of [`nav a[href='${path}']`, `a[href='${path}']`]) {
    const l = page.locator(sel).locator("visible=true");
    if (await l.count().catch(() => 0)) { link = l.first(); break; }
  }
  if (!link) return null;
  const started = await page.evaluate(() => performance.now());
  try {
    await link.click({ noWaitAfter: true, timeout: 5000 });
  } catch (err) {
    return { ms: null, skeleton_ms: null, error: String(err).split("\n")[0].slice(0, 120) };
  }
  return waitNav(page, path, started);
}

async function waitNav(page, path, started) {
  const t0 = Date.now();
  let skeletonAt = null;
  while (Date.now() - t0 < 90_000) {
    const r = await page.evaluate(({ path, busy }) => {
      const here = location.pathname === path;
      const b = [...document.querySelectorAll(busy)].some((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      return { here, busy: b, now: performance.now() };
    }, { path, busy: BUSY }).catch(() => null);
    if (!r) break;
    if (r.busy && skeletonAt == null) skeletonAt = r.now - started;
    if (r.here && !r.busy) return { ms: r0(r.now - started), skeleton_ms: r0(skeletonAt) };
    await sleep(16);
  }
  return { ms: null, skeleton_ms: r0(skeletonAt), timeout: true };
}

async function run(profile, browser, contactPath) {
  const pages = Object.keys(PAGES).filter((p) => (!ONLY.length || ONLY.includes(p)) && !SKIP.includes(p));
  const result = { profile, base: BASE, rounds: ROUNDS, pages: {}, nav: [], history: {} };

  for (const key of pages) {
    const path = key === "/contacts/[id]" ? contactPath : key;
    if (!path) continue;
    const cold = [];
    let repeat = null;
    for (let i = 0; i < ROUNDS; i++) {
      const context = await newContext(browser, profile);
      const page = await context.newPage();
      await throttle(page, profile);
      try {
        cold.push(await measureLoad(page, path, PAGES[key], INTERACTIONS[key]));
        if (i === ROUNDS - 1) {
          // Repeat visit in the same context: HTTP cache warm, service worker (if any) installed.
          await page.goto("about:blank");
          repeat = await measureLoad(page, path, PAGES[key], null);
        }
      } catch (err) {
        cold.push({ error: String(err).slice(0, 200) });
      } finally {
        await context.close();
      }
    }
    const ok = cold.filter((r) => !r.error);
    result.pages[key] = { path, cold: ok.length ? medianOf(ok) : null, cold_runs: cold, repeat };
    console.log(profile, key, JSON.stringify(result.pages[key].cold), "repeat:", repeat?.usable);
  }

  // Client-side navigation tour, then history back/forward, in one warm context.
  if ((!ONLY.length || ONLY.includes("nav")) && !SKIP.includes("nav")) {
    const context = await newContext(browser, profile);
    const page = await context.newPage();
    await throttle(page, profile);
    try {
      await page.goto(`${BASE}/dashboard`, { waitUntil: "load" });
      await page.evaluate((s) => window.__latReady(s), PAGES["/dashboard"]);
      await sleep(2000);
      for (const path of NAV_TOUR) {
        const r = await clickNav(page, path).catch((err) => ({ ms: null, skeleton_ms: null, error: String(err).slice(0, 120) }));
        result.nav.push({ to: path, ...(r ?? { ms: null, missing_link: true }) });
        console.log(profile, "nav", path, JSON.stringify(r));
        await sleep(800);
      }
      const back = await page.evaluate(() => performance.now());
      await page.goBack({ waitUntil: "commit" }).catch(() => {});
      result.history.back = await waitNav(page, NAV_TOUR[NAV_TOUR.length - 2], back);
      await sleep(500);
      const fwd = await page.evaluate(() => performance.now());
      await page.goForward({ waitUntil: "commit" }).catch(() => {});
      result.history.forward = await waitNav(page, NAV_TOUR[NAV_TOUR.length - 1], fwd);
      console.log(profile, "history", JSON.stringify(result.history));
    } finally {
      await context.close();
    }
  }
  return result;
}

async function warmRoutes(browser, contactPath) {
  const context = await newContext(browser, "desktop");
  const page = await context.newPage();
  for (const key of Object.keys(PAGES)) {
    // Honour --skip here too: warming a page known to hang the tier (see tier-50k.sh) would
    // freeze the single-writer database for every page after it.
    if (SKIP.includes(key) || (ONLY.length && !ONLY.includes(key))) continue;
    const path = key === "/contacts/[id]" ? contactPath : key;
    if (!path) continue;
    await page.goto(`${BASE}${path}`, { waitUntil: "load", timeout: 180_000 }).catch((e) => console.warn("warm", path, String(e).slice(0, 80)));
  }
  await context.close();
}

const browser = await chromium.launch({ headless: true, executablePath: chromiumExecutable(chromium), args: ["--ignore-certificate-errors"] });
try {
  const probe = await newContext(browser, "desktop");
  const contactPath = await firstContactPath(probe);
  await probe.close();
  if (WARM) await warmRoutes(browser, contactPath);
  const profiles = PROFILE === "both" ? ["desktop", "mobile4g"] : [PROFILE];
  const results = {};
  for (const p of profiles) {
    try {
      results[p] = await run(p, browser, contactPath);
    } catch (err) {
      console.error(`profile ${p} failed:`, err);
      results[p] = { profile: p, error: String(err).slice(0, 300), pages: {}, nav: [], history: {} };
    }
    // Write after every profile so a failure in the second one keeps the first's numbers.
    writeJson(OUT, { base: BASE, at: new Date().toISOString(), contactPath, results });
  }
} finally {
  await browser.close();
}
