/**
 * The landing page's own pictures. The hero's posters: stills of its 3D scene, shown before
 * the scene loads and in place of it for reduced motion, no WebGL2, save-data and low-memory
 * devices. And the three How it works crops of the app (see STEPS).
 *
 *   node scripts/dev/capture-landing.mjs http://localhost:3001
 *   npx tsx scripts/optimize-landing-assets.ts
 *
 * Needs a dev server started with ORBIT_BENCH=1 (the `orbit-demo-bench` preview config), which
 * is what makes `/bench/hero` exist. Each still fixes the orbits at the same second (`t`), so a
 * re-capture after a scene change moves only what changed. Writes PNGs into the gitignored
 * `assets-src/landing/shots/`; the optimize script turns them into the served AVIF/WebP.
 *
 * `--frames <dir>` instead writes a strip of frames across the scroll at desktop and phone
 * size, for tuning the choreography by eye.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://localhost:3001";
const framesAt = process.argv.indexOf("--frames");
const FRAMES_DIR = framesAt > 0 ? process.argv[framesAt + 1] : null;
const SHOTS = path.join(process.cwd(), "assets-src", "landing", "shots");
/** Orbit phase every poster is taken at: the scene's first frame. */
const T = 0;

const POSTERS = [
  { name: "poster-wide", width: 1280, height: 800, scale: 2, p: 0 },
  { name: "poster-tall", width: 390, height: 844, scale: 2, p: 0, light: true },
  // The overhead beat, square: the static page lays its ring labels over this one.
  { name: "poster-rings", width: 1200, height: 1200, scale: 1, p: 0.5, layout: "still" },
];

/**
 * The How it works crops: three screens of the app itself, in demo mode (fictional people).
 * Each crop is found by the text on the page, not by fixed coordinates, so it follows the
 * app's layout: `from` and `to` name the first and last thing the crop holds, and `frame`
 * the element whose left and right edges it takes. Each leaves out the sidebar (which lists
 * unreleased pages) and every profile photograph. Look at the PNGs before shipping them.
 *
 * `landing-how-it-works.tsx` carries each crop's width and height; update them if these move.
 */
const STEPS = [
  { name: "step-import", path: "/capture", from: ["Capture", 0], to: ["Imports", 0], frame: ["Capture", 0], pad: 20 },
  // From the first chip (on a phone the chips wrap, and "Last touch" is on the second row)
  // to the bottom of the card that holds the discussions.
  // On a phone the card folds its discussions away mid-list, so that crop ends on the
  // sentence above them instead (sample data: this person's summary line).
  {
    name: "step-person", path: null, from: ["Closeness", 0], to: ["Recent discussions", 0], frame: ["Closeness", 0], pad: 0, toCard: true,
    phone: { to: ["Light but friendly", 0], toCard: false, below: 10 },
  },
  // "Today" is also the sidebar's first item; the list's own heading is the last match.
  // The crop ends under the last reminder's "Overdue N days" line, not at the card's empty
  // bottom, and takes its width from that row: the list is the narrower of two columns, so
  // its frame is anything over two fifths of the window.
  {
    name: "step-today", path: "/reminders", from: ["Today", -1], to: ["Overdue ", -1], frame: ["Overdue ", -1], pad: 0, frameMin: 0.4,
    phone: { frameMin: undefined },
  },
];
/** The person whose page is the second crop: sample data from src/lib/demo-data/network.ts. */
const PERSON = "Rachel Adeyemi";

/** The crop rectangle, in page pixels, for a step (runs in the page). */
function findClip({ from, to, frame, pad, toCard, frameMin, below = 22 }) {
  /** The element holding the nth text that starts with `text` (-1: the last one). */
  const byText = ([text, nth]) => {
    const found = [];
    const walker = document.createTreeWalker(document.querySelector("main") ?? document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.textContent.trim().toLowerCase().startsWith(text.toLowerCase())) found.push(node.parentElement);
    }
    return found.at(nth) ?? null;
  };
  /** The nearest ancestor at least `min` wide: a card, or the column it sits in. */
  const column = (el, min) => {
    let box = el;
    while (box.parentElement && box.getBoundingClientRect().width < min) box = box.parentElement;
    return box.getBoundingClientRect();
  };
  const wide = frameMin ? window.innerWidth * frameMin : Math.min(700, window.innerWidth * 0.75);
  const first = byText(from);
  const last = byText(to);
  const side = byText(frame);
  if (!first || !last || !side) return null;
  const edges = column(side, wide);
  const top = first.getBoundingClientRect().top - 16;
  // `toCard`: down to the bottom of the card holding `to`, which is the ancestor about as
  // wide as the frame itself.
  const bottom = (toCard ? column(last, edges.width * 0.9).bottom : last.getBoundingClientRect().bottom) + below;
  return { x: edges.left - pad, y: top, width: edges.width + pad * 2, height: bottom - top };
}

