/**
 * One-of-a-kind planets, drawn from a key, in the style of the landing art
 * (`public/landing/planets/`): flat vector shapes, a glassy lighter disc offset to the
 * upper left, a darker limb at the lower right, a specular spot, and sometimes a ring.
 *
 * Pure and client-safe. The same key always draws byte-identical SVG, so nothing is stored
 * and nothing is generated ahead of time. Today it is the owner's planet on their Orbit Card
 * (`lib/cards/card-art.ts` nests `body` in the card's SVG).
 *
 * Satori-safe on purpose (the card's link preview renders through `next/og`): only paths,
 * circles, ellipses, gradients, clip paths and opacity. No filters, no blur.
 */
import { fnv1a64 } from "@/lib/conversations/hash";
import { mulberry32 } from "@/lib/hash";

export type PlanetKind = "banded" | "blotched" | "terrestrial" | "streaked";

export type GeneratedPlanet = {
  key: string;
  kind: PlanetKind;
  /** A Saturn-style ring or a Uranus-style pair of moons: the sphere is drawn smaller. */
  ringed: boolean;
  /** `--planet-glow` for `.hero-planet-atmosphere`. */
  glow: string;
  /** The mid tone, as hex, for a glow drawn in SVG. */
  tone: string;
  /** The sphere's radius in the 100-unit viewBox (smaller when ringed), for scaling it in. */
  radius: number;
  /** A standalone document, for an `<img>`. */
  svg: string;
  /** The same drawing without the outer `<svg>`, for nesting in a larger SVG (100×100 units). */
  body: string;
  /** Invented, e.g. "Velora". See `planetName`. */
  name: string;
};

/** 16 lowercase hex chars: everything a planet's look and name are drawn from. */
export type PlanetKey = string & { readonly __planetKey: true };

/** The key for an id, for planets derived rather than stored. URLs carry this, never the id. */
export function planetKey(id: string): PlanetKey {
  return fnv1a64(`planet:${id}`) as PlanetKey;
}

/** A fresh key for a new member, stored as their planet. */
export function randomPlanetKey(): PlanetKey {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("") as PlanetKey;
}

export function isPlanetKey(value: string | null | undefined): value is PlanetKey {
  return typeof value === "string" && /^[0-9a-f]{16}$/.test(value);
}

function seedOf(key: string): number {
  return (parseInt(key.slice(0, 8), 16) ^ parseInt(key.slice(8, 16), 16)) >>> 0;
}

// ── Name ────────────────────────────────────────────────────────────────────

/** Stems ending in a consonant take a vowel ending (or a syllable first); the rest the reverse. */
const STEMS_CONSONANT = ["Al", "Ar", "Bel", "Cal", "Cor", "Dor", "El", "Eld", "Fen", "Gal", "Hal", "Il", "Kael", "Kes", "Lys", "Mir", "Nev", "Or", "Os", "Quin", "Sel", "Ser", "Thal", "Tor", "Ul", "Var", "Ven", "Zar"];
const STEMS_VOWEL = ["Ca", "Da", "Io", "Ka", "Ki", "Lu", "Ly", "Mi", "Mo", "Ne", "No", "Ny", "Pe", "Pha", "Rho", "Ri", "Sa", "So", "Ta", "Te", "Tha", "Va", "Ve", "Vo", "Xe", "Ya", "Ze", "Zo"];
const SYLLABLES = ["la", "li", "lo", "ra", "ri", "ro", "ve", "vi", "na", "no", "se", "si", "the", "mi", "do", "te"];
const ENDS_VOWEL = ["ae", "an", "ar", "ara", "ea", "el", "ell", "eth", "ia", "ine", "ion", "ir", "ira", "is", "ix", "on", "or", "os", "oth", "ova", "um", "une", "ux", "ys", "yx"];
const ENDS_CONSONANT = ["dra", "lis", "lune", "n", "ne", "nia", "nox", "ra", "rae", "ris", "rion", "ron", "s", "th", "thar", "thys", "vex", "vos", "x"];

