// Manual layout check: the bell/feedback rail never overlaps header actions, and phone
// contact rows give the name room. Needs a demo-mode dev server.
// Run: BASE=http://localhost:3001 node scripts/dev/check-floating-rail.mjs
import { chromium } from "playwright";

const BASE = process.env.BASE || "http://localhost:3001";
const browser = await chromium.launch({
  executablePath: process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

async function rect(page, sel) {
  return page.evaluate((s) => {
    const el = [...document.querySelectorAll(s)].find((e) => e.getBoundingClientRect().width > 0);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width };
  }, sel);
}
const hit = (a, b) => a && b && a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;

for (const width of [1440, 1280]) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 } });
  await ctx.addCookies([{ name: "orbit_preview_unreleased", value: "1", domain: "localhost", path: "/" }]);
  const page = await ctx.newPage();
  for (const [route, sel] of [
    ["/contacts", '[role="tablist"][aria-label="People view"]'],
    ["/contacts?sort=closeness", '[role="tablist"][aria-label="People view"]'],
    ["/recruiters", '[role="tablist"][aria-label="People view"]'],
    ["/outreach", 'a[href="/outreach/new"]'],
  ]) {
    await page.goto(BASE + route, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForTimeout(2500);
    const bell = await rect(page, 'div.fixed > button[aria-label^="Open notifications"]');
    const fb = await rect(page, 'div.fixed > button[aria-label="Send feedback"]');
    const action = await rect(page, sel);
    check(`${width} ${route}: header action found`, Boolean(action));
    check(`${width} ${route}: clear of the bell and feedback`, Boolean(action) && !hit(bell, action) && !hit(fb, action),
      JSON.stringify({ bell, fb, action }));
  }
  await ctx.close();
}

{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto(BASE + "/contacts", { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForTimeout(2500);
  const name = await rect(page, "li.contact-row p.truncate.font-medium");
  check("phone: contact name gets at least 150px", Boolean(name) && name.w >= 150, JSON.stringify(name));
  const del = await rect(page, 'li.contact-row button[aria-label^="Delete "]');
  check("phone: row delete button is hidden", del === null);
  await ctx.close();
}
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(BASE + "/contacts", { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForTimeout(2500);
  const del = await rect(page, 'li.contact-row button[aria-label^="Delete "]');
  check("desktop: row delete button is still shown", del !== null);
  await ctx.close();
}

await browser.close();
process.exit(failures ? 1 : 0);
