/**
 * Placing cluster footprints in the galaxy: no overlap, related clusters together, the biggest
 * near the middle, deterministic, and sliced so the main thread can breathe.
 * Pure: no DB, no network.
 * Run: npx tsx scripts/smoke-disk-placement.ts
 */
import { hashUnit } from "../src/lib/hash";
import type { AffinityEdge } from "../src/lib/constellation-affinity";
import {
  placeClusterDisks,
  type DiskInput,
  type DiskOptions,
  type DiskPlacement,
} from "../src/lib/graph/disk-placement";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const OPTS: DiskOptions = { sunClear: 180, gap: 104 };

function run(inputs: DiskInput[], affinity: AffinityEdge[], options: DiskOptions = OPTS) {
  const g = placeClusterDisks(inputs, affinity, options);
  let yields = 0;
  for (;;) {
    const step = g.next();
    if (step.done) return { placement: step.value as DiskPlacement, yields };
    yields += 1;
  }
}

const disks = (n: number, seed = "d"): DiskInput[] =>
  Array.from({ length: n }, (_, i) => {
    const foot = 80 + Math.round(hashUnit(`${seed}${i}`, 1) * 520);
    return { id: `${seed}${i}`, foot, size: foot };
  });

const dist = (p: DiskPlacement, a: string, b: string) => {
  const A = p.centers.get(a)!;
  const B = p.centers.get(b)!;
  return Math.hypot(A.x - B.x, A.y - B.y);
};

console.log("\nNo overlap");
{
  const inputs = disks(60);
  const chain: AffinityEdge[] = inputs.slice(1).map((d, i) => ({ a: inputs[i].id, b: d.id, weight: 0.6, kind: "alumni" as const }));
  const { placement, yields } = run(inputs, chain);
  let worst = Infinity;
  for (let i = 0; i < inputs.length; i++) {
    for (let j = i + 1; j < inputs.length; j++) {
      worst = Math.min(worst, dist(placement, inputs[i].id, inputs[j].id) - inputs[i].foot - inputs[j].foot);
    }
  }
  check(`every pair of disks keeps the gap (tightest ${worst.toFixed(1)} ≥ ${OPTS.gap})`, worst >= OPTS.gap - 1e-6);
  check(
    "no disk intrudes on the sun's clear zone",
    inputs.every((d) => {
      const c = placement.centers.get(d.id)!;
      return Math.hypot(c.x, c.y) >= OPTS.sunClear + d.foot - 1e-6;
    })
  );
  check("every disk is placed", placement.centers.size === inputs.length);
  const reach = Math.max(...inputs.map((d) => Math.hypot(placement.centers.get(d.id)!.x, placement.centers.get(d.id)!.y) + d.foot));
  check("diskRadius is the outermost reach", Math.abs(placement.diskRadius - reach) < 1e-6);
  check("the placement yields to the main thread", yields >= 5, `${yields} yields`);

  const again = run(inputs, chain).placement;
  check("deterministic", JSON.stringify([...again.centers]) === JSON.stringify([...placement.centers]));
  const shuffled = run([...inputs].reverse(), [...chain].reverse()).placement;
  check("independent of input order", JSON.stringify([...shuffled.centers].sort()) === JSON.stringify([...placement.centers].sort()));
}

console.log("\nLegal even with no relaxation");
{
  const inputs = Array.from({ length: 200 }, (_, i) => ({ id: `e${i}`, foot: 300, size: 5 }));
  const { placement } = run(inputs, [], { ...OPTS, iterations: 0 });
  let worst = Infinity;
  for (let i = 0; i < inputs.length; i++) {
    for (let j = i + 1; j < inputs.length; j++) worst = Math.min(worst, dist(placement, inputs[i].id, inputs[j].id) - 600);
  }
  check(`200 identical disks still clear each other (tightest ${worst.toFixed(1)})`, worst >= OPTS.gap - 1e-6);
}

console.log("\nNear = related");
{
  // 8 families of 5: strong pulls inside a family, none between.
  const inputs: DiskInput[] = [];
  const affinity: AffinityEdge[] = [];
  for (let f = 0; f < 8; f++) {
    const ids = Array.from({ length: 5 }, (_, k) => `f${f}k${k}`);
    ids.forEach((id) => inputs.push({ id, foot: 120 + Math.round(hashUnit(id, 2) * 80), size: 10 }));
    for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) affinity.push({ a: ids[i], b: ids[j], weight: 1, kind: "family" });
  }
  const { placement } = run(inputs, affinity);
  const within: number[] = [];
  const all: number[] = [];
  for (let i = 0; i < inputs.length; i++) {
    for (let j = i + 1; j < inputs.length; j++) {
      const d = dist(placement, inputs[i].id, inputs[j].id);
      all.push(d);
      if (inputs[i].id.slice(0, 2) === inputs[j].id.slice(0, 2)) within.push(d);
    }
  }
  all.sort((a, b) => a - b);
  const median = all[Math.floor(all.length / 2)];
  const mean = within.reduce((s, d) => s + d, 0) / within.length;
  check(`related disks sit closer than a typical pair (mean ${mean.toFixed(0)} < 0.6 × median ${median.toFixed(0)})`, mean < 0.6 * median);
}

console.log("\nThe biggest cluster anchors the middle");
{
  const inputs: DiskInput[] = [{ id: "big", foot: 400, size: 1000 }];
  for (let i = 0; i < 30; i++) inputs.push({ id: `s${i}`, foot: 90 + (i % 5) * 20, size: 3 });
  const { placement } = run(inputs, []);
  const c = placement.centers.get("big")!;
  const reach = Math.hypot(c.x, c.y) - 400;
  check(`its near edge is close to the sun (${reach.toFixed(0)} ≤ ${OPTS.sunClear + 2 * OPTS.gap})`, reach <= OPTS.sunClear + 2 * OPTS.gap);
}

console.log("\nA hub of strong non-family links");
{
  // 60 alumni ties, each heavier than a family link, on one cluster. Only family links skip the
  // partner cap; these are seated as usual, so the seed is not one 60-cluster search.
  const inputs = disks(200, "h");
  const hub = inputs[0].id;
  const links: AffinityEdge[] = inputs
    .slice(1, 61)
    .map((d) => ({ a: hub, b: d.id, weight: 1.5, kind: "alumni" as const }));
  const g = placeClusterDisks(inputs, links, OPTS);
  const t0 = performance.now();
  g.next();
  const seedMs = performance.now() - t0;
  console.log(`  seeding step took ${seedMs.toFixed(1)} ms`);
  check("the hub's non-family links do not all seat at once (seed step < 60 ms)", seedMs < 60, seedMs.toFixed(1));
  for (;;) if (g.next().done) break;
}

console.log("\nEdge cases");
{
  const empty = run([], []).placement;
  check("no disks: nothing placed, radius 0", empty.centers.size === 0 && empty.diskRadius === 0);
  const one = run([{ id: "solo", foot: 200, size: 9 }], []).placement;
  const c = one.centers.get("solo")!;
  check("a single disk sits just outside the sun's clear zone", Math.abs(Math.hypot(c.x, c.y) - (OPTS.sunClear + 200)) < 30);
  const stray = run([{ id: "a", foot: 100, size: 2 }], [{ a: "a", b: "ghost", weight: 1, kind: "family" }]).placement;
  check("an edge to an unknown cluster is ignored", stray.centers.size === 1);
}

console.log("\ndisk-placement: all checks passed");
process.exit(0);