/** Never spelled, even inside a longer name; and the stock eight stay the stock eight. */
const BLOCKED = /anal|anus|ass|butt|cock|coon|cum|cunt|dick|dyke|fag|fuck|homo|jew|kike|nazi|negr|nig|paki|penis|piss|poo|porn|rape|sex|shit|slut|spic|tit|twat|vag|whor|mercury|venus|earth|mars|jupiter|saturn|uranus|neptune|pluto/i;

/**
 * A pronounceable invented name, e.g. "Velora", "Kestrion", "Thalune". Drawn from its own
 * stream of the key, so it never shifts the drawing. Not unique: about 12k names exist, and
 * two members will sometimes share one, as Jason chose (Nov 11).
 */
export function planetName(key: string): string {
  const rng = mulberry32(seedOf(key) ^ 0x9e3779b9);
  for (let attempt = 0; attempt < 12; attempt++) {
    // Four shapes: Var·el, Var·la·thys, Tha·dra, Ka·li·nox.
    const shape = rng();
    const name =
      shape < 0.25
        ? pick(rng, STEMS_CONSONANT) + pick(rng, ENDS_VOWEL)
        : shape < 0.55
          ? pick(rng, STEMS_CONSONANT) + pick(rng, SYLLABLES) + pick(rng, ENDS_CONSONANT)
          : shape < 0.7
            ? pick(rng, STEMS_VOWEL) + pick(rng, ENDS_CONSONANT)
            : pick(rng, STEMS_VOWEL) + pick(rng, SYLLABLES) + pick(rng, ENDS_CONSONANT);
    // Five letters at least: four-letter draws kept landing on real words ("None", "Sane").
    // And no stutter ("Dorroron", "Coror").
    if (name.length >= 5 && name.length <= 10 && !BLOCKED.test(name) && !/([a-z]{2}).?\1/i.test(name)) return name;
  }
  return "Velora";
}

// ── Colour ──────────────────────────────────────────────────────────────────

/** Hue, saturation, lightness of each family's mid tone. Curated so nothing goes muddy. */
const FAMILIES: ReadonlyArray<readonly [number, number, number]> = [
  [26, 74, 57], // mars orange
  [14, 60, 52], // rust
  [36, 62, 58], // jupiter amber
  [42, 50, 64], // venus sand
  [205, 60, 52], // neptune blue
  [193, 68, 60], // uranus ice
  [222, 50, 52], // cobalt
  [252, 38, 60], // lavender
  [336, 46, 62], // rose
  [168, 42, 50], // jade
  [86, 44, 52], // moss
  [8, 60, 62], // coral
  [214, 22, 58], // slate
];

type Ramp = [string, string, string, string, string];

function hsl(h: number, s: number, l: number): string {
  const hue = ((h % 360) + 360) % 360;
  const sat = Math.min(100, Math.max(0, s)) / 100;
  const lig = Math.min(96, Math.max(8, l)) / 100;
  const k = (n: number) => (n + hue / 30) % 12;
  const a = sat * Math.min(lig, 1 - lig);
  const f = (n: number) => lig - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  const hex = (x: number) => Math.round(x * 255).toString(16).padStart(2, "0");
  return `#${hex(f(0))}${hex(f(8))}${hex(f(4))}`;
}

/** Light → dark, five steps around the mid tone. Hue drifts warm as it lightens, like paint. */
function ramp(h: number, s: number, l: number): Ramp {
  return [
    hsl(h + 6, s - 4, l + 22),
    hsl(h + 3, s, l + 11),
    hsl(h, s, l),
    hsl(h - 2, s + 2, l - 11),
    hsl(h - 4, s + 4, l - 22),
  ];
}

function jitteredRamp(rng: () => number, family: readonly [number, number, number]): Ramp {
  const [h, s, l] = family;
  return ramp(h + (rng() - 0.5) * 24, s + 4 + (rng() - 0.5) * 12, l + (rng() - 0.5) * 10);
}

function glowFrom(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, 0.5)`;
}

// ── Geometry ────────────────────────────────────────────────────────────────

type Pt = [number, number];

const r1 = (n: number) => Math.round(n * 10) / 10;

/** Catmull-Rom through the points, as cubic Béziers. */
function smoothPath(points: Pt[], closed: boolean): string {
  const n = points.length;
  const at = (i: number) => (closed ? points[(i + n) % n] : points[Math.max(0, Math.min(n - 1, i))]);
  let d = `M${r1(points[0][0])} ${r1(points[0][1])}`;
  const segments = closed ? n : n - 1;
  for (let i = 0; i < segments; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    const c1: Pt = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2: Pt = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${r1(c1[0])} ${r1(c1[1])} ${r1(c2[0])} ${r1(c2[1])} ${r1(p2[0])} ${r1(p2[1])}`;
  }
  return closed ? `${d}Z` : d;
}

