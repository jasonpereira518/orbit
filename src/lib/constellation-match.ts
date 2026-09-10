/**
 * Finding a real constellation in a field of unrelated stars, and laying it over
 * them at the proportions the sky actually holds it in.
 *
 * The interactive starfield calls this when the cursor has been still for a
 * moment: it hands over the stars currently drawn near the pointer and asks
 * which classic figure — Orion, the Big Dipper, Cassiopeia — those stars come
 * closest to tracing. The answer is drawn over the sky, and the stars it names
 * drift the last few pixels into their true places (see `targets`).
 *
 * THE FIGURES ARE REAL, NOT DRAWN. `sky-figures.ts` carries the IAU line figures
 * as J2000 right ascension and declination; this module projects them onto a
 * plane and matches that. So the shape laid over the sky is Orion's shape, to
 * the precision of the catalogue, rather than a designer's memory of it.
 *
 * WHY STEREOGRAPHIC. A sphere cannot be flattened without giving something up,
 * and the projection decides what. Stereographic is conformal: it preserves
 * shape, which is exactly the property being claimed when a figure is named.
 * The obvious alternative, gnomonic, has the tidier property that great circles
 * come out straight — but measured across this pool it stretches the widest
 * figures by up to 16%, against 4.8% for stereographic (Draco and Carina are
 * the worst cases). Shape is what matters here and straight lines are not, so
 * the conformal one wins. Figures wider than 60° are not offered at all; past
 * that no flat drawing is the constellation any more.
 *
 * WHAT "FITS" MEANS HERE. A constellation is a shape, not a place: the same
 * figure is the same figure wherever it sits, however large it appears, and
 * whatever angle it is seen at. So a template may translate, rotate and scale
 * freely, and what is measured is how far each of its points ends up from the
 * star it claims. Reflection is NOT allowed, and that is the one transform
 * people notice: a mirrored Big Dipper is not the Big Dipper, it is a shape
 * nobody has ever seen in the sky.
 *
 * HOW THE SEARCH WORKS. Two matched points pin a similarity transform exactly,
 * so the search enumerates ordered pairs of nearby stars, maps each template's
 * own widest pair onto them, and checks where the rest of the figure lands. A
 * pair whose span would make the figure absurdly small or large is skipped
 * before any work happens, and a partial fit is abandoned the moment its
 * running error passes the tolerance.
 *
 * IT IS ALSO INTERRUPTIBLE, which is what lets the pool be large and the
 * candidate set wide. Fifty-six figures against forty-eight stars is roughly
 * 28ms of work — nearly two dropped frames if it ran in one go — so
 * `createConstellationSearch` hands back a search that can be stepped inside a
 * couple of milliseconds per frame and finishes a dozen or so frames later.
 * Nobody notices a quarter of a second after a deliberate pause; everybody
 * notices a stutter.
 *
 * WHY THE SCORING IS NOT JUST "SMALLEST ERROR". A small figure is easier to
 * satisfy than a large one — five points leave six degrees of freedom to argue
 * with, nine points leave fourteen — so raw residual hands back the smallest
 * template in the pool almost every time. Larger figures are therefore
 * discounted by `sizeBias` before comparison.
 *
 * WHAT THIS IS AND IS NOT. It is a best fit, not a discovery: a rested cursor
 * nearly always finds something, because a large pool against thirty stars
 * nearly always contains a good fit. What the ceilings buy is that the answer
 * is anchored to stars that were genuinely near where it is drawn — no star is
 * asked to move more than `maxShiftPx` — so the figure is laid over the sky
 * rather than invented on top of it.
 *
 * Deliberately free of React, canvas and `next/*`: this is pure geometry, which
 * is what lets the smoke tests run it over thousands of random skies.
 */
import { SKY_FIGURES, type SkyFigure } from "@/lib/sky-figures";

export type FieldStar = { x: number; y: number };

