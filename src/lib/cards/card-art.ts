/**
 * The Orbit Card's artwork: a star chart with a constellation generated from the card's seed,
 * the owner's own planet (`lib/planets/generate.ts`, keyed on the owner, so shuffling the stars
 * never changes it), under a frosted glass pane. One generator for every place the card appears —
 * the scan page, show mode, the /card editor and the link-preview image.
 *
 * Pure: no DOM, no database. And NO USER TEXT: the seed is hashed before anything reads it and
 * the SVG holds only numbers and fixed colours, so it is safe to inline with
 * dangerouslySetInnerHTML and to embed in the OG image as a data URI. The name and role are
 * real elements laid on top by the caller. `scripts/smoke-card-art.ts` holds that line.
 *
 * Everything is laid out in fractions of the card's short side, so one artwork renders at any
 * aspect: the credit-card landscape (1.586:1), show mode's portrait, and 1200×630.
 */

import { generatePlanet, planetKey, type PlanetKey } from "@/lib/planets/generate";

/** The five colours a card can wear. The accent tints the constellation and the back's dot. */
export const ACCENTS = {
  teal: { hex: "#5ec8c0", ink: "#0d3b38", label: "Teal" },
  gold: { hex: "#d4b469", ink: "#3b2f0e", label: "Gold" },
  sky: { hex: "#7cc3e2", ink: "#0c3349", label: "Sky" },
  rose: { hex: "#e59ab0", ink: "#4d1527", label: "Rose" },
  violet: { hex: "#b7a6f2", ink: "#2b1d5c", label: "Violet" },
} as const;

export type AccentKey = keyof typeof ACCENTS;
export const ACCENT_KEYS = Object.keys(ACCENTS) as AccentKey[];

export function isAccentKey(value: unknown): value is AccentKey {
  return typeof value === "string" && Object.hasOwn(ACCENTS, value);
}

/** The card's seed: its row id (stable across name edits) and the salt "Shuffle my stars" bumps. */
export const cardSeed = (cardId: string, salt: number) => `${cardId}:${salt}`;

export const CARD_NAVY = "#070b1a";
const STAR = "#fff8e6";
const GOLD = "#d4b469";
const TILE = "#fbfbf9";

/** A constellation star; x and y are fractions of the constellation's safe box. */
export type Star = { x: number; y: number; size: number };
/** A dust star; x and y are fractions of the whole card. */
export type Dust = { x: number; y: number; size: number; alpha: number };

export type CardArt = {
  /** A short hash of the seed: the SVG's id prefix, so two cards on one page never share a gradient. */
  id: string;
  accent: AccentKey;
  /** In path order: each one joins the nearest star not yet on the line (long jumps stay undrawn). */
  stars: Star[];
  dust: Dust[];
  /** The owner's planet: the same one wherever they appear, whatever the card's seed. */
  planet: { key: PlanetKey; name: string; ringed: boolean };
  /** Where the accent dot sits on the back's gold ring, in degrees. */
  dotAngle: number;
};

/** FNV-1a, 32-bit. */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** xorshift32 → [0, 1). */
function xorshift(seed: number) {
  let x = seed | 0 || 0x9e3779b9;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
}

const between = (rand: () => number, lo: number, hi: number) => lo + rand() * (hi - lo);

/** `owner` is the card owner's user id: their planet's seed, apart from the card's. */
export function cardArt(seed: string, accent: AccentKey | null, owner: string): CardArt {
  const hash = fnv1a(seed);
  const rand = xorshift(hash);
  // Always drawn, so choosing an accent never moves the stars.
  const seeded = ACCENT_KEYS[Math.floor(rand() * ACCENT_KEYS.length)];

  const count = 6 + Math.floor(rand() * 4);
  const placed: Star[] = [];
  for (let i = 0; i < count; i++) {
    // Spread them out; after a few misses take what comes, so this always ends.
    let star: Star = { x: rand(), y: rand(), size: between(rand, 0.35, 1) };
    for (let tries = 0; tries < 30 && placed.some((p) => Math.hypot(p.x - star.x, p.y - star.y) < 0.2); tries++) {
      star = { x: rand(), y: rand(), size: star.size };
    }
    placed.push(star);
  }
  // Nearest-neighbour path from the leftmost star.
  const stars: Star[] = [];
  const left = [...placed].sort((p, q) => p.x - q.x);
  let at = left.shift()!;
  stars.push(at);
  while (left.length) {
    let best = 0;
    for (let i = 1; i < left.length; i++) {
      if (Math.hypot(left[i].x - at.x, left[i].y - at.y) < Math.hypot(left[best].x - at.x, left[best].y - at.y)) best = i;
    }
    at = left.splice(best, 1)[0];
    stars.push(at);
  }

  const dust: Dust[] = Array.from({ length: 70 }, () => ({
    x: rand(),
    y: rand(),
    size: between(rand, 0.3, 1.1),
    alpha: between(rand, 0.12, 0.55),
  }));

  const key = planetKey(owner);
  const planet = generatePlanet(key);

  return {
    id: `oc${hash.toString(36)}`,
    accent: accent ?? seeded,
    stars,
    dust,
    planet: { key, name: planet.name, ringed: planet.ringed },
    dotAngle: rand() * 360,
  };
}

