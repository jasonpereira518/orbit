/**
 * The phone "peek" strip's stills (`components/interest/demo-peek.tsx`): screenshots of the
 * desktop demo, cropped to the part of each screen that reads on a phone.
 *
 *   node scripts/dev/capture-waitlist-tour.mjs http://localhost:3000
 *
 * Needs a running dev server with the demo switched on. Drives the demo by its
 * `data-demo-target` hooks (the same ones the autoplay tour uses), under reduced motion so
 * nothing is mid-animation, and writes `public/waitlist/tour/<name>-{420,840}.webp`.
 * Re-run it whenever the demo's screens change, or the phone strip goes stale.
 *
 * The files live under `public/waitlist/` because that is the one public folder the
 * waitlist host serves, and one level down (`tour/`) because single segments under
 * `/waitlist/` are referral slugs.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import sharp from "sharp";

const BASE = process.argv[2] ?? "http://localhost:3000";
const OUT = path.join(process.cwd(), "public", "waitlist", "tour");
const SCALE = 2;
/** Every crop is this size in CSS px of the 1072 × 720 demo window. */
const W = 420;
const H = 315;

/**
 * Each still is cut around a `data-demo-target` element rather than at fixed offsets, so it
 * follows the layout when the preview changes: `dx`/`dy` place the crop's top-left relative to
 * the element's own top-left, before it is clamped inside the window.
 */
const CROPS = {
  suggestion: { target: "suggestion-amanda", dx: -28, dy: -64 },
  timeline: { target: "profile-timeline", dx: -8, dy: -6 },
  draft: { target: "chat-draft-card", dx: -14, dy: -22 },
  constellation: { target: "star-card", dx: -190, dy: -10 },
};

const T = (id) => `[data-demo-target="${id}"]`;

async function main() {
  try {
    await fetch(`${BASE}/interest`, { method: "HEAD" });
  } catch {
    console.error(
      `Nothing is answering at ${BASE}. Start a dev server in this worktree (npm run dev) and ` +
        `pass the URL it prints: node scripts/dev/capture-waitlist-tour.mjs http://localhost:<port>`
    );
    process.exit(1);
  }
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const page = await (
    await browser.newContext({ viewport: { width: 1700, height: 1000 }, deviceScaleFactor: SCALE, reducedMotion: "reduce" })
  ).newPage();
  await page.goto(`${BASE}/interest`, { waitUntil: "networkidle" });
  await page.evaluate(() => document.getElementById("waitlist-demo")?.scrollIntoView({ block: "start" }));
  await page.waitForSelector(T("nav-dashboard"), { timeout: 60_000 });

  /** The window's box in the viewport, with the window scrolled into view. */
  const windowBox = async () => {
    const box = await page.evaluate((sel) => {
      const el = document.querySelector(sel)?.closest(".dark");
      el?.scrollIntoView({ block: "center" });
      const r = el?.getBoundingClientRect();
      return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
    }, T("nav-dashboard"));
    if (!box) throw new Error("demo window not found — is the demo switched on?");
    return box;
  };

  const still = async (name) => {
    const { target, dx, dy } = CROPS[name];
    // Bring the target to the upper part of the pane first, so there is room below it.
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      const pane = el?.closest("main");
      if (el && pane) pane.scrollTo({ top: pane.scrollTop + el.getBoundingClientRect().top - pane.getBoundingClientRect().top - 90 });
    }, T(target));
    await page.waitForTimeout(1400);
    const win = await windowBox();
    const el = await page.locator(T(target)).first().boundingBox();
    if (!el) throw new Error(`target ${target} not on screen`);
    const x = Math.min(Math.max(el.x + dx, win.x + 8), win.x + win.width - W - 8);
    const y = Math.min(Math.max(el.y + dy, win.y + 44), win.y + win.height - H - 8);
    const png = await page.screenshot({ clip: { x, y, width: W, height: H } });
    for (const width of [W, W * SCALE]) {
      await sharp(png).resize({ width }).webp({ quality: 82 }).toFile(path.join(OUT, `${name}-${width}.webp`));
    }
    console.log(`  wrote ${name}`);
  };

  // A click anywhere takes the demo over from the autoplay tour.
  await page.click(T("nav-dashboard"));
  await still("suggestion");
  await page.click(T("suggest-open-amanda"));
  await still("timeline");
  await page.click(T("profile-ask"));
  await page.waitForSelector(T("chat-draft-btn"), { timeout: 30_000 });
  await page.click(T("chat-draft-btn"));
  await page.waitForTimeout(3000);
  await still("draft");
  await page.click(T("nav-constellation"));
  await page.waitForTimeout(600);
  await page.click(T("star-amanda"), { force: true });
  await still("constellation");

  await browser.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