/**
 * Fewer points than this and almost any stars satisfy the shape, so naming it
 * would be a statement about geometry rather than about the sky. Measured on
 * random skies at the starfield's own density: three-point figures were claimed
 * on 399 rests out of 400 at a near-zero residual, four-point figures on 100% of
 * the remainder. The cost of the floor is real and worth naming — Crux, Aries
 * and Triangulum are all four-star figures, and none of them is offered.
 */
export const FIGURE_MIN_STARS = 5;

export type ConstellationMatch = {
  figureId: string;
  /** Display name, e.g. "Cassiopeia". */
  name: string;
  /**
   * Indices into the `stars` array handed to the search, in template point
   * order — `starIndices[i]` is the star standing in for template point i.
   */
  starIndices: number[];
  /**
   * Where each of those stars belongs if the figure is to be drawn true, in the
   * caller's coordinate space. The starfield eases its stars onto these, which
   * is what makes the figure proportionally exact rather than approximate.
   */
  targets: FieldStar[];
  /** Template edges, as index pairs into `starIndices`. */
  edges: Array<[number, number]>;
  /** RMS residual as a fraction of the figure's own radius. Lower is tighter. */
  error: number;
  /** The furthest any one star has to move, in caller units. */
  shift: number;
  /** Centroid of the drawn figure, in the caller's coordinate space. */
  cx: number;
  cy: number;
  /** RMS radius of the drawn figure about that centroid. */
  radius: number;
};

export type MatchOptions = {
  /** Where the pointer is resting. The figure has to be found around here. */
  cursorX: number;
  cursorY: number;
  /** Only stars within this distance of the cursor are considered. */
  searchRadius?: number;
  /** Hard cap on candidate stars, nearest first. Bounds the whole search. */
  maxStars?: number;
  /** Allowed figure radius, so a match is neither a speck nor the whole screen. */
  minRadius?: number;
  maxRadius?: number;
  /** How far a star may sit from its template point, as a fraction of radius. */
  tolerance?: number;
  /** Residual ceiling: beyond this the figure is no longer anchored to the sky. */
  maxError?: number;
  /** No single star may be asked to move further than this. */
  maxShiftPx?: number;
  /** The figure's centroid must land within this distance of the cursor. */
  cursorMaxOffset?: number;
  /** Smallest template the search may offer. See FIGURE_MIN_STARS. */
  minStars?: number;
  /** How hard richer figures are favoured over smaller ones. See `sizeWeight`. */
  sizeBias?: number;
};

const DEFAULTS = {
  searchRadius: 320,
  // The cap bounds the pair enumeration, so it is a cost guarantee rather than
  // a preference: the search is quadratic in this number, and 48 costs about
  // 28ms against the whole pool where 32 costs 6ms.
  //
  // It is nonetheless set by reach rather than by cost. At the starfield's
  // density the nearest 48 stars fill a disc of about 200px, which is what a
  // figure of up to `maxRadius` needs to have all of its stars visible to the
  // search at all. At 32 the disc is 164px and the large figures — Orion,
  // Scorpius, Sagittarius — were being cut off mid-shape and losing to small
  // ones: measured on planted figures buried in an ordinary field, recall went
  // from 29% to 85%, and on random skies the answers went from 39 distinct
  // figures averaging 8.4 stars to 43 averaging 10.8. Slicing is what makes
  // that affordable.
  maxStars: 48,
  minRadius: 60,
  maxRadius: 230,
  tolerance: 0.3,
  maxError: 0.16,
  // A star may be nudged, never relocated. Beyond roughly this the figure stops
  // being laid over the stars that are there and starts inventing its own.
  maxShiftPx: 34,
  cursorMaxOffset: 210,
  minStars: FIGURE_MIN_STARS,
  sizeBias: 0.5,
} as const;

const RAD = Math.PI / 180;

/** A figure projected onto the plane, recentred and scaled to RMS radius 1. */
type PreparedFigure = {
  figure: SkyFigure;
  pts: FieldStar[];
  /** The two points furthest apart — the pair the search pins to real stars. */
  a: number;
  b: number;
  basisLen: number;
  /**
   * The order the remaining points are tested in: furthest from the basis
   * midpoint first, so a wrong transform is contradicted as early as possible.
   */
  rest: number[];
};