/**
 * Room kept for a ring or moons, in planet radii. From generate.ts's ranges: a ring reaches at
 * most ~1.55 sideways and ~0.92 up or down at its steepest tilt; the moons ~1.39 and ~1.08.
 */
const RING_RX = 1.75;
const RING_REACH = { x: 1.56, y: 1.1 };

/** Where things sit on the front, in the SVG's own units. */
export function artLayout(width: number, height: number) {
  const s = Math.min(width, height);
  const inset = 0.04 * s;
  const margin = 0.04 * s;
  const r = 0.15 * s;
  const ringRx = RING_RX * r;
  // The ring's tip a margin inside the pane; the disc's top a margin below it (a ring tilted at
  // most 26° never reaches higher than the disc does).
  const cx = width - inset - margin - ringRx;
  const cy = inset + margin + r;
  const landscape = width >= height;
  // Left of the planet on a landscape card; below it on a portrait one. Clear of the name either way.
  const box = landscape
    ? { x0: inset + 0.08 * s, x1: cx - RING_RX * r - 0.04 * s, y0: inset + 0.1 * s, y1: height * 0.58 }
    : { x0: inset + 0.08 * s, x1: width - inset - 0.08 * s, y0: cy + r + 0.12 * s, y1: height * 0.64 };
  return { s, inset, planet: { cx, cy, r, ringRx }, box };
}

/** The planet's whole footprint — disc and any ring or moons — for keeping it inside the pane. */
export function planetBox(art: CardArt, width: number, height: number) {
  const { cx, cy, r } = artLayout(width, height).planet;
  const hx = art.planet.ringed ? RING_REACH.x * r : r;
  const hy = art.planet.ringed ? RING_REACH.y * r : r;
  return { x0: cx - hx, x1: cx + hx, y0: cy - hy, y1: cy + hy };
}

/** Where the planet's name sits: centred under it, clear of any ring. */
export function planetNameLayout(width: number, height: number) {
  const { cx, cy, r } = artLayout(width, height).planet;
  return { cx, top: cy + RING_REACH.y * r + 0.02 * Math.min(width, height) };
}

/**
 * Where the gold orbit and the QR tile sit on the back, in the SVG's own units. Upright cards
 * keep a circle; a horizontal card's orbit is an ellipse, which is what lets the code take two
 * thirds of the card's height (a circle would cap it near a third) and still scan at arm's length.
 */
export function backLayout(width: number, height: number) {
  const s = Math.min(width, height);
  if (width >= height) {
    return { s, cx: width / 2, cy: height * 0.43, rx: 0.7 * s, ry: 0.38 * s, tile: 0.66 * s };
  }
  const R = 0.44 * s;
  return { s, cx: width / 2, cy: height * 0.42, rx: R, ry: R, tile: R * 1.36 };
}

const n = (v: number) => (Math.round(v * 100) / 100).toString();

/** Navy, the faint glow, and the dust: both sides start here. */
function sky(art: CardArt, w: number, h: number, s: number) {
  const p = art.id;
  const dust = art.dust
    .map((d) => `<circle cx="${n(d.x * w)}" cy="${n(d.y * h)}" r="${n(d.size * s * 0.0045)}" fill="${STAR}" fill-opacity="${n(d.alpha)}"/>`)
    .join("");
  return {
    defs:
      `<radialGradient id="${p}-glow" cx="18%" cy="8%" r="85%"><stop offset="0" stop-color="#16204a" stop-opacity="0.9"/><stop offset="1" stop-color="${CARD_NAVY}" stop-opacity="0"/></radialGradient>` +
      `<radialGradient id="${p}-halo"><stop offset="0" stop-color="${STAR}" stop-opacity="0.9"/><stop offset="0.25" stop-color="${STAR}" stop-opacity="0.3"/><stop offset="1" stop-color="${STAR}" stop-opacity="0"/></radialGradient>` +
      `<linearGradient id="${p}-glass" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity="0.08"/><stop offset="1" stop-color="#ffffff" stop-opacity="0.045"/></linearGradient>`,
    body: `<rect width="${n(w)}" height="${n(h)}" fill="${CARD_NAVY}"/><rect width="${n(w)}" height="${n(h)}" fill="url(#${p}-glow)"/>${dust}`,
  };
}

/** The frosted pane, inset from the edge, with its hairline. */
function glass(art: CardArt, w: number, h: number, s: number) {
  const inset = 0.04 * s;
  return `<rect x="${n(inset)}" y="${n(inset)}" width="${n(w - 2 * inset)}" height="${n(h - 2 * inset)}" rx="${n(0.045 * s)}" fill="url(#${art.id}-glass)" stroke="#ffffff" stroke-opacity="0.22" stroke-width="${n(Math.max(1, 0.004 * s))}"/>`;
}

