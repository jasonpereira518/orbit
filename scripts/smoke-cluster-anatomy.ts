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
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 14, 20, 21, 22, 30, 43, 44]) {
    const { positions } = ringLayout(n, `s${n}`);
    check(`${n} stars are placed (min of ${n} and ${RING_CAPACITY})`, positions.length === Math.min(n, RING_CAPACITY), String(positions.length));
    if (n > 1) check(`…and keep ${RING_SPACING}px between centres (tightest ${minPair(positions).toFixed(1)})`, minPair(positions) >= RING_SPACING - 1e-6);
  }
  check("bad counts place nothing", ringLayout(NaN, "n").positions.length === 0 && ringLayout(-5, "n").positions.length === 0);
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
  let worst = Infinity;
  const runTrial = (label: string, core: PartDisk | null, petals: PartDisk[], gap: number, seed: string) => {
    const { centers, foot } = arrangeParts(core, petals, gap, seed);
    const all = [...(core ? [core] : []), ...petals];
    check(`${label}: every part gets a centre`, all.every((d) => centers.has(d.key)));
    let tightest = Infinity;
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const A = centers.get(all[i].key)!;
        const B = centers.get(all[j].key)!;
        tightest = Math.min(tightest, Math.hypot(A.x - B.x, A.y - B.y) - all[i].foot - all[j].foot);
      }
      const P = centers.get(all[i].key)!;
      if (Math.hypot(P.x, P.y) + all[i].foot > foot + 1e-6) throw new Error(`${label}: footprint too small`);
    }
    check(`${label}: keeps the gap ${gap} (tightest ${tightest.toFixed(1)})`, tightest >= gap - 1e-6);
    worst = Math.min(worst, tightest - gap);
  };
  const GAP = 64;
  for (let trial = 0; trial < 60; trial++) {
    const petals = disks(2 + (trial % 8), `t${trial}`);
    const core: PartDisk | null = trial % 3 === 0 ? null : { key: "core", foot: 120 + (trial % 5) * 60 };
    runTrial(`trial ${trial}`, core, petals, GAP, `seed${trial}`);
  }
  const tiny = (n: number): PartDisk[] =>
    Array.from({ length: n }, (_, i) => ({ key: `t${i}`, foot: 60 + i * 5 }));
  const giant: PartDisk = { key: "giant", foot: 900 };
  runTrial("one giant among tiny, no core", null, [giant, ...tiny(6)], GAP, "g1");
  runTrial("one giant among tiny, with core", { key: "core", foot: 150 }, [giant, ...tiny(6)], GAP, "g2");
  const equal = (n: number): PartDisk[] => Array.from({ length: n }, (_, i) => ({ key: `e${i}`, foot: 140 }));
  runTrial("equal feet, no core", null, equal(7), GAP, "e1");
  runTrial("equal feet, with core", { key: "core", foot: 140 }, equal(7), GAP, "e2");
  runTrial("a larger gap (200), no core", null, disks(6, "lg"), 200, "lg1");
  runTrial("a larger gap (200), with core", { key: "core", foot: 200 }, disks(6, "lg"), 200, "lg2");
  runTrial("the maximum 12 petals, no core", null, disks(12, "m"), GAP, "m1");
  runTrial("the maximum 12 petals, with core", { key: "core", foot: 200 }, disks(12, "m"), GAP, "m2");
  check(`disks keep the gap in every trial (tightest excess ${worst.toFixed(1)} ≥ 0)`, worst >= -1e-6);

  const bad = arrangeParts({ key: "core", foot: NaN }, [{ key: "p", foot: -20 }, { key: "q", foot: Infinity }], GAP, "bad");
  check("bad feet are treated as 0", [...bad.centers.values()].every((c) => Number.isFinite(c.x) && Number.isFinite(c.y)) && Number.isFinite(bad.foot));

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
