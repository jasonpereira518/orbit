/**
 * Asserts that the how-it-works globe stays inside its camera's frustum at any window size.
 *
 * The scene in `earth-globe.tsx` is orthographic and its world units ARE the sticky
 * frame's CSS pixels, so a sphere's half-depth is literally the radius `earthAt` hands
 * out. The finale grows that to `maxEarthRadius` — 0.53x the frame's diagonal — which on
 * a big monitor is well over a thousand pixels. The camera used to be parked at a
 * constant z of 1000, so past a diagonal of ~1887px (about 1644x925 and up) the near
 * plane cut straight through the globe and left a hole punched through the middle of it
 * during the zoom, growing with the window. Nothing failed: the render is perfectly
 * valid, it just has the front of the planet clipped away.
 *
 * Two things are checked, because the fix rests on both:
 *
 *   1. `maxEarthRadius` really is the largest radius `earthAt` can return. The camera is
 *      sized off it, so if retiming a beat ever pushed a pose past it, the clipping would
 *      come straight back.
 *   2. The camera `earthCameraStandoff` describes contains the whole sphere, projected
 *      with three's own matrices rather than by re-deriving the frustum here.
 *
 * Run: npx tsx scripts/smoke-earth-camera.ts
 */
import { OrthographicCamera, Vector3 } from "three";
import {
  earthAt,
  earthCameraStandoff,
  maxEarthRadius,
  RING_RATIO,
  stageSize,
  type Geom,
} from "../src/components/landing/how-it-works-choreography";

/** Mirrors the `near` in `earth-globe.tsx`. The standoff leaves a couple of hundred
 * pixels of slack, so this assertion does not hinge on the exact value. */
const CAMERA_NEAR = 0.1;

/** Sticky-frame sizes, in CSS px. The frame is the full window width by one viewport
 * height, so these are real windows: a laptop, a maximized 1080p window, a 27" display,
 * an ultrawide, and a 6K panel — the large end is the whole point. */
const FRAMES: Array<[number, number]> = [
  [1024, 640],
  [1280, 800],
  [1440, 900],
  [1600, 1000],
  [1920, 1080],
  [2560, 1440],
  [3440, 1440],
  [3840, 2160],
  [6016, 3384],
];

function geomFor(w: number, h: number): Geom {
  return { w, h, ringR: stageSize(w, h) * RING_RATIO };
}

/** The largest radius the choreography actually asks for, swept across the whole scene. */
function observedMaxRadius(g: Geom) {
  let max = 0;
  for (let i = 0; i <= 1000; i++) {
    const p = i / 1000;
    for (let j = 0; j <= 20; j++) {
      max = Math.max(max, earthAt(p, g, j / 20).r);
    }
  }
  return max;
}

function main() {
  let failures = 0;

  console.log("maxEarthRadius bounds every pose earthAt can produce:\n");
  for (const [w, h] of FRAMES) {
    const g = geomFor(w, h);
    const claimed = maxEarthRadius(w, h);
    const observed = observedMaxRadius(g);
    const ok = observed <= claimed + 1e-6;
    console.log(
      `  ${ok ? "ok  " : "FAIL"} ${`${w}x${h}`.padEnd(11)} widest pose ${observed
        .toFixed(0)
        .padStart(5)}px  <=  maxEarthRadius ${claimed.toFixed(0).padStart(5)}px`
    );
    if (!ok) failures++;
  }

  console.log("\nthe whole sphere sits inside the camera frustum:\n");
  for (const [w, h] of FRAMES) {
    const r = maxEarthRadius(w, h);
    const standoff = earthCameraStandoff(w, h);

    // The camera exactly as `measure()` builds it.
    const camera = new OrthographicCamera(
      -w / 2,
      w / 2,
      h / 2,
      -h / 2,
      CAMERA_NEAR,
      standoff * 2
    );
    camera.position.z = standoff;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);

    // The globe sits on the scene plane (root.position.z is always 0) with the trail one
    // unit behind it, so these three points bracket everything the camera has to hold.
    const probes: Array<[string, number]> = [
      ["front of globe", r],
      ["back of globe", -r],
      ["trail", -1],
    ];

    const depths = probes.map(
      ([, z]) => new Vector3(0, 0, z).project(camera).z
    );
    const clipped = probes.filter((_, i) => {
      const z = depths[i]!;
      return z < -1 || z > 1;
    });
    const ok = clipped.length === 0;
    console.log(
      `  ${ok ? "ok  " : "FAIL"} ${`${w}x${h}`.padEnd(11)} r=${r
        .toFixed(0)
        .padStart(5)}px  camera z=${standoff.toFixed(0).padStart(5)}  ndc z ${depths
        .map((z) => z.toFixed(2).padStart(6))
        .join(" ")}` + (ok ? "" : `  <- ${clipped.map(([n]) => n).join(", ")} clipped`)
    );
    if (!ok) failures++;
  }

  if (failures > 0) {
    console.error(
      `\nFAILED: ${failures} check(s). The globe is being clipped by its own camera — ` +
        `see earthCameraStandoff() in src/components/landing/how-it-works-choreography.ts.`
    );
    process.exit(1);
  }
  console.log("\nThe globe clears the near and far planes at every window size.");
}

main();