/**
 * Each crop is taken twice: from the app's desktop layout, at a window narrow enough that
 * the crop is shown near its true size in the page's column, and from its phone layout,
 * for phones. A desktop crop squeezed onto a phone puts the app's text at a few pixels.
 * Both in the app's dark theme: the landing page is always dark, and a light crop is the
 * brightest thing on it.
 */
const WINDOWS = [
  { suffix: "", width: 1180, height: 900, scale: 2 },
  { suffix: "-phone", width: 430, height: 900, scale: 3 },
];

async function steps(browser, { suffix, width, height, scale }) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, reducedMotion: "reduce" });
  await context.addInitScript(() => localStorage.setItem("theme", "dark"));
  const page = await context.newPage();
  for (const { phone, ...base } of STEPS) {
    const step = suffix === "-phone" ? { ...base, ...phone } : base;
    if (step.path) {
      await page.goto(`${BASE}${step.path}`, { waitUntil: "domcontentloaded", timeout: 90_000 });
    } else {
      await page.goto(`${BASE}/contacts`, { waitUntil: "domcontentloaded", timeout: 90_000 });
      const href = await page.getByRole("link", { name: PERSON }).first().getAttribute("href", { timeout: 60_000 });
      await page.goto(`${BASE}${href}`, { waitUntil: "domcontentloaded", timeout: 90_000 });
    }
    await page.waitForSelector("h1", { timeout: 60_000 });
    await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
    // The anchors arrive with hydration and data, not with the document: wait for them
    // rather than for a fixed time, then let the layout settle.
    await page.waitForFunction(findClip, step, { timeout: 60_000 }).catch(() => {
      throw new Error(`${step.name}${suffix}: the page does not have the text this crop is anchored on`);
    });
    await page.waitForTimeout(2500);
    // Hydration can swap the nodes out once more after the first sighting.
    let clip = null;
    for (let tries = 0; !clip && tries < 5; tries++) {
      clip = await page.evaluate(findClip, step);
      if (!clip) await page.waitForTimeout(1500);
    }
    if (!clip) throw new Error(`${step.name}${suffix}: its anchors appeared and then went away`);
    const file = path.join(SHOTS, `${step.name}${suffix}.png`);
    await page.screenshot({ path: file, clip });
    console.log(file, `${Math.round(clip.width)} x ${Math.round(clip.height)}`);
  }
  await context.close();
}

async function shoot(browser, { width, height, scale = 1, p, light = false, days = 14, layout }, file) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale });
  const page = await context.newPage();
  const query = new URLSearchParams({ p: String(p), t: String(T), days: String(days), bare: "1" });
  if (light) query.set("light", "1");
  if (layout) query.set("layout", layout);
  await page.goto(`${BASE}/bench/hero?${query}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("html[data-hero-ready]", { timeout: 90_000 });
  // Next's dev indicator sits in the corner of every dev page.
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
  // The comet's model loads on demand, after the first frame.
  await page.waitForTimeout(p > 0.36 ? 2500 : 600);
  await page.screenshot({ path: file });
  await context.close();
  console.log(file);
}

async function main() {
  try {
    await fetch(`${BASE}/bench/hero`, { method: "HEAD" });
  } catch {
    console.error(`Nothing is answering at ${BASE}. Start the orbit-demo-bench preview and pass its URL.`);
    process.exit(1);
  }
  // System Chrome, so the scene renders on the real GPU rather than a software rasteriser.
  const browser = await chromium.launch({ channel: "chrome" });
  if (FRAMES_DIR) {
    mkdirSync(FRAMES_DIR, { recursive: true });
    for (const p of [0, 0.2, 0.36, 0.5, 0.72, 0.84, 0.95]) {
      const tag = String(Math.round(p * 100)).padStart(3, "0");
      await shoot(browser, { width: 1440, height: 900, p }, path.join(FRAMES_DIR, `wide-${tag}.png`));
      await shoot(browser, { width: 390, height: 844, scale: 2, p, light: true }, path.join(FRAMES_DIR, `tall-${tag}.png`));
    }
  } else {
    mkdirSync(SHOTS, { recursive: true });
    for (const poster of POSTERS) await shoot(browser, poster, path.join(SHOTS, `${poster.name}.png`));
    for (const window of WINDOWS) await steps(browser, window);
  }
  await browser.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
