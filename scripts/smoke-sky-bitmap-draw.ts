/**
 * What the worker bitmaps draw, checked with a recording context: the galaxy backdrop, and a
 * different wash per cluster form.
 * Pure: no DOM. Run: npx tsx scripts/smoke-sky-bitmap-draw.ts
 */
import { buildHybridGraphLayout } from "../src/lib/graph-layout";
import { galaxyBackdropData, galaxyBackdropZoom } from "../src/lib/graph/galaxy-dust";
import { DUST_CHUNK, drawSkyBitmap, skyBitmapSize, type SkyBitmapJob } from "../src/lib/graph/sky-bitmap-draw";
import { buildSyntheticGraphPayload } from "../src/lib/graph/synthetic-network";
import type { NebulaWashCluster, NebulaWashData } from "../src/components/graph/graph-nodes";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

/**
 * A context that records what is called and what is assigned. Method calls go through `get`;
 * assignments such as `ctx.fillStyle = …` go through `set` and are logged in order, so drawing
 * code must never READ a property off it.
 */
function recorder() {
  const calls = new Map<string, number>();
  const assigned: Array<[string, unknown]> = [];
  const stops: Array<Array<[number, string]>> = [];
  const bump = (name: string) => calls.set(name, (calls.get(name) ?? 0) + 1);
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (_t, prop: string) => () => {
      bump(prop);
      if (!prop.startsWith("create")) return undefined;
      const mine: Array<[number, string]> = [];
      stops.push(mine);
      return { addColorStop: (at: number, color: string) => mine.push([at, color]) };
    },
    set: (_t, prop: string, value) => {
      assigned.push([prop, value]);
      return true;
    },
  });
  return { ctx: ctx as never, count: (n: string) => calls.get(n) ?? 0, assigned, stops };
}

console.log("\nWashes by form");
const washCluster = (over: Partial<NebulaWashCluster>): NebulaWashCluster => ({
  seed: "Acme", color: "#3aa3ff", x: 0, y: 0, radius: 300, opacity: 1, ...over,
});
const washData = (clusters: NebulaWashCluster[]): NebulaWashData => ({
  kind: "nebulaWash", clusters, minX: -2000, minY: -2000, width: 4000, height: 4000,
});
const washJob = (clusters: NebulaWashCluster[]): SkyBitmapJob => ({ kind: "wash", data: washData(clusters), zoom: 1, dpr: 1, maxBackingPx: 2048 });
const gradientsFor = (clusters: NebulaWashCluster[]) => {
  const r = recorder();
  drawSkyBitmap(r.ctx, washJob(clusters));
  return r.count("createRadialGradient");
};
const parts = [
  { key: "core", role: "core" as const, x: 0, y: 0, radius: 150 },
  { key: "petal:engineering", role: "petal" as const, x: 400, y: 0, radius: 200 },
  { key: "petal:design", role: "petal" as const, x: -400, y: 0, radius: 200 },
];
const figure = gradientsFor([washCluster({})]);
check("a figure keeps its five lobes", figure === 5, String(figure));
check("a cluster with no form is a figure", gradientsFor([washCluster({ form: "figure" })]) === figure);
check("a petal cluster adds five lobes per part", gradientsFor([washCluster({ form: "petal", parts })]) === 5 + 5 * parts.length);
check("a ring is one annulus glow", gradientsFor([washCluster({ form: "ring", parts: [{ key: "main", role: "main", x: 0, y: 0, radius: 200 }] })]) === 1);
check("a role cluster has no shared wash", gradientsFor([washCluster({ form: "open" })]) === 0);
check("a binary has no wash", gradientsFor([washCluster({ form: "binary" })]) === 0);
check("a ring with no parts still draws something sane", gradientsFor([washCluster({ form: "ring" })]) === 1);