/**
 * Stereographic projection of a figure about its own centroid, in degrees near
 * the centre. North is up and right ascension increases to the left, which is
 * how the sky is drawn on every star chart and in `virgo-figure.ts`.
 *
 * Exported so the smoke test can check the result against the angular
 * separations the coordinates came from.
 */
export function projectFigure(figure: SkyFigure): FieldStar[] {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const [ra, dec] of figure.stars) {
    x += Math.cos(dec * RAD) * Math.cos(ra * RAD);
    y += Math.cos(dec * RAD) * Math.sin(ra * RAD);
    z += Math.sin(dec * RAD);
  }
  const norm = Math.hypot(x, y, z) || 1;
  const ra0 = Math.atan2(y / norm, x / norm);
  const dec0 = Math.asin(Math.max(-1, Math.min(1, z / norm)));

  return figure.stars.map(([ra, dec]) => {
    const a = ra * RAD;
    const e = dec * RAD;
    const cos =
      Math.sin(dec0) * Math.sin(e) +
      Math.cos(dec0) * Math.cos(e) * Math.cos(a - ra0);
    const k = 2 / (1 + cos);
    return {
      x: (-k * Math.cos(e) * Math.sin(a - ra0)) / RAD,
      y:
        (-k *
          (Math.cos(dec0) * Math.sin(e) -
            Math.sin(dec0) * Math.cos(e) * Math.cos(a - ra0))) /
        RAD,
    };
  });
}

let prepared: PreparedFigure[] | null = null;

function prepare(figure: SkyFigure): PreparedFigure | null {
  const n = figure.stars.length;
  if (n < FIGURE_MIN_STARS) return null;

  const raw = projectFigure(figure);
  let cx = 0;
  let cy = 0;
  for (const p of raw) {
    cx += p.x / n;
    cy += p.y / n;
  }
  let sumSq = 0;
  for (const p of raw) sumSq += (p.x - cx) ** 2 + (p.y - cy) ** 2;
  const rms = Math.sqrt(sumSq / n);
  if (!(rms > 1e-9)) return null;

  const pts = raw.map((p) => ({ x: (p.x - cx) / rms, y: (p.y - cy) / rms }));

  let a = 0;
  let b = 1;
  let best = -1;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = (pts[i].x - pts[j].x) ** 2 + (pts[i].y - pts[j].y) ** 2;
      if (d > best) {
        best = d;
        a = i;
        b = j;
      }
    }
  }
  const basisLen = Math.sqrt(best);
  if (!(basisLen > 1e-9)) return null;

  const mx = (pts[a].x + pts[b].x) / 2;
  const my = (pts[a].y + pts[b].y) / 2;
  const rest: number[] = [];
  for (let i = 0; i < n; i++) if (i !== a && i !== b) rest.push(i);
  rest.sort(
    (p, q) =>
      (pts[q].x - mx) ** 2 +
      (pts[q].y - my) ** 2 -
      ((pts[p].x - mx) ** 2 + (pts[p].y - my) ** 2)
  );

  return { figure, pts, a, b, basisLen, rest };
}

/** Every figure the search may offer, projected and normalised once. */
export function preparedFigures(): PreparedFigure[] {
  if (!prepared) {
    prepared = SKY_FIGURES.map(prepare).filter(
      (f): f is PreparedFigure => f !== null
    );
  }
  return prepared;
}

/**
 * Least-squares similarity (rotation + uniform scale + translation, never
 * reflection) taking the template points onto their matched stars, and where
 * each template point lands under it.
 *
 * The pair-based transform that produced a candidate is pinned to two stars and
 * therefore carries their placement error into every other point. Re-solving
 * over the whole assignment spreads that error out, which is both a fairer
 * residual and — since these landing points are what the stars are eased onto —
 * the difference between a figure that sits among its stars and one that hangs
 * off the two it was seeded from.
 */