/**
 * An irregular closed blob, the shape of every continent and patch. Its outline is a few
 * low harmonics (big lobes) plus a faster one (the bumpy coast), never per-point noise,
 * which reads as spiky stars rather than land.
 */
function blob(rng: () => number, cx: number, cy: number, r: number, wobble: number, points: number): string {
  const lobes = [2, 3, 5, 8].map((f, i) => ({
    f,
    a: wobble * [0.22, 0.16, 0.09, 0.05][i] * (0.5 + rng()),
    p: rng() * Math.PI * 2,
  }));
  const n = Math.max(points, 16);
  const pts: Pt[] = [];
  const stretch = 0.8 + rng() * 0.4;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    let rr = 1;
    for (const l of lobes) rr += l.a * Math.sin(l.f * a + l.p);
    pts.push([cx + Math.cos(a) * r * rr * stretch, cy + Math.sin(a) * r * rr]);
  }
  return smoothPath(pts, true);
}

/** A wavy horizontal edge at `y`, closed down to the bottom: stacked, these are bands. */
function bandFrom(rng: () => number, y: number, amp: number, jag: number): string {
  const f1 = 0.05 + rng() * 0.08;
  const f2 = 0.15 + rng() * 0.2;
  const p1 = rng() * 6.28;
  const p2 = rng() * 6.28;
  const pts: Pt[] = [];
  for (let x = -12; x <= 112; x += 6) {
    const spike = rng() < jag ? (rng() - 0.5) * amp * 3 : 0;
    pts.push([x, y + amp * Math.sin(x * f1 + p1) + amp * 0.4 * Math.sin(x * f2 + p2) + spike]);
  }
  return `${smoothPath(pts, false)}L112 140L-12 140Z`;
}

/** A long thin lens, the streaks of the windswept kind. */
function lens(x0: number, x1: number, y: number, thick: number, bend: number): string {
  const xm = (x0 + x1) / 2;
  return `M${r1(x0)} ${r1(y)}Q${r1(xm)} ${r1(y - thick + bend)} ${r1(x1)} ${r1(y + bend / 2)}Q${r1(xm)} ${r1(y + thick + bend)} ${r1(x0)} ${r1(y)}Z`;
}

// ── Surfaces ────────────────────────────────────────────────────────────────

type Surface = { base: string; body: string; defs?: string };

function banded(rng: () => number, c: Ramp): Surface {
  let body = "";
  const count = 5 + Math.floor(rng() * 5);
  let y = 4 + rng() * 8;
  for (let i = 0; i < count && y < 96; i++) {
    // Lighter up top, darker toward the bottom, with a little disorder.
    const t = y / 100;
    const shade = Math.max(0, Math.min(4, Math.round(t * 3.2 + (rng() - 0.5) * 1.8)));
    const opacity = 0.55 + rng() * 0.45;
    body += `<path d="${bandFrom(rng, y, 1.2 + rng() * 2.4, rng() < 0.5 ? 0.12 : 0)}" fill="${c[shade]}" fill-opacity="${r1(opacity)}"/>`;
    y += 6 + rng() * 12;
  }
  if (rng() < 0.4) {
    // A storm: a light oval in a darker rim, Jupiter's spot.
    const sx = 30 + rng() * 40;
    const sy = 55 + rng() * 25;
    const rx = 8 + rng() * 6;
    const ry = rx * (0.38 + rng() * 0.12);
    body += `<ellipse cx="${r1(sx)}" cy="${r1(sy)}" rx="${r1(rx)}" ry="${r1(ry)}" fill="${c[1]}" stroke="${c[3]}" stroke-width="1.4"/>`;
    body += `<ellipse cx="${r1(sx + 0.6)}" cy="${r1(sy)}" rx="${r1(rx * 0.55)}" ry="${r1(ry * 0.5)}" fill="${c[0]}"/>`;
  }
  for (let i = 0, n = Math.floor(rng() * 4); i < n; i++) {
    body += `<circle cx="${r1(20 + rng() * 60)}" cy="${r1(20 + rng() * 60)}" r="${r1(0.9 + rng() * 1.4)}" fill="${c[3]}" fill-opacity="0.55"/>`;
  }
  return { base: c[0], body };
}

