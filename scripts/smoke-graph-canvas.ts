/**
 * The mobile constellation's arithmetic: the world↔screen camera, the tap grid, and the
 * breakpoint that decides which renderer a device gets.
 *
 * All of this is what a phone's finger actually lands on, and none of it can be checked
 * in a browser pane — that runs at `visibilityState: "hidden"`, where rAF is starved and
 * gestures do not exist. So the rules are pinned here as pure math, and the paint itself
 * is verified by hand on a real device.
 *
 * No DB, no network, no DOM.
 * Run: npx tsx scripts/smoke-graph-canvas.ts
 */

import {
  PAN_SLACK_VIEWPORTS,
  SKY_FIT_MAX_ZOOM,
  SKY_MAX_ZOOM,
  SKY_MIN_ZOOM,
  clampPan,
  clampZoom,
  easeOutCubic,
  computeSunExtents,
  fitWorldRect,
  lerpCamera,
  panBy,
  rectOf,
  screenToWorld,
  visibleWorldRect,
  worldToScreen,
  zoomAt,
  zoomToFitSunCentered,
  type Camera,
  type Vec2,
} from "../src/lib/graph/sky-camera";
import { buildSkyGrid, hitTest, queryRect, type SkyTarget } from "../src/lib/graph/hit-test";
import {
  INERTIA_DECAY,
  INERTIA_MIN_PX_PER_FRAME,
  MAX_FLICK_PX_PER_FRAME,
  flickVelocity,
  type Sample,
} from "../src/components/graph/sky-canvas/use-sky-gestures";
import {
  SMALL_SKY_MAX_PX,
  SMALL_SKY_QUERY,
  isSmallSkyViewport,
} from "../src/components/graph/use-small-sky";
import { STAR_HIT_PAD, starSize, starVisual, zoomRelief } from "../src/lib/graph/star-style";
import { buildHybridGraphLayout, type GraphContactInput } from "../src/lib/graph-layout";
import { readFileSync } from "node:fs";
import { buildSkyIndex } from "../src/components/graph/sky-canvas/sky-index";
import {
  FOCUS_DIM_OPACITY,
  SEARCH_DIM_OPACITY,
  edgeEmphasis,
  starEmphasis,
} from "../src/lib/graph/sky-emphasis";
import {
  TAP_SLOP_PX,
  TAP_TOLERANCE_PX as GESTURE_TAP_TOLERANCE,
} from "../src/components/graph/sky-canvas/use-sky-gestures";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) {
    throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  }
  console.log(`  ok  ${label}`);
}

const close = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

