/**
 * How long "opening something" takes, the way a person does it: point at the thing, click,
 * and wait for it to be on screen. Covers route changes from the sidebar, opening a contact
 * profile from wherever people open them, and the panels and dialogs that fetch on open.
 *
 *   node scripts/dev/open-timing.mjs <baseUrl> [--latency=ms] [--rounds=n] [--dwell=ms]
 *            [--only=name,name] [--json=out.json]
 *
 * Point it at a PRODUCTION build in demo mode (dev mode neither prefetches nor serves
 * compiled routes). `--latency` adds client↔server round-trip time via CDP; set
 * ORBIT_SIM_DB_LATENCY_MS on the server for database round trips.
 *
 * Per interaction, measured from the mouse press:
 *   feedback — first frame showing anything for the destination: a skeleton, a spinner or
 *              real content. The "is anything happening?" moment.
 *   content  — first frame with the destination on screen and no skeleton or spinner in it.
 *   settled  — the last DOM change in the destination before 1.5 s of quiet: sections that
 *              stream in with no fallback (related people, mentions) land here.
 *
 * `--dwell` is how long the pointer rests on the target before the press (default 150 ms,
 * a quick deliberate click). Hover-triggered prefetching can only use that window.
 */
import { writeFileSync } from "node:fs";
import { launch } from "./cdp.mjs";

const args = process.argv.slice(2);
const BASE = args.find((a) => !a.startsWith("--")) ?? "http://localhost:3000";
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=")[1] : fallback;
};
const LATENCY = Number(flag("latency", 0));
const ROUNDS = Number(flag("rounds", 3));
const DWELL = Number(flag("dwell", 150));
const ONLY = flag("only", "")?.split(",").filter(Boolean) ?? [];
const JSON_OUT = flag("json", null);

// Skeletons and explicit aria-busy anywhere; spinners only inside a dialog. A page can carry a
// spinner that is not about loading it — the background-jobs card ("Fetching LinkedIn
// photos…") spins for as long as a job runs.
const BUSY = `[data-slot="skeleton"], [aria-busy="true"], [role="dialog"] .animate-spin`;

/**
 * One interaction. `setup` runs before timing (navigate somewhere, open a menu); `target`
 * returns the CSS selector (or null) of the element to press; `done` is the in-page predicate
 * for "the destination is showing" and `scope` the element whose busy state counts.
 */
const SCENARIOS = [
  ...["/contacts", "/reminders", "/graph", "/chat", "/capture", "/imports", "/knowledge", "/events", "/outreach", "/recruiters", "/dashboard"].map((href) => ({
    name: `nav → ${href}`,
    from: href === "/dashboard" ? "/contacts" : "/dashboard",
    target: `aside a[href="${href}"], nav a[href="${href}"]`,
    done: `location.pathname === ${JSON.stringify(href)}`,
    scope: "main",
  })),
  {
    name: "nav → /settings",
    from: "/dashboard",
    target: `a[href="/settings"]`,
    done: `location.pathname === "/settings"`,
    scope: "main",
  },
  {
    name: "profile ← contacts list row",
    from: "/contacts",
    target: `main li.contact-row`,
    targetFallback: `(() => { const el = [...document.querySelectorAll('main *')].find((e) => e.textContent?.trim() === 'Sarah Chen' && e.children.length === 0); return el; })()`,
    done: `location.pathname.startsWith("/contacts/") && location.pathname.length > 20`,
    scope: "main",
  },
  {
    name: "profile ← dashboard follow-up",
    from: "/dashboard",
    target: `main a[href^="/contacts/"]`,
    done: `location.pathname.startsWith("/contacts/") && location.pathname.length > 20`,
    scope: "main",
  },
  {
    name: "sheet: interaction detail",
    from: "/contacts/5af8c32a-04c3-4cfa-a09c-3e5e0d07c9f6",
    target: `main button[data-interaction-id]`,
    done: `!!document.querySelector('[role="dialog"]')`,
    scope: `[role="dialog"]`,
    // Content means the body, not just the header: the notes or summary are on screen.
    ready: `(() => { const d = document.querySelector('[role="dialog"]'); return d && d.innerText.split(String.fromCharCode(10)).filter((l) => l.trim()).length > 4; })()`,
  },
  {
    name: "sheet: follow-up draft",
    from: "/dashboard",
    target: `main button`,
    targetText: "Follow up",
    done: `!!document.querySelector('[role="dialog"]')`,
    scope: `[role="dialog"]`,
  },
  {
    name: "⌘K palette (first open)",
    from: "/dashboard",
    fresh: true,
    key: "k",
    done: `!!document.querySelector('[role="dialog"] input')`,
    scope: `[role="dialog"]`,
  },
  {
    name: "chat: open a past thread",
    from: "/chat",
    target: `nav[aria-label="Chat history"] li > button:not([aria-current])`,
    done: `!!document.querySelector('nav[aria-label="Chat history"] li > button[aria-current="true"]')`,
    scope: "main",
    // The thread is on screen once "Loading chat…" is gone and the conversation has text.
    ready: `!document.querySelector("main")?.innerText.includes("Loading chat")`,
  },
  {
    name: "profile revisit (back)",
    from: "@profile-then-contacts",
    back: true,
    done: `location.pathname.startsWith("/contacts/") && location.pathname.length > 20`,
    scope: "main",
  },
];

