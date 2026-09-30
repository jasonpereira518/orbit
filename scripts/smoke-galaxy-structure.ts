/**
 * The galaxy's shape data — the bright core, the disk's edge and the dust filaments that
 * trace the strongest relatedness chains. Pure: no DB, no network.
 * Run: npx tsx scripts/smoke-galaxy-structure.ts
 */
import type { AffinityEdge } from "../src/lib/constellation-affinity";
import { buildGalaxyStructure, FILAMENT_POINTS, MAX_FILAMENTS } from "../src/lib/graph/galaxy-structure";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const centers = new Map([
  ["A", { x: 0, y: -400 }],
  ["B", { x: 300, y: -300 }],
  ["C", { x: 500, y: 0 }],
  ["D", { x: 700, y: 300 }],
]);
const OPTS = { sunClear: 180, diskRadius: 1000 };
const edge = (a: string, b: string, weight: number): AffinityEdge => ({ a, b, weight });

console.log("\nFilaments");
{
  const g = buildGalaxyStructure(
    centers,
    [edge("A", "B", 1), edge("B", "C", 0.9), edge("A", "C", 0.8), edge("C", "D", 0.7)],
    OPTS
  );
  check("the spanning tree comes first, strongest links first", g.filaments.slice(0, 3).map((f) => `${f.from}${f.to}`).join() === "AB,BC,CD");
  check("a cycle-closing link follows as an extra", g.filaments.length === 4 && `${g.filaments[3].from}${g.filaments[3].to}` === "AC");
  const f = g.filaments[0];
  check("a path has the fixed number of points", f.path.length === FILAMENT_POINTS);
  check("it starts and ends on the two clusters", f.path[0].x === 0 && f.path[0].y === -400 && f.path[FILAMENT_POINTS - 1].x === 300 && f.path[FILAMENT_POINTS - 1].y === -300);
  const mid = f.path[Math.floor(FILAMENT_POINTS / 2)];
  const straightMid = { x: 150, y: -350 };
  check("it bows away from the straight line", Math.hypot(mid.x - straightMid.x, mid.y - straightMid.y) > 5);
  check("points are whole numbers", g.filaments.every((fl) => fl.path.every((p) => Number.isInteger(p.x) && Number.isInteger(p.y))));
  check("weight is carried through", g.filaments[0].weight === 1);
}

console.log("\nCore and disk");
{
  const g = buildGalaxyStructure(centers, [], OPTS);
  check("disk radius is the placement's", g.diskRadius === 1000);
  check("the core is a fraction of the disk, never inside the sun's clear zone", g.coreRadius >= 180 && g.coreRadius <= g.diskRadius);
  const none = buildGalaxyStructure(new Map(), [], { sunClear: 180, diskRadius: 0 });
  check("an empty sky still has a sane core", none.coreRadius === 180 && none.filaments.length === 0);
}

console.log("\nRobustness");
{
  const g = buildGalaxyStructure(centers, [edge("A", "ghost", 1), edge("A", "B", 0.5)], OPTS);
  check("links to unknown clusters are skipped", g.filaments.length === 1);
  const big = new Map(Array.from({ length: 900 }, (_, i) => [`n${i}`, { x: i * 10, y: (i % 7) * 30 }] as const));
  const links: AffinityEdge[] = [];
  for (let i = 0; i < 899; i++) links.push(edge(`n${i}`, `n${i + 1}`, 1 - i / 1000));
  for (let i = 0; i < 890; i++) links.push(edge(`n${i}`, `n${i + 9}`, 0.05 + (i % 10) / 100));
  const capped = buildGalaxyStructure(big, links, { sunClear: 180, diskRadius: 9000 });
  check("filaments are capped", capped.filaments.length === MAX_FILAMENTS, String(capped.filaments.length));
  const again = buildGalaxyStructure(big, links, { sunClear: 180, diskRadius: 9000 });
  check("deterministic", JSON.stringify(again) === JSON.stringify(capped));
}

console.log("\ngalaxy-structure: all checks passed");
process.exit(0);