/** Deterministic pseudo-random, so a failure is always reproducible. */
function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ---------------------------------------------------------------------------
console.log("\ncamera transform\n");
// ---------------------------------------------------------------------------
{
  const rng = makeRng(20260908);
  let worstRoundTrip = 0;
  for (let i = 0; i < 200; i += 1) {
    const cam: Camera = {
      x: (rng() - 0.5) * 4000,
      y: (rng() - 0.5) * 4000,
      k: SKY_MIN_ZOOM + rng() * (SKY_MAX_ZOOM - SKY_MIN_ZOOM),
    };
    const p: Vec2 = { x: (rng() - 0.5) * 20000, y: (rng() - 0.5) * 20000 };
    const back = screenToWorld(worldToScreen(p, cam), cam);
    worstRoundTrip = Math.max(worstRoundTrip, Math.abs(back.x - p.x), Math.abs(back.y - p.y));
  }
  check(
    "screenToWorld inverts worldToScreen across the whole zoom range",
    worstRoundTrip < 1e-6,
    `worst drift ${worstRoundTrip}`
  );

  // The pinch invariant. When this is wrong the sky slides out from under the fingers.
  const rng2 = makeRng(7);
  let worstAnchorDrift = 0;
  for (let i = 0; i < 200; i += 1) {
    const cam: Camera = {
      x: (rng2() - 0.5) * 2000,
      y: (rng2() - 0.5) * 2000,
      k: 0.1 + rng2() * 2,
    };
    const anchor: Vec2 = { x: rng2() * 400, y: rng2() * 800 };
    const before = screenToWorld(anchor, cam);
    const after = screenToWorld(anchor, zoomAt(cam, anchor, 0.2 + rng2() * 4));
    worstAnchorDrift = Math.max(
      worstAnchorDrift,
      Math.abs(after.x - before.x),
      Math.abs(after.y - before.y)
    );
  }
  check(
    "zoomAt holds the world point under the anchor still",
    worstAnchorDrift < 1e-6,
    `worst drift ${worstAnchorDrift}`
  );

  // Including at the clamp, where a naive implementation applies the requested factor
  // to the translation but the clamped one to the zoom, and the sky lurches.
  const atMax: Camera = { x: 10, y: -40, k: SKY_MAX_ZOOM };
  const anchor: Vec2 = { x: 190, y: 410 };
  const clampedDrift = screenToWorld(anchor, zoomAt(atMax, anchor, 8));
  const beforeClamp = screenToWorld(anchor, atMax);
  check(
    "zoomAt holds the anchor even when the zoom clamps",
    close(clampedDrift.x, beforeClamp.x) && close(clampedDrift.y, beforeClamp.y)
  );
  check("zoomAt never exceeds the zoom bounds", zoomAt(atMax, anchor, 8).k === SKY_MAX_ZOOM);
  check(
    "zoomAt never falls below the zoom bounds",
    zoomAt({ x: 0, y: 0, k: SKY_MIN_ZOOM }, anchor, 0.01).k === SKY_MIN_ZOOM
  );

  /**
   * A two-finger gesture, composed the way `use-sky-gestures` composes it: scale about
   * the midpoint the fingers came FROM, then translate by how far the midpoint moved.
   *
   * Anchoring the zoom at the new midpoint instead is the subtle version of this bug —
   * it holds still whatever happened to be under the finger's destination, so the sky
   * creeps a little on every pinch. That is what this case is here to prevent.
   *
   * Modelled as a pure scale + translation (no rotation), which is the transform the
   * camera can actually represent: the sky has a fixed orientation, so a twisting pinch
   * is deliberately treated as scale and pan only.
   */
  const pane = { width: 393, height: 760 };
  let cam: Camera = { x: pane.width / 2, y: pane.height / 2, k: 0.4 };
  const f1 = { x: 120, y: 300 };
  const f2 = { x: 280, y: 520 };
  const w1 = screenToWorld(f1, cam);
  const w2 = screenToWorld(f2, cam);

  const midPrev = { x: (f1.x + f2.x) / 2, y: (f1.y + f2.y) / 2 };
  const spread = 1.5;
  const drift = { x: -30, y: 40 };
  const spreadFrom = (f: Vec2) => ({
    x: midPrev.x + (f.x - midPrev.x) * spread + drift.x,
    y: midPrev.y + (f.y - midPrev.y) * spread + drift.y,
  });
  const n1 = spreadFrom(f1);
  const n2 = spreadFrom(f2);
  const mid = { x: (n1.x + n2.x) / 2, y: (n1.y + n2.y) / 2 };
  const factor = Math.hypot(n2.x - n1.x, n2.y - n1.y) / Math.hypot(f2.x - f1.x, f2.y - f1.y);

  cam = panBy(zoomAt(cam, midPrev, factor), mid.x - midPrev.x, mid.y - midPrev.y);

  const after1 = worldToScreen(w1, cam);
  const after2 = worldToScreen(w2, cam);
  check(
    "pinch composition keeps both touched points exactly under their fingers",
    Math.hypot(after1.x - n1.x, after1.y - n1.y) < 1e-6 &&
      Math.hypot(after2.x - n2.x, after2.y - n2.y) < 1e-6,
    `f1 off by ${Math.hypot(after1.x - n1.x, after1.y - n1.y).toFixed(6)}px`
  );

  check("clampZoom pins to the documented bounds", clampZoom(99) === SKY_MAX_ZOOM && clampZoom(0) === SKY_MIN_ZOOM);

  const rect = visibleWorldRect({ x: 100, y: 50, k: 2 }, 400, 800);
  check(
    "visibleWorldRect describes exactly the pane's world footprint",
    close(rect.minX, -50) && close(rect.minY, -25) && close(rect.maxX, 150) && close(rect.maxY, 375)
  );

  const tween = lerpCamera({ x: 0, y: 0, k: 0.1 }, { x: 100, y: 200, k: 2 }, 1);
  check(
    "lerpCamera lands exactly on its target at t=1",
    close(tween.x, 100) && close(tween.y, 200) && close(tween.k, 2)
  );
  // A linear ramp from 0.1 to 10 spends almost the whole flight near the top and reads
  // as a lurch at the end; the geometric one must stay below it the whole way.
  {
    const from = { x: 0, y: 0, k: 0.1 };
    const to = { x: 0, y: 0, k: 10 };
    let alwaysBelow = true;
    for (let t = 0.05; t < 1; t += 0.05) {
      const eased = easeOutCubic(t);
      const linear = from.k + (to.k - from.k) * eased;
      if (lerpCamera(from, to, t).k >= linear) alwaysBelow = false;
    }
    check("lerpCamera interpolates zoom geometrically, not linearly", alwaysBelow);
  }
}

