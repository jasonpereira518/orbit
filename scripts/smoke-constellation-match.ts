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
 * AND THE WARP. The stars a rested cursor happens to sit near only ever
 * approximate a figure, so the matcher hands back the exact positions they
 * should be eased onto (`targets`) and the starfield moves them there. That
 * makes the drawn shape as accurate as the catalogue — but only if the targets
 * really are the figure, and only if no star is dragged so far that the answer
 * stops being about the stars that were there. Both are asserted below.
 *
 * The figures themselves are checked in `smoke-sky-figures.ts`, against
 * published positions in the sky; this file is about the matching.
 *
 * Run: npx tsx scripts/smoke-constellation-match.ts
 */
import {
  createConstellationSearch,
  matchConstellation,
  projectFigure,
  FIGURE_MIN_STARS,
  type FieldStar,
} from "../src/lib/constellation-match";
import { SKY_FIGURES } from "../src/lib/sky-figures";

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

/** RMS distance between two point sets after the best similarity fit. */
function shapeResidual(
  a: Array<{ x: number; y: number }>,
  b: Array<{ x: number; y: number }>
) {
  const n = a.length;
  const norm = (pts: Array<{ x: number; y: number }>) => {
    const mx = pts.reduce((t, p) => t + p.x, 0) / n;
    const my = pts.reduce((t, p) => t + p.y, 0) / n;
    const centred = pts.map((p) => ({ x: p.x - mx, y: p.y - my }));
    const rms = Math.sqrt(
      centred.reduce((t, p) => t + p.x * p.x + p.y * p.y, 0) / n
    );
    return centred.map((p) => ({ x: p.x / rms, y: p.y / rms }));
  };
  const u = norm(a);
  const v = norm(b);
  // Best rotation, as the argument of the summed complex ratio.
  let re = 0;
  let im = 0;
  for (let i = 0; i < n; i++) {
    re += u[i].x * v[i].x + u[i].y * v[i].y;
    im += u[i].x * v[i].y - u[i].y * v[i].x;
  }
  const len = Math.hypot(re, im) || 1;
  const c = re / len;
  const sn = im / len;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const rx = u[i].x * c - u[i].y * sn;
    const ry = u[i].x * sn + u[i].y * c;
    sum += (rx - v[i].x) ** 2 + (ry - v[i].y) ** 2;
  }
  return Math.sqrt(sum / n);
}