function solve(
  pts: FieldStar[],
  order: number[],
  stars: FieldStar[],
  picks: number[]
): {
  error: number;
  shift: number;
  cx: number;
  cy: number;
  radius: number;
  targets: FieldStar[];
} | null {
  const k = order.length;
  let pxs = 0;
  let pys = 0;
  let qxs = 0;
  let qys = 0;
  for (let i = 0; i < k; i++) {
    pxs += pts[order[i]].x;
    pys += pts[order[i]].y;
    qxs += stars[picks[i]].x;
    qys += stars[picks[i]].y;
  }
  const pcx = pxs / k;
  const pcy = pys / k;
  const qcx = qxs / k;
  const qcy = qys / k;

  let dot = 0;
  let cross = 0;
  let pden = 0;
  let qsum = 0;
  for (let i = 0; i < k; i++) {
    const px = pts[order[i]].x - pcx;
    const py = pts[order[i]].y - pcy;
    const qx = stars[picks[i]].x - qcx;
    const qy = stars[picks[i]].y - qcy;
    dot += px * qx + py * qy;
    cross += px * qy - py * qx;
    pden += px * px + py * py;
    qsum += qx * qx + qy * qy;
  }
  const radius = Math.sqrt(qsum / k);
  if (!(pden > 1e-9) || !(radius > 1e-6)) return null;

  // The complex ratio that best carries p onto q: scale and rotation together,
  // with no reflected branch to take by accident.
  const kx = dot / pden;
  const ky = cross / pden;

  const targets = new Array<FieldStar>(k);
  let sq = 0;
  let shift = 0;
  for (let i = 0; i < k; i++) {
    const px = pts[order[i]].x - pcx;
    const py = pts[order[i]].y - pcy;
    const tx = qcx + kx * px - ky * py;
    const ty = qcy + ky * px + kx * py;
    targets[i] = { x: tx, y: ty };
    const d = (tx - stars[picks[i]].x) ** 2 + (ty - stars[picks[i]].y) ** 2;
    sq += d;
    shift = Math.max(shift, Math.sqrt(d));
  }

  return { error: Math.sqrt(sq / k) / radius, shift, cx: qcx, cy: qcy, radius, targets };
}

/** Larger figures win, and not merely on ties — see the header. */
function sizeWeight(k: number, bias: number) {
  return 1 + bias * (k - FIGURE_MIN_STARS);
}

/**
 * A search in progress. `step` does a slice of the work and reports whether it
 * has finished; `result` is the best figure found so far, and is final once
 * `step` has returned true.
 */
export type ConstellationSearch = {
  step(budgetMs: number): boolean;
  result(): ConstellationMatch | null;
};