const cdp = await launch({ width: 1440, height: 900 });
if (LATENCY) {
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: LATENCY, downloadThroughput: -1, uploadThroughput: -1 });
}

const MONITOR = (done, scope, ready = "true") => `(() => {
  const busy = (root) => root && [...root.querySelectorAll(${JSON.stringify(BUSY)})].some((e) => e.getClientRects().length > 0);
  const M = window.__m = { t0: performance.now(), feedback: null, content: null, lastMut: 0, from: location.href };
  const scopeEl = () => document.querySelector(${JSON.stringify(scope)});
  new MutationObserver(() => { M.lastMut = performance.now() - M.t0; }).observe(document.body, { childList: true, subtree: true, characterData: true });
  const tick = () => {
    const now = performance.now() - M.t0;
    const arrived = (${done});
    const root = scopeEl();
    const isBusy = busy(root) || busy(document.querySelector('[role="dialog"]'));
    const showing = arrived && root && root.getClientRects().length > 0 && (isBusy || root.innerText.trim().length > 0);
    if (M.feedback === null && (showing || (isBusy && location.href !== M.from))) M.feedback = now;
    if (M.content === null && arrived && root && !isBusy && root.innerText.trim().length > 0 && (${ready})) M.content = now;
    if (now < 30000) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})()`;

async function pointAndPress(selector, fallbackExpr, text) {
  const pos = await cdp.evaluate(`(() => {
    let el = [...document.querySelectorAll(${JSON.stringify(selector ?? "__none__")})].find((e) => e.getClientRects().length && (${JSON.stringify(text ?? "")} === "" || e.textContent.trim() === ${JSON.stringify(text ?? "")}));
    if (!el && ${JSON.stringify(Boolean(fallbackExpr))}) el = ${fallbackExpr ?? "null"};
    if (!el) return null;
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    return { x: r.x + Math.min(r.width / 2, 60), y: r.y + r.height / 2 };
  })()`);
  if (!pos) return false;
  await cdp.sleep(120);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pos.x, y: pos.y });
  await cdp.sleep(DWELL);
  return pos;
}

async function press(pos, done, scope, ready) {
  await cdp.evaluate(MONITOR(done, scope, ready));
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
}

async function settle() {
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    const m = await cdp.evaluate("window.__m");
    const elapsed = await cdp.evaluate("performance.now() - window.__m.t0");
    if (m.content !== null && elapsed - m.lastMut > 1500) return m;
    await cdp.sleep(100);
  }
  return cdp.evaluate("window.__m");
}