// ---------------------------------------------------------------------------
console.log("\nflick velocity\n");
// ---------------------------------------------------------------------------
{
  const now = 10_000;
  /** How far a coast travels in total, given its opening speed. */
  const coastDistance = (v: number) => {
    let speed = v;
    let total = 0;
    while (Math.abs(speed) >= INERTIA_MIN_PX_PER_FRAME) {
      speed *= INERTIA_DECAY;
      total += speed;
    }
    return Math.abs(total);
  };

  check(
    "no samples means no coast",
    flickVelocity([], now).x === 0 && flickVelocity([], now).y === 0
  );
  check(
    "samples older than the window are ignored",
    flickVelocity([{ dx: -40, dy: 0, dt: 16, t: now - 500 }], now).x === 0,
    "a finger that paused before lifting is not a flick"
  );

  /**
   * The case caught on a real iPhone: a slow drag that ends with one small nudge.
   *
   * Measuring against `now` rather than the samples' own duration made the elapsed time
   * collapse toward zero, so an 8px nudge read as hundreds of px per frame and threw the
   * sky most of a screen off. 8px over 250ms is about half a pixel a frame.
   */
  const gentle: Sample[] = [{ dx: -8, dy: -8, dt: 250, t: now - 1 }];
  const gentleV = flickVelocity(gentle, now);
  check(
    "a slow nudge before lifting stays a slow nudge",
    Math.hypot(gentleV.x, gentleV.y) < 2,
    `${Math.hypot(gentleV.x, gentleV.y).toFixed(1)} px/frame`
  );
  check(
    "...so it coasts a few pixels, not across the sky",
    coastDistance(gentleV.x) < 20,
    `${coastDistance(gentleV.x).toFixed(0)}px of coast`
  );

  const flick: Sample[] = [
    { dx: -18, dy: 0, dt: 16, t: now - 48 },
    { dx: -20, dy: 0, dt: 16, t: now - 32 },
    { dx: -22, dy: 0, dt: 16, t: now - 16 },
  ];
  const flickV = flickVelocity(flick, now);
  check(
    "a real flick keeps the speed the finger actually had",
    Math.abs(flickV.x + 20) < 1.5,
    `${flickV.x.toFixed(1)} px/frame against ~-20 measured`
  );

  const violent: Sample[] = [{ dx: -900, dy: 0, dt: 16, t: now - 8 }];
  check(
    "an absurd sample is capped rather than trusted",
    Math.abs(flickVelocity(violent, now).x) === MAX_FLICK_PX_PER_FRAME
  );
  check(
    "so a coast can never exceed a bounded distance",
    coastDistance(MAX_FLICK_PX_PER_FRAME) < 700,
    `${coastDistance(MAX_FLICK_PX_PER_FRAME).toFixed(0)}px worst case`
  );
  check(
    "the coast always terminates",
    Number.isFinite(coastDistance(MAX_FLICK_PX_PER_FRAME))
  );
}

