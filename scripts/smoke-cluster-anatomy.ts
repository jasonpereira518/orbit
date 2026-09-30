/**
 * The geometry of a cluster's parts: stars on rings, and disks arranged round a core.
 * Pure: no DB, no network.
 * Run: npx tsx scripts/smoke-cluster-anatomy.ts
 */
import { hashUnit } from "../src/lib/hash";
import {
  arrangeParts,
  RING_CAPACITY,
  RING_MAX_RADIUS,
  RING_MIN_RADIUS,
  RING_SPACING,
  ringCapacity,
  ringLayout,
  type PartDisk,
} from "../src/lib/graph/cluster-anatomy";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const minPair = (pts: Array<{ x: number; y: number }>) => {
  let m = Infinity;
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++) m = Math.min(m, Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y));
  return m;
};

console.log("\nRings");
{
  check("a ring of radius 124 holds 6", ringCapacity(124) === 6);
  check("the rings hold 43 stars at most", RING_CAPACITY === 43, String(RING_CAPACITY));
  for (const n of [1, 2, 3, 4, 5, 8, 14, 21, 30, 43]) {
    const { positions } = ringLayout(n, `s${n}`);
    check(`${n} stars are all placed`, positions.length === n, String(positions.length));
    if (n > 1) check(`…and keep ${RING_SPACING}px between centres (tightest ${minPair(positions).toFixed(1)})`, minPair(positions) >= RING_SPACING - 1e-6);
  }
  const big = ringLayout(100, "big");
  check("more than the rings hold places only what fits", big.positions.length === RING_CAPACITY);
  check("the outer radius is clamped", big.radius <= RING_MAX_RADIUS + 1e-9 && ringLayout(2, "x").radius >= RING_MIN_RADIUS - 1e-9);
  check("every star lies within the outer radius", ringLayout(30, "r").positions.every((p) => Math.hypot(p.x, p.y) <= ringLayout(30, "r").radius + 1e-6));
  const a = ringLayout(14, "same");
  const b = ringLayout(14, "same");
  const c = ringLayout(14, "other");
  check("deterministic", JSON.stringify(a) === JSON.stringify(b));
  check("the seed only rotates the ring", Math.abs(minPair(a.positions) - minPair(c.positions)) < 1e-6);
}

console.log("\nArranging parts");
{
  const disks = (n: number, seed: string): PartDisk[] =>
    Array.from({ length: n }, (_, i) => ({ key: `p${i}`, foot: 90 + Math.round(hashUnit(`${seed}${i}`, 3) * 400) }));
  const GAP = 64;
  let worst = Infinity;
  for (let trial = 0; trial < 60; trial++) {
    const petals = disks(2 + (trial % 8), `t${trial}`);
    const core: PartDisk | null = trial % 3 === 0 ? null : { key: "core", foot: 120 + (trial % 5) * 60 };
    const { centers, foot } = arrangeParts(core, petals, GAP, `seed${trial}`);
    const all = [...(core ? [core] : []), ...petals];
    check(`trial ${trial}: every part gets a centre`, all.every((d) => centers.has(d.key)));
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const A = centers.get(all[i].key)!;
        const B = centers.get(all[j].key)!;
        worst = Math.min(worst, Math.hypot(A.x - B.x, A.y - B.y) - all[i].foot - all[j].foot);
      }
      const P = centers.get(all[i].key)!;
      if (Math.hypot(P.x, P.y) + all[i].foot > foot + 1e-6) throw new Error(`trial ${trial}: footprint too small`);
    }
  }
  check(`disks keep the gap in every trial (tightest ${worst.toFixed(1)} ≥ ${GAP})`, worst >= GAP - 1e-6);

  const one = arrangeParts({ key: "core", foot: 150 }, [{ key: "p", foot: 200 }], GAP, "one");
  const d = Math.hypot(one.centers.get("p")!.x, one.centers.get("p")!.y);
  check("a single petal sits clear of the core", d >= 150 + 200 + GAP - 1e-6);
  const lone = arrangeParts(null, [{ key: "p", foot: 200 }], GAP, "lone");
  check("a lone part sits at the origin", lone.centers.get("p")!.x === 0 && lone.foot === 200);
  const none = arrangeParts({ key: "core", foot: 150 }, [], GAP, "none");
  check("a core alone is its own footprint", none.foot === 150);

  const petals = disks(6, "det");
  const x = arrangeParts({ key: "core", foot: 140 }, petals, GAP, "k");
  const y = arrangeParts({ key: "core", foot: 140 }, [...petals].reverse(), GAP, "k");
  check("deterministic and independent of input order", JSON.stringify([...x.centers].sort()) === JSON.stringify([...y.centers].sort()) && x.foot === y.foot);
}

console.log("\ncluster-anatomy: all checks passed");
process.exit(0);