function planetSvg(art: CardArt, w: number, h: number) {
  const { s, planet } = artLayout(w, h);
  const { cx, cy, r } = planet;
  const p = art.id;
  // The generated planet is drawn in a 100-unit box with its sphere `radius` across; scale that
  // sphere onto the card's disc and nest it, its ids prefixed with this card's.
  const g = generatePlanet(art.planet.key, `${p}-pl`);
  const k = r / g.radius;
  return {
    defs: `<radialGradient id="${p}-aura"><stop offset="0.5" stop-color="${g.tone}" stop-opacity="0.22"/><stop offset="1" stop-color="${g.tone}" stop-opacity="0"/></radialGradient>`,
    body:
      `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r * 1.7)}" fill="url(#${p}-aura)"/>` +
      `<svg x="${n(cx - 50 * k)}" y="${n(cy - 50 * k)}" width="${n(100 * k)}" height="${n(100 * k)}" viewBox="0 0 100 100" overflow="visible">${g.body}</svg>`,
    s,
  };
}

function constellation(art: CardArt, w: number, h: number) {
  const { s, box } = artLayout(w, h);
  const at = (st: Star) => [box.x0 + st.x * (box.x1 - box.x0), box.y0 + st.y * (box.y1 - box.y0)];
  // A long jump back across the chart (where nearest-neighbour runs out of near stars) is
  // left undrawn: two small figures read as a constellation, a slash across one does not.
  const d = art.stars
    .map((st, i) => {
      const prev = art.stars[i - 1];
      const move = !prev || Math.hypot(st.x - prev.x, st.y - prev.y) > 0.55;
      return `${move ? "M" : "L"}${at(st).map(n).join(" ")}`;
    })
    .join("");
  const line = `<path class="oc-line" pathLength="1" d="${d}" fill="none" stroke="${ACCENTS[art.accent].hex}" stroke-opacity="0.6" stroke-width="${n(0.0045 * s)}" stroke-linecap="round" stroke-linejoin="round"/>`;
  const stars = art.stars
    .map((st, i) => {
      const [x, y] = at(st);
      return (
        `<g class="oc-star" style="animation-delay:${i * 80}ms">` +
        `<circle cx="${n(x)}" cy="${n(y)}" r="${n((0.022 + 0.022 * st.size) * s)}" fill="url(#${art.id}-halo)"/>` +
        `<circle cx="${n(x)}" cy="${n(y)}" r="${n((0.004 + 0.004 * st.size) * s)}" fill="${STAR}"/></g>`
      );
    })
    .join("");
  return line + stars;
}

function back(art: CardArt, w: number, h: number) {
  const { s, cx, cy, rx, ry, tile } = backLayout(w, h);
  const a = (art.dotAngle * Math.PI) / 180;
  const dx = cx + Math.cos(a) * rx;
  const dy = cy + Math.sin(a) * ry;
  const hex = ACCENTS[art.accent].hex;
  const tileSvg = `<rect x="${n(cx - tile / 2)}" y="${n(cy - tile / 2)}" width="${n(tile)}" height="${n(tile)}" rx="${n(tile * 0.08)}" fill="${TILE}"/>`;
  // A horizontal back is the code on its own against the stars — no orbit around it.
  if (w >= h) return tileSvg;
  return (
    `<ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(rx * 1.05)}" ry="${n(ry * 1.05)}" fill="none" stroke="${GOLD}" stroke-opacity="0.25" stroke-width="${n(0.004 * s)}"/>` +
    `<ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(rx)}" ry="${n(ry)}" fill="none" stroke="${GOLD}" stroke-width="${n(0.012 * s)}"/>` +
    `<circle cx="${n(dx)}" cy="${n(dy)}" r="${n(0.05 * s)}" fill="url(#${art.id}-halo)"/>` +
    `<circle cx="${n(dx)}" cy="${n(dy)}" r="${n(0.02 * s)}" fill="${hex}"/>` +
    tileSvg
  );
}

/**
 * The whole background as one SVG string. `width`/`height` set the aspect (and the size when
 * it is used as an image); the caller scales it to fit.
 */
export function cardArtSvg(art: CardArt, { width, height, part }: { width: number; height: number; part: "front" | "back" }): string {
  const s = Math.min(width, height);
  const base = sky(art, width, height, s);
  let defs = base.defs;
  let body = base.body;
  if (part === "front") {
    const planet = planetSvg(art, width, height);
    defs += planet.defs;
    body += planet.body + constellation(art, width, height);
  } else {
    body += back(art, width, height);
  }
  body += glass(art, width, height, s);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(width)} ${n(height)}" width="${n(width)}" height="${n(height)}" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false"><defs>${defs}</defs>${body}</svg>`;
}