// ---------------------------------------------------------------------------
console.log("\nframing\n");
// ---------------------------------------------------------------------------
{
  const empty = computeSunExtents([], {}, []);
  check(
    "computeSunExtents floors at 240 so an empty sky still frames",
    empty.maxAbsX === 240 && empty.maxAbsY === 240
  );

  const layout = buildHybridGraphLayout([], "Test User");
  const withOverride = computeSunExtents(layout.nodes, { someone: { x: 4000, y: 10 } }, []);
  check(
    "a position override far from the sun expands the extents",
    withOverride.maxAbsX >= 4000,
    `got ${withOverride.maxAbsX}`
  );

  const z = zoomToFitSunCentered(1000, 1000, 400, 800);
  check(
    "zoomToFitSunCentered pads the sky off the pane edge",
    close(z, 400 / (2 * 1000 * 1.18)),
    `got ${z}`
  );
  check(
    "zoomToFitSunCentered stays inside the fit bounds",
    zoomToFitSunCentered(1, 1, 4000, 4000) === SKY_FIT_MAX_ZOOM &&
      zoomToFitSunCentered(1e9, 1e9, 400, 800) === SKY_MIN_ZOOM
  );

  // Both renderers must open on the same picture: same extents in, same camera out.
  const pane = { width: 393, height: 700 };
  const extents = computeSunExtents(layout.nodes, {}, []);
  const k = zoomToFitSunCentered(extents.maxAbsX, extents.maxAbsY, pane.width, pane.height);
  const mobileCamera: Camera = { x: pane.width / 2, y: pane.height / 2, k };
  const sunOnScreen = worldToScreen({ x: 0, y: 0 }, mobileCamera);
  check(
    "the default mobile camera lands the sun dead centre, as the DOM chart does",
    close(sunOnScreen.x, pane.width / 2) && close(sunOnScreen.y, pane.height / 2)
  );

  const single = rectOf([{ x: 500, y: -300 }]);
  const framed = fitWorldRect(single!, pane, { padding: 0.55, maxZoom: 1.8 });
  const centred = worldToScreen({ x: 500, y: -300 }, framed);
  check(
    "fitWorldRect centres a single node without dividing by zero",
    close(centred.x, pane.width / 2) && close(centred.y, pane.height / 2) && framed.k === 1.8
  );

  const wide = fitWorldRect({ minX: -2000, minY: -2000, maxX: 2000, maxY: 2000 }, pane, {
    padding: 0.2,
  });
  const corner = worldToScreen({ x: -2000, y: -2000 }, wide);
  check(
    "fitWorldRect keeps the whole rect inside the pane",
    corner.x >= 0 && corner.y >= 0,
    `corner at ${corner.x.toFixed(1)},${corner.y.toFixed(1)}`
  );
}

// ---------------------------------------------------------------------------
console.log("\npan clamp\n");
// ---------------------------------------------------------------------------
{
  const pane = { width: 393, height: 760 };
  const bounds = { minX: -1000, minY: -1000, maxX: 1000, maxY: 1000 };
  const flung = clampPan({ x: 500000, y: -500000, k: 0.3 }, bounds, pane);
  check(
    "clampPan stops the sky being flung out of the pane",
    Number.isFinite(flung.x) && flung.x <= pane.width * PAN_SLACK_VIEWPORTS + 1000 * 0.3
  );
  const centred: Camera = { x: pane.width / 2, y: pane.height / 2, k: 0.15 };
  const held = clampPan(centred, bounds, pane);
  check(
    "clampPan leaves a centred camera untouched",
    close(held.x, centred.x) && close(held.y, centred.y)
  );
}