console.log("\nGalaxy backdrop");
const galaxy = galaxyBackdropData({
  coreRadius: 400, diskRadius: 4000,
  filaments: Array.from({ length: 20 }, (_, i) => ({ from: `a${i}`, to: `b${i}`, weight: 1, path: Array.from({ length: 6 }, (_, k) => ({ x: -1500 + k * 600, y: -800 + i * 80 + k * 30 })) })),
});
const gjob: SkyBitmapJob = { kind: "galaxy", data: galaxy, zoom: 0.1, dpr: 2, maxBackingPx: 2048 };
const size = skyBitmapSize(gjob);
check("the backing store respects the cap", size.width <= 2048 && size.height <= 2048 && size.scale > 0);
const g = recorder();
drawSkyBitmap(g.ctx, gjob);
check("it paints the disk haze and the bulge (two gradients)", g.count("createRadialGradient") === 2, String(g.count("createRadialGradient")));
check("it strokes the dark lanes", g.count("stroke") === galaxy.dust.lanes.length);
// Two fills for the disk and the bulge, then each alpha band in chunks of DUST_CHUNK dots.
const bandCounts = [0, 0, 0, 0, 0, 0];
for (const a of galaxy.dust.alpha) bandCounts[Math.min(5, Math.floor(a / 0.04))] += 1;
const expectedFills = 2 + bandCounts.reduce((sum, n) => sum + Math.ceil(n / DUST_CHUNK), 0);
check("it fills the dust in chunks, not per dot and not per band", g.count("fill") === expectedFills, `${g.count("fill")} vs ${expectedFills}`);
check("it clears first", g.count("clearRect") === 1);
const alphas = g.assigned.filter(([k]) => k === "globalAlpha");
check("it resets alpha last", alphas.length > 0 && alphas[alphas.length - 1][1] === 1);
const rgb = (c: string) => c.replace(/,[^,)]*\)$/, "");
const alphaOf = (c: string) => Number(c.match(/,([^,)]*)\)$/)?.[1]);
check(
  "both gradients fade to their own colour (the last stop) at zero alpha",
  g.stops.length === 2 &&
    g.stops.every((s) => {
      // The last stop is the colour of the stop before it, at zero alpha: never black.
      const last = s[s.length - 1][1];
      const before = s[s.length - 2][1];
      return alphaOf(last) === 0 && rgb(before) === rgb(last);
    }),
  JSON.stringify(g.stops)
);

console.log("\nRedraws");
// Every quarter-octave zoom step the node can see, from the camera's minimum (0.05) to its maximum (2.4).
const zooms = Array.from({ length: 23 }, (_, i) => 0.05 * Math.pow(2, i / 4));
const synthetic = (n: number) => galaxyBackdropData(buildHybridGraphLayout(buildSyntheticGraphPayload(n).contacts, "You").galaxy);
/** Distinct jobs (effective zoom) and distinct bitmaps (backing size + min dot radius) across the steps. */
function draws(d: ReturnType<typeof galaxyBackdropData>, dpr: number) {
  const jobs = new Set<number>();
  const pixels = new Set<string>();
  for (const z of zooms) {
    const zoom = galaxyBackdropZoom(z, d.width, dpr, 2048);
    jobs.add(zoom);
    const { scale, width } = skyBitmapSize({ kind: "galaxy", data: d, zoom, dpr, maxBackingPx: 2048 });
    pixels.add(`${width}|${scale}`);
  }
  return { jobs: jobs.size, pixels: pixels.size, floor: 2048 / (d.width * dpr) };
}
for (const n of [1000, 2500, 10000]) {
  const d = synthetic(n);
  for (const dpr of [1, 2]) {
    const r = draws(d, dpr);
    const below = zooms.filter((z) => z < r.floor).length;
    check(`${n} contacts at dpr ${dpr}: a draw per step below the cap's zoom (${below}), then one`, r.jobs === below + 1 && r.pixels === r.jobs, JSON.stringify(r));
    if (n === 10000) check("…and at 10,000 contacts that is exactly one draw ever", r.jobs === 1);
  }
}
const tiny = galaxyBackdropData({ coreRadius: 180, diskRadius: 500, filaments: [] });
check("a tiny galaxy still follows the zoom", draws(tiny, 1).jobs > 1 && draws(tiny, 2).jobs > 1);

console.log("\nsky-bitmap-draw: all checks passed");
process.exit(0);
