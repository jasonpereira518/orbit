/**
 * What the worker bitmaps draw, checked with a recording context: the galaxy backdrop.
 * Pure: no DOM. Run: npx tsx scripts/smoke-sky-bitmap-draw.ts
 */
import { galaxyBackdropData } from "../src/lib/graph/galaxy-dust";
import { drawSkyBitmap, skyBitmapSize, type SkyBitmapJob } from "../src/lib/graph/sky-bitmap-draw";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

/**
 * A context that only counts calls. Method calls go through `get`; assignments such as
 * `ctx.fillStyle = …` go through `set`, so drawing code must never READ a property off it.
 */
function recorder() {
  const calls = new Map<string, number>();
  const bump = (name: string) => calls.set(name, (calls.get(name) ?? 0) + 1);
  const gradient = { addColorStop: () => bump("addColorStop") };
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (_t, prop: string) => (..._a: unknown[]) => {
      bump(prop);
      return prop.startsWith("create") ? gradient : undefined;
    },
    set: () => true,
  });
  return { ctx: ctx as never, count: (n: string) => calls.get(n) ?? 0 };
}

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
check("it fills the dust in a handful of batches, not per dot", g.count("fill") >= 3 && g.count("fill") <= 12, String(g.count("fill")));
check("it clears first and resets alpha last", g.count("clearRect") === 1);

console.log("\nsky-bitmap-draw: all checks passed");
process.exit(0);