function blotched(rng: () => number, c: Ramp): Surface {
  let body = "";
  for (let i = 0, n = 2 + Math.floor(rng() * 2); i < n; i++) {
    const cx = 18 + rng() * 64;
    const cy = 18 + rng() * 64;
    const r = 14 + rng() * 12;
    body += `<path d="${blob(rng, cx, cy, r, 0.8, 12 + Math.floor(rng() * 5))}" fill="${c[1]}" fill-opacity="0.85"/>`;
    // Darker islands inside the light patch.
    for (let j = 0, m = 1 + Math.floor(rng() * 3); j < m; j++) {
      const a = rng() * Math.PI * 2;
      const d = rng() * r * 0.5;
      body += `<path d="${blob(rng, cx + Math.cos(a) * d, cy + Math.sin(a) * d, 3 + rng() * 5, 0.9, 9)}" fill="${c[2]}" fill-opacity="0.7"/>`;
    }
  }
  for (let i = 0, n = 3 + Math.floor(rng() * 4); i < n; i++) {
    body += `<path d="${blob(rng, 10 + rng() * 80, 10 + rng() * 80, 4 + rng() * 7, 0.9, 9)}" fill="${c[rng() < 0.6 ? 1 : 3]}" fill-opacity="0.6"/>`;
  }
  return { base: c[2], body };
}

function terrestrial(rng: () => number, ocean: Ramp, land: Ramp, id: string): Surface {
  const defs = `<linearGradient id="${id}l" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${land[0]}"/><stop offset="1" stop-color="${land[3]}"/></linearGradient>`;
  let body = "";
  for (let i = 0, n = 2 + Math.floor(rng() * 3); i < n; i++) {
    body += `<path d="${blob(rng, 12 + rng() * 76, 12 + rng() * 76, 13 + rng() * 14, 1.0, 14 + Math.floor(rng() * 6))}" fill="url(#${id}l)"/>`;
  }
  for (let i = 0, n = 2 + Math.floor(rng() * 4); i < n; i++) {
    body += `<path d="${blob(rng, 10 + rng() * 80, 10 + rng() * 80, 1.8 + rng() * 3, 0.8, 8)}" fill="${land[1]}"/>`;
  }
  return { base: ocean[2], body, defs };
}

function streaked(rng: () => number, c: Ramp): Surface {
  let body = "";
  for (let i = 0, n = 6 + Math.floor(rng() * 5); i < n; i++) {
    const y = 6 + rng() * 88;
    const x0 = -10 + rng() * 40;
    const x1 = x0 + 40 + rng() * 70;
    const light = rng() < 0.65;
    body += `<path d="${lens(x0, x1, y, 1.5 + rng() * 4, (rng() - 0.5) * 8)}" fill="${light ? c[0] : c[3]}" fill-opacity="${r1(light ? 0.35 + rng() * 0.3 : 0.45 + rng() * 0.3)}"/>`;
  }
  // Cracks: two or three thin dark slivers low on the planet.
  for (let i = 0, n = 2 + Math.floor(rng() * 2); i < n; i++) {
    const y = 58 + rng() * 32;
    const x0 = 30 + rng() * 30;
    body += `<path d="${lens(x0, x0 + 25 + rng() * 30, y, 0.9 + rng() * 0.8, -4 - rng() * 6)}" fill="${c[4]}" fill-opacity="0.7"/>`;
  }
  for (let i = 0, n = 6 + Math.floor(rng() * 8); i < n; i++) {
    body += `<path d="${blob(rng, 15 + rng() * 70, 15 + rng() * 55, 0.8 + rng() * 1.2, 0.7, 6)}" fill="${c[0]}" fill-opacity="0.6"/>`;
  }
  return { base: c[2], body };
}

// ── Assembly ────────────────────────────────────────────────────────────────