async function softGo(path) {
  // A client-side navigation where a link exists (keeps the router cache warm, as a person
  // clicking around would), else a full load.
  const ok = await cdp.evaluate(`(() => { const a = document.querySelector('a[href="${path}"]'); if (!a) return false; a.click(); return true; })()`);
  if (!ok) await cdp.goto(BASE + path);
  await cdp.waitFor(`location.pathname === ${JSON.stringify(path)} && !document.querySelector('[data-slot="skeleton"]')`, 30000).catch(() => {});
  await cdp.sleep(2500); // read the page; lets viewport prefetches land
}

await cdp.goto(`${BASE}/dashboard`);
await cdp.waitHydrated();
await cdp.sleep(3000);

const rows = [];
const run = SCENARIOS.filter((s) => !ONLY.length || ONLY.some((o) => s.name.includes(o)));
for (let round = 0; round < ROUNDS; round++) {
  for (const s of run) {
    let pos;
    if (s.back) {
      // Open a profile, go to the list, then come back with the browser's Back.
      const href = await cdp.evaluate(`(() => { const a = document.querySelector('main a[href^="/contacts/"]'); return a?.getAttribute('href') ?? null; })()`);
      await softGo("/dashboard");
      const target = await cdp.evaluate(`document.querySelector('main a[href^="/contacts/"]')?.getAttribute('href') ?? null`);
      if (!target && !href) { rows.push({ name: s.name, round, error: "no profile link" }); continue; }
      await cdp.evaluate(`document.querySelector('main a[href^="/contacts/"]').click()`);
      await cdp.waitFor(`location.pathname.startsWith("/contacts/") && location.pathname.length > 20 && !document.querySelector('[data-slot="skeleton"]')`, 30000).catch(() => {});
      await cdp.sleep(2500);
      await softGo("/contacts");
      await cdp.evaluate(MONITOR(s.done, s.scope));
      await cdp.evaluate("history.back()");
    } else if (s.key) {
      // A fresh page load each round, so "first open" really is the first.
      await cdp.goto(BASE + s.from);
      await cdp.waitHydrated().catch(() => {});
      await cdp.sleep(3000);
      await cdp.evaluate(MONITOR(s.done, s.scope, s.ready));
      await cdp.key(s.key, { modifiers: 4 /* meta */ });
    } else {
      await softGo(s.from);
      pos = await pointAndPress(s.target, s.targetFallback, s.targetText);
      if (!pos) { rows.push({ name: s.name, round, error: "target not found" }); continue; }
      await press(pos, s.done, s.scope, s.ready);
    }
    const m = await settle();
    // Close whatever dialog the scenario opened, so it cannot swallow the next click.
    if (s.scope === `[role="dialog"]`) {
      await cdp.key("Escape");
      await cdp.sleep(600);
    }
    rows.push({
      name: s.name,
      round,
      feedback: m.feedback === null ? null : Math.round(m.feedback),
      content: m.content === null ? null : Math.round(m.content),
      settled: m.content === null ? null : Math.round(Math.max(m.lastMut, m.content)),
    });
  }
}

// Median per scenario across rounds.
const med = (xs) => { const v = xs.filter((x) => typeof x === "number").sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };
const summary = run.map((s) => {
  const r = rows.filter((x) => x.name === s.name);
  return { interaction: s.name, feedback_ms: med(r.map((x) => x.feedback)), content_ms: med(r.map((x) => x.content)), settled_ms: med(r.map((x) => x.settled)), errors: r.filter((x) => x.error).length };
});
console.table(summary);
if (cdp.consoleErrors.length) console.log("console errors:", cdp.consoleErrors.slice(0, 8));
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ summary, rows }, null, 2));
cdp.close();
process.exit(0);
