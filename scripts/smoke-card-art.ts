/**
 * The Orbit Card artwork (`src/lib/cards/card-art.ts`): seeded and stable, unique per seed,
 * always inside its safe area, and free of any user text — the SVG is inlined with
 * dangerouslySetInnerHTML and embedded in the link-preview image, so that last one is the
 * safety property. Pure: no database, no network.
 */
import { ACCENTS, ACCENT_KEYS, artLayout, backLayout, cardArt, cardArtSvg, cardSeed, isAccentKey, planetBox } from "../src/lib/cards/card-art";
import { checker } from "./smoke/check";

const t = checker();
const SIZES = [
  { width: 1586, height: 1000 }, // the card, landscape
  { width: 1000, height: 1586 }, // show mode, portrait
  { width: 1200, height: 630 }, // the link preview
];

// Stable.
const a = cardArt(cardSeed("card-1", 0), null, "user-1");
const front = cardArtSvg(a, { ...SIZES[0], part: "front" });
t.check("same seed → identical front SVG", front === cardArtSvg(cardArt(cardSeed("card-1", 0), null, "user-1"), { ...SIZES[0], part: "front" }));
t.check("same seed → identical back SVG", cardArtSvg(a, { ...SIZES[0], part: "back" }) === cardArtSvg(cardArt(cardSeed("card-1", 0), null, "user-1"), { ...SIZES[0], part: "back" }));
t.check("cardSeed is id:salt", cardSeed("abc", 3) === "abc:3");

// Unique.
const b = cardArt(cardSeed("card-1", 1), null, "user-1");
t.check("a new salt moves the stars", JSON.stringify(a.stars) !== JSON.stringify(b.stars));
t.check("a new salt keeps the owner's planet", JSON.stringify(a.planet) === JSON.stringify(b.planet));
const other = cardArt(cardSeed("card-1", 0), null, "user-2");
t.check("another owner gets another planet", other.planet.key !== a.planet.key);
t.check("the planet has a name", /^[A-Z][a-z]{4,9}$/.test(a.planet.name), a.planet.name);
t.check("the planet nests with this card's id prefix", front.includes(`id="${a.id}-plc"`));
t.check("different seeds → different SVG id prefixes", a.id !== b.id && front.includes(`id="${a.id}-`));

// Accent.
t.check("null accent is picked from the seed", ACCENT_KEYS.includes(a.accent));
const rose = cardArt(cardSeed("card-1", 0), "rose", "user-1");
t.check("an explicit accent wins", rose.accent === "rose" && cardArtSvg(rose, { ...SIZES[0], part: "front" }).includes(ACCENTS.rose.hex));
t.check("the accent never moves the stars", JSON.stringify(rose.stars) === JSON.stringify(a.stars));
t.check("five accents", ACCENT_KEYS.join() === "teal,gold,sky,rose,violet");
t.check("isAccentKey refuses strangers", !isAccentKey("magenta") && !isAccentKey("__proto__") && !isAccentKey("toString") && !isAccentKey(null) && isAccentKey("violet"));