// ---------------------------------------------------------------------------
console.log("\nhit testing\n");
// ---------------------------------------------------------------------------
{
  const rng = makeRng(4242);
  const targets: SkyTarget[] = [];
  for (let i = 0; i < 3000; i += 1) {
    targets.push({
      id: `c${i}`,
      x: (rng() - 0.5) * 12000,
      y: (rng() - 0.5) * 12000,
      r: starSize(1 + Math.floor(rng() * 5)) / 2,
      kind: "contact",
    });
  }
  const grid = buildSkyGrid(targets);

  const bruteForce = (p: Vec2, tol: number): SkyTarget | null => {
    let best: SkyTarget | null = null;
    let bestDistance = Infinity;
    for (const t of targets) {
      const d = Math.hypot(t.x - p.x, t.y - p.y);
      if (d > t.r + tol) continue;
      if (d < bestDistance) {
        bestDistance = d;
        best = t;
      }
    }
    return best;
  };

  // The assertion that actually proves the grid: it must agree with an O(n) scan every
  // single time, at every zoom a finger can reach.
  let disagreements = 0;
  const probe = makeRng(99);
  for (let i = 0; i < 500; i += 1) {
    const k = 0.05 + probe() * 2;
    const tol = STAR_HIT_PAD / k;
    const p = { x: (probe() - 0.5) * 13000, y: (probe() - 0.5) * 13000 };
    const a = hitTest(grid, p, tol);
    const b = bruteForce(p, tol);
    if ((a?.id ?? null) !== (b?.id ?? null)) disagreements += 1;
  }
  check(
    "the grid agrees with a brute-force scan over 3,000 nodes and 500 taps",
    disagreements === 0,
    `${disagreements} disagreements`
  );

  const pair = buildSkyGrid([
    { id: "near", x: 0, y: 0, r: 5, kind: "contact" },
    { id: "far", x: 18, y: 0, r: 5, kind: "contact" },
  ]);
  check(
    "the nearest centre wins when two stars are both in tolerance",
    hitTest(pair, { x: 7, y: 0 }, 40)?.id === "near"
  );
  check(
    "...and the other one wins from the other side",
    hitTest(pair, { x: 12, y: 0 }, 40)?.id === "far"
  );
  check(
    "both stars at the layout's 18-unit minimum stay individually selectable",
    hitTest(pair, { x: 0, y: 0 }, STAR_HIT_PAD)?.id === "near" &&
      hitTest(pair, { x: 18, y: 0 }, STAR_HIT_PAD)?.id === "far"
  );
  check(
    "a tap beyond r + tolerance hits nothing",
    hitTest(pair, { x: 0, y: 400 }, STAR_HIT_PAD) === null
  );

  // Tolerance is in world units, so it must widen as the camera pulls back — that is
  // what keeps a 2px star tappable at the default framing.
  const farOut = hitTest(pair, { x: 0, y: 60 }, STAR_HIT_PAD / 0.1);
  const zoomedIn = hitTest(pair, { x: 0, y: 60 }, STAR_HIT_PAD / 2);
  check(
    "tolerance scales as 1/zoom: reachable pulled back, not reachable zoomed in",
    farOut?.id === "near" && zoomedIn === null
  );

  const filtered = hitTest(
    buildSkyGrid([
      { id: "star", x: 0, y: 0, r: 6, kind: "contact" },
      { id: "haze", x: 0, y: 0, r: 400, kind: "nebula" },
    ]),
    { x: 2, y: 2 },
    20,
    (t) => t.kind === "contact"
  );
  check("hitTest honours a kind filter, so a star can beat the nebula behind it", filtered?.id === "star");

  // Culling may over-include; it must never under-include, or stars pop in at the edge.
  const rect = { minX: -3000, minY: -3000, maxX: 3000, maxY: 3000 };
  const visible = new Set(queryRect(grid, rect).map((t) => t.id));
  const trulyVisible = targets.filter(
    (t) => t.x + t.r >= rect.minX && t.x - t.r <= rect.maxX && t.y + t.r >= rect.minY && t.y - t.r <= rect.maxY
  );
  check(
    "queryRect never misses a node that is actually on screen",
    trulyVisible.every((t) => visible.has(t.id)),
    `${trulyVisible.filter((t) => !visible.has(t.id)).length} missed`
  );
  check(
    "queryRect culls: a small window returns far fewer than the whole sky",
    queryRect(grid, { minX: -200, minY: -200, maxX: 200, maxY: 200 }).length < targets.length / 10
  );
  check(
    "an empty sky builds a usable grid rather than throwing",
    hitTest(buildSkyGrid([]), { x: 0, y: 0 }, 20) === null
  );
}

