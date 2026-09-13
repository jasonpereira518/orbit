/**
 * Are the constellations actually the constellations?
 *
 * The starfield does not draw an impression of Orion, it draws Orion — so the
 * claim to check is proportional accuracy, and the way to check it is against
 * the sky rather than against the code that produced it. Every separation below
 * is a published figure looked up independently of the dataset: the Pointers
 * are 5.37° apart, Betelgeuse and Rigel 18.6°, Deneb and Altair 38.0°. If the
 * generator, the source data, or a hand edit ever moved a star, these move too.
 *
 * THE PROJECTION IS CHECKED SEPARATELY, and not by calling it twice. A tangent
 * plane cannot preserve every distance, but near its centre it must keep them
 * proportional to the angles they came from — so the test computes angular
 * separations from the raw coordinates with its own trigonometry and asserts
 * that the projected distances track them. A projection that quietly stretched
 * one axis would sail past a test that only re-ran the projection.
 *
 * Run: npx tsx scripts/smoke-sky-figures.ts
 */
import { projectFigure } from "../src/lib/constellation-match";
import { SKY_FIGURES, type SkyFigure } from "../src/lib/sky-figures";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const RAD = Math.PI / 180;

/** Angular separation of two [ra, dec] points in degrees, from first principles. */
function separation(a: [number, number], b: [number, number]) {
  const [r1, d1] = a;
  const [r2, d2] = b;
  const cos =
    Math.sin(d1 * RAD) * Math.sin(d2 * RAD) +
    Math.cos(d1 * RAD) * Math.cos(d2 * RAD) * Math.cos((r1 - r2) * RAD);
  return Math.acos(Math.max(-1, Math.min(1, cos))) / RAD;
}

const byId = new Map(SKY_FIGURES.map((f) => [f.id, f]));

/** The catalogued star of `figure` nearest a known position. */
function star(figure: SkyFigure, ra: number, dec: number): [number, number] {
  let best = figure.stars[0];
  for (const s of figure.stars) {
    if (separation(s, [ra, dec]) < separation(best, [ra, dec])) best = s;
  }
  return best;
}

function figure(id: string) {
  const f = byId.get(id);
  if (!f) throw new Error(`${id} is not in the pool`);
  return f;
}