export function createConstellationSearch(
  stars: FieldStar[],
  options: MatchOptions
): ConstellationSearch {
  const opts = { ...DEFAULTS, ...options };
  const { cursorX, cursorY } = opts;

  // Candidate stars: nearest to the cursor first, capped.
  const near: Array<{ i: number; d: number }> = [];
  const rSq = opts.searchRadius ** 2;
  for (let i = 0; i < stars.length; i++) {
    const d = (stars[i].x - cursorX) ** 2 + (stars[i].y - cursorY) ** 2;
    if (d <= rSq) near.push({ i, d });
  }
  near.sort((p, q) => p.d - q.d);
  const chosen = near.slice(0, opts.maxStars);
  const pool = chosen.map((e) => stars[e.i]);
  const poolIndex = chosen.map((e) => e.i);
  const n = pool.length;

  const figures = preparedFigures();
  // Stamped rather than cleared: an assignment marks the stars it has taken with
  // the current attempt's number, so "already used" costs no allocation.
  const claimed = new Int32Array(Math.max(1, n));
  let epoch = 0;

  let best: ConstellationMatch | null = null;
  let bestCost = Infinity;
  let cursor = 0;

  function evaluate(t: PreparedFigure) {
    const k = t.pts.length;
    if (k > n || k < opts.minStars) return;

    const minSpanSq = (opts.minRadius * t.basisLen) ** 2;
    const maxSpanSq = (opts.maxRadius * t.basisLen) ** 2;
    const picks = new Array<number>(k);
    const order = [t.a, t.b, ...t.rest];
    const ux = t.pts[t.b].x - t.pts[t.a].x;
    const uy = t.pts[t.b].y - t.pts[t.a].y;
    const uLenSq = ux * ux + uy * uy;

    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const vx = pool[j].x - pool[i].x;
        const vy = pool[j].y - pool[i].y;
        const spanSq = vx * vx + vy * vy;
        if (spanSq < minSpanSq || spanSq > maxSpanSq) continue;

        // v / u as a complex number: rotation and scale in one step.
        const kx = (vx * ux + vy * uy) / uLenSq;
        const ky = (vy * ux - vx * uy) / uLenSq;

        const scale = Math.sqrt(spanSq) / t.basisLen;
        const tolSq = (opts.tolerance * scale) ** 2;

        epoch++;
        claimed[i] = epoch;
        claimed[j] = epoch;
        picks[0] = i;
        picks[1] = j;

        let sumSq = 0;
        let ok = true;
        for (let oi = 2; oi < k; oi++) {
          const p = t.pts[order[oi]];
          const dx = p.x - t.pts[t.a].x;
          const dy = p.y - t.pts[t.a].y;
          const tx = pool[i].x + (kx * dx - ky * dy);
          const ty = pool[i].y + (ky * dx + kx * dy);

          let bestD = tolSq;
          let bestS = -1;
          for (let s = 0; s < n; s++) {
            if (claimed[s] === epoch) continue;
            const d = (pool[s].x - tx) ** 2 + (pool[s].y - ty) ** 2;
            if (d < bestD) {
              bestD = d;
              bestS = s;
            }
          }
          if (bestS < 0) {
            ok = false;
            break;
          }
          claimed[bestS] = epoch;
          picks[oi] = bestS;
          sumSq += bestD;
          // Abandon as soon as the running residual cannot come back under the
          // tolerance — most wrong transforms die on their third point.
          if (sumSq > tolSq * (oi + 1)) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;

        const fit = solve(t.pts, order, pool, picks);
        if (!fit) continue;
        if (!(fit.error <= opts.maxError)) continue;
        if (fit.shift > opts.maxShiftPx) continue;
        if (fit.radius < opts.minRadius || fit.radius > opts.maxRadius) continue;
        if (Math.hypot(fit.cx - cursorX, fit.cy - cursorY) > opts.cursorMaxOffset) {
          continue;
        }

        const cost = fit.error / sizeWeight(k, opts.sizeBias);
        if (cost >= bestCost) continue;

        // Template point order, not evaluation order: the edge list indexes the
        // figure's own points, so the drawing has to agree with it.
        const byPoint = new Array<number>(k);
        const targets = new Array<FieldStar>(k);
        for (let oi = 0; oi < k; oi++) {
          byPoint[order[oi]] = poolIndex[picks[oi]];
          targets[order[oi]] = fit.targets[oi];
        }

        bestCost = cost;
        best = {
          figureId: t.figure.id,
          name: t.figure.name,
          starIndices: byPoint,
          targets,
          edges: t.figure.edges.map(([x, y]) => [x, y] as [number, number]),
          error: fit.error,
          shift: fit.shift,
          cx: fit.cx,
          cy: fit.cy,
          radius: fit.radius,
        };
      }
    }
  }

  return {
    step(budgetMs: number) {
      if (n < opts.minStars) return true;
      const until = Date.now() + Math.max(0, budgetMs);
      // At least one figure per call, so a zero budget still makes progress
      // rather than spinning forever.
      do {
        evaluate(figures[cursor]);
        cursor++;
      } while (cursor < figures.length && Date.now() < until);
      return cursor >= figures.length;
    },
    result() {
      return best;
    },
  };
}

/**
 * The best real constellation traced by these stars, or null when the field near
 * the cursor does not credibly hold one. Runs the whole search at once; the
 * starfield uses `createConstellationSearch` instead so it can spread the work.
 */
export function matchConstellation(
  stars: FieldStar[],
  options: MatchOptions
): ConstellationMatch | null {
  const search = createConstellationSearch(stars, options);
  while (!search.step(Infinity));
  return search.result();
}