/**
 * The shared finish — what makes every planet read as one set with the landing art: the
 * glassy disc offset up-left, the darker limb low-right, a light rim, a specular spot.
 */
function finish(id: string, cx: number, cy: number, R: number, outline: string): { defs: string; body: string } {
  const defs =
    `<linearGradient id="${id}g" x1="0.15" y1="0.1" x2="0.85" y2="0.95"><stop offset="0" stop-color="#fff" stop-opacity="0.34"/><stop offset="0.55" stop-color="#fff" stop-opacity="0.12"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>` +
    `<linearGradient id="${id}d" x1="0.2" y1="0.15" x2="0.9" y2="0.95"><stop offset="0.45" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.26"/></linearGradient>` +
    `<linearGradient id="${id}r" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.6"/><stop offset="0.5" stop-color="#fff" stop-opacity="0"/></linearGradient>` +
    `<radialGradient id="${id}s"><stop offset="0" stop-color="#fff" stop-opacity="0.95"/><stop offset="0.35" stop-color="#fff" stop-opacity="0.45"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>`;
  const body =
    `<circle cx="${cx}" cy="${cy}" r="${R}" fill="url(#${id}d)"/>` +
    `<circle cx="${r1(cx - R * 0.09)}" cy="${r1(cy - R * 0.1)}" r="${r1(R * 0.86)}" fill="url(#${id}g)"/>` +
    `<circle cx="${cx}" cy="${cy}" r="${r1(R - 1.3)}" fill="none" stroke="url(#${id}r)" stroke-width="1.6"/>` +
    `<circle cx="${cx}" cy="${cy}" r="${r1(R - 0.5)}" fill="none" stroke="${outline}" stroke-opacity="0.55" stroke-width="1"/>` +
    `<circle cx="${r1(cx - R * 0.6)}" cy="${r1(cy - R * 0.62)}" r="${r1(R * 0.2)}" fill="url(#${id}s)"/>`;
  return { defs, body };
}

type Extras = { defs: string; back: string; front: string };

/** Saturn's ring: concentric bands on a tilted ellipse, split into back and front halves. */
function ring(rng: () => number, cx: number, cy: number, R: number, c: Ramp, id: string): Extras {
  const tilt = (rng() < 0.5 ? -1 : 1) * (18 + rng() * 14);
  const rx = R * (1.38 + rng() * 0.08);
  const ry = R * (0.26 + rng() * 0.1);
  const bands =
    `<ellipse cx="0" cy="0" rx="${r1(rx)}" ry="${r1(ry)}" fill="none" stroke="${c[0]}" stroke-width="${r1(R * 0.16)}"/>` +
    `<ellipse cx="0" cy="0" rx="${r1(rx - R * 0.17)}" ry="${r1(ry - R * 0.05)}" fill="none" stroke="${c[2]}" stroke-width="${r1(R * 0.07)}"/>` +
    `<ellipse cx="0" cy="0" rx="${r1(rx + R * 0.08)}" ry="${r1(ry + R * 0.03)}" fill="none" stroke="${c[3]}" stroke-opacity="0.6" stroke-width="0.8"/>`;
  const frame = `transform="translate(${cx} ${cy}) rotate(${r1(tilt)})"`;
  return {
    defs: `<clipPath id="${id}f"><rect x="-80" y="0" width="160" height="80"/></clipPath>`,
    back: `<g ${frame}>${bands}</g>`,
    front: `<g ${frame}><g clip-path="url(#${id}f)">${bands}</g></g>`,
  };
}

