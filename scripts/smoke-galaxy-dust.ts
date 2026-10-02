/**
 * The galaxy backdrop's raw material: dust and dark lanes along the filaments.
 * Pure: no DOM. Run: npx tsx scripts/smoke-galaxy-dust.ts
 */
import { createHash } from "node:crypto";
import { galaxyBackdropData } from "../src/lib/graph/galaxy-dust";
import type { GalaxyStructure } from "../src/lib/graph/galaxy-structure";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const path = (x0: number, y0: number, x1: number, y1: number) =>
  Array.from({ length: 6 }, (_, i) => ({ x: x0 + ((x1 - x0) * i) / 5, y: y0 + ((y1 - y0) * i) / 5 + (i % 2 ? 12 : 0) }));
const filaments = Array.from({ length: 30 }, (_, i) => ({
  from: `a${i}`, to: `b${i}`, weight: 0.1 + (i % 7) * 0.3,
  path: path(-2000 + i * 100, -1500 + i * 60, 1500 - i * 40, 1800 - i * 90),
}));
const galaxy: GalaxyStructure = { coreRadius: 600, diskRadius: 5000, filaments };
const d = galaxyBackdropData(galaxy);

console.log("\nBox");
check("a square about the origin", d.minX === d.minY && d.width === d.height && d.minX === -d.width / 2, `${d.minX} ${d.width}`);
check("wide enough to hold the disk", d.width / 2 >= 5000 * 1.15 - 1e-9);
console.log("\nDust");
check("every array has the same length", d.dust.x.length === d.dust.y.length && d.dust.x.length === d.dust.alpha.length && d.dust.x.length === d.dust.radius.length);
check("there is dust for every filament (≥ 14 each)", d.dust.x.length >= 30 * 14, String(d.dust.x.length));
check("…and a bounded amount (≤ 70 each)", d.dust.x.length <= 30 * 70);
check("every point lies inside the box", d.dust.x.every((x, i) => x >= d.minX && x <= d.minX + d.width && d.dust.y[i] >= d.minY && d.dust.y[i] <= d.minY + d.height));
check("alphas are faint and positive", d.dust.alpha.every((a) => a > 0 && a <= 0.25));
check("radii are small but visible", d.dust.radius.every((r) => r >= 1 && r <= 8));
console.log("\nLanes");
check("at most 14 lanes, from the heaviest filaments", d.dust.lanes.length === 14 && d.dust.lanes.every((l) => l.path.length === 6 && l.width > 0 && l.alpha > 0 && l.alpha <= 0.35));
console.log("\nStability");
check("deterministic", JSON.stringify(galaxyBackdropData(galaxy)) === JSON.stringify(d));
// Pinned from the per-dot `hashUnit` version: hashing each filament's seed once (hashUnitStream)
// is an optimisation only, so the sky must come out byte for byte the same.
const fingerprint = createHash("sha256").update(JSON.stringify(d)).digest("hex").slice(0, 16);
check("byte-identical to the pinned fingerprint", fingerprint === "9b4551b414ee1537", fingerprint);
// Equal weights and equal `from` force the lane tie-break down to `to`.
const tied = [
  ...filaments,
  ...["z", "y", "x"].map((to) => ({ from: "a0", to, weight: 9, path: path(-900, -700, 900, 800) })),
];
const tiedGalaxy: GalaxyStructure = { ...galaxy, filaments: tied };
const tiedData = galaxyBackdropData(tiedGalaxy);
check(
  "independent of filament order (whole dust, lanes included)",
  JSON.stringify(galaxyBackdropData({ ...tiedGalaxy, filaments: [...tied].reverse() }).dust.lanes) === JSON.stringify(tiedData.dust.lanes) &&
    JSON.stringify(tiedData.dust.lanes.map((l) => l.path)) !== JSON.stringify(d.dust.lanes.map((l) => l.path))
);
check("…and so are the dust arrays, point for point", JSON.stringify(galaxyBackdropData({ ...tiedGalaxy, filaments: [...tied].reverse() }).dust) === JSON.stringify(tiedData.dust));
console.log("\nClamping");
const far: GalaxyStructure = {
  coreRadius: 180, diskRadius: 0,
  filaments: [{ from: "p", to: "q", weight: 1, path: path(-9000, -9000, 9000, 9000) }],
};
const farData = galaxyBackdropData(far);
const farHalf = farData.width / 2;
check("a filament past the box is clamped onto its edge", farData.dust.x.some((x) => Math.abs(x) === farHalf) || farData.dust.y.some((y) => Math.abs(y) === farHalf));
check("…and nothing escapes the box", farData.dust.x.every((x) => Math.abs(x) <= farHalf) && farData.dust.y.every((y) => Math.abs(y) <= farHalf));
const empty = galaxyBackdropData({ coreRadius: 180, diskRadius: 0, filaments: [] });
check("an empty galaxy still has a box and no dust", empty.dust.x.length === 0 && empty.dust.lanes.length === 0 && empty.width >= 800);
console.log("\ngalaxy-dust: all checks passed");
process.exit(0);
