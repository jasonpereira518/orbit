/**
 * Times client-side navigations the way a person makes them: click a sidebar link, measure
 * until the destination's content is on screen. The in-app benchmark for the
 * navigation-speed work; the production counterpart is `page_views.load_ms`
 * (`src/lib/nav-timing.ts`), which uses the same "no visible skeleton" definition.
 *
 *   node scripts/dev/nav-timing.mjs [baseUrl] [--latency=ms] [--rounds=n]
 *
 * Point it at a PRODUCTION build (`next build && next start`): dev mode does not prefetch
 * and compiles routes on first hit, so its numbers say nothing about what users feel. The
 * app must be signed-in-able without Clerk, i.e. demo mode.
 *
 * Per click it reports:
 *   skeleton — first frame a `loading.tsx` skeleton was visible (null = none was shown,
 *              the page came straight from the client router cache or a full prefetch)
 *   ready    — first frame with the URL changed and no skeleton visible
 */
import { launch } from "./cdp.mjs";

const args = process.argv.slice(2);
const BASE = args.find((a) => !a.startsWith("--")) ?? "http://localhost:3000";
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split("=")[1]) : fallback;
};
const LATENCY = flag("latency", 0);
const ROUNDS = flag("rounds", 1);

// Revisits are deliberate: the second visit to a route is what the client router cache
// (`staleTimes`) changes, so a tour with no repeats cannot see it.
const TOUR = ["/contacts", "/reminders", "/graph", "/chat", "/capture", "/dashboard", "/contacts", "/imports", "/dashboard"];

const cdp = await launch({ width: 1280, height: 800 });
if (LATENCY) {
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: LATENCY,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
}

await cdp.goto(`${BASE}/dashboard`);
await cdp.waitHydrated();
// Let viewport prefetches land, as they would for someone who reads the page first.
await cdp.sleep(4000);

const rows = [];
for (let round = 0; round < ROUNDS; round++) {
  for (const href of TOUR) {
    await cdp.evaluate(`(() => {
      const visible = () => [...document.querySelectorAll('[data-slot="skeleton"]')].some((e) => e.getClientRects().length > 0);
      window.__nav = { t0: 0, skeleton: null, ready: null, from: location.pathname };
      const tick = () => {
        const T = window.__nav;
        const now = performance.now() - T.t0;
        const moved = location.pathname !== T.from;
        const skel = visible();
        if (T.skeleton === null && moved && skel) T.skeleton = now;
        if (moved && !skel) { T.ready = now; return; }
        if (now < 20000) requestAnimationFrame(tick);
      };
      window.__navStart = () => { window.__nav.t0 = performance.now(); requestAnimationFrame(tick); };
    })()`);
    const pos = await cdp.evaluate(`(() => {
      const a = [...document.querySelectorAll('a[href="${href}"]')].find((e) => e.getClientRects().length && e.closest('aside, nav'));
      if (!a) return null;
      const r = a.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (!pos) {
      rows.push({ to: href, error: "no visible nav link" });
      continue;
    }
    const from = await cdp.evaluate("location.pathname");
    await cdp.evaluate("window.__navStart()");
    await cdp.click(pos.x, pos.y);
    const started = Date.now();
    while (Date.now() - started < 20000 && (await cdp.evaluate("window.__nav.ready")) === null) {
      await cdp.sleep(50);
    }
    const t = await cdp.evaluate("window.__nav");
    const round0 = (v) => (v === null ? null : Math.round(v));
    rows.push({ from, to: href, skeleton_ms: round0(t.skeleton), ready_ms: round0(t.ready) });
    // Idle between clicks, as a person reading the page would be.
    await cdp.sleep(2500);
  }
}

console.table(rows);
const ready = rows.map((r) => r.ready_ms).filter((v) => typeof v === "number").sort((a, b) => a - b);
const pct = (p) => ready[Math.min(ready.length - 1, Math.floor(p * ready.length))];
console.log(`ready p50=${pct(0.5)}ms p75=${pct(0.75)}ms max=${ready.at(-1)}ms (n=${ready.length})`);
if (cdp.consoleErrors.length) console.log("console errors:", cdp.consoleErrors.slice(0, 5));
cdp.close();
process.exit(0);
