/**
 * Placing cluster footprints in the galaxy: no overlap, related clusters together, the biggest
 * near the middle, deterministic, and sliced so the main thread can breathe.
 * Pure: no DB, no network.
 * Run: npx tsx scripts/smoke-disk-placement.ts
 */
import { hashUnit } from "../src/lib/hash";
import type { AffinityEdge } from "../src/lib/constellation-affinity";
import {
  circularize,
  MAX_CIRCULARIZE_STRETCH,
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

console.log("\nA small galaxy stays tight");
{
  // 40 disks, footprints 90-330, size proportional to footprint, a ring of family links among the
  // 8 smallest. The shape of the result, not its exact coordinates: how much of the galaxy's disk
  // the footprints fill (loose = the relax step and the legalize search are not pulling inward),
  // and whether the biggest disk anchors the middle.
  // Measured with the current constants: density 0.352, biggest disk's near edge 251 px from the
  // sun (its ring, seed "g"). Other seeds of the same shape give density 0.26-0.38.
  const inputs: DiskInput[] = Array.from({ length: 40 }, (_, i) => {
    const foot = 90 + Math.round(hashUnit(`g${i}`, 1) * 240);
    return { id: `g${i}`, foot, size: foot };
  });
  const smallest = [...inputs].sort((a, b) => a.foot - b.foot).slice(0, 8);
  const ring: AffinityEdge[] = smallest.map((d, i) => ({
    a: d.id,
    b: smallest[(i + 1) % smallest.length].id,
    weight: 1,
    kind: "family" as const,
  }));
  const { placement } = run(inputs, ring);
  const density = inputs.reduce((s, d) => s + d.foot * d.foot, 0) / (placement.diskRadius * placement.diskRadius);
  check(`the footprints fill the disk (density ${density.toFixed(3)} >= 0.30)`, density >= 0.3);
  const biggest = inputs.reduce((a, b) => (b.foot > a.foot ? b : a));
  const c = placement.centers.get(biggest.id)!;
  const edge = Math.hypot(c.x, c.y) - biggest.foot;
  const limit = OPTS.sunClear + 3 * OPTS.gap;
  check(`the biggest disk's near edge is within the sun's clear zone + 3 gaps (${edge.toFixed(0)} <= ${limit})`, edge <= limit);
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

// ---- circularize: a strip becomes round, and nothing that was clear is brought together -------
{
  const ids = Array.from({ length: 12 }, (_, i) => `c${i}`);
  const foot = ids.map(() => 100);
  // A tall strip: x narrow, y long.
  const xs = ids.map((_, i) => (i % 2 === 0 ? 220 : -220));
  const ys = ids.map((_, i) => (i - 5.5) * 110);
  const ox = [...xs];
  const oy = [...ys];
  circularize(xs, ys, foot, ids);
  const spread = (a: number[], b: number[]) => {
    let sxx = 0, syy = 0, sxy = 0;
    for (let i = 0; i < a.length; i++) { sxx += a[i] * a[i]; syy += b[i] * b[i]; sxy += a[i] * b[i]; }
    const m = (sxx + syy) / 2, d = Math.hypot((sxx - syy) / 2, sxy);
    return Math.sqrt((m + d) / (m - d));
  };
  const before = spread(ox, oy);
  const after = spread(xs, ys);
  check("a strip comes out round (axis ratio near 1)", before > 1.5 && after < 1.1, `${before.toFixed(2)} → ${after.toFixed(2)}`);
  let closer = 0;
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++)
      if (Math.hypot(xs[i] - xs[j], ys[i] - ys[j]) < Math.hypot(ox[i] - ox[j], oy[i] - oy[j]) - 1e-9) closer++;
  check("no pair of disks ends up closer (so nothing overlaps that did not)", closer === 0);
  check("nothing moves toward the sun", ids.every((_, i) => Math.hypot(xs[i], ys[i]) >= Math.hypot(ox[i], oy[i]) - 1e-9));
  // Order independence.
  const perm = ids.map((_, i) => (i * 5) % ids.length);
  const px = perm.map((k) => ox[k]), py = perm.map((k) => oy[k]);
  circularize(px, py, perm.map((k) => foot[k]), perm.map((k) => ids[k]));
  check("the result does not depend on the order the disks are listed in", perm.every((k, i) => Math.abs(px[i] - xs[k]) < 1e-6 && Math.abs(py[i] - ys[k]) < 1e-6));
  // The stretch is capped, and a round galaxy is left alone.
  const sx = ids.map((_, i) => (i % 2 ? 10 : -10)), sy = ids.map((_, i) => (i - 5.5) * 500);
  const sBefore = spread(sx, sy);
  circularize(sx, sy, foot, ids);
  const sAfter = spread(sx, sy);
  check("a very thin strip is stretched by the cap and no more", sAfter > 1.5 && Math.abs(sBefore / sAfter - MAX_CIRCULARIZE_STRETCH) < 0.05, `${sBefore.toFixed(2)} → ${sAfter.toFixed(2)}`);
  const rx = ids.map((_, i) => Math.cos((i / 12) * Math.PI * 2) * 500), ry = ids.map((_, i) => Math.sin((i / 12) * Math.PI * 2) * 500);
  const rx0 = [...rx], ry0 = [...ry];
  circularize(rx, ry, foot, ids);
  check("a round ring is left exactly as it was", rx.every((x, i) => x === rx0[i]) && ry.every((y, i) => y === ry0[i]));
}

console.log("\ndisk-placement: all checks passed");
process.exit(0);
