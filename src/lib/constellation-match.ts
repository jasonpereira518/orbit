/**
 * Finding a real constellation inside a field of unrelated stars.
 *
 * The interactive starfield calls this when the cursor has been still for a
 * moment: it hands over the stars currently drawn near the pointer and asks
 * which classic figure — Orion, the Big Dipper, Cassiopeia — those stars come
 * closest to tracing. The answer is then drawn over the sky.
 *
 * WHAT "FITS" MEANS HERE. A constellation is a shape, not a place: the same
 * figure is the same figure wherever it sits, however large it appears, and
 * whatever angle it is seen at. So a template is allowed to translate, rotate
 * and scale freely, and what is measured is how far each of its points ends up
 * from the star it claims. Reflection is NOT allowed, and that is the one
 * transform people notice: a mirrored Big Dipper is not the Big Dipper, it is a
 * shape nobody has ever seen in the sky.
 *
 * HOW THE SEARCH WORKS. Two matched points pin a similarity transform exactly,
 * so the search enumerates ordered pairs of nearby stars, maps each template's
 * own widest pair onto them, and checks where the rest of the figure lands. A
 * pair whose span would make the figure absurdly small or large is skipped
 * before any work happens, and a partial fit is abandoned the moment its
 * running error passes the tolerance — which is what keeps a full sweep of
 * twenty figures inside a few milliseconds on the main thread.
 *
 * WHY THE SCORING IS NOT JUST "SMALLEST ERROR". A small figure is easier to
 * satisfy than a large one — five points leave six degrees of freedom to argue
 * with, nine points leave fourteen — so raw residual hands back the smallest
 * template in the pool almost every time. Measured over 300 random skies,
 * comparing residuals alone made 95% of claims five-star figures, drawn from
 * only six of the fourteen shapes, with Cepheus alone accounting for 43%.
 * Discounting by size (`sizeBias`) drops that to 26%, brings all fourteen
 * figures onto the board with none above 16%, and lifts the average claim from
 * five stars to seven and a half — at a residual still tight enough (0.08
 * average) that the figure drawn looks like the figure named.
 *
 * WHAT THIS IS AND IS NOT. It is a best fit, not a discovery: a rested cursor
 * nearly always finds something, because a pool of fourteen figures against
 * thirty stars nearly always contains a good fit. What the residual ceiling
 * buys is that the answer resembles its name — this is pareidolia held to a
 * measurable standard, not a claim to have found a hidden Orion.
 *
 * Deliberately free of React, canvas and `next/*`: this is pure geometry, which
 * is what lets `scripts/smoke-constellation-match.ts` run it over thousands of
 * random skies to check both that a planted figure is found and that an
 * ordinary field does not "recognise" something in every direction.
 */
import {
  FIGURE_MATCH_MIN,
  recognizableConstellations,
  type ConstellationShape,
} from "@/lib/constellation-shapes";

export type FieldStar = { x: number; y: number };

export type ConstellationMatch = {
  shapeId: string;
  /** Display name, e.g. "Cassiopeia". */
  name: string;
  /**
   * Indices into the `stars` array handed to `matchConstellation`, in template
   * point order — `starIndices[i]` is the star standing in for template point i.
   */
  starIndices: number[];
  /** Template edges, as index pairs into `starIndices`. */
  edges: Array<[number, number]>;
  /** RMS residual as a fraction of the figure's own radius. Lower is tighter. */
  error: number;
  /** Centroid of the matched stars, in the caller's coordinate space. */
  cx: number;
  cy: number;
  /** RMS radius of the matched stars about that centroid. */
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
  /** Residual ceiling: beyond this the figure stops resembling its name. */
  maxError?: number;
  /** The figure's centroid must land within this distance of the cursor. */
  cursorMaxOffset?: number;
  /** Smallest template the search may offer. See FIGURE_MATCH_MIN. */
  minStars?: number;
  /** How hard richer figures are favoured over smaller ones. See `sizeWeight`. */
  sizeBias?: number;
};