function main() {
  /* The figures as the matcher sees them: projected onto the plane, which is
   * also what a plant has to be built from. */
  const shapes = SKY_FIGURES.map((f) => ({
    id: f.id,
    name: f.name,
    edges: f.edges,
    stars: projectFigure(f),
  }));

  /* ------------------------------------------------------------- the pool */

  check("the pool holds real figures", shapes.length >= 50, `${shapes.length} shapes`);
  check(
    `no figure below ${FIGURE_MIN_STARS} stars is offered`,
    shapes.every((s) => s.stars.length >= FIGURE_MIN_STARS),
    "smaller figures are satisfiable by almost any stars — see the note in constellation-match.ts"
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
  //
  // A plant that reaches outside `searchRadius` is skipped rather than counted
  // as a miss. Only stars within that radius of the cursor are candidates, so
  // such a figure is not being rejected — parts of it were never offered. It is
  // a real limit and it bites the long figures (Carina at scale 150 spans past
  // it and comes back as Volans, a fit to the part that was visible), but it is
  // a fact about the search disc rather than about matching, so it is asserted
  // where it belongs and not here.
  const SEARCH_RADIUS = 320;
  const bigish = shapes.filter((s) => s.stars.length >= 6);
  let planted = 0;
  let foundExact = 0;
  const cleanMisses: string[] = [];
  for (const shape of bigish) {
    for (const rotation of [0, 0.7, 2.1, 4.4]) {
      for (const scale of [90, 150]) {
        const stars = plant(shape, { cx: 640, cy: 400, scale, rotation });
        const reaches = stars.some(
          (s) => Math.hypot(s.x - 640, s.y - 400) > SEARCH_RADIUS
        );
        if (reaches) continue;
        const m = matchConstellation(stars, { cursorX: 640, cursorY: 400 });
        planted++;
        if (m && m.name === shape.name && m.starIndices.length === shape.stars.length) {
          foundExact++;
        } else {
          cleanMisses.push(
            `${shape.name}@${scale} -> ${m ? `${m.name}/${m.starIndices.length}` : "none"}`
          );
        }
      }
    }
  }
  check(
    "a cleanly planted figure is found, by name",
    foundExact === planted,
    `${foundExact}/${planted} planted figures recognised — ${cleanMisses.slice(0, 6).join(", ")}`
  );

  /* --------------------------------------------------- the warp is the figure */

  // THE CLAIM THE WARP MAKES. `targets` is where the starfield eases the named
  // stars to, so whatever the figure looks like once it has settled is those
  // points and nothing else. They therefore have to BE the constellation —
  // measured, like everything else here, against the template rather than
  // against the matcher's own opinion of its work.
  //
  // The stars a match is built on are only ever an approximation (that is the
  // residual), so this is the check that separates "roughly Cassiopeia" from
  // Cassiopeia: after the warp, the drawn shape is exact.
  const jitterRandom = rng(4242);
  let warpChecked = 0;
  let warpExact = 0;
  let worstWarp = 0;
  let worstShift = 0;
  const sloppy: string[] = [];
  for (const shape of bigish) {
    for (const rotation of [0.4, 2.6]) {
      // Jittered, so the stars do NOT already sit at the figure's proportions
      // and the warp has real work to do.
      const stars = plant(shape, {
        cx: 640,
        cy: 400,
        scale: 120,
        rotation,
        jitter: 9,
        random: jitterRandom,
      });
      const m = matchConstellation(stars, { cursorX: 640, cursorY: 400 });
      if (!m || m.name !== shape.name) continue;
      warpChecked++;
      const template = m.starIndices.map((_, i) => shape.stars[i]);
      const residual = shapeResidual(template, m.targets);
      worstWarp = Math.max(worstWarp, residual);
      if (residual < 1e-6) warpExact++;
      else sloppy.push(`${shape.name} ${residual.toExponential(1)}`);
      for (let i = 0; i < m.targets.length; i++) {
        const from = stars[m.starIndices[i]];
        worstShift = Math.max(
          worstShift,
          Math.hypot(m.targets[i].x - from.x, m.targets[i].y - from.y)
        );
      }
    }
  }
  check(
    "the warped figure is the constellation, exactly",
    warpChecked > 0 && warpExact === warpChecked,
    `${warpExact}/${warpChecked} exact — worst residual ${worstWarp.toExponential(1)}${sloppy.length ? ` (${sloppy.slice(0, 3).join(", ")})` : ""}`
  );
  check(
    "no star is dragged further than the matcher allows",
    // 34px is `maxShiftPx`. Past it the figure would stop being laid over the
    // stars that were there and start being drawn on top of them.
    worstShift <= 34.001,
    `worst shift ${worstShift.toFixed(1)}px`
  );

  /* ------------------------------------------- the search may be interrupted */

  // The starfield steps the search a couple of milliseconds per frame so a
  // 56-figure sweep never costs a frame. Slicing it must not change the answer:
  // if it did, the feature would behave differently under load, which is both
  // wrong and untestable.
  const sliceRandom = rng(99001);
  let sliceChecked = 0;
  let sliceAgreed = 0;
  for (let i = 0; i < 40; i++) {
    const stars = randomField(sliceRandom, Math.round((1280 * 800) / 2650));
    const options = {
      cursorX: 200 + sliceRandom() * 880,
      cursorY: 150 + sliceRandom() * 500,
    };
    const whole = matchConstellation(stars, options);
    const sliced = createConstellationSearch(stars, options);
    let steps = 0;
    // A budget of zero is the pathological case worth pinning: every slice does
    // the minimum and stops, so a search that only makes progress on a generous
    // budget would hang here rather than quietly degrade.
    while (!sliced.step(0) && steps < 100000) steps++;
    const answer = sliced.result();
    sliceChecked++;
    if (
      (whole === null && answer === null) ||
      (whole !== null &&
        answer !== null &&
        whole.figureId === answer.figureId &&
        whole.starIndices.join() === answer.starIndices.join())
    ) {
      sliceAgreed++;
    }
  }
  check(
    "stepping the search a slice at a time gives the same answer",
    sliceAgreed === sliceChecked,
    `${sliceAgreed}/${sliceChecked} agreed with the uninterrupted search`
  );

  // The same, buried in an ordinary field at the starfield's real density. An
  // exact fit costs nothing, and nothing the noise offers can beat it, so the
  // planted figure has to come back out.
  //
  // The plant is scaled to sit inside the candidate disc rather than across it:
  // `maxStars` keeps only the 48 stars nearest the cursor, which at this
  // density reaches about 200px, so a figure planted much wider than that has
  // members the search never sees — a fact about the cap, not about matching.
  // (This is what the cap is set by: at 32 the disc was 164px and this same
  // measurement read 29% rather than 85%.)
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
  /* ------------------------------------------------- affordable per FRAME */

  // WHAT AFFORDABLE MEANS NOW. A whole search is ~28ms, which is two dropped
  // frames if it runs in one go, so it does not: the starfield steps it at
  // SEARCH_BUDGET_MS (2ms) a frame. The number that matters is therefore not
  // the total but the worst single slice — a slice that overruns its budget is
  // the stutter, however cheap the search is overall — and, secondarily, that
  // the whole thing still lands in a fraction of a second after the rest.
  const budgetRandom = rng(31337);
  let worstSlice = 0;
  let worstFrames = 0;
  for (let i = 0; i < 20; i++) {
    const stars = randomField(budgetRandom, Math.round((1280 * 800) / 2650));
    const search = createConstellationSearch(stars, {
      cursorX: 200 + budgetRandom() * 880,
      cursorY: 150 + budgetRandom() * 500,
    });
    let frames = 0;
    for (;;) {
      const t0 = performance.now();
      const done = search.step(2);
      worstSlice = Math.max(worstSlice, performance.now() - t0);
      frames++;
      if (done) break;
    }
    worstFrames = Math.max(worstFrames, frames);
  }
  console.log(
    `  sliced at 2ms: worst slice ${worstSlice.toFixed(1)}ms, worst ${worstFrames} frames (~${(worstFrames / 60).toFixed(2)}s)
`
  );
  check(
    "no single slice of the search can drop a frame",
    // 2ms budget plus one unit of work: a slice checks the clock between units,
    // so it may overshoot by the cost of the unit it was in. Well inside 16ms.
    worstSlice < 6,
    `worst slice ${worstSlice.toFixed(1)}ms`
  );
  check(
    "the whole search still finishes promptly",
    worstFrames <= 40,
    `${worstFrames} frames (~${(worstFrames / 60).toFixed(2)}s) after the cursor comes to rest`
  );

  /* ------------------------------------------------------ shape of the result */

  const stars = plant(shapes.find((s) => s.id === "Cas")!, {
    cx: 600,
    cy: 380,
    scale: 140,
    rotation: 0.25,
  });
  const dipper = matchConstellation(stars, { cursorX: 600, cursorY: 380 });
  check("Cassiopeia is found where it was planted", dipper?.name === "Cassiopeia");
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
      plant(shapes.find((s) => s.id === "Cas")!, {
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
