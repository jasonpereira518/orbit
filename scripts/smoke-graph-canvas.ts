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
  fitStarsToPane,
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
import {
  PETAL_LABEL_MIN_ZOOM,
  STAR_HIT_PAD,
  petalLabelOffset,
  petalNodeGeometry,
  pinnedNameFloor,
  showPetalLabels,
  starSize,
  starSubtitle,
  starVisual,
  zoomRelief,
} from "../src/lib/graph/star-style";
import { buildHybridGraphLayout, type GraphContactInput } from "../src/lib/graph-layout";
import { clusterNameSize } from "../src/components/graph/graph-nodes";
import { buildSkyIndex } from "../src/components/graph/sky-canvas/sky-index";
import {
  PETAL_LABEL_CAP,
  drawSky,
  pickPetalLabels,
  worldBoxVisible,
  type SkyFrame,
} from "../src/components/graph/sky-canvas/draw-sky";
import {
  bakedGalaxyBitmap,
  clearSpriteCaches,
  galaxyBackdropBitmap,
  releaseGalaxyBitmaps,
} from "../src/components/graph/sky-canvas/sky-sprites";
import { galaxyBackdropData } from "../src/lib/graph/galaxy-dust";
import { anatomyFixture } from "./lib/anatomy-fixture";
import type { ClusterLabelData } from "../src/lib/graph-layout";
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
  const sunOnly = buildHybridGraphLayout([], "Test User").nodes;
  /** Layout nodes for bare contact stars at the given points — framing only reads positions. */
  const starsAt = (points: Record<string, Vec2>) => [
    ...sunOnly,
    ...Object.entries(points).map(
      ([id, position]) =>
        ({ id, type: "contact", position, data: {} }) as unknown as (typeof sunOnly)[number]
    ),
  ];
  const empty = computeSunExtents([], []);
  check(
    "computeSunExtents floors at 240 so an empty sky still frames",
    empty.maxAbsX === 240 && empty.maxAbsY === 240
  );

  const withOverride = computeSunExtents(starsAt({ someone: { x: 4000, y: 10 } }), []);
  check(
    "a star far from the sun expands the extents",
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

  // The phone opens on the stars' own bounds, clear of the chart's overlays — not
  // sun-centred like the DOM chart, which left a lopsided sky in the middle third of it.
  const pane = { width: 393, height: 700 };
  const inset = { x: 28, top: 112, bottom: 60 };
  const lopsided = { east: { x: 1400, y: 60 }, west: { x: -300, y: -220 }, south: { x: 200, y: 420 } };
  const phone = fitStarsToPane(starsAt(lopsided), pane, inset);
  const stars = [{ x: 0, y: 0 }, ...Object.values(lopsided)].map((p) => worldToScreen(p, phone));
  check(
    "fitStarsToPane keeps every star inside the pane's clear band",
    stars.every(
      (p) =>
        p.x >= inset.x - 1e-6 &&
        p.x <= pane.width - inset.x + 1e-6 &&
        p.y >= inset.top - 1e-6 &&
        p.y <= pane.height - inset.bottom + 1e-6
    ),
    stars.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")
  );
  const sunExtents = computeSunExtents(starsAt(lopsided), []);
  const sunK = zoomToFitSunCentered(sunExtents.maxAbsX, sunExtents.maxAbsY, pane.width, pane.height);
  check(
    "fitStarsToPane frames a lopsided sky larger than the sun-centred fit does",
    phone.k > sunK * 1.2,
    `phone k ${phone.k.toFixed(3)} vs sun-centred ${sunK.toFixed(3)}`
  );
  const lonely = fitStarsToPane(starsAt({}), pane, inset);
  check(
    "fitStarsToPane caps a sun-only sky at the default-framing ceiling",
    lonely.k === SKY_FIT_MAX_ZOOM && Number.isFinite(lonely.x) && Number.isFinite(lonely.y),
    `got ${lonely.k}`
  );
  // A few far-flung loose contacts must not shrink every constellation to a knot.
  const crowd: Record<string, Vec2> = {};
  const rng = makeRng(7);
  for (let i = 0; i < 60; i++) crowd[`c${i}`] = { x: (rng() - 0.5) * 800, y: (rng() - 0.5) * 800 };
  crowd.farEast = { x: 5000, y: 0 };
  crowd.farWest = { x: -4200, y: 30 };
  const crowded = fitStarsToPane(starsAt(crowd), pane, inset);
  const untrimmed = fitStarsToPane(starsAt({ farEast: crowd.farEast, farWest: crowd.farWest, core: { x: 400, y: 400 } }), pane, inset);
  const inBand = Object.values(crowd)
    .map((p) => worldToScreen(p, crowded))
    .filter((p) => p.x >= inset.x - 1e-6 && p.x <= pane.width - inset.x + 1e-6).length;
  check(
    "fitStarsToPane frames the crowd, not its two loners (and keeps 90% of stars in frame)",
    crowded.k > untrimmed.k * 4 && inBand >= Math.ceil(0.9 * 62),
    `k ${crowded.k.toFixed(3)} vs ${untrimmed.k.toFixed(3)}, ${inBand}/62 stars in the band`
  );
  const sunAt = worldToScreen({ x: 0, y: 0 }, crowded);
  check(
    "the trim never frames the sun out",
    sunAt.x >= 0 && sunAt.x <= pane.width && sunAt.y >= 0 && sunAt.y <= pane.height
  );
  // A small network (a few hundred world units across) must open larger than the
  // sun-centred fit, whose 240-unit floor pinned every such sky at one zoom.
  const small = { a: { x: 180, y: 40 }, b: { x: -120, y: -90 }, c: { x: 60, y: 150 } };
  const smallPhone = fitStarsToPane(starsAt(small), pane, inset);
  const smallSun = computeSunExtents(starsAt(small), []);
  check(
    "fitStarsToPane opens a small network closer than the sun-centred floor allows",
    smallPhone.k > zoomToFitSunCentered(smallSun.maxAbsX, smallSun.maxAbsY, pane.width, pane.height),
    `got ${smallPhone.k}`
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
  const extents = computeSunExtents(layout.nodes, []);

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
  // In a role cluster everyone does the same job, so the company is the news.
  check(
    "a role cluster's subtitle puts the company first",
    starSubtitle({ ...base, clusterKind: "role", company: "Stripe", title: "Engineer" }) === "Stripe" &&
      starSubtitle({ ...base, clusterKind: "company", company: "Stripe", title: "Engineer" }) === "Engineer" &&
      starSubtitle({ ...base, clusterKind: "role", company: null, title: "Engineer" }) === "Engineer" &&
      starSubtitle({ ...base, clusterKind: "role", company: "  ", title: null }) === null
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
  const index = buildSkyIndex(layout);

  check("every contact becomes a star", index.stars.length === 300);
  check("the sun is found", index.sun !== null && index.sun.x === 0 && index.sun.y === 0);
  check(
    "there are no orbit rings to draw",
    !("ringRadii" in index) && !layout.nodes.some((n) => (n.type as string) === "orbitRings")
  );
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
console.log("\nthe index carries the anatomy\n");
// ---------------------------------------------------------------------------
const anatomyLayout = buildHybridGraphLayout(anatomyFixture(), "Test User");
const anatomyIndex = buildSkyIndex(anatomyLayout);
{
  const neb = (name: string) => anatomyIndex.nebulae.find((n) => n.company === name)!;
  const lab = (name: string) => anatomyIndex.clusterLabels.find((l) => l.label === name)!;

  check("the index carries the layout's galaxy", anatomyIndex.galaxy === anatomyLayout.galaxy && anatomyIndex.galaxy !== undefined);
  check(
    "a layout without a galaxy builds an index without one",
    buildSkyIndex({ nodes: anatomyLayout.nodes, edges: anatomyLayout.edges }).galaxy === undefined
  );
  check(
    "Northwind is a petal nebula with its four parts",
    neb("Northwind").form === "petal" &&
      (neb("Northwind").parts ?? []).map((p) => p.key).join() === "core,petal:engineering,petal:design,petal:sales"
  );
  check(
    "the school is a ring nebula with one part",
    neb("Chapel Hill").form === "ring" && neb("Chapel Hill").parts?.length === 1
  );
  check("a role cluster is open and a pair is binary", neb("Engineers").form === "open" && neb("Duo Labs").form === "binary");
  check("forms without parts carry none", neb("Engineers").parts === undefined && neb("Duo Labs").parts === undefined);

  const nwNode = anatomyLayout.nodes.find(
    (n) => n.type === "clusterLabel" && (n.data as ClusterLabelData).label === "Northwind"
  )!;
  const nwData = nwNode.data as ClusterLabelData;
  const petals = lab("Northwind").petals ?? [];
  check("Northwind's label has a caption for the core and each petal", petals.length === 4, String(petals.length));
  check(
    "captions are finite world coordinates, in the layout's order",
    petals.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)) &&
      petals.map((p) => p.label).join() === "Leadership,Engineering,Design,Sales & BD" &&
      petals[0].role === "core" &&
      petals.slice(1).every((p) => p.role === "petal")
  );
  check(
    "a caption's top-centre is the label node's position less its anchor plus the petal's anchor",
    petals.every((p, i) => {
      const a = nwData.petalLabels![i].anchor;
      return close(p.x, nwNode.position.x - nwData.anchor!.x + a.x) && close(p.y, nwNode.position.y - nwData.anchor!.y + a.y);
    })
  );
  const starsOfPart = (key: string) =>
    anatomyIndex.stars.filter((s) => s.data.partKey === key);
  check(
    "every caption lies below every star of its part",
    petals.every((p) => {
      const stars = starsOfPart(p.key);
      return stars.length > 0 && stars.every((s) => p.y > s.y);
    })
  );
  check("the cluster name sits above the topmost star, the captions below the parts", petals.every((p) => p.y > lab("Northwind").y));
  check("only a split company has captions", lab("Chapel Hill").petals === undefined && lab("Duo Labs").petals === undefined && lab("Engineers").petals === undefined);
  check("the role cluster says how many companies", lab("Engineers").subtitle === "across 4 companies");
  check("no other cluster has a subtitle", ["Northwind", "Chapel Hill", "Duo Labs"].every((n) => lab(n).subtitle === undefined));

  const roleEdges = anatomyIndex.edges.filter((e) => anatomyLayout.edges.find((l) => l.source === e.source && l.target === e.target)?.data?.reason === "role");
  check("the role cluster draws lines", roleEdges.length > 0);
  check(
    "role lines are dotted, in screen px, and faint",
    roleEdges.every((e) => e.dash !== undefined && e.dash[0] === 2 && e.dash[1] === 5 && e.opacity === 0.35)
  );
  check("every other line is solid", anatomyIndex.edges.filter((e) => !roleEdges.includes(e)).every((e) => e.dash === undefined));
  check("there are solid lines to tell apart", anatomyIndex.edges.length > roleEdges.length);
}

// ---------------------------------------------------------------------------
console.log("\nthe phone canvas draws the galaxy\n");
// ---------------------------------------------------------------------------
{
  // A recording 2D context that accepts any call, plus a `document` whose canvases are
  // recording contexts: enough to run the real bake and the real frame without a browser.
  type Call = { name: string; args: unknown[] };
  const makeCtx = () => {
    const calls: Call[] = [];
    const assigned: Array<[string, unknown]> = [];
    const ctx = new Proxy({} as Record<string, unknown>, {
      get: (_t, prop: string) => (...args: unknown[]) => {
        calls.push({ name: prop, args });
        if (prop.startsWith("create")) return { addColorStop() {} };
        if (prop === "measureText") return { width: String(args[0]).length * 6 };
        return undefined;
      },
      set: (_t, prop: string, value) => {
        assigned.push([prop, value]);
        return true;
      },
    });
    return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, assigned };
  };
  type FakeCanvas = { width: number; height: number; rec: ReturnType<typeof makeCtx>; getContext: () => unknown };
  const made: FakeCanvas[] = [];
  (globalThis as unknown as { document: unknown }).document = {
    createElement: () => {
      const rec = makeCtx();
      const c: FakeCanvas = { width: 0, height: 0, rec, getContext: () => rec.ctx };
      made.push(c);
      return c;
    },
  };

  const galaxy = anatomyLayout.galaxy;
  const before = made.length;
  const bitmap = galaxyBackdropBitmap(galaxy)!;
  const box = galaxyBackdropData(galaxy);
  const baked = made[made.length - 1];
  check("the bake is one offscreen canvas of 1024 x 1024", made.length === before + 1 && baked.width === 1024 && baked.height === 1024);
  check("...covering the backdrop's box", bitmap.minX === box.minX && bitmap.minY === box.minY && bitmap.width === box.width && bitmap.height === box.height);
  const scale = 1024 / box.width;
  const t = baked.rec.calls.find((c) => c.name === "setTransform")!.args as number[];
  check(
    "...drawn at the backing scale size/width, origin on the box",
    close(t[0], scale) && close(t[3], scale) && close(t[4], -box.minX * scale) && close(t[5], -box.minY * scale)
  );
  check(
    "...by the same drawing the desktop worker runs (bulge gradient, dust fills)",
    baked.rec.calls.some((c) => c.name === "createRadialGradient") && baked.rec.calls.filter((c) => c.name === "fill").length > 0
  );
  check("asking again is free: the same galaxy gives the same bitmap", galaxyBackdropBitmap(galaxy) === bitmap && made.length === before + 1);
  const other = buildHybridGraphLayout(anatomyFixture(), "Test User");
  const otherBitmap = galaxyBackdropBitmap(other.galaxy)!;
  check("a new layout's galaxy is baked again", otherBitmap !== bitmap && made.length === before + 2);
  clearSpriteCaches();
  check("a theme flip keeps it: the backdrop has no theme colour in it", galaxyBackdropBitmap(galaxy) === bitmap && made.length === before + 2);
  const small = galaxyBackdropBitmap(galaxy, 512)!;
  check("a different size is its own bake", small.canvas.width === 512);
  releaseGalaxyBitmaps();
  // The live bitmap is the last one baked; older ones belong to superseded layouts and go at GC.
  check(
    "leaving the chart zeroes the live bitmap's backing store and forgets every bake",
    small.canvas.width === 0 && small.canvas.height === 0 &&
      bakedGalaxyBitmap(galaxy) === undefined && bakedGalaxyBitmap(galaxy, 512) === undefined && galaxyBackdropBitmap(galaxy) !== bitmap
  );
  // A browser that will not give a 2D context: the bake fails once and is not retried per frame.
  const realDocument = (globalThis as unknown as { document: unknown }).document;
  let refusedCanvases = 0;
  (globalThis as unknown as { document: unknown }).document = {
    createElement: () => {
      refusedCanvases += 1;
      return { width: 0, height: 0, getContext: () => null };
    },
  };
  const refused = buildHybridGraphLayout(anatomyFixture(), "Test User").galaxy;
  const failedTwice = [galaxyBackdropBitmap(refused), galaxyBackdropBitmap(refused)];
  check(
    "a failed bake is remembered for its galaxy, not retried every frame",
    failedTwice.every((b) => b === null) && refusedCanvases === 1 && bakedGalaxyBitmap(refused) === null,
    String(refusedCanvases)
  );
  (globalThis as unknown as { document: unknown }).document = realDocument;

  // The pure test for "is the box on screen".
  const screenWorld = { minX: 0, minY: 0, maxX: 400, maxY: 800 };
  check("a box over the view is visible", worldBoxVisible({ minX: -500, minY: -500, width: 1000, height: 1000 }, screenWorld));
  check("a box inside the view is visible", worldBoxVisible({ minX: 100, minY: 100, width: 50, height: 50 }, screenWorld));
  check("a box beside the view is not", !worldBoxVisible({ minX: 401, minY: 0, width: 100, height: 100 }, screenWorld));
  check("a box above the view is not", !worldBoxVisible({ minX: 0, minY: -300, width: 100, height: 100 }, screenWorld));

  // Driving the real frame.
  const idle = { hoveredId: null, selectedContactId: null, searchHitIds: new Set<string>(), searchDimActive: false };
  const frameAt = (camera: SkyFrame["camera"]): SkyFrame => ({
    index: anatomyIndex,
    camera,
    width: 390,
    height: 800,
    focus: idle,
    focusCluster: null,
    focusCompany: null,
    companyFilter: "all",
    sunSelected: false,
    background: null,
  });
  // The bake is deferred to an idle callback, captured here and run by hand.
  const idleQueue: Array<() => void> = [];
  const g = globalThis as unknown as { requestIdleCallback?: unknown; cancelIdleCallback?: unknown; setTimeout: unknown };
  g.requestIdleCallback = (cb: () => void) => idleQueue.push(cb);
  g.cancelIdleCallback = () => {};
  const runIdle = () => {
    while (idleQueue.length) idleQueue.shift()!();
  };
  let redraws = 0;
  const runFrame = (camera: SkyFrame["camera"]) => {
    const rec = makeCtx();
    drawSky(rec.ctx, { ...frameAt(camera), onBackdropBaked: () => (redraws += 1) });
    return rec;
  };
  releaseGalaxyBitmaps();
  const galaxyBlits = (rec: ReturnType<typeof makeCtx>) => {
    const bmp = bakedGalaxyBitmap(anatomyIndex.galaxy!);
    return bmp ? rec.calls.filter((c) => c.name === "drawImage" && c.args[0] === bmp.canvas) : [];
  };
  const bakesBefore = made.filter((c) => c.width === 1024).length;
  const firstFrame = runFrame({ x: 195, y: 400, k: 0.4 });
  check(
    "the first frame does not bake the galaxy: it is left for an idle moment",
    made.filter((c) => c.width === 1024).length === bakesBefore && bakedGalaxyBitmap(anatomyIndex.galaxy!) === undefined &&
      idleQueue.length === 1 && galaxyBlits(firstFrame).length === 0
  );
  runFrame({ x: 195, y: 400, k: 0.4 });
  check("...scheduled at most once for its galaxy, however many frames ask", idleQueue.length === 1 && redraws === 0);
  runIdle();
  check(
    "the idle bake fills the cache and asks for exactly one redraw",
    bakedGalaxyBitmap(anatomyIndex.galaxy!) !== undefined && made.filter((c) => c.width === 1024).length === bakesBefore + 1 && redraws === 1
  );

  const onScreen = runFrame({ x: 195, y: 400, k: 0.4 });
  check("a baked galaxy schedules nothing more", idleQueue.length === 0 && redraws === 1);
  check("a frame over the galaxy blits the backdrop exactly once", galaxyBlits(onScreen).length === 1, String(galaxyBlits(onScreen).length));
  const blit = galaxyBlits(onScreen)[0].args as number[];
  check(
    "...through worldToScreen: the box's corner and its size at the zoom",
    close(blit[1], box.minX * 0.4 + 195) && close(blit[2], box.minY * 0.4 + 400) && close(blit[3], box.width * 0.4)
  );
  const firstDraw = onScreen.calls.findIndex((c) => c.name === "drawImage");
  check("...and it is the first image drawn, under the haze", onScreen.calls[firstDraw].args[0] === bakedGalaxyBitmap(anatomyIndex.galaxy!)!.canvas);

  // Leaving the chart with a bake still pending: it never runs and never asks for a frame.
  releaseGalaxyBitmaps();
  runFrame({ x: 195, y: 400, k: 0.4 });
  releaseGalaxyBitmaps();
  runIdle();
  check("a bake pending when the chart unmounts is dropped", bakedGalaxyBitmap(anatomyIndex.galaxy!) === undefined && redraws === 1);

  // No requestIdleCallback (Safari): a zero-delay timeout instead, still outside the frame.
  delete g.requestIdleCallback;
  delete g.cancelIdleCallback;
  const realSetTimeout = g.setTimeout;
  const timeouts: Array<[() => void, number]> = [];
  g.setTimeout = (cb: () => void, ms: number) => timeouts.push([cb, ms]);
  const noIdle = runFrame({ x: 195, y: 400, k: 0.4 });
  g.setTimeout = realSetTimeout;
  check("without requestIdleCallback the bake waits on a timeout", timeouts.length === 1 && galaxyBlits(noIdle).length === 0);
  timeouts[0][0]();
  check("...and blits once it has run", galaxyBlits(runFrame({ x: 195, y: 400, k: 0.4 })).length === 1 && redraws === 2);
  g.requestIdleCallback = (cb: () => void) => idleQueue.push(cb);
  g.cancelIdleCallback = () => {};
  const away = runFrame({ x: 5e6, y: 5e6, k: 0.4 });
  check("a frame looking elsewhere draws no backdrop", galaxyBlits(away).length === 0);
  const noGalaxy = (() => {
    const rec = makeCtx();
    drawSky(rec.ctx, { ...frameAt({ x: 195, y: 400, k: 0.4 }), index: { ...anatomyIndex, galaxy: undefined } });
    return rec;
  })();
  check("an index without a galaxy draws none", galaxyBlits(noGalaxy).length === 0);

  // Washes by form: sprites blitted per nebula.
  const imagesOf = (rec: ReturnType<typeof makeCtx>) => rec.calls.filter((c) => c.name === "drawImage").length;
  const formCount = (form: string) => {
    const rec = makeCtx();
    drawSky(rec.ctx, {
      ...frameAt({ x: 195, y: 400, k: 0.05 }),
      index: { ...anatomyIndex, galaxy: undefined, nebulae: anatomyIndex.nebulae.filter((n) => n.form === form), stars: [], labelOrder: [], edges: [], sun: null, clusterLabels: [], grid: anatomyIndex.grid },
    });
    return imagesOf(rec);
  };
  check("a petal cluster blits its haze and one per part (1 + 4)", formCount("petal") === 5, String(formCount("petal")));
  check("a ring blits one annulus", formCount("ring") === 1, String(formCount("ring")));
  check("open and binary clusters are not washed", formCount("open") === 0 && formCount("binary") === 0);

  // Dashes: looking at the role cluster's own lines.
  const centredOn = (x: number, y: number, k: number) => ({ x: 195 - x * k, y: 400 - y * k, k });
  const roleEdge = anatomyIndex.edges.find((e) => e.dash)!;
  const dashCalls = (rec: ReturnType<typeof makeCtx>) => rec.calls.filter((c) => c.name === "setLineDash").map((c) => JSON.stringify(c.args[0]));
  const dashed = dashCalls(runFrame(centredOn(roleEdge.ax, roleEdge.ay, 0.4)));
  check("the role lines are dashed [2,5] in screen px, and the dash is reset after", dashed.includes("[2,5]") && dashed[dashed.indexOf("[2,5]") + 1] === "[]", dashed.join(" "));
  const zoomedDash = dashCalls(runFrame(centredOn(roleEdge.ax, roleEdge.ay, 1.5)));
  check("...whatever the zoom", zoomedDash.includes("[2,5]"));
  const solid = anatomyIndex.edges.find((e) => !e.dash)!;
  check(
    "a frame over solid lines only sets no dash",
    !dashCalls(runFrame(centredOn(solid.ax, solid.ay, 1.5))).includes("[2,5]")
  );

  // Captions and subtitles.
  const textsOf = (rec: ReturnType<typeof makeCtx>) => rec.calls.filter((c) => c.name === "strokeText").map((c) => String(c.args[0]));
  const nwNode = anatomyLayout.nodes.find((n) => n.type === "clusterLabel" && (n.data as ClusterLabelData).label === "Northwind")!;
  const nwData = nwNode.data as ClusterLabelData;
  const nwBox = nwData.box!;
  const nwCentre = { x: nwNode.position.x - nwData.anchor!.x + nwBox.width / 2, y: nwNode.position.y - nwData.anchor!.y + nwBox.height / 2 };
  const near = textsOf(runFrame(centredOn(nwCentre.x, nwCentre.y, PETAL_LABEL_MIN_ZOOM)));
  check("petal names are drawn in capitals once the camera is close enough", ["LEADERSHIP", "ENGINEERING", "DESIGN", "SALES & BD"].every((t) => near.includes(t)), near.join("|"));
  const far = textsOf(runFrame(centredOn(nwCentre.x, nwCentre.y, PETAL_LABEL_MIN_ZOOM - 0.01)));
  check("...and not before", !far.includes("ENGINEERING") && !far.includes("LEADERSHIP"));
  const engLabel = anatomyIndex.clusterLabels.find((l) => l.label === "Engineers")!;
  const engText = textsOf(runFrame(centredOn(engLabel.x, engLabel.y, 0.6)));
  check("the role cluster's subtitle is drawn under its name", engText.includes("Engineers") && engText.includes("across 4 companies"), engText.join("|"));
  check("...after the name", engText.indexOf("across 4 companies") > engText.indexOf("Engineers"));

  const busy = runFrame(centredOn(nwCentre.x, nwCentre.y, 0.3));
  check("no frame ever assigns shadowBlur", !busy.assigned.some(([k]) => k === "shadowBlur"));
  check(
    "captions are stroked for legibility before they are filled",
    busy.calls.findIndex((c) => c.name === "strokeText" && c.args[0] === "ENGINEERING") + 1 ===
      busy.calls.findIndex((c) => c.name === "fillText" && c.args[0] === "ENGINEERING")
  );
  check(
    "the core reads warm and the petals white",
    busy.assigned.some(([k, v]) => k === "fillStyle" && /255, 233, 194, 0.7/.test(String(v))) &&
      busy.assigned.some(([k, v]) => k === "fillStyle" && v === "rgba(255,255,255,0.55)")
  );

  // The cap and the order.
  const synth = Array.from({ length: 70 }, (_, i) => ({
    id: `l${i}`, x: 0, y: 0, label: `L${i}`, color: "#fff",
    petals: [{ key: "core", label: `P${i}`, role: "core" as const, x: i * 10, y: 0 }],
  }));
  const picked = pickPetalLabels(synth, { minX: -10, minY: -10, maxX: 10000, maxY: 10 }, PETAL_LABEL_CAP);
  check("at most PETAL_LABEL_CAP captions a frame", PETAL_LABEL_CAP === 40 && picked.length === 40);
  check("...nearest the view's centre first", picked[0].petal.label === "P69");
  check(
    "...the nearest forty, none farther than one left out",
    picked.map((p) => p.petal.label).sort().join() === Array.from({ length: 40 }, (_, i) => `P${30 + i}`).sort().join()
  );
  check("captions outside the view are not picked", pickPetalLabels(synth, { minX: -10, minY: -10, maxX: 95, maxY: 10 }, 40).length === 10);
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
console.log("\npetal labels\n");
// ---------------------------------------------------------------------------
{
  check("petal names wait for a zoom close enough to read them", PETAL_LABEL_MIN_ZOOM === 0.25);
  const off = petalLabelOffset({ x: 100, y: 48 }, { x: 140, y: 300 });
  check(
    "a petal label sits at its anchor minus the cluster name's anchor",
    off.dx === 40 && off.dy === 252,
    JSON.stringify(off)
  );
  check("shown when close, unsummarised and the name is shown", showPetalLabels({ zoomReached: true, summary: false, nameShown: true }));
  check("hidden below the zoom floor", !showPetalLabels({ zoomReached: false, summary: false, nameShown: true }));
  check("hidden in the summary view", !showPetalLabels({ zoomReached: true, summary: true, nameShown: true }));
  check("hidden when the cluster's name lost the collision pass", !showPetalLabels({ zoomReached: true, summary: false, nameShown: false }));

  const box = { width: 400, height: 800 };
  const anchor = { x: 100, y: 48 };
  check("a cluster without petal names keeps the name's own box", petalNodeGeometry({ showPetals: false, box, anchor }) === undefined);
  check("no box or anchor, no geometry", petalNodeGeometry({ showPetals: true }) === undefined);
  const g = petalNodeGeometry({ showPetals: true, box, anchor });
  check(
    "a petal cluster's node is the cluster box with its origin on the name's anchor",
    g?.width === 400 && g.height === 800 && g.originX === 0.25 && g.originY === 0.06,
    JSON.stringify(g)
  );

  check("a pinned name travels the whole box when there are no petal names", pinnedNameFloor(box, anchor, null, 1) === 800);
  check("a pinned name stops above the topmost petal name", pinnedNameFloor(box, anchor, 300, 2) === 292);
  check("a petal name right under the anchor never inverts the range", pinnedNameFloor(box, anchor, 50, 2) === 48);

  const plain = clusterNameSize("Engineers", false, 1);
  const withSub = clusterNameSize("Engineers", false, 1, "across 12 companies");
  check(
    "a subtitle adds a line to the name's box",
    withSub.height > plain.height,
    `${plain.height} -> ${withSub.height}`
  );
  check(
    "a subtitle longer than the name widens the box",
    withSub.width > plain.width,
    `${plain.width} -> ${withSub.width}`
  );
}

delete (globalThis as { document?: unknown }).document;
delete (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback;
delete (globalThis as { cancelIdleCallback?: unknown }).cancelIdleCallback;

console.log("\nAll graph-canvas smoke checks passed.\n");
process.exit(0);