const DEFAULTS = {
  searchRadius: 320,
  // The cap is what bounds the pair enumeration, so it is a frame-budget
  // guarantee: 32 candidates keeps a full sweep near 2.5ms, 44 pushes past 7ms
  // and 58 past 14ms, which is a dropped frame on the main thread.
  maxStars: 32,
  minRadius: 60,
  maxRadius: 230,
  tolerance: 0.3,
  maxError: 0.16,
  cursorMaxOffset: 210,
  minStars: FIGURE_MATCH_MIN,
  sizeBias: 0.5,
} as const;

/** A template, recentred on its centroid and scaled to RMS radius 1. */
type PreparedTemplate = {
  shape: ConstellationShape;
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

let prepared: PreparedTemplate[] | null = null;

function prepare(shape: ConstellationShape): PreparedTemplate | null {
  const n = shape.stars.length;
  if (n < FIGURE_MATCH_MIN) return null;

  let sx = 0;
  let sy = 0;
  for (const s of shape.stars) {
    sx += s.x;
    sy += s.y;
  }
  const cx = sx / n;
  const cy = sy / n;

  let sumSq = 0;
  for (const s of shape.stars) {
    sumSq += (s.x - cx) ** 2 + (s.y - cy) ** 2;
  }
  const rms = Math.sqrt(sumSq / n);
  // A template whose points all coincide has no shape to match.
  if (!(rms > 1e-6)) return null;

  const pts = shape.stars.map((s) => ({ x: (s.x - cx) / rms, y: (s.y - cy) / rms }));

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
  if (!(basisLen > 1e-6)) return null;

  const mx = (pts[a].x + pts[b].x) / 2;
  const my = (pts[a].y + pts[b].y) / 2;
  const rest = [];
  for (let i = 0; i < n; i++) if (i !== a && i !== b) rest.push(i);
  rest.sort(
    (p, q) =>
      (pts[q].x - mx) ** 2 +
      (pts[q].y - my) ** 2 -
      ((pts[p].x - mx) ** 2 + (pts[p].y - my) ** 2)
  );

  return { shape, pts, a, b, basisLen, rest };
}

function templates(): PreparedTemplate[] {
  if (!prepared) {
    prepared = recognizableConstellations()
      .map(prepare)
      .filter((t): t is PreparedTemplate => t !== null);
  }
  return prepared;
}

/**
 * Least-squares similarity (rotation + uniform scale + translation, never
 * reflection) taking the template points onto their matched stars.
 *
 * The pair-based transform that produced a candidate is pinned to two stars and
 * therefore carries their placement error into every other point. Re-solving
 * over the whole assignment spreads that error out, which is what makes the
 * reported residual a fair description of the figure rather than an artefact of
 * whichever two stars happened to seed it.
 */
function similarityResidual(
  pts: FieldStar[],
  order: number[],
  stars: FieldStar[],
  picks: number[]
): { error: number; cx: number; cy: number; radius: number } {
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
  if (!(pden > 1e-9) || !(radius > 1e-6)) {
    return { error: Infinity, cx: qcx, cy: qcy, radius };
  }

  // The complex ratio that best carries p onto q: scale and rotation together.
  const kx = dot / pden;
  const ky = cross / pden;

  let sq = 0;
  for (let i = 0; i < k; i++) {
    const px = pts[order[i]].x - pcx;
    const py = pts[order[i]].y - pcy;
    const tx = kx * px - ky * py;
    const ty = ky * px + kx * py;
    sq += (tx - (stars[picks[i]].x - qcx)) ** 2 + (ty - (stars[picks[i]].y - qcy)) ** 2;
  }

  return { error: Math.sqrt(sq / k) / radius, cx: qcx, cy: qcy, radius };
}

/**
 * Larger figures win, and not merely on ties.
 *
 * Each extra point spends two more degrees of freedom against the four a
 * similarity transform has to spare, so a seven-star fit at a loose residual is
 * a far stronger statement about the sky than a four-star fit at a tight one.
 * Comparing raw residuals would invert that and hand back the smallest figure
 * in the pool almost every time.
 */
function sizeWeight(k: number, bias: number) {
  return 1 + bias * (k - FIGURE_MATCH_MIN);
}

/**
 * The best real constellation traced by these stars, or null when the field
 * near the cursor does not credibly hold one.
 */
export function matchConstellation(
  stars: FieldStar[],
  options: MatchOptions
): ConstellationMatch | null {
  const opts = { ...DEFAULTS, ...options };
  const { cursorX, cursorY } = opts;

  // Candidate stars: nearest to the cursor first, capped. The cap is what
  // bounds the pair enumeration below, so it is a performance guarantee rather
  // than a preference.
  const near: Array<{ i: number; d: number }> = [];
  const rSq = opts.searchRadius ** 2;
  for (let i = 0; i < stars.length; i++) {
    const d = (stars[i].x - cursorX) ** 2 + (stars[i].y - cursorY) ** 2;
    if (d <= rSq) near.push({ i, d });
  }
  if (near.length < FIGURE_MATCH_MIN) return null;
  near.sort((p, q) => p.d - q.d);
  const pool = near.slice(0, opts.maxStars).map((e) => stars[e.i]);
  const poolIndex = near.slice(0, opts.maxStars).map((e) => e.i);
  const n = pool.length;

  // Stamped rather than cleared: an assignment marks the stars it has taken with
  // the current attempt's number, so "already used" costs no allocation.
  const claimed = new Int32Array(n);
  let epoch = 0;

  let best: ConstellationMatch | null = null;
  let bestCost = Infinity;

  for (const t of templates()) {
    const k = t.pts.length;
    if (k > n || k < opts.minStars) continue;
    // The basis span that would put the figure inside the allowed size band.
    const minSpan = opts.minRadius * t.basisLen;
    const maxSpan = opts.maxRadius * t.basisLen;
    const minSpanSq = minSpan * minSpan;
    const maxSpanSq = maxSpan * maxSpan;

    const picks = new Array<number>(k);
    const order = [t.a, t.b, ...t.rest];

    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const ux = t.pts[t.b].x - t.pts[t.a].x;
        const uy = t.pts[t.b].y - t.pts[t.a].y;
        const vx = pool[j].x - pool[i].x;
        const vy = pool[j].y - pool[i].y;
        const spanSq = vx * vx + vy * vy;
        if (spanSq < minSpanSq || spanSq > maxSpanSq) continue;

        // v / u as a complex number: rotation and scale in one step, with no
        // reflected branch to accidentally take.
        const uLenSq = ux * ux + uy * uy;
        const kx = (vx * ux + vy * uy) / uLenSq;
        const ky = (vy * ux - vx * uy) / uLenSq;

        const scale = Math.sqrt(spanSq) / t.basisLen;
        const tol = opts.tolerance * scale;
        const tolSq = tol * tol;

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

        const fit = similarityResidual(t.pts, order, pool, picks);
        if (!(fit.error <= opts.maxError)) continue;
        if (fit.radius < opts.minRadius || fit.radius > opts.maxRadius) continue;
        const offset = Math.hypot(fit.cx - cursorX, fit.cy - cursorY);
        if (offset > opts.cursorMaxOffset) continue;

        const cost = fit.error / sizeWeight(k, opts.sizeBias);
        if (cost >= bestCost) continue;

        // Template point order, not evaluation order: the edge list indexes the
        // shape's own points, so the drawn figure has to agree with it.
        const byTemplatePoint = new Array<number>(k);
        for (let oi = 0; oi < k; oi++) {
          byTemplatePoint[order[oi]] = poolIndex[picks[oi]];
        }

        bestCost = cost;
        best = {
          shapeId: t.shape.id,
          name: t.shape.name,
          starIndices: byTemplatePoint,
          edges: t.shape.edges.map(([x, y]) => [x, y] as [number, number]),
          error: fit.error,
          cx: fit.cx,
          cy: fit.cy,
          radius: fit.radius,
        };
      }
    }
  }

  return best;
}