// 50 random seeds: shape, bounds, no NaN, every size.
let shapeOk = true;
let boundsOk = true;
let finiteOk = true;
let ringed = 0;
let layoutOk = true;
let planetOk = true;
const detail: string[] = [];
for (let i = 0; i < 50; i++) {
  // A fresh owner each time, so the 50 cover plain, ringed and mooned planets.
  const art = cardArt(cardSeed(`seed-${i}-${Math.random().toString(36).slice(2)}`, i), null, `user-${i}-${Math.random()}`);
  if (art.stars.length < 6 || art.stars.length > 9) {
    shapeOk = false;
    detail.push(`${art.stars.length} stars`);
  }
  if (!art.stars.every((s) => s.x >= 0 && s.x <= 1 && s.y >= 0 && s.y <= 1)) boundsOk = false;
  if (art.planet.ringed) ringed++;
  for (const { width, height } of SIZES) {
    // Planet, ring and moon stay inside the glass pane with a margin, and clear of the stars.
    const { s, inset, box } = artLayout(width, height);
    const p = planetBox(art, width, height);
    const m = inset + 0.02 * s;
    const inPane = p.x0 >= m && p.y0 >= m && p.x1 <= width - m && p.y1 <= height - m;
    const clearOfStars = box.x1 <= p.x0 || box.y0 >= p.y1;
    if (!inPane || !clearOfStars || [p.x0, p.x1, p.y0, p.y1].some((v) => !Number.isFinite(v))) {
      planetOk = false;
      detail.push(`planet ${width}x${height} ringed=${art.planet.ringed} ${JSON.stringify(p)}`);
    }
  }
  for (const size of SIZES) {
    for (const part of ["front", "back"] as const) {
      const svg = cardArtSvg(art, { ...size, part });
      if (/NaN|Infinity|undefined/.test(svg)) {
        finiteOk = false;
        detail.push(`${part} ${size.width}x${size.height}`);
      }
    }
  }
}
for (const { width, height } of SIZES) {
  const { inset, box, planet } = artLayout(width, height);
  // The constellation box sits inside the glass pane and clear of the planet and its ring.
  const inside = box.x0 >= inset && box.y0 >= inset && box.x1 <= width - inset && box.y1 <= height - inset;
  const clear = box.x1 <= planet.cx - planet.ringRx || box.y0 >= planet.cy + planet.r;
  const back = backLayout(width, height);
  // The tile's corners sit inside the (elliptical) orbit, and the orbit inside the pane.
  const half = back.tile / 2;
  const tileInRing = (half / back.rx) ** 2 + (half / back.ry) ** 2 < 1;
  const ringInPane = back.cx - back.rx > inset && back.cx + back.rx < width - inset && back.cy - back.ry > inset;
  // A horizontal card's code has to scan from a phone held at arm's length: ≥ 60% of the height.
  const bigEnough = width < height || back.tile >= 0.6 * height;
  if (!ringInPane || !bigEnough) {
    layoutOk = false;
    detail.push(`back ${width}x${height}${ringInPane ? "" : " ring outside pane"}${bigEnough ? "" : " tile too small"}`);
  }
  if (!inside || !clear || box.x1 <= box.x0 || box.y1 <= box.y0 || !tileInRing) {
    layoutOk = false;
    detail.push(`layout ${width}x${height}`);
  }
}
t.check("6–9 constellation stars", shapeOk, detail.join(", "));
t.check("stars stay inside the safe area", boundsOk);
t.check("the 50 include ringed planets", ringed > 0, String(ringed));
t.check("planet, ring and moons stay inside the pane, clear of the stars", planetOk, detail.join(", "));
t.check("no NaN/Infinity/undefined in any SVG", finiteOk, detail.join(", "));
t.check("safe area clear of the planet; QR tile inside the ring", layoutOk, detail.join(", "));

// A horizontal back is the QR on its own: no orbit ring, no dot. An upright back keeps its circle.
const flatBack = cardArtSvg(a, { width: 1586, height: 1000, part: "back" });
const tallBack = cardArtSvg(a, { width: 1000, height: 1586, part: "back" });
t.check("horizontal back has no ring around the QR", !/<ellipse|stroke="#d4b469"/i.test(flatBack));
t.check("upright back keeps its gold ring", /<ellipse/.test(tallBack));

// No user text, ever.
const named = cardArt(cardSeed("Ada Lovelace", 0), null, "user-1");
const svgs = SIZES.flatMap((s) => [cardArtSvg(named, { ...s, part: "front" }), cardArtSvg(named, { ...s, part: "back" })]);
t.check("the SVG has no <text>", svgs.every((s) => !/<text|<foreignObject/i.test(s)));
t.check("the SVG never carries the seed", svgs.every((s) => !s.includes("Ada") && !s.includes("Lovelace")));
t.check("the SVG has no script or event handler", svgs.every((s) => !/<script|\son[a-z]+=/i.test(s)));

t.done("card art smoke tests");