// ---------------------------------------------------------------------------
console.log("\nbacking store\n");
// ---------------------------------------------------------------------------
{
  /**
   * The regression test for this whole exercise. The canvas is sized to the PANE and
   * pans a transform; sizing it to the sky is the mistake that silently blanks the
   * canvas on iOS, as `src/components/landing/starfield.tsx` documents.
   */
  const contacts: GraphContactInput[] = Array.from({ length: 3000 }, (_, i) => ({
    id: `c${i}`,
    fullName: `Person ${i}`,
    company: `Company ${i % 40}`,
    title: null,
    relationshipScore: (i % 5) + 1,
    lastInteractionAt: null,
    nextFollowUpAt: null,
    tags: [],
    aiSummary: null,
    keyFacts: null,
  }));
  const layout = buildHybridGraphLayout(contacts, "Test User");
  const extents = computeSunExtents(layout.nodes, {}, []);

  const DPR_CAP = 2;
  const pane = { width: 430, height: 932 };
  const paneStore = pane.width * DPR_CAP * pane.height * DPR_CAP;
  check(
    "a 3,000-contact sky on a pane-sized canvas stays under 4M pixels",
    paneStore <= 4_000_000,
    `${(paneStore / 1e6).toFixed(2)}M px`
  );

  const skySized = extents.maxAbsX * 2 * DPR_CAP * (extents.maxAbsY * 2 * DPR_CAP);
  check(
    "...whereas a sky-sized canvas would blow past it, which is why we never build one",
    skySized > 40_000_000,
    `${(skySized / 1e6).toFixed(0)}M px`
  );
}

// ---------------------------------------------------------------------------
console.log("\nrenderer breakpoint\n");
// ---------------------------------------------------------------------------
{
  const phone = { width: 393, height: 852, coarsePointer: true };
  const phoneLandscape = { width: 852, height: 393, coarsePointer: true };
  const ipad = { width: 768, height: 1024, coarsePointer: true };
  const desktop = { width: 1440, height: 900, coarsePointer: false };
  const narrowDesktop = { width: 700, height: 900, coarsePointer: false };
  const shortDesktop = { width: 1440, height: 600, coarsePointer: false };

  check("a phone in portrait gets the canvas", isSmallSkyViewport(phone));
  check(
    "a phone rotated to landscape STAYS on the canvas",
    isSmallSkyViewport(phoneLandscape),
    "a width-only query would hand React Flow to the device that cannot survive it"
  );
  check("an iPad keeps the DOM chart", !isSmallSkyViewport(ipad));
  check("a desktop keeps the DOM chart", !isSmallSkyViewport(desktop));
  check("a narrow desktop window gets the canvas", isSmallSkyViewport(narrowDesktop));
  check(
    "a short desktop window keeps the DOM chart, because its pointer is fine",
    !isSmallSkyViewport(shortDesktop)
  );
  check(
    "the breakpoint sits exactly at Tailwind's md",
    isSmallSkyViewport({ width: 767, height: 900, coarsePointer: false }) &&
      !isSmallSkyViewport({ width: 768, height: 900, coarsePointer: false })
  );
  check(
    "a fractional viewport just under md still matches",
    isSmallSkyViewport({ width: 767.5, height: 900, coarsePointer: false })
  );

  // The predicate and the CSS query are two spellings of one rule; if one is edited
  // without the other, phones silently get the wrong renderer.
  check(
    "the media query and the pure predicate spell the same numbers",
    SMALL_SKY_QUERY.includes(`max-width: ${SMALL_SKY_MAX_PX}px`) &&
      SMALL_SKY_QUERY.includes(`max-height: ${SMALL_SKY_MAX_PX}px`) &&
      SMALL_SKY_QUERY.includes("pointer: coarse")
  );
}

