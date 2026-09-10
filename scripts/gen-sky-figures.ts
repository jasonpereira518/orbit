/**
 * Regenerates `src/lib/sky-figures.ts` from the IAU constellation line figures.
 *
 * WHY THIS EXISTS. The starfield names the constellation a rested cursor is
 * sitting in, and it lays that figure over the sky at its true proportions. A
 * figure drawn from a stylised, hand-tuned template would be a drawing of a
 * constellation; these are the constellations, at the shape the sky actually
 * holds them in.
 *
 * SOURCE. `constellations.lines.json` from d3-celestial (Olaf Frohn,
 * BSD-3-Clause), which carries the standard IAU line figures as J2000 right
 * ascension and declination. Star positions are measurements rather than
 * anyone's invention; what the dataset contributes is the conventional choice
 * of which stars a figure joins, and the licence is reproduced in the header of
 * the generated file.
 *
 * The generated coordinates are checked, not trusted: `smoke-sky-figures.ts`
 * measures famous separations (the Pointers at 5.37°, Betelgeuse to Rigel at
 * 18.6°, Deneb to Altair at 38.0°) against their published values, and asserts
 * the projection keeps distances proportional to the angles they came from.
 *
 * Run: npx tsx scripts/gen-sky-figures.ts [path/to/constellations.lines.json]
 *      (downloads the dataset when no path is given)
 */
import { writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";

const SOURCE_URL =
  "https://raw.githubusercontent.com/ofrohn/d3-celestial/master/data/constellations.lines.json";
const OUT = "src/lib/sky-figures.ts";

/* Every constellation the generator can name. Abbreviations are the IAU's. */
const NAMES: Record<string, string> = {
  And: "Andromeda", Ant: "Antlia", Aps: "Apus", Aqr: "Aquarius", Aql: "Aquila",
  Ara: "Ara", Ari: "Aries", Aur: "Auriga", Boo: "Boötes", Cae: "Caelum",
  Cam: "Camelopardalis", Cnc: "Cancer", CVn: "Canes Venatici", CMa: "Canis Major",
  CMi: "Canis Minor", Cap: "Capricornus", Car: "Carina", Cas: "Cassiopeia",
  Cen: "Centaurus", Cep: "Cepheus", Cet: "Cetus", Cha: "Chamaeleon", Cir: "Circinus",
  Col: "Columba", Com: "Coma Berenices", CrA: "Corona Australis", CrB: "Corona Borealis",
  Crv: "Corvus", Crt: "Crater", Cru: "Crux", Cyg: "Cygnus", Del: "Delphinus",
  Dor: "Dorado", Dra: "Draco", Equ: "Equuleus", Eri: "Eridanus", For: "Fornax",
  Gem: "Gemini", Gru: "Grus", Her: "Hercules", Hor: "Horologium", Hya: "Hydra",
  Hyi: "Hydrus", Ind: "Indus", Lac: "Lacerta", Leo: "Leo", LMi: "Leo Minor",
  Lep: "Lepus", Lib: "Libra", Lup: "Lupus", Lyn: "Lynx", Lyr: "Lyra",
  Men: "Mensa", Mic: "Microscopium", Mon: "Monoceros", Mus: "Musca", Nor: "Norma",
  Oct: "Octans", Oph: "Ophiuchus", Ori: "Orion", Pav: "Pavo", Peg: "Pegasus",
  Per: "Perseus", Phe: "Phoenix", Pic: "Pictor", Psc: "Pisces", PsA: "Piscis Austrinus",
  Pup: "Puppis", Pyx: "Pyxis", Ret: "Reticulum", Sge: "Sagitta", Sgr: "Sagittarius",
  Sco: "Scorpius", Scl: "Sculptor", Sct: "Scutum", Ser: "Serpens", Sex: "Sextans",
  Tau: "Taurus", Tel: "Telescopium", Tri: "Triangulum", TrA: "Triangulum Australe",
  Tuc: "Tucana", UMa: "Ursa Major", UMi: "Ursa Minor", Vel: "Vela", Vir: "Virgo",
  Vol: "Volans", Vul: "Vulpecula",
};

/**
 * A figure has to clear all three of these to be offered to the matcher, and
 * each threshold is about whether naming it would mean anything.
 */
/** Fewer points than this and almost any stars satisfy the shape. */
const MIN_STARS = 5;
/**
 * Wider than this and a flat drawing stops being the constellation: a gnomonic
 * projection is faithful near its centre and stretches at the edges, and Hydra
 * at 95° across is a fact about the whole sky rather than a shape on a screen.
 */
const MAX_EXTENT_DEG = 60;
/**
 * Elongation, as the ratio of the figure's two principal axes. A nearly
 * straight figure is the small-figure problem wearing a disguise — it pins one
 * direction and says almost nothing about the other, so it fits anywhere.
 */
const MAX_ASPECT = 4.5;

const RAD = Math.PI / 180;

type Feature = {
  id: string;
  geometry: { coordinates: number[][][] };
};

/** Angular separation of two [ra, dec] points, in degrees. */
function separation(a: number[], b: number[]) {
  const [r1, d1] = a;
  const [r2, d2] = b;
  const cos =
    Math.sin(d1 * RAD) * Math.sin(d2 * RAD) +
    Math.cos(d1 * RAD) * Math.cos(d2 * RAD) * Math.cos((r1 - r2) * RAD);
  return Math.acos(Math.max(-1, Math.min(1, cos))) / RAD;
}

/** Unique points in first-seen order, plus the edges joining them. */
function figureOf(feature: Feature) {
  const index = new Map<string, number>();
  const stars: number[][] = [];
  const edges: Array<[number, number]> = [];
  const key = (p: number[]) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`;

  for (const line of feature.geometry.coordinates) {
    let previous = -1;
    for (const point of line) {
      const k = key(point);
      let at = index.get(k);
      if (at === undefined) {
        at = stars.length;
        index.set(k, at);
        stars.push([
          Number(point[0].toFixed(4)),
          Number(point[1].toFixed(4)),
        ]);
      }
      if (previous >= 0 && previous !== at) edges.push([previous, at]);
      previous = at;
    }
  }
  return { stars, edges };
}

/** Stereographic projection about the figure's own centroid — see the matcher. */
function project(stars: number[][]) {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const [ra, dec] of stars) {
    x += Math.cos(dec * RAD) * Math.cos(ra * RAD);
    y += Math.cos(dec * RAD) * Math.sin(ra * RAD);
    z += Math.sin(dec * RAD);
  }
  const norm = Math.hypot(x, y, z);
  const ra0 = Math.atan2(y / norm, x / norm);
  const dec0 = Math.asin(z / norm);
  return stars.map(([ra, dec]) => {
    const a = ra * RAD;
    const e = dec * RAD;
    const c =
      Math.sin(dec0) * Math.sin(e) +
      Math.cos(dec0) * Math.cos(e) * Math.cos(a - ra0);
    const k = 2 / (1 + c);
    return [
      (-k * Math.cos(e) * Math.sin(a - ra0)) / RAD,
      (-k *
        (Math.cos(dec0) * Math.sin(e) -
          Math.sin(dec0) * Math.cos(e) * Math.cos(a - ra0))) /
        RAD,
    ];
  });
}

/**
 * Whether the edges join every star into one shape. A figure catalogued in two
 * unconnected halves draws as two loose scribbles rather than as one thing, so
 * it is not offered.
 */
function connected(count: number, edges: Array<[number, number]>) {
  const seen = new Set([0]);
  const queue = [0];
  while (queue.length) {
    const at = queue.pop()!;
    for (const [a, b] of edges) {
      const other = a === at ? b : b === at ? a : -1;
      if (other >= 0 && !seen.has(other)) {
        seen.add(other);
        queue.push(other);
      }
    }
  }
  return seen.size === count;
}

/** The two principal axis lengths of a projected figure. */
function principalAxes(points: number[][]) {
  const n = points.length;
  let mx = 0;
  let my = 0;
  for (const [x, y] of points) {
    mx += x / n;
    my += y / n;
  }
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const [x, y] of points) {
    sxx += (x - mx) ** 2 / n;
    sxy += ((x - mx) * (y - my)) / n;
    syy += (y - my) ** 2 / n;
  }
  const mid = (sxx + syy) / 2;
  const half = Math.sqrt(Math.max(0, ((sxx - syy) / 2) ** 2 + sxy * sxy));
  return [Math.sqrt(Math.max(0, mid + half)), Math.sqrt(Math.max(0, mid - half))];
}

async function load(path: string | undefined) {
  if (path) return JSON.parse(readFileSync(path, "utf8"));
  const res = await fetch(SOURCE_URL);
  if (!res.ok) throw new Error(`${SOURCE_URL} responded ${res.status}`);
  return res.json();
}

async function main() {
  const data = await load(process.argv[2]);
  const kept: Array<{
    id: string;
    name: string;
    stars: number[][];
    edges: Array<[number, number]>;
    extent: number;
  }> = [];
  const dropped: string[] = [];
  const seen = new Set<string>();

  for (const feature of data.features as Feature[]) {
    const name = NAMES[feature.id];
    if (!name) {
      dropped.push(`${feature.id} (no name)`);
      continue;
    }
    const { stars, edges } = figureOf(feature);
    if (stars.length < MIN_STARS) {
      dropped.push(`${feature.id} (${stars.length} stars)`);
      continue;
    }
    let extent = 0;
    for (let i = 0; i < stars.length; i++) {
      for (let j = i + 1; j < stars.length; j++) {
        extent = Math.max(extent, separation(stars[i], stars[j]));
      }
    }
    if (extent > MAX_EXTENT_DEG) {
      dropped.push(`${feature.id} (${extent.toFixed(0)}° across)`);
      continue;
    }
    if (!connected(stars.length, edges)) {
      dropped.push(`${feature.id} (drawn in unjoined pieces)`);
      continue;
    }
    const [major, minor] = principalAxes(project(stars));
    const aspect = minor > 1e-9 ? major / minor : Infinity;
    if (aspect > MAX_ASPECT) {
      dropped.push(`${feature.id} (${aspect.toFixed(1)}:1 elongation)`);
      continue;
    }
    // Serpens is catalogued as two disjoint halves under one abbreviation.
    const id = seen.has(feature.id) ? `${feature.id}2` : feature.id;
    seen.add(feature.id);
    kept.push({ id, name, stars, edges, extent });
  }

  kept.sort((a, b) => a.name.localeCompare(b.name));

  const body = kept
    .map((f) => {
      const stars = f.stars.map(([ra, dec]) => `[${ra}, ${dec}]`).join(", ");
      const edges = f.edges.map(([a, b]) => `[${a}, ${b}]`).join(", ");
      return `  {
    id: ${JSON.stringify(f.id)},
    name: ${JSON.stringify(f.name)},
    stars: [${stars}],
    edges: [${edges}],
  },`;
    })
    .join("\n");

  const source = `/**
 * The real constellations, at the proportions the sky holds them in.
 *
 * GENERATED by \`scripts/gen-sky-figures.ts\` — edit that, not this. Positions are
 * J2000 right ascension and declination in degrees, taken from the standard IAU
 * line figures; the edges are the conventional joins between them.
 *
 * Source data: d3-celestial by Olaf Frohn, BSD-3-Clause.
 *
 *   Copyright (c) 2015, Olaf Frohn. Redistribution and use in source and binary
 *   forms, with or without modification, are permitted provided that the above
 *   copyright notice, this list of conditions and the following disclaimer are
 *   retained. THIS SOFTWARE IS PROVIDED "AS IS" AND ANY EXPRESS OR IMPLIED
 *   WARRANTIES ARE DISCLAIMED.
 *
 * ${kept.length} figures, filtered from the full 88 on three grounds, each about
 * whether naming the figure would mean anything (see the generator for the
 * reasoning and the thresholds):
 *
 * ${dropped.join(", ")}
 */

export type SkyFigure = {
  /** IAU abbreviation, e.g. "UMa". */
  id: string;
  /** Display name, e.g. "Ursa Major". */
  name: string;
  /** [right ascension, declination], both in degrees, J2000. */
  stars: Array<[number, number]>;
  /** Conventional joins, as index pairs into \`stars\`. */
  edges: Array<[number, number]>;
};

export const SKY_FIGURES: SkyFigure[] = [
${body}
];
`;

  writeFileSync(OUT, source);
  console.log(`${OUT}: ${kept.length} figures`);
  console.log(`  kept:    ${kept.map((f) => f.id).join(" ")}`);
  console.log(`  dropped: ${dropped.join(", ")}`);
}

main();