/** Uranus's look: two thin orbit lines and a moon at each end. */
function moons(rng: () => number, cx: number, cy: number, R: number, c: Ramp, id: string): Extras {
  const tilt = (rng() < 0.5 ? -1 : 1) * (28 + rng() * 14);
  const rx = R * 1.42;
  const ry = R * (0.22 + rng() * 0.08);
  const m = R * 0.13;
  const lines =
    `<ellipse cx="0" cy="0" rx="${r1(rx)}" ry="${r1(ry)}" fill="none" stroke="${c[3]}" stroke-width="1.1"/>` +
    `<ellipse cx="0" cy="0" rx="${r1(rx - 3)}" ry="${r1(ry - 1)}" fill="none" stroke="${c[1]}" stroke-width="0.7"/>`;
  const moon = (x: number) =>
    `<circle cx="${r1(x)}" cy="0" r="${r1(m)}" fill="${c[2]}"/><circle cx="${r1(x - m * 0.3)}" cy="${r1(-m * 0.3)}" r="${r1(m * 0.55)}" fill="${c[0]}" fill-opacity="0.8"/>`;
  const frame = `transform="translate(${cx} ${cy}) rotate(${r1(tilt)})"`;
  return {
    defs: `<clipPath id="${id}f"><rect x="-80" y="0" width="160" height="80"/></clipPath>`,
    back: `<g ${frame}>${lines}</g>`,
    front: `<g ${frame}><g clip-path="url(#${id}f)">${lines}</g>${moon(-rx)}${moon(rx)}</g>`,
  };
}

const KINDS: ReadonlyArray<readonly [PlanetKind, number]> = [
  ["banded", 0.38],
  ["blotched", 0.22],
  ["terrestrial", 0.18],
  ["streaked", 0.22],
];

function pick<T>(rng: () => number, items: ReadonlyArray<T>): T {
  return items[Math.floor(rng() * items.length)];
}

/** `idPrefix` keeps gradient ids unique when the planet is nested in a larger, inlined SVG. */
export function generatePlanet(key: string, idPrefix = "p"): GeneratedPlanet {
  const rng = mulberry32(seedOf(key));
  const id = idPrefix;

  let roll = rng();
  let kind: PlanetKind = "banded";
  for (const [k, weight] of KINDS) {
    if (roll < weight) {
      kind = k;
      break;
    }
    roll -= weight;
  }

  const colours = jitteredRamp(rng, pick(rng, FAMILIES));
  const extra = rng();
  const hasRing = (kind === "banded" || kind === "streaked") && extra < 0.24;
  const hasMoons = !hasRing && extra > 0.94;
  const ringed = hasRing || hasMoons;

  const cx = 50;
  const cy = 50;
  const R = ringed ? 34 : 47;

  let surface: Surface;
  let glowHex = colours[2];
  if (kind === "terrestrial") {
    const ocean = ramp(204 + rng() * 20, 56 + rng() * 12, 54 + rng() * 6);
    const land = rng() < 0.25 ? ramp(34 + rng() * 10, 58, 60) : ramp(60 + rng() * 50, 58 + rng() * 14, 52);
    surface = terrestrial(rng, ocean, land, id);
    glowHex = ocean[2];
  } else if (kind === "banded") surface = banded(rng, colours);
  else if (kind === "blotched") surface = blotched(rng, colours);
  else surface = streaked(rng, colours);

  // Bands and streaks run at a slant, like the art.
  const slant = kind === "banded" || kind === "streaked" ? r1((rng() - 0.6) * 50) : 0;
  const extras = hasRing ? ring(rng, cx, cy, R, colours, id) : hasMoons ? moons(rng, cx, cy, R, colours, id) : null;

  // The surface is drawn in a 100-unit frame and scaled onto the sphere.
  const s = Math.round(((R * 2) / 100) * 1000) / 1000;
  const surfaceFrame = `translate(${cx - R} ${cy - R}) scale(${s}) rotate(${slant} 50 50)`;
  const sheen = finish(id, cx, cy, R, kind === "terrestrial" ? hsl(215, 45, 40) : colours[3]);

  const body =
    `<defs><clipPath id="${id}c"><circle cx="${cx}" cy="${cy}" r="${R}"/></clipPath>${surface.defs ?? ""}${sheen.defs}${extras?.defs ?? ""}</defs>` +
    (extras?.back ?? "") +
    `<g clip-path="url(#${id}c)"><circle cx="${cx}" cy="${cy}" r="${R}" fill="${surface.base}"/>` +
    `<g transform="${surfaceFrame}">${surface.body}</g>${sheen.body}</g>` +
    (extras?.front ?? "");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">${body}</svg>`;

  return { key, kind, ringed, glow: glowFrom(glowHex), tone: glowHex, radius: R, svg, body, name: planetName(key) };
}

/** `<img src>` for a generated planet. Percent-encoded: smaller than base64 for SVG. */
export function planetDataUri(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