// ---------------------------------------------------------------------------
console.log("\nstar parity\n");
// ---------------------------------------------------------------------------
{
  const base = {
    kind: "contact" as const,
    label: "Ada",
    initials: "A",
    score: 4,
    title: "Engineer",
    company: "Analytical",
  };
  const figure = starVisual({ ...base, figureRole: "figure", clusterColor: "#3aa3ff" }, false);
  const scatter = starVisual({ ...base, figureRole: "scatter" }, false);

  check("a figure star is tinted by its cluster", figure.fill !== "#ffffff");
  check("a scatter star stays white", scatter.fill === "#ffffff" && scatter.core === "#ffffff");
  check("a resting scatter star is dimmed and smaller", scatter.dimmedScatter && scatter.disc < figure.disc);
  check(
    "selecting a scatter star brings it back to full",
    !starVisual({ ...base, figureRole: "scatter" }, true).dimmedScatter
  );
  check(
    "a spotlit star grows and brightens",
    starVisual({ ...base, figureRole: "figure", spotlight: true }, false).disc > figure.disc &&
      starVisual({ ...base, figureRole: "figure", spotlight: true }, false).spotlightBoost > 1
  );
  check("the subtitle prefers the title over the company", figure.subtitle === "Engineer");
  check(
    "...and falls back to the company when the title is unknown",
    starVisual({ ...base, title: null }, false).subtitle === "Analytical"
  );

  check("zoomRelief is inert when zoomed in", zoomRelief(10, 2) === 1);
  check(
    "zoomRelief grows a star as the camera pulls back, but never past the hit pad",
    zoomRelief(10, 0.1) > 1 && zoomRelief(10, 0.001) === (10 + STAR_HIT_PAD) / 10
  );
}


// ---------------------------------------------------------------------------
console.log("\nemphasis parity\n");
// ---------------------------------------------------------------------------
{
  const idle = {
    hoveredId: null,
    selectedContactId: null,
    searchHitIds: new Set<string>(),
    searchDimActive: false,
  };
  check("an untouched sky is fully lit", starEmphasis("a", idle).opacity === 1);

  const searching = {
    hoveredId: null,
    selectedContactId: null,
    searchHitIds: new Set(["hit", "other"]),
    searchDimActive: true,
  };
  check("a search hit stays lit and spotlit", starEmphasis("hit", searching).opacity === 1 && starEmphasis("hit", searching).spotlight);
  check(
    "the rest of the sky stays readable as context, not blanked",
    starEmphasis("miss", searching).opacity === SEARCH_DIM_OPACITY
  );
  check(
    "two hits means neither bobs — solo is solo",
    !starEmphasis("hit", searching).spotlightSolo
  );
  check(
    "one hit does bob",
    starEmphasis("hit", { ...searching, searchHitIds: new Set(["hit"]) }).spotlightSolo
  );

  const focused = {
    hoveredId: null,
    selectedContactId: "me-star",
    searchHitIds: new Set<string>(),
    searchDimActive: false,
  };
  check(
    "hover/selection focus dims harder than search, because it is transient",
    starEmphasis("other", focused).opacity === FOCUS_DIM_OPACITY &&
      FOCUS_DIM_OPACITY < SEARCH_DIM_OPACITY
  );
  check("the selected star itself stays lit", starEmphasis("me-star", focused).opacity === 1);

  const edge = { source: "me-star", target: "x", opacity: 0.5, strokeWidth: 1, kind: "constellation" };
  const touched = edgeEmphasis(edge, { ...focused, focusCluster: null });
  const untouched = edgeEmphasis(
    { ...edge, source: "p", target: "q" },
    { ...focused, focusCluster: null }
  );
  check(
    "an edge touching the selection is emphasized and thickened",
    touched.opacity > 0.5 && touched.strokeWidth > 1
  );
  check("...and the others recede", untouched.opacity <= 0.1);
}