function main() {
  /* ------------------------------------------------------------- the pool */

  check("the pool is large", SKY_FIGURES.length >= 50, `${SKY_FIGURES.length} figures`);
  check(
    "every figure has a name and an abbreviation",
    SKY_FIGURES.every((f) => f.name.trim() && f.id.trim())
  );
  check(
    "no figure is offered twice",
    new Set(SKY_FIGURES.map((f) => f.id)).size === SKY_FIGURES.length
  );
  check(
    "every edge joins two stars the figure has",
    SKY_FIGURES.every((f) =>
      f.edges.every(([a, b]) => a !== b && f.stars[a] && f.stars[b])
    )
  );
  check(
    "every figure is connected by its edges",
    SKY_FIGURES.every((f) => {
      // A figure in two unjoined halves would draw as two loose scribbles.
      const seen = new Set([0]);
      const queue = [0];
      while (queue.length) {
        const at = queue.pop()!;
        for (const [a, b] of f.edges) {
          const other = a === at ? b : b === at ? a : -1;
          if (other >= 0 && !seen.has(other)) {
            seen.add(other);
            queue.push(other);
          }
        }
      }
      return seen.size === f.stars.length;
    }),
    SKY_FIGURES.filter((f) => {
      const seen = new Set([0]);
      const queue = [0];
      while (queue.length) {
        const at = queue.pop()!;
        for (const [a, b] of f.edges) {
          const other = a === at ? b : b === at ? a : -1;
          if (other >= 0 && !seen.has(other)) {
            seen.add(other);
            queue.push(other);
          }
        }
      }
      return seen.size !== f.stars.length;
    })
      .map((f) => f.id)
      .join(", ")
  );
  check(
    "the sky is covered in both hemispheres",
    SKY_FIGURES.some((f) => f.stars.every(([, dec]) => dec > 40)) &&
      SKY_FIGURES.some((f) => f.stars.every(([, dec]) => dec < -40))
  );

  /* ------------------------------------- the constellations people know are here */

  const wanted = [
    "Orion", "Ursa Major", "Ursa Minor", "Cassiopeia", "Cygnus", "Lyra",
    "Aquila", "Scorpius", "Leo", "Gemini", "Taurus", "Canis Major", "Boötes",
    "Perseus", "Andromeda", "Pegasus", "Auriga", "Draco", "Cepheus", "Virgo",
    "Sagittarius", "Cancer", "Capricornus", "Aquarius", "Pisces", "Libra",
    "Hercules", "Ophiuchus", "Centaurus", "Delphinus", "Corona Borealis",
  ];
  const have = new Set(SKY_FIGURES.map((f) => f.name));
  const missing = wanted.filter((w) => !have.has(w));
  check(
    "every constellation most people can name is in the pool",
    missing.length === 0,
    `missing: ${missing.join(", ")}`
  );

  /* --------------------------------------------- proportions, against the sky */

  // [figure, star A, star B, published separation in degrees]. The star
  // positions locate which point of the figure is meant; the separation is the
  // measurement being checked.
  const KNOWN: Array<[string, [number, number], [number, number], number, string]> = [
    ["UMa", [165.932, 61.751], [165.46, 56.382], 5.37, "Dubhe–Merak, the Pointers"],
    ["UMa", [165.932, 61.751], [206.885, 49.313], 25.71, "Dubhe–Alkaid, the Dipper's length"],
    ["Ori", [88.793, 7.407], [78.634, -8.202], 18.61, "Betelgeuse–Rigel"],
    ["Ori", [85.19, -1.943], [83.002, -0.299], 2.74, "Alnitak–Mintaka, the belt"],
    ["Ori", [88.793, 7.407], [81.283, 6.35], 7.5, "Betelgeuse–Bellatrix, the shoulders"],
    ["Gem", [113.65, 31.888], [116.329, 28.026], 4.51, "Castor–Pollux"],
    ["Cas", [10.127, 56.537], [21.454, 60.235], 6.98, "Schedar–Ruchbah"],
    ["Cyg", [310.358, 45.28], [292.68, 27.96], 22.29, "Deneb–Albireo, the swan's length"],
    ["Leo", [152.093, 11.967], [177.265, 14.572], 24.5, "Regulus–Denebola"],
    ["Tau", [68.98, 16.509], [81.573, 28.607], 16.5, "Aldebaran–Elnath"],
    ["CMa", [101.287, -16.716], [104.656, -28.972], 12.5, "Sirius–Wezen"],
    ["Per", [51.081, 49.861], [47.042, 40.956], 9.5, "Mirfak–Algol"],
    // The Great Square: two sides and the diagonal across them. Kept together
    // because the diagonal is the one people quote as a side, and reaching for
    // a side's figure here is how three of these rows were wrong to begin with.
    ["Peg", [346.19, 15.205], [345.944, 28.083], 12.88, "Markab–Scheat, a side of the Square"],
    ["Peg", [2.097, 29.09], [3.309, 15.184], 13.95, "Alpheratz–Algenib, a side of the Square"],
    ["Peg", [346.19, 15.205], [2.097, 29.09], 20.2, "Markab–Alpheratz, the Square's diagonal"],
    ["Sco", [247.352, -26.432], [263.402, -37.104], 17.28, "Antares–Shaula"],
  ];

  let worst = 0;
  const drift: string[] = [];
  for (const [id, a, b, expected, label] of KNOWN) {
    const f = figure(id);
    const measured = separation(star(f, ...a), star(f, ...b));
    const off = Math.abs(measured - expected);
    worst = Math.max(worst, off);
    if (off > 0.35) {
      drift.push(`${label}: ${measured.toFixed(2)}° vs ${expected}°`);
    }
  }
  check(
    `all ${KNOWN.length} known separations match the sky`,
    drift.length === 0,
    drift.join("; ")
  );
  console.log(`       worst disagreement ${worst.toFixed(2)}°`);

  /* ------------------------------------------------------------ the projection */

  // A stereographic projection is conformal, so near its centre it must keep
  // distances proportional to the angles behind them. Checked per figure, on
  // its own scale, against separations this file computed independently.
  let worstRatio = 0;
  const stretched: string[] = [];
  for (const f of SKY_FIGURES) {
    const flat = projectFigure(f);
    let sumFlat = 0;
    let sumSky = 0;
    const pairs: Array<[number, number]> = [];
    for (let i = 0; i < f.stars.length; i++) {
      for (let j = i + 1; j < f.stars.length; j++) {
        const sky = separation(f.stars[i], f.stars[j]);
        const flatD = Math.hypot(flat[i].x - flat[j].x, flat[i].y - flat[j].y);
        pairs.push([sky, flatD]);
        sumSky += sky;
        sumFlat += flatD;
      }
    }
    const scale = sumFlat / sumSky;
    let worstPair = 0;
    for (const [sky, flatD] of pairs) {
      if (sky < 1) continue;
      worstPair = Math.max(worstPair, Math.abs(flatD / (sky * scale) - 1));
    }
    worstRatio = Math.max(worstRatio, worstPair);
    // The pool measures 4.8% worst case (Carina, the widest figure offered), so
    // 6% is a ceiling that would actually catch a regression. Gnomonic — the
    // obvious alternative projection — measures 16.4% here and would fail this.
    if (worstPair > 0.06) stretched.push(`${f.id} ${(worstPair * 100).toFixed(1)}%`);
  }
  check(
    "the projection keeps distances proportional to their angles",
    stretched.length === 0,
    `stretched: ${stretched.join(", ")}`
  );
  console.log(`       worst distortion ${(worstRatio * 100).toFixed(1)}%`);

  check(
    "projected figures are centred on their own stars",
    SKY_FIGURES.every((f) => {
      const flat = projectFigure(f);
      const cx = flat.reduce((a, p) => a + p.x, 0) / flat.length;
      const cy = flat.reduce((a, p) => a + p.y, 0) / flat.length;
      return Math.hypot(cx, cy) < 2;
    })
  );

  // Orientation: right ascension increases to the left, declination up, the way
  // every star chart is drawn. Mirroring this would flip every figure.
  const uma = figure("UMa");
  const flatUma = projectFigure(uma);
  const dubheAt = uma.stars.findIndex(
    (s) => s === star(uma, 165.932, 61.751)
  );
  const alkaidAt = uma.stars.findIndex(
    (s) => s === star(uma, 206.885, 49.313)
  );
  check(
    "right ascension increases to the left, declination up",
    flatUma[alkaidAt].x < flatUma[dubheAt].x && flatUma[alkaidAt].y > flatUma[dubheAt].y,
    `Dubhe (${flatUma[dubheAt].x.toFixed(1)}, ${flatUma[dubheAt].y.toFixed(1)}) Alkaid (${flatUma[alkaidAt].x.toFixed(1)}, ${flatUma[alkaidAt].y.toFixed(1)})`
  );

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll sky-figure checks passed.");
}

main();
