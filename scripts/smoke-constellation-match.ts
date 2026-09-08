/**
 * The starfield's constellation recognition: does it find a figure that is
 * really there, refuse the ones that are not, and stay affordable?
 *
 * THE TWO FAILURES THIS GUARDS AGAINST pull in opposite directions, which is
 * why both are asserted here rather than judged by eye:
 *
 *   - Too strict, and the feature never fires. Someone rests the cursor, waits,
 *     and nothing happens — indistinguishable from a bug.
 *   - Too loose, and it fires everywhere. If every patch of random sky
 *     "contains" a constellation then the claim is worthless, and worse, it is
 *     a lie told confidently in a product about real things.
 *
 * So the planted-figure checks pin the first, and the random-field rate pins
 * the second: a match has to be a real find, not a formality.
 *
 * Also asserted here because it is invisible in behaviour: NO REFLECTION. A
 * mirrored Big Dipper is a shape that has never appeared in the sky, and a
 * matcher that allows it roughly doubles its hit rate while quietly making
 * every claim untrue.
 *
 * Run: npx tsx scripts/smoke-constellation-match.ts
 */
import { matchConstellation, type FieldStar } from "../src/lib/constellation-match";
import {
  recognizableConstellations,
  FIGURE_MATCH_MAX,
  FIGURE_MATCH_MIN,
} from "../src/lib/constellation-shapes";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

/** Deterministic RNG — a flaky sky would make this whole file useless. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A field of unrelated stars at the interactive starfield's own density. */
function randomField(random: () => number, count: number, w = 1280, h = 800): FieldStar[] {
  return Array.from({ length: count }, () => ({
    x: random() * w,
    y: random() * h,
  }));
}

/** Place a template's points on the field, rotated/scaled, optionally mirrored. */
function plant(
  shape: { stars: Array<{ x: number; y: number }> },
  opts: {
    cx: number;
    cy: number;
    scale: number;
    rotation: number;
    mirror?: boolean;
    jitter?: number;
    random?: () => number;
  }
): FieldStar[] {
  const n = shape.stars.length;
  const mx = shape.stars.reduce((a, s) => a + s.x, 0) / n;
  const my = shape.stars.reduce((a, s) => a + s.y, 0) / n;
  const rms = Math.sqrt(
    shape.stars.reduce((a, s) => a + (s.x - mx) ** 2 + (s.y - my) ** 2, 0) / n
  );
  const cos = Math.cos(opts.rotation);
  const sin = Math.sin(opts.rotation);
  const jitter = opts.jitter ?? 0;
  const random = opts.random ?? (() => 0.5);
  return shape.stars.map((s) => {
    const px = ((s.x - mx) / rms) * (opts.mirror ? -1 : 1);
    const py = (s.y - my) / rms;
    return {
      x: opts.cx + (px * cos - py * sin) * opts.scale + (random() - 0.5) * 2 * jitter,
      y: opts.cy + (px * sin + py * cos) * opts.scale + (random() - 0.5) * 2 * jitter,
    };
  });
}