// ---------------------------------------------------------------------------
console.log("\nthe index the renderer draws from\n");
// ---------------------------------------------------------------------------
{
  const contacts: GraphContactInput[] = Array.from({ length: 300 }, (_, i) => ({
    id: `c${i}`,
    fullName: `Person ${i}`,
    company: `Company ${i % 12}`,
    title: null,
    relationshipScore: (i % 5) + 1,
    lastInteractionAt: null,
    nextFollowUpAt: null,
    tags: [],
    aiSummary: null,
    keyFacts: null,
  }));
  const layout = buildHybridGraphLayout(contacts, "Test User");
  const index = buildSkyIndex(layout, {});

  check("every contact becomes a star", index.stars.length === 300);
  check("the sun is found", index.sun !== null && index.sun.x === 0 && index.sun.y === 0);
  check("the rings survive", index.ringRadii.length > 0);
  check(
    "labels are ordered by orbit score, so the budget keeps the closest people",
    index.labelOrder.every((s, i, arr) => i === 0 || arr[i - 1].score >= s.score)
  );
  check(
    "the sun is tappable",
    index.grid.targets.some((t) => t.kind === "user" && t.id === "me")
  );
  check(
    "the tap grid holds every star plus the sun, the haze and the cluster names",
    index.grid.targets.length ===
      index.stars.length + 1 + index.nebulae.length + index.clusterLabels.length
  );
  check(
    "only peer lines are drawn — the sun's rays are the DOM chart's own decoration",
    index.edges.every((e) => e.kind === "constellation" || e.kind === "knows")
  );
  check(
    "the pan bounds contain everything the renderer will draw",
    index.grid.targets.every(
      (t) =>
        t.x - t.r >= index.bounds.minX &&
        t.x + t.r <= index.bounds.maxX &&
        t.y - t.r >= index.bounds.minY &&
        t.y + t.r <= index.bounds.maxY
    )
  );

  /**
   * A star arranged on a laptop must sit in the same place on a phone. The canvas never
   * writes overrides back — dragging a two-pixel star is not a gesture a finger can
   * perform — but it must honour the ones already stored.
   */
  const moved = buildSkyIndex(layout, { c7: { x: 4321, y: -765 } });
  const star = moved.starsById.get("c7");
  check(
    "a saved position from the desktop chart is honoured for rendering",
    star?.x === 4321 && star?.y === -765
  );
  check(
    "...and so is its tap target, or the star and its hitbox would separate",
    moved.grid.targets.some((t) => t.id === "c7" && t.x === 4321 && t.y === -765)
  );

  // Tapping a person inside a cluster must open the person, not reframe the cluster.
  const nebula = index.nebulae[0];
  if (nebula) {
    const inside = index.stars.find(
      (s) => Math.hypot(s.x - nebula.x, s.y - nebula.y) < nebula.radius
    );
    if (inside) {
      const star = hitTest(
        index.grid,
        { x: inside.x, y: inside.y },
        GESTURE_TAP_TOLERANCE / 1,
        (t) => t.kind === "contact" || t.kind === "user"
      );
      check(
        "a star inside a nebula still resolves to the star",
        star?.id === inside.id,
        "the haze is hundreds of units wide and sits under its own members"
      );
    }
  }
}

// ---------------------------------------------------------------------------
console.log("\ngesture constants\n");
// ---------------------------------------------------------------------------
{
  check(
    "the tap target is at least Apple's 44pt minimum",
    GESTURE_TAP_TOLERANCE * 2 >= 44
  );
  check(
    "a tap tolerates less travel than it forgives, so a pan is never a tap",
    TAP_SLOP_PX < GESTURE_TAP_TOLERANCE
  );
  check(
    "the hit tolerance and the star's own pad agree",
    GESTURE_TAP_TOLERANCE + STAR_HIT_PAD > STAR_HIT_PAD
  );
}


// ---------------------------------------------------------------------------
console.log("\nthe phone never writes a layout it cannot make\n");
// ---------------------------------------------------------------------------
{
  /**
   * Structural, because the failure is silent and unrecoverable.
   *
   * The canvas has no drag — a two-pixel star is not something a finger can place — so
   * it reads saved positions and must never write them. The specific trap: `goHome`
   * clears the overrides AND persists the empty map, which on a phone would make an
   * innocuous Home tap permanently delete a sky the user arranged on a laptop, from the
   * one device that cannot rebuild it.
   */
  const mobile = readFileSync("src/components/graph/graph-canvas-mobile.tsx", "utf8");
  check(
    "the canvas renderer never imports the position writer",
    !/\bsavePositions\b/.test(mobile),
    "reading a hand-arranged sky is required; writing one from a phone is not possible"
  );
  check(
    "...nor the merge helper that feeds it",
    !/\bmergePositionsForStorage\b/.test(mobile)
  );

  const shell = readFileSync("src/components/graph/network-graph.tsx", "utf8");
  check(
    "and the shared Home button guards its clear-and-save on the renderer",
    /hadOverrides && !smallSky/.test(shell),
    "Home must reset the camera on the canvas, not wipe stored positions"
  );
}

console.log("\nAll graph-canvas smoke checks passed.\n");
process.exit(0);
