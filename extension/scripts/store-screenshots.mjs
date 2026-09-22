/**
 * Chrome Web Store screenshots (1280×800), composed from the design harness.
 *
 * Each slide is one real panel state from dev/preview.tsx — the same React
 * components the extension ships, rendered against fixtures — beside a caption.
 * Fixture people only (Amara Osei & co.), so no real person's data ever lands
 * in a store image.
 *
 *   npm --prefix extension run preview:design          # the harness, :5174
 *   node scripts/dev/cdp.mjs http://localhost:5174/dev/preview.html \
 *     extension/scripts/store-screenshots.mjs           # from the repo root
 *
 * Writes extension/release/store/<n>-<slug>.png, and the 440×280 small promo
 * tile as promo-tile.png (gitignored with release/).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "release", "store");

/** Frame label in the harness → the caption beside it. Order is store order. */
const SLIDES = [
  {
    frame: "Known contact",
    slug: "know-who-you-know",
    title: "Know who you already know",
    body: "Open anyone's profile and Orbit tells you — with what you last talked about, what you owe them, and what to say next.",
  },
  {
    frame: "Capture",
    slug: "save-in-one-click",
    title: "Someone new? One click",
    body: "Their name, title and company come straight off the page. Add a note and a follow-up before you move on.",
  },
  {
    frame: "People — search results",
    slug: "every-list",
    title: "Every list, marked",
    body: "LinkedIn searches, a company's People tab, a team page: who's already in your network, and who's new.",
  },
  {
    frame: "Company — Pro",
    slug: "who-you-know-there",
    title: "Who you know at any company",
    body: "People who work there now, and people who used to — the warm way in, before you hit Apply.",
  },
  {
    frame: "Home — page about nobody",
    slug: "beside-everything",
    title: "Beside everything you read",
    body: "On any other page: today's follow-ups, search, and a quick note about anyone. It reads a page only when you click.",
  },
];

export async function run(cdp) {
  mkdirSync(OUT, { recursive: true });
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.waitFor(`document.body.innerText.includes("Known contact")`, 60_000);
  await cdp.sleep(1500);

  for (const [i, slide] of SLIDES.entries()) {
    const ok = await cdp.evaluate(`(() => {
      document.getElementById("store-slide")?.remove();
      const label = [...document.querySelectorAll("div")].find(
        (d) => d.childNodes[0]?.nodeType === 3 && d.childNodes[0].textContent.trim() === ${JSON.stringify(slide.frame)}
      );
      const panel = label?.nextElementSibling;
      if (!panel) return false;
      const slideEl = document.createElement("div");
      slideEl.id = "store-slide";
      slideEl.style.cssText = [
        "position:fixed", "inset:0", "z-index:99999", "display:flex", "align-items:center",
        "gap:72px", "padding:0 96px",
        "background:radial-gradient(circle at 78% 30%, #16305a 0%, #0a1733 45%, #03050c 100%)",
        "font-family:Outfit, system-ui, sans-serif",
      ].join(";");
      const copy = document.createElement("div");
      copy.style.cssText = "flex:1;color:#e8f3f1";
      copy.innerHTML =
        '<div style="font-size:14px;letter-spacing:.18em;text-transform:uppercase;color:#f2c14e">Orbit for Chrome</div>' +
        '<div style="margin-top:18px;font-family:Fraunces, Georgia, serif;font-size:52px;line-height:1.08;letter-spacing:-.02em">' +
        ${JSON.stringify(slide.title)} + '</div>' +
        '<div style="margin-top:22px;font-size:20px;line-height:1.55;color:#9aada8;max-width:30ch">' +
        ${JSON.stringify(slide.body)} + '</div>';
      const clone = panel.cloneNode(true);
      clone.style.boxShadow = "0 30px 80px rgba(0,0,0,.55)";
      clone.style.borderRadius = "14px";
      clone.style.flex = "none";
      clone.style.transform = "scale(1.08)";
      clone.style.transformOrigin = "center";
      slideEl.append(copy, clone);
      document.body.append(slideEl);
      return true;
    })()`);
    if (!ok) throw new Error(`no harness frame "${slide.frame}"`);
    await cdp.sleep(400);
    const shot = await cdp.send("Page.captureScreenshot", {
      format: "png",
      clip: { x: 0, y: 0, width: 1280, height: 800, scale: 1 },
    });
    const file = join(OUT, `${i + 1}-${slide.slug}.png`);
    writeFileSync(file, Buffer.from(shot.data, "base64"));
    console.log(`wrote ${file}`);
  }

  // The small promo tile the listing requires: mark, name, one line.
  await cdp.evaluate(`(() => {
    document.getElementById("store-slide")?.remove();
    const tile = document.createElement("div");
    tile.id = "store-slide";
    tile.style.cssText = [
      "position:fixed", "left:0", "top:0", "width:440px", "height:280px", "z-index:99999",
      "display:flex", "flex-direction:column", "justify-content:center", "padding:0 36px",
      "background:radial-gradient(circle at 80% 20%, #16305a 0%, #0a1733 50%, #03050c 100%)",
      "color:#e8f3f1", "font-family:Outfit, system-ui, sans-serif",
    ].join(";");
    tile.innerHTML =
      '<div style="display:flex;align-items:center;gap:14px">' +
      '<img src="/public/icons/128.png" width="56" height="56" alt="">' +
      '<div style="font-family:Fraunces, Georgia, serif;font-size:44px;letter-spacing:-.02em">Orbit</div></div>' +
      '<div style="margin-top:16px;font-size:19px;line-height:1.4;color:#c9d6d2">See who you already know —<br>on every page you read.</div>';
    document.body.append(tile);
  })()`);
  await cdp.sleep(600);
  const tileShot = await cdp.send("Page.captureScreenshot", {
    format: "png",
    clip: { x: 0, y: 0, width: 440, height: 280, scale: 1 },
  });
  const tileFile = join(OUT, "promo-tile.png");
  writeFileSync(tileFile, Buffer.from(tileShot.data, "base64"));
  console.log(`wrote ${tileFile}`);
}