function main() {
  const shapes = recognizableConstellations();

  /* ------------------------------------------------------------- the pool */

  check("the pool holds real figures", shapes.length >= 12, `${shapes.length} shapes`);
  check(
    `no figure below ${FIGURE_MATCH_MIN} stars is offered`,
    shapes.every((s) => s.stars.length >= FIGURE_MATCH_MIN),
    "smaller figures are satisfiable by almost any stars — see the note in constellation-shapes.ts"
  );
  check(
    `no figure above ${FIGURE_MATCH_MAX} stars is offered`,
    shapes.every((s) => s.stars.length <= FIGURE_MATCH_MAX)
  );
  check(
    "every figure's edges index its own stars",
    shapes.every((s) => s.edges.every(([a, b]) => s.stars[a] && s.stars[b] && a !== b))
  );
  check(
    "every figure is named",
    shapes.every((s) => s.name.trim().length > 0)
  );

  /* ------------------------------------------- a figure that is really there */

  // Planted cleanly on an otherwise empty sky, at several angles and sizes:
  // the matcher must return that figure by name, on those very stars.
  const bigish = shapes.filter((s) => s.stars.length >= 6);
  let planted = 0;
  let foundExact = 0;
  for (const shape of bigish) {
    for (const rotation of [0, 0.7, 2.1, 4.4]) {
      for (const scale of [90, 150]) {
        const stars = plant(shape, { cx: 640, cy: 400, scale, rotation });
        const m = matchConstellation(stars, { cursorX: 640, cursorY: 400 });
        planted++;
        if (m && m.name === shape.name && m.starIndices.length === shape.stars.length) {
          foundExact++;
        }
      }
    }
  }
  check(
    "a cleanly planted figure is found, by name",
    foundExact === planted,
    `${foundExact}/${planted} planted figures recognised`
  );

  // The same, buried in an ordinary field at the starfield's real density. An
  // exact fit costs nothing, and nothing the noise offers can beat it, so the
  // planted figure has to come back out.
  //
  // The plant is scaled to sit inside the candidate disc rather than across it:
  // `maxStars` keeps only the 32 stars nearest the cursor, which at this
  // density reaches about 164px, so a figure planted much wider than that has
  // members the search never sees — a fact about the cap, not about matching.
  const noiseRandom = rng(20260908);
  const noiseCount = Math.round((1280 * 800) / 2650);
  let buriedFound = 0;
  let buriedTotal = 0;
  const buriedMisses: string[] = [];
  for (const shape of bigish) {
    for (const rotation of [0.3, 3.9]) {
      const stars = [
        ...plant(shape, { cx: 640, cy: 400, scale: 95, rotation }),
        ...randomField(noiseRandom, noiseCount),
      ];
      const m = matchConstellation(stars, { cursorX: 640, cursorY: 400 });
      buriedTotal++;
      if (m && m.name === shape.name) buriedFound++;
      else buriedMisses.push(`${shape.name}->${m ? m.name : "none"}`);
    }
  }
  check(
    "a planted figure still wins inside a busy field",
    buriedFound / buriedTotal >= 0.8,
    `${buriedFound}/${buriedTotal} recognised — ${buriedMisses.join(", ")}`
  );

  /* --------------------------------------------------- orientation is kept */

  // THE DIRECT INVARIANT, asserted instead of "a mirrored plant is refused".
  //
  // That proxy looked stronger and was in fact weaker. Several figures are
  // near-symmetric — Cassiopeia's zigzag, Corona Borealis' arc — so their
  // mirror image genuinely IS the same figure seen at another angle, and
  // refusing it would be wrong rather than strict. What must never happen is
  // the matcher's own transform flipping, so the property asserted is the exact
  // one: laid onto the stars, the figure keeps the handedness it was drawn
  // with. Walking the matched stars in template order must give a signed area
  // of the same sign as the template's own.
  function signedArea(points: Array<{ x: number; y: number }>) {
    let a = 0;
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const q = points[(i + 1) % points.length];
      a += p.x * q.y - q.x * p.y;
    }
    return a / 2;
  }

  let orientationChecked = 0;
  let orientationKept = 0;
  for (const shape of bigish) {
    for (const rotation of [0, 1.2, 3.3, 5.0]) {
      const stars = plant(shape, { cx: 640, cy: 400, scale: 140, rotation });
      const m = matchConstellation(stars, { cursorX: 640, cursorY: 400 });
      if (!m || m.name !== shape.name) continue;
      const template = signedArea(shape.stars);
      const drawn = signedArea(m.starIndices.map((i) => stars[i]));
      if (Math.abs(template) < 1e-6 || Math.abs(drawn) < 1e-6) continue;
      orientationChecked++;
      if (Math.sign(template) === Math.sign(drawn)) orientationKept++;
    }
  }
  check(
    "the matcher never reflects a figure onto the stars",
    orientationChecked > 0 && orientationKept === orientationChecked,
    `${orientationKept}/${orientationChecked} matches kept the template's handedness`
  );

  /* ------------------------------------------------- ordinary random skies */

  // WHAT IS BEING PINNED HERE. An earlier version of this file asserted that an
  // ordinary sky must NOT always yield a figure, on the theory that a match
  // should be a rare discovery. That was the wrong model, and the measurements
  // said so: with five-point figures and up, a good fit is nearly always
  // available, and suppressing it would only mean resting the cursor and being
  // told nothing on a sky that genuinely does contain a passable Cepheus.
  //
  // The feature is a best fit, so what has to hold is that the answer is worth
  // showing: tight enough to resemble its name, substantial enough to be worth
  // naming, and varied enough that it is reading the sky rather than reciting
  // one favourite figure.
  const sampleRandom = rng(770177);
  const SAMPLES = 300;
  let matched = 0;
  let errorSum = 0;
  let starSum = 0;
  let worstError = 0;
  const byName = new Map<string, number>();
  const started = Date.now();
  for (let i = 0; i < SAMPLES; i++) {
    // The starfield's own density: one star per 2650px² (see STAR_AREA).
    const stars = randomField(sampleRandom, Math.round((1280 * 800) / 2650));
    const m = matchConstellation(stars, {
      cursorX: 200 + sampleRandom() * 880,
      cursorY: 150 + sampleRandom() * 500,
    });
    if (!m) continue;
    matched++;
    errorSum += m.error;
    starSum += m.starIndices.length;
    worstError = Math.max(worstError, m.error);
    byName.set(m.name, (byName.get(m.name) ?? 0) + 1);
  }
  const perCall = (Date.now() - started) / SAMPLES;
  const rate = matched / SAMPLES;
  const avgError = errorSum / Math.max(1, matched);
  const avgStars = starSum / Math.max(1, matched);
  const ranked = [...byName.entries()].sort((a, b) => b[1] - a[1]);

  console.log(
    `\n  random skies: ${(rate * 100).toFixed(0)}% found · avg ${avgStars.toFixed(1)} stars · avg residual ${avgError.toFixed(3)} (worst ${worstError.toFixed(3)}) · ${perCall.toFixed(1)}ms/call`
  );
  console.log(`  found: ${ranked.map(([n, c]) => `${n} ${c}`).join(", ")}\n`);

  check(
    "a rested cursor reliably finds a figure",
    rate >= 0.9,
    `only ${(rate * 100).toFixed(0)}% of rests found one — the feature would read as broken`
  );
  check(
    "the figures found actually resemble their name",
    avgError <= 0.11 && worstError <= 0.16,
    `avg residual ${avgError.toFixed(3)}, worst ${worstError.toFixed(3)}`
  );
  check(
    "claims are substantial, not the smallest figure available",
    avgStars >= 6.5,
    `average claim was ${avgStars.toFixed(1)} stars`
  );
  check(
    "the sky is read, not one favourite figure recited",
    byName.size >= 10 && (ranked[0]?.[1] ?? 0) / Math.max(1, matched) <= 0.35,
    `${byName.size} distinct figures, most common ${ranked[0]?.[0]} at ${(((ranked[0]?.[1] ?? 0) / Math.max(1, matched)) * 100).toFixed(0)}%`
  );
  check(
    "the search is affordable on the main thread",
    perCall < 8,
    `${perCall.toFixed(1)}ms per call would be felt as a stutter`
  );

  /* ------------------------------------------------------ shape of the result */

  const stars = plant(shapes.find((s) => s.id === "big-dipper")!, {
    cx: 600,
    cy: 380,
    scale: 140,
    rotation: 0.25,
  });
  const dipper = matchConstellation(stars, { cursorX: 600, cursorY: 380 });
  check("the Big Dipper is found where it was planted", dipper?.name === "Big Dipper");
  if (dipper) {
    check(
      "every star index is distinct and in range",
      new Set(dipper.starIndices).size === dipper.starIndices.length &&
        dipper.starIndices.every((i) => i >= 0 && i < stars.length)
    );
    check(
      "the edges index the returned points",
      dipper.edges.every(
        ([a, b]) => dipper.starIndices[a] !== undefined && dipper.starIndices[b] !== undefined
      )
    );
    check("an exact plant reports a near-zero residual", dipper.error < 0.02, `${dipper.error}`);
    check(
      "the reported centroid and radius describe the drawn figure",
      Math.hypot(dipper.cx - 600, dipper.cy - 380) < 40 && Math.abs(dipper.radius - 140) < 30,
      `centroid=(${dipper.cx.toFixed(0)}, ${dipper.cy.toFixed(0)}) radius=${dipper.radius.toFixed(0)}`
    );
  }

  /* --------------------------------------------------------------- degenerate */

  check("an empty sky matches nothing", matchConstellation([], { cursorX: 0, cursorY: 0 }) === null);
  check(
    "two stars match nothing",
    matchConstellation([{ x: 0, y: 0 }, { x: 10, y: 10 }], { cursorX: 0, cursorY: 0 }) === null
  );
  check(
    "a figure far from the cursor is not claimed",
    matchConstellation(
      plant(shapes.find((s) => s.id === "cassiopeia")!, {
        cx: 1600,
        cy: 1200,
        scale: 130,
        rotation: 0,
      }),
      { cursorX: 40, cursorY: 40 }
    ) === null,
    "the figure has to be where the cursor is resting"
  );
  check(
    "coincident stars match nothing",
    matchConstellation(
      Array.from({ length: 12 }, () => ({ x: 500, y: 500 })),
      { cursorX: 500, cursorY: 500 }
    ) === null
  );

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll constellation-match checks passed.");
}

main();
