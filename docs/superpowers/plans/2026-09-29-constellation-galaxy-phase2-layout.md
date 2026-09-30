# Constellation Galaxy — Phase 2: Galaxy Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the concentric-shell packing, the decorative orbit rings and the dotted Deep-Space rim with a galaxy layout: cluster disks placed by relatedness ("near = related"), a fading halo of unaffiliated stars, and a `galaxy` structure (core, disk radius, filaments) for the renderers to draw in phase 4.

**Architecture:** Three new pure modules feed `buildHybridGraphLayoutSteps`: `constellation-affinity.ts` (which clusters are related, and how strongly), `graph/disk-placement.ts` (a deterministic seed → force-relax → legalize placement of cluster footprint disks, as a generator that yields between slices), and `graph/galaxy-structure.ts` (core radius, disk radius, dust filaments along the strongest affinity links). `graph-layout.ts` swaps its shell packing and rim scatter for them; the ring node and its renderer plumbing are deleted.

**Tech Stack:** TypeScript, smoke scripts run with `npx tsx`, suite runner `scripts/run-smoke.ts`. No React or DB in the new modules.

**Spec:** `docs/superpowers/specs/2026-09-29-constellation-galaxy-design.md` (section 2, "Galaxy layout"; build phase 2, plus the affinity weights deferred from phase 1).

## Global Constraints

- Position means exactly one thing: near = related. No radial meaning, no rings, no closeness-as-position.
- Affinity signals: company family (fixed strong weight), alumni overlap (school groups from `schoolGroupKeys`), shared tags/interests (a value shared by more than 20 clusters is too generic and ignored). Weights are scaled by `1/√(sizeA·sizeB)` except family. All coefficients live in ONE exported constant, `AFFINITY`.
- No new DB queries and no new payload fields (`loadGraphData` is at its statement cap). Inputs are the contact fields already in the graph payload (`company`, `school`, `tags`, `sharedInterests`).
- Deterministic: seeded hashes (`hashUnit`), fixed iteration counts, stable sort orders. Same input → byte-identical layout.
- Non-overlap is a guarantee, not best effort: after placement every pair of cluster disks is at least `CLUSTER_GAP` apart (edge to edge) and no disk intrudes on the sun's clear zone (`SUN_CLEAR`). Star–star ≥ 18px, star–line ≥ 12px, figures undistorted (existing `smoke-graph-layout` checks stay green).
- Performance: every yield-to-yield slice of the layout ≤ ~15ms at 10,000 contacts; whole layout no worse than ~1.5× the pre-phase-2 figure (base `21561d5e` on this machine: 10k ≈ 60–70ms under load). Per-slice timing is measured, not assumed (Task 6).
- Cluster-local geometry (`buildClusterGeometry`, figure/scatter, satellites) is unchanged in this phase — petals/rings/binary are phase 3.
- The decorative orbit rings are removed from the layout AND from every renderer; `RING_LABELS` stays (the inspect panel still names a contact's closeness ring).
- There is NO persisted drag-position key to bump (the spec's `orbit-graph-positions-v6` line is wrong: nothing in `src` stores positions). Task 6 corrects the spec.
- Halo stars sit beyond `galaxy.diskRadius` and fade outward; there is no rim ring.
- Every new `scripts/smoke-*.ts` must be registered in `scripts/run-smoke.ts` (`"pure"`).
- Commit messages end with the line `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Run commands from `/Users/jasonpereira/Projects/claude-worktrees/orbit/constellation-render-clustering-b81406`. Never `git stash`. Never kill processes (a demo dev server may be running on port 3001).
- Temporary measurement scripts go at `scripts/.tmp-*.ts` (so `@/` imports resolve) and are deleted before committing.

---

## File Structure

| File | Responsibility |
|---|---|
| Create `src/lib/constellation-affinity.ts` | `buildClusterAffinity()` → sparse weighted cluster-pair edges; the `AFFINITY` constants. |
| Create `src/lib/graph/disk-placement.ts` | `placeClusterDisks()` generator: seed, relax, legalize; returns centers + `diskRadius`. |
| Create `src/lib/graph/galaxy-structure.ts` | `buildGalaxyStructure()` → `{ coreRadius, diskRadius, filaments }`. |
| Modify `src/lib/graph-layout.ts` | Use the three modules; delete shell packing + family ordering; halo; `galaxy` on the layout; drop the ring node. |
| Modify `src/components/graph/graph-nodes.tsx`, `graph-canvas-flow.tsx`, `sky-canvas/sky-index.ts`, `sky-canvas/draw-sky.ts`, `src/lib/graph/sky-camera.ts`, `preview-sky.ts`, `preview-sky-shape.ts` | Delete ring plumbing (Task 5). |
| Create `scripts/smoke-cluster-affinity.ts`, `scripts/smoke-disk-placement.ts`, `scripts/smoke-galaxy-structure.ts` | Pure-tier specs. |
| Modify `scripts/smoke-graph-layout.ts`, `scripts/smoke-graph-family-seating.ts`, `scripts/smoke-graph-canvas.ts` | Halo/disk/affinity expectations replace shell/rim/ring ones. |
| Modify `scripts/run-smoke.ts`, the spec, `docs/…phase2…` | Registry; spec correction. |

---

### Task 1: Cluster affinity

**Files:**
- Create: `src/lib/constellation-affinity.ts`
- Test: `scripts/smoke-cluster-affinity.ts`
- Modify: `scripts/run-smoke.ts` (registry, beside `"smoke-constellation-clusters": "pure",`)

**Interfaces:**
- Consumes: `companyFamilyKey(raw): string` from `@/lib/company-family` (returns `""` for a company with no known family); `schoolGroupKeys(values): Map<string,string>` from `@/lib/school-key`; `BuiltCluster` from `@/lib/constellation-clusters`.
- Produces:
  - `type AffinityContact = { id: string; school?: string | null; tags?: string[] | null; sharedInterests?: string[] | null }`
  - `type AffinityEdge = { a: string; b: string; weight: number }` (`a < b` by string compare; ids are cluster ids)
  - `const AFFINITY = { family: 1, alumni: 1, tags: 0.5, minWeight: 0.05, perCluster: 8, maxSchoolClusters: 24, maxTagClusters: 20, maxFamilyClusters: 12 } as const`
  - `function buildClusterAffinity(contacts: AffinityContact[], byContactId: Map<string, { id: string }>, clusters: Array<Pick<BuiltCluster, "id" | "name" | "kind" | "count">>): AffinityEdge[]` — only clusters passed in participate; result sorted by weight desc, then `a`, then `b`.

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-cluster-affinity.ts`:

```ts
/**
 * Which constellations are related — the pulls that place clusters near each other.
 * Pure: no DB, no network.
 * Run: npx tsx scripts/smoke-cluster-affinity.ts
 */
import { buildConstellationClusters } from "../src/lib/constellation-clusters";
import {
  AFFINITY,
  buildClusterAffinity,
  type AffinityContact,
  type AffinityEdge,
} from "../src/lib/constellation-affinity";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

type P = AffinityContact & { company?: string | null; title?: string | null };
const person = (id: string, company: string | null, extra: Partial<P> = {}): P => ({
  id,
  company,
  ...extra,
});

function affinityOf(contacts: P[]): AffinityEdge[] {
  const { clusters, byContactId } = buildConstellationClusters(contacts);
  const eligible = clusters.filter((c) => c.kind !== "other" && c.count >= 2);
  return buildClusterAffinity(contacts, byContactId, eligible);
}
const find = (edges: AffinityEdge[], a: string, b: string) =>
  edges.find((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a));

console.log("\nFamily");
{
  const edges = affinityOf([
    person("g1", "Google"),
    person("g2", "Google"),
    person("d1", "Google DeepMind"),
    person("d2", "Google DeepMind"),
    person("s1", "Stripe"),
    person("s2", "Stripe"),
  ]);
  const gd = find(edges, "company:google", "company:google deepmind");
  check("Google and DeepMind are related", Boolean(gd));
  check("family is a strong pull", (gd?.weight ?? 0) >= AFFINITY.family);
  check("unrelated companies are not", !find(edges, "company:google", "company:stripe"));
}

console.log("\nAlumni");
{
  const edges = affinityOf([
    person("a1", "Acme", { school: "MIT" }),
    person("a2", "Acme", { school: "Massachusetts Institute of Technology" }),
    person("a3", "Acme"),
    person("b1", "Beta", { school: "M.I.T." }),
    person("b2", "Beta", { school: "MIT" }),
    person("b3", "Beta"),
    person("c1", "Gamma"),
    person("c2", "Gamma"),
    person("c3", "Gamma"),
  ]);
  const ab = find(edges, "company:acme", "company:beta");
  check("two companies sharing a school (in any spelling) are related", Boolean(ab));
  // min(2 alumni, 2 alumni) / sqrt(3 members * 3 members) = 2/3
  check("weight is shared alumni over √(sizes)", Math.abs((ab?.weight ?? 0) - (2 / 3) * AFFINITY.alumni) < 1e-9, String(ab?.weight));
  check("a company with no shared school is not pulled in", !find(edges, "company:acme", "company:gamma"));
}

console.log("\nTags and interests");
{
  const contacts: P[] = [
    person("x1", "Xco", { tags: ["Climbing", "friend"] }),
    person("x2", "Xco"),
    person("y1", "Yco", { sharedInterests: ["climbing"], tags: ["friend"] }),
    person("y2", "Yco"),
  ];
  // "friend" spans 27 clusters: too generic to mean anything.
  for (let i = 0; i < 25; i++) {
    contacts.push(person(`z${i}-1`, `Zco${i}`, { tags: ["friend"] }), person(`z${i}-2`, `Zco${i}`));
  }
  const edges = affinityOf(contacts);
  const xy = find(edges, "company:xco", "company:yco");
  check("a rare shared value relates two clusters", Boolean(xy));
  // one shared value / sqrt(2*2) = 0.5, times the tag coefficient
  check("weight is shared values over √(sizes)", Math.abs((xy?.weight ?? 0) - 0.5 * AFFINITY.tags) < 1e-9, String(xy?.weight));
  check("a generic value (>20 clusters) relates nothing", !find(edges, "company:xco", "company:zco0"));
}

console.log("\nBounds and determinism");
{
  const contacts: P[] = [];
  for (let i = 0; i < 30; i++) {
    const n = String(i).padStart(2, "0");
    contacts.push(person(`m${n}-1`, `Co${n}`, { school: "MIT" }), person(`m${n}-2`, `Co${n}`));
  }
  const edges = affinityOf(contacts);
  check("a school shared by 30 clusters is capped to the 24 largest", !edges.some((e) => e.a === "company:co29" || e.b === "company:co29"));
  check("edges are capped per cluster (≤ 8 kept from each side)", edges.length <= 24 * AFFINITY.perCluster, String(edges.length));
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.a, (degree.get(e.a) ?? 0) + 1);
    degree.set(e.b, (degree.get(e.b) ?? 0) + 1);
  }
  check("every kept cluster still has its 8 strongest links", [...degree.values()].every((d) => d >= AFFINITY.perCluster));
  check("sorted by weight, then ids", edges.every((e, i) => i === 0 || edges[i - 1].weight >= e.weight));
  const again = affinityOf(contacts);
  check("deterministic", JSON.stringify(again) === JSON.stringify(edges));
  const reversed = affinityOf([...contacts].reverse());
  check("independent of contact order", JSON.stringify(reversed) === JSON.stringify(edges));
}

console.log("\ncluster-affinity: all checks passed");
process.exit(0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/smoke-cluster-affinity.ts`
Expected: FAIL — `Cannot find module '../src/lib/constellation-affinity'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/constellation-affinity.ts`:

```ts
/**
 * Which constellations belong near each other.
 *
 * The galaxy's one honest meaning for position is "near = related", so this decides what
 * related means. Three signals, each cheap to bucket (no all-pairs scan over people):
 *   - family: Google ↔ Google DeepMind. A fixed strong pull, deliberately not size-scaled —
 *     sister companies belong together whatever their headcounts.
 *   - alumni: two clusters whose members went to the same school (spellings grouped by
 *     `schoolGroupKeys`), by how many alumni the smaller side has. This is also what finally
 *     uses the school ties that clustering only shows for people nothing else claimed.
 *   - tags / interests: a value two clusters share. A value that spans more than
 *     `maxTagClusters` clusters ("friend", "mentor") says nothing about any pair, so it is
 *     dropped rather than linking half the sky.
 * Alumni and tag pulls are divided by √(sizeA·sizeB): a 300-person company shares a school
 * with everyone, and must not drag the whole map toward itself.
 *
 * The result is sparse on purpose — only each cluster's `perCluster` strongest links survive —
 * because the layout's force pass touches every edge every iteration.
 */

import { companyFamilyKey } from "@/lib/company-family";
import type { BuiltCluster } from "@/lib/constellation-clusters";
import { schoolGroupKeys } from "@/lib/school-key";

export type AffinityContact = {
  id: string;
  school?: string | null;
  tags?: string[] | null;
  sharedInterests?: string[] | null;
};

export type AffinityEdge = { a: string; b: string; weight: number };

export const AFFINITY = {
  /** Pull between two clusters of one company family. */
  family: 1,
  /** Coefficient on shared alumni ÷ √(sizeA·sizeB). */
  alumni: 1,
  /** Coefficient on shared tag/interest values ÷ √(sizeA·sizeB). */
  tags: 0.5,
  /** Links weaker than this are noise. */
  minWeight: 0.05,
  /** Strongest links kept per cluster (an edge survives if either end keeps it). */
  perCluster: 8,
  /** A school spanning more clusters than this keeps only its largest few. */
  maxSchoolClusters: 24,
  /** A tag/interest spanning more clusters than this is too generic to relate any pair. */
  maxTagClusters: 20,
  /** A family with more member clusters than this keeps only its largest few. */
  maxFamilyClusters: 12,
} as const;

const byWeight = (x: AffinityEdge, y: AffinityEdge) =>
  y.weight - x.weight || x.a.localeCompare(y.a) || x.b.localeCompare(y.b);

export function buildClusterAffinity(
  contacts: AffinityContact[],
  byContactId: Map<string, { id: string }>,
  clusters: Array<Pick<BuiltCluster, "id" | "name" | "kind" | "count">>
): AffinityEdge[] {
  const size = new Map(clusters.map((c) => [c.id, c.count]));
  const total = new Map<string, AffinityEdge>();

  const bump = (x: string, y: string, amount: number) => {
    if (x === y) return;
    const [a, b] = x < y ? [x, y] : [y, x];
    const key = `${a.length}:${a}${b}`;
    const edge = total.get(key);
    if (edge) edge.weight += amount;
    else total.set(key, { a, b, weight: amount });
  };
  const pairs = (ids: string[], amountOf: (x: string, y: string) => number) => {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) bump(ids[i], ids[j], amountOf(ids[i], ids[j]));
    }
  };
  const scaled = (x: string, y: string) => 1 / Math.sqrt((size.get(x) ?? 1) * (size.get(y) ?? 1));

  // Family.
  const byFamily = new Map<string, Array<{ id: string; count: number }>>();
  for (const c of clusters) {
    if (c.kind !== "company") continue;
    const key = companyFamilyKey(c.name);
    if (!key) continue;
    const list = byFamily.get(key) ?? [];
    list.push({ id: c.id, count: c.count });
    byFamily.set(key, list);
  }
  for (const members of byFamily.values()) {
    if (members.length < 2) continue;
    const top = members
      .sort((x, y) => y.count - x.count || x.id.localeCompare(y.id))
      .slice(0, AFFINITY.maxFamilyClusters)
      .map((m) => m.id);
    pairs(top, () => AFFINITY.family);
  }

  const inScope = contacts.filter((c) => size.has(byContactId.get(c.id)?.id ?? ""));

  // Alumni.
  const trimmed = (c: AffinityContact) => (c.school ?? "").trim();
  const groups = schoolGroupKeys(inScope.map(trimmed).filter(Boolean));
  const bySchool = new Map<string, Map<string, number>>();
  for (const c of inScope) {
    const group = groups.get(trimmed(c));
    if (!group) continue;
    const clusterId = byContactId.get(c.id)!.id;
    const counts = bySchool.get(group) ?? new Map<string, number>();
    counts.set(clusterId, (counts.get(clusterId) ?? 0) + 1);
    bySchool.set(group, counts);
  }
  for (const counts of bySchool.values()) {
    if (counts.size < 2) continue;
    const top = [...counts.entries()]
      .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
      .slice(0, AFFINITY.maxSchoolClusters);
    for (let i = 0; i < top.length; i++) {
      for (let j = i + 1; j < top.length; j++) {
        bump(
          top[i][0],
          top[j][0],
          (AFFINITY.alumni * Math.min(top[i][1], top[j][1])) * scaled(top[i][0], top[j][0])
        );
      }
    }
  }

  // Tags and interests.
  const byValue = new Map<string, Set<string>>();
  for (const c of inScope) {
    const clusterId = byContactId.get(c.id)!.id;
    const values = new Set(
      [...(c.tags ?? []), ...(c.sharedInterests ?? [])]
        .map((v) => v.trim().toLowerCase())
        .filter(Boolean)
    );
    for (const value of values) {
      const set = byValue.get(value) ?? new Set<string>();
      set.add(clusterId);
      byValue.set(value, set);
    }
  }
  for (const set of byValue.values()) {
    if (set.size < 2 || set.size > AFFINITY.maxTagClusters) continue;
    pairs([...set].sort(), (x, y) => AFFINITY.tags * scaled(x, y));
  }

  // Sparse: each cluster keeps its strongest links.
  const strong = [...total.values()].filter((e) => e.weight >= AFFINITY.minWeight);
  const incident = new Map<string, AffinityEdge[]>();
  for (const e of strong) {
    for (const id of [e.a, e.b]) {
      const list = incident.get(id) ?? [];
      list.push(e);
      incident.set(id, list);
    }
  }
  const keep = new Set<AffinityEdge>();
  for (const list of incident.values()) {
    list.sort(byWeight);
    for (const e of list.slice(0, AFFINITY.perCluster)) keep.add(e);
  }
  return [...keep].sort(byWeight);
}
```

- [ ] **Step 4: Register the smoke**

In `scripts/run-smoke.ts`, beside `"smoke-constellation-clusters": "pure",`:

```ts
  "smoke-cluster-affinity": "pure",
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx tsx scripts/smoke-cluster-affinity.ts`
Expected: ends with `cluster-affinity: all checks passed`.

If the "capped to the 24 largest" check fails, note that all 30 clusters have equal counts, so the cap keeps the first 24 by id (`co00`…`co23`); `company:co29` must be absent. Fix the code, not the test.

- [ ] **Step 6: Commit**

```bash
git add src/lib/constellation-affinity.ts scripts/smoke-cluster-affinity.ts scripts/run-smoke.ts
git commit -m "feat(constellation): cluster affinity — family, alumni, shared tags

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Disk placement

**Files:**
- Create: `src/lib/graph/disk-placement.ts`
- Test: `scripts/smoke-disk-placement.ts`
- Modify: `scripts/run-smoke.ts`

**Interfaces:**
- Consumes: `AffinityEdge` (Task 1); `hashUnit(seed: string, salt: number): number` from `@/lib/hash`.
- Produces:
  - `type DiskInput = { id: string; foot: number; size: number }`
  - `type DiskPlacement = { centers: Map<string, { x: number; y: number }>; diskRadius: number }` (`diskRadius` = max over disks of `|center| + foot`; `0` for no disks)
  - `type DiskOptions = { sunClear: number; gap: number; iterations?: number }`
  - `const DISK_ITERATIONS = 90`
  - `function* placeClusterDisks(inputs: DiskInput[], affinity: AffinityEdge[], options: DiskOptions): Generator<void, DiskPlacement, void>` — yields every 10 relax iterations plus once after seeding.

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-disk-placement.ts`:

```ts
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
  const chain: AffinityEdge[] = inputs.slice(1).map((d, i) => ({ a: inputs[i].id, b: d.id, weight: 0.6 }));
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
    for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) affinity.push({ a: ids[i], b: ids[j], weight: 1 });
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

console.log("\nEdge cases");
{
  const empty = run([], []).placement;
  check("no disks: nothing placed, radius 0", empty.centers.size === 0 && empty.diskRadius === 0);
  const one = run([{ id: "solo", foot: 200, size: 9 }], []).placement;
  const c = one.centers.get("solo")!;
  check("a single disk sits just outside the sun's clear zone", Math.abs(Math.hypot(c.x, c.y) - (OPTS.sunClear + 200)) < 30);
  const stray = run([{ id: "a", foot: 100, size: 2 }], [{ a: "a", b: "ghost", weight: 1 }]).placement;
  check("an edge to an unknown cluster is ignored", stray.centers.size === 1);
}

console.log("\ndisk-placement: all checks passed");
process.exit(0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/smoke-disk-placement.ts`
Expected: FAIL — `Cannot find module '../src/lib/graph/disk-placement'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/graph/disk-placement.ts`:

```ts
/**
 * Where each constellation's footprint disk sits in the galaxy.
 *
 * Three passes, all deterministic (seeded hashes, fixed iteration counts, stable order):
 *   1. SEED — biggest first. A cluster with an already-placed neighbour goes tangent to its
 *      strongest one (at the free angle nearest the sun); one with none goes to the nearest
 *      free ring around the sun. The seed alone is already legal.
 *   2. RELAX — a fixed number of force steps. Affinity edges pull a pair together until their
 *      disks are tangent; overlapping disks push apart; a pull toward the sun, stronger for
 *      bigger clusters, makes the galaxy dense in the middle; the sun's clear zone repels.
 *   3. LEGALIZE — clusters in size order keep their relaxed spot if it is free and otherwise
 *      take the nearest free one. This is what makes non-overlap a guarantee rather than a
 *      hope: it cannot fail, because the search always ends at a spot beyond everything
 *      placed so far.
 *
 * It is a generator so the caller can hand the main thread back every few iterations — the
 * whole layout is one long task otherwise (see `buildHybridGraphLayoutSteps`).
 *
 * Pure geometry on plain data: it knows nothing about contacts, clusters or React.
 */

import type { AffinityEdge } from "@/lib/constellation-affinity";
import { hashUnit } from "@/lib/hash";

export type DiskInput = { id: string; foot: number; size: number };
export type DiskPlacement = {
  centers: Map<string, { x: number; y: number }>;
  /** Outermost reach of any disk from the sun: the galaxy's edge. */
  diskRadius: number;
};
export type DiskOptions = {
  /** No disk may reach inside this radius of the sun. */
  sunClear: number;
  /** Clear space kept between two disks, edge to edge. */
  gap: number;
  iterations?: number;
};

export const DISK_ITERATIONS = 90;
const YIELD_EVERY = 10;
/** Fraction of a link's slack closed per step (each end moves half). */
const ATTRACT = 0.3;
/** Each end of an overlapping pair moves this fraction of the overlap. */
const REPEL = 0.5;
/** Per-step pull toward the sun, as a fraction of distance, at the biggest cluster's weight. */
const GRAVITY = 0.015;
const MAX_STEP = 80;
const SEARCH_STEP = 24;
const SEARCH_ANGLES = 24;
const SEARCH_RINGS = 600;

/** Disks bucketed by the grid cells their bounding box covers, so a test looks at neighbours. */
class DiskGrid {
  private cells = new Map<number, number[]>();

  constructor(private readonly cell: number) {}

  private key(cx: number, cy: number) {
    return (cx + 100000) * 200003 + (cy + 100000);
  }

  clear() {
    this.cells.clear();
  }

  add(i: number, x: number, y: number, r: number) {
    const x0 = Math.floor((x - r) / this.cell);
    const x1 = Math.floor((x + r) / this.cell);
    const y0 = Math.floor((y - r) / this.cell);
    const y1 = Math.floor((y + r) / this.cell);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const k = this.key(cx, cy);
        const list = this.cells.get(k);
        if (list) list.push(i);
        else this.cells.set(k, [i]);
      }
    }
  }

  /** Every disk whose box could overlap the query circle (a superset of the true overlaps). */
  near(x: number, y: number, r: number): number[] {
    const seen = new Set<number>();
    const x0 = Math.floor((x - r) / this.cell);
    const x1 = Math.floor((x + r) / this.cell);
    const y0 = Math.floor((y - r) / this.cell);
    const y1 = Math.floor((y + r) / this.cell);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const list = this.cells.get(this.key(cx, cy));
        if (list) for (const j of list) seen.add(j);
      }
    }
    return [...seen];
  }
}

export function* placeClusterDisks(
  inputs: DiskInput[],
  affinity: AffinityEdge[],
  options: DiskOptions
): Generator<void, DiskPlacement, void> {
  const { sunClear, gap } = options;
  const iterations = options.iterations ?? DISK_ITERATIONS;
  const order = [...inputs].sort((a, b) => b.size - a.size || a.id.localeCompare(b.id));
  const n = order.length;
  const centers = new Map<string, { x: number; y: number }>();
  if (n === 0) return { centers, diskRadius: 0 };

  const index = new Map(order.map((d, i) => [d.id, i]));
  const foot = order.map((d) => d.foot);
  const size = order.map((d) => d.size);
  const maxSize = Math.max(1, size[0]);
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const links: Array<Array<{ j: number; w: number }>> = order.map(() => []);
  for (const e of affinity) {
    const i = index.get(e.a);
    const j = index.get(e.b);
    if (i === undefined || j === undefined || i === j) continue;
    links[i].push({ j, w: e.weight });
    links[j].push({ j: i, w: e.weight });
  }
  // Forces are summed link by link, and float addition is not associative: a fixed order is
  // what makes the result independent of the order the affinity list arrived in.
  for (const list of links) list.sort((p, q) => p.j - q.j);

  const meanFoot = foot.reduce((s, f) => s + f, 0) / n;
  const grid = new DiskGrid(Math.min(900, Math.max(160, meanFoot * 2)));
  let extent = 0;

  const place = (i: number, x: number, y: number) => {
    xs[i] = x;
    ys[i] = y;
    grid.add(i, x, y, foot[i]);
    extent = Math.max(extent, Math.hypot(x, y) + foot[i]);
  };

  /** Free of the sun's clear zone and of every disk in the grid. */
  const free = (x: number, y: number, r: number) => {
    if (Math.hypot(x, y) < sunClear + r) return false;
    for (const j of grid.near(x, y, r + gap)) {
      if (Math.hypot(x - xs[j], y - ys[j]) < foot[j] + r + gap) return false;
    }
    return true;
  };

  /**
   * The free spot for disk `i` nearest the sun, searching outward from (bx, by) in rings of
   * growing distance. Ends at a spot beyond everything placed, so it always finds one.
   */
  const findSpot = (i: number, bx: number, by: number, minDist: number) => {
    const r = foot[i];
    const start = hashUnit(order[i].id, 21) * Math.PI * 2;
    for (let ring = 0; ring < SEARCH_RINGS; ring++) {
      const d = minDist + ring * SEARCH_STEP;
      let best: { x: number; y: number; dist: number } | null = null;
      for (let k = 0; k < SEARCH_ANGLES; k++) {
        const t = start + (k / SEARCH_ANGLES) * Math.PI * 2;
        const x = bx + Math.cos(t) * d;
        const y = by + Math.sin(t) * d;
        const dist = Math.hypot(x, y);
        if ((!best || dist < best.dist - 1e-9) && free(x, y, r)) best = { x, y, dist };
      }
      if (best) return best;
    }
    const d = extent + r + gap;
    return { x: Math.cos(start) * d, y: Math.sin(start) * d, dist: d };
  };

  // 1. Seed.
  for (let i = 0; i < n; i++) {
    let anchor = -1;
    let anchorW = 0;
    for (const { j, w } of links[i]) {
      if (j < i && (w > anchorW || (w === anchorW && j < anchor))) {
        anchor = j;
        anchorW = w;
      }
    }
    const spot =
      anchor >= 0
        ? findSpot(i, xs[anchor], ys[anchor], foot[anchor] + foot[i] + gap)
        : findSpot(i, 0, 0, sunClear + foot[i]);
    place(i, spot.x, spot.y);
  }
  yield;

  // 2. Relax.
  const dx = new Float64Array(n);
  const dy = new Float64Array(n);
  for (let step = 0; step < iterations; step++) {
    grid.clear();
    for (let i = 0; i < n; i++) grid.add(i, xs[i], ys[i], foot[i]);
    dx.fill(0);
    dy.fill(0);
    for (let i = 0; i < n; i++) {
      const xi = xs[i];
      const yi = ys[i];
      for (const { j, w } of links[i]) {
        const ex = xs[j] - xi;
        const ey = ys[j] - yi;
        const d = Math.hypot(ex, ey);
        const want = foot[i] + foot[j] + gap;
        if (d > want) {
          const pull = (d - want) * ATTRACT * Math.min(1, w) * 0.5;
          dx[i] += (ex / d) * pull;
          dy[i] += (ey / d) * pull;
        }
      }
      const r = Math.hypot(xi, yi);
      if (r > 1e-6) {
        const g = GRAVITY * Math.sqrt(size[i] / maxSize) * r;
        dx[i] -= (xi / r) * g;
        dy[i] -= (yi / r) * g;
      }
      for (const j of grid.near(xi, yi, foot[i] + gap)) {
        if (j === i) continue;
        let ex = xi - xs[j];
        let ey = yi - ys[j];
        let d = Math.hypot(ex, ey);
        const min = foot[i] + foot[j] + gap;
        if (d >= min) continue;
        if (d < 1e-6) {
          const t = hashUnit(order[i].id, 33) * Math.PI * 2;
          ex = Math.cos(t);
          ey = Math.sin(t);
          d = 1;
        }
        const push = (min - d) * REPEL;
        dx[i] += (ex / d) * push;
        dy[i] += (ey / d) * push;
      }
      if (r < sunClear + foot[i]) {
        const out = sunClear + foot[i] - r;
        if (r > 1e-6) {
          dx[i] += (xi / r) * out;
          dy[i] += (yi / r) * out;
        } else {
          dx[i] += out;
        }
      }
    }
    for (let i = 0; i < n; i++) {
      let mx = dx[i];
      let my = dy[i];
      const m = Math.hypot(mx, my);
      if (m > MAX_STEP) {
        mx = (mx / m) * MAX_STEP;
        my = (my / m) * MAX_STEP;
      }
      xs[i] += mx;
      ys[i] += my;
    }
    if (step % YIELD_EVERY === YIELD_EVERY - 1) yield;
  }

  // 3. Legalize.
  grid.clear();
  extent = 0;
  for (let i = 0; i < n; i++) {
    if (free(xs[i], ys[i], foot[i])) {
      place(i, xs[i], ys[i]);
    } else {
      const spot = findSpot(i, xs[i], ys[i], 0);
      place(i, spot.x, spot.y);
    }
  }

  let diskRadius = 0;
  for (let i = 0; i < n; i++) {
    centers.set(order[i].id, { x: xs[i], y: ys[i] });
    diskRadius = Math.max(diskRadius, Math.hypot(xs[i], ys[i]) + foot[i]);
  }
  return { centers, diskRadius };
}
```

- [ ] **Step 4: Register the smoke**

In `scripts/run-smoke.ts`, beside `"smoke-cluster-affinity": "pure",`:

```ts
  "smoke-disk-placement": "pure",
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx tsx scripts/smoke-disk-placement.ts`
Expected: ends with `disk-placement: all checks passed`.

If "related disks sit closer…" or "the biggest cluster anchors the middle" fails, tune ONLY the module constants (`ATTRACT`, `GRAVITY`, `REPEL`) and report the values tried; do not loosen a threshold. If "independent of input order" fails, the cause is an unstable tiebreak in `order` or `links` — fix the code.

- [ ] **Step 6: Commit**

```bash
git add src/lib/graph/disk-placement.ts scripts/smoke-disk-placement.ts scripts/run-smoke.ts
git commit -m "feat(constellation): place cluster disks by affinity — seed, relax, legalize

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Galaxy structure

**Files:**
- Create: `src/lib/graph/galaxy-structure.ts`
- Test: `scripts/smoke-galaxy-structure.ts`
- Modify: `scripts/run-smoke.ts`

**Interfaces:**
- Consumes: `AffinityEdge` (Task 1).
- Produces:
  - `type GalaxyFilament = { from: string; to: string; weight: number; path: Array<{ x: number; y: number }> }` (6 points, first = `from`'s center, last = `to`'s, integers)
  - `type GalaxyStructure = { coreRadius: number; diskRadius: number; filaments: GalaxyFilament[] }`
  - `const FILAMENT_POINTS = 6`, `const MAX_FILAMENTS = 400`
  - `function buildGalaxyStructure(centers: Map<string, { x: number; y: number }>, affinity: AffinityEdge[], options: { sunClear: number; diskRadius: number }): GalaxyStructure` — filaments are the strongest-link spanning forest first, then up to `max(8, round(0.15 × clusters))` extra strongest non-tree links.

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-galaxy-structure.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/smoke-galaxy-structure.ts`
Expected: FAIL — `Cannot find module '../src/lib/graph/galaxy-structure'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/graph/galaxy-structure.ts`:

```ts
/**
 * The galaxy's shape data, for the renderers to draw in a later phase.
 *
 * Nothing here decides where anything sits — `disk-placement.ts` did that. This turns the
 * placement into three things a backdrop needs: how big the bright core is, where the disk
 * fades out, and which relatedness chains to trace with dust. Filaments follow the spanning
 * forest of the affinity graph (every related cluster reaches its neighbours by the strongest
 * route, and no more) plus a few strong cycle-closing links so the dust reads as fragments of
 * arms rather than a bare tree.
 */

import type { AffinityEdge } from "@/lib/constellation-affinity";
import { hashUnit } from "@/lib/hash";

export type GalaxyFilament = {
  from: string;
  to: string;
  weight: number;
  path: Array<{ x: number; y: number }>;
};

export type GalaxyStructure = {
  /** Radius of the warm glow around the sun. */
  coreRadius: number;
  /** Where the disk's haze fades out: the placement's outermost reach. */
  diskRadius: number;
  filaments: GalaxyFilament[];
};

export const FILAMENT_POINTS = 6;
export const MAX_FILAMENTS = 400;
/** How far a filament bows sideways, as a fraction of its length. */
const BOW = 0.12;
const CORE_FRACTION = 0.15;

export function buildGalaxyStructure(
  centers: Map<string, { x: number; y: number }>,
  affinity: AffinityEdge[],
  options: { sunClear: number; diskRadius: number }
): GalaxyStructure {
  const { sunClear, diskRadius } = options;
  const coreRadius = Math.max(sunClear, diskRadius * CORE_FRACTION);

  // Kruskal over the strongest links first (`affinity` arrives sorted; sort again to be safe).
  const links = affinity
    .filter((e) => centers.has(e.a) && centers.has(e.b))
    .sort((x, y) => y.weight - x.weight || x.a.localeCompare(y.a) || x.b.localeCompare(y.b));
  const parent = new Map<string, string>();
  const root = (id: string): string => {
    let cur = id;
    while ((parent.get(cur) ?? cur) !== cur) {
      const up = parent.get(cur)!;
      parent.set(cur, parent.get(up) ?? up);
      cur = up;
    }
    return cur;
  };
  const tree: AffinityEdge[] = [];
  const rest: AffinityEdge[] = [];
  for (const e of links) {
    const ra = root(e.a);
    const rb = root(e.b);
    if (ra === rb) {
      rest.push(e);
    } else {
      parent.set(ra, rb);
      tree.push(e);
    }
  }
  const extras = Math.max(8, Math.round(centers.size * 0.15));
  const chosen = [...tree, ...rest.slice(0, extras)].slice(0, MAX_FILAMENTS);

  const filaments = chosen.map((e) => {
    const a = centers.get(e.a)!;
    const b = centers.get(e.b)!;
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    // A perpendicular unit vector, and a side that stays the same for the same pair.
    const nx = -(b.y - a.y) / len;
    const ny = (b.x - a.x) / len;
    const side = hashUnit(`${e.a}|${e.b}`, 31) < 0.5 ? -1 : 1;
    const path: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < FILAMENT_POINTS; i++) {
      const t = i / (FILAMENT_POINTS - 1);
      const bow = Math.sin(Math.PI * t) * len * BOW * side;
      path.push({
        x: Math.round(a.x + (b.x - a.x) * t + nx * bow),
        y: Math.round(a.y + (b.y - a.y) * t + ny * bow),
      });
    }
    return { from: e.a, to: e.b, weight: e.weight, path };
  });

  return { coreRadius, diskRadius, filaments };
}
```

- [ ] **Step 4: Register the smoke**

In `scripts/run-smoke.ts`, beside `"smoke-disk-placement": "pure",`:

```ts
  "smoke-galaxy-structure": "pure",
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx tsx scripts/smoke-galaxy-structure.ts`
Expected: ends with `galaxy-structure: all checks passed`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/graph/galaxy-structure.ts scripts/smoke-galaxy-structure.ts scripts/run-smoke.ts
git commit -m "feat(constellation): galaxy structure — core, disk edge, affinity filaments

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Wire the galaxy into the layout

**Files:**
- Modify: `src/lib/graph-layout.ts`
- Modify: `scripts/smoke-graph-layout.ts`, `scripts/smoke-graph-family-seating.ts`

**Interfaces:**
- Consumes: `buildClusterAffinity`, `placeClusterDisks`, `buildGalaxyStructure`, `GalaxyStructure` (Tasks 1–3); existing `SUN_CLEAR` (180), `CLUSTER_GAP` (104), `BACKGROUND_GAP`, `ClearanceGrid`, `hashUnitStream`, `familySatellites`, `buildClusterGeometry`.
- Produces: `HybridGraphLayout = { nodes: LayoutNode[]; edges: LayoutEdge[]; galaxy: GalaxyStructure }`. The layout no longer emits the `"rings"` node (the `"orbitRings"` type stays until Task 5). Exported `packClusterShells`, `PackedShells`, `RING_RADII` stay for now only if something still imports them (nothing outside graph-layout does; delete `packClusterShells` and `PackedShells`; leave `RING_RADII` for Task 5).

- [ ] **Step 1: Extend the layout smoke first (failing)**

In `scripts/smoke-graph-layout.ts`:

Add to the imports:

```ts
import { buildClusterAffinity } from "../src/lib/constellation-affinity";
import { buildSyntheticGraphPayload } from "../src/lib/graph/synthetic-network";
```

and add `type NebulaData,` to the file's existing `import { buildHybridGraphLayout, type GraphContactInput, type GraphNodeData } from "../src/lib/graph-layout"` (do not add a second import from that module).

Add a new section just before the `Edges match the fit` section:

```ts
// ---------------------------------------------------------------------------
console.log("\nThe galaxy");

{
  const g = layout.galaxy;
  check("the layout carries a galaxy", Boolean(g) && g.diskRadius > 0);
  check(
    "no ring node is emitted",
    !layout.nodes.some((n) => n.id === "rings" || (n.type as string) === "orbitRings")
  );
  const clusteredIds = new Set(
    [...fit.fits.values()].flatMap((f) => [...f.figureMemberIds, ...f.scatterMemberIds])
  );
  check(
    "every clustered star lies inside the disk",
    [...clusteredIds].every((id) => {
      const p = posById.get(id)!;
      return Math.hypot(p.x, p.y) <= g.diskRadius + 1e-6;
    })
  );
  const haloIds = ["solo", ...Array.from({ length: 7 }, (_, i) => `d${i}`)];
  check(
    "unaffiliated stars sit in the halo, beyond the disk",
    haloIds.every((id) => {
      const p = posById.get(id)!;
      return Math.hypot(p.x, p.y) >= g.diskRadius;
    })
  );
  check("the core is inside the disk", g.coreRadius <= g.diskRadius);
  check(
    "filaments join clusters that exist",
    g.filaments.every((f) => fit.fits.has(f.from) && fit.fits.has(f.to))
  );
}

// ---------------------------------------------------------------------------
console.log("\nNear = related (a realistic network)");

{
  const network = buildSyntheticGraphPayload(600, 3).contacts;
  const big = buildHybridGraphLayout(network, "Tester");
  const bigFit = buildConstellationFit(network);
  const eligible = bigFit.clusters.filter((c) => bigFit.fits.has(c.id));
  const links = buildClusterAffinity(network, bigFit.byContactId, eligible);
  const centre = new Map(
    big.nodes
      .filter((n) => n.type === "nebula")
      .map((n) => [(n.data as NebulaData).clusterId!, n.position] as const)
  );
  const d = (a: string, b: string) => {
    const A = centre.get(a)!;
    const B = centre.get(b)!;
    return Math.hypot(A.x - B.x, A.y - B.y);
  };
  const ids = [...centre.keys()];
  const all: number[] = [];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) all.push(d(ids[i], ids[j]));
  all.sort((a, b) => a - b);
  const median = all[Math.floor(all.length / 2)];
  const related = links.filter((l) => centre.has(l.a) && centre.has(l.b));
  const mean = related.reduce((s, l) => s + d(l.a, l.b), 0) / Math.max(1, related.length);
  check("the network has related clusters", related.length > 10, String(related.length));
  check(
    `related clusters sit closer than a typical pair (mean ${mean.toFixed(0)} < median ${median.toFixed(0)})`,
    mean < median
  );
}
```

Also change the existing check `"every star keeps clear of the sun"` is fine as is (`SUN_MIN_DIST` = 150 ≤ 180 + foot).

In `scripts/smoke-graph-family-seating.ts`, replace the `rimFrom` block and the two checks that use it with:

```ts
  const haloFrom = layout.galaxy.diskRadius;
  check(
    "and not out in the halo with the unclustered",
    radius("gcloud-0") < haloFrom,
    `radius ${radius("gcloud-0").toFixed(0)} vs halo from ${haloFrom.toFixed(0)}`
  );
  check(
    "a lone contact at an unrelated company still goes to the halo",
    radius("bank-0") >= haloFrom - 1,
    `radius ${radius("bank-0").toFixed(0)} vs halo from ${haloFrom.toFixed(0)}`
  );
```

(Delete the old `const rimFrom = Math.min(...)` statement.) Update the file's header comment: "a family could straddle two shells" → "a family could end up apart", "a shell's spare arc was spread evenly" → "related clusters were placed by list order, not relatedness".

Run: `npx tsx scripts/smoke-graph-layout.ts`
Expected: FAIL at `the layout carries a galaxy` (`layout.galaxy` is undefined) — after a type error is resolved by running through tsx (tsx does not typecheck).

- [ ] **Step 2: Rewire `src/lib/graph-layout.ts`**

Imports — add, and drop `companyFamilyKey`:

```ts
import { companyFamilyRoot } from "@/lib/company-family";
import { buildClusterAffinity } from "@/lib/constellation-affinity";
import { placeClusterDisks } from "@/lib/graph/disk-placement";
import { buildGalaxyStructure, type GalaxyStructure } from "@/lib/graph/galaxy-structure";
```

Delete these (find each by name; line numbers have shifted):
- the `family?: string;` field (and its doc comment) on `ClusterGeometry`;
- `function clusterFamily`, `function orderClustersByFamily`;
- `export type PackedShells`, `function pairArc`, `function shellFits`, `export function packClusterShells`;
- the constant `BACKGROUND_FIELD_WIDTH`.

Replace the `HybridGraphLayout` type and its doc comment:

```ts
/**
 * The galaxy:
 * - Sun at the center inside a clear core.
 * - Each company / role / school cluster draws its asterism, undistorted, with overflow
 *   members ringed around it, inside a footprint disk.
 * - Disks are placed by relatedness — family, alumni, shared tags — so near means related
 *   (`constellation-affinity.ts`, `graph/disk-placement.ts`), with the biggest clusters
 *   anchoring the middle. Nothing overlaps: stars, figures, lines and disks keep their distance.
 * - Everyone no cluster claimed drifts in a halo beyond the disk, thinning outward.
 * - `galaxy` is the backdrop's shape data: core, disk edge and dust filaments.
 */
export type HybridGraphLayout = {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  galaxy: GalaxyStructure;
};
```

Add the halo sampler right after `scatterField`:

```ts
/** Halo width scale, as a fraction of the disk's radius, and its floor. */
const HALO_SCALE_FRACTION = 0.2;
const HALO_MIN_SCALE = 160;

/**
 * Unaffiliated stars, drifting beyond the galaxy's edge and thinning with distance.
 *
 * The old deep-space rim was a uniform annulus, which drew a perfect dotted circle. Here the
 * radius falls off exponentially from `inner`, so the halo is densest where the galaxy ends
 * and fades into empty sky, with noise on the angle. Same seeded rejection sampling against
 * label boxes as `scatterField`; when the band fills up it widens.
 */
function haloField(
  ids: string[],
  inner: number
): Array<{ id: string; x: number; y: number }> {
  const placed: Array<{ id: string; x: number; y: number }> = [];
  const occupied = new ClearanceGrid();
  let scale = Math.max(HALO_MIN_SCALE, inner * HALO_SCALE_FRACTION);

  for (const id of ids) {
    let spot: { x: number; y: number } | null = null;
    let attempt = 0;
    const hash = hashUnitStream(`halo:${id}`);
    for (let rounds = 0; !spot && rounds < 200; rounds++) {
      for (let tries = 0; tries < 24 && !spot; tries++, attempt++) {
        const u = hash(attempt * 2 + 1);
        const v = hash(attempt * 2 + 2);
        const radius = inner - Math.log(1 - u * 0.999) * scale;
        const angle = v * Math.PI * 2;
        const candidate = { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
        if (occupied.clear(candidate)) spot = candidate;
      }
      if (!spot) scale *= 1.15;
    }
    // Practically unreachable — the band widens until a spot clears.
    if (!spot) spot = { x: inner + scale, y: 0 };
    placed.push({ id, ...spot });
    occupied.add(spot);
  }
  return placed;
}
```

In `buildHybridGraphLayoutSteps`, replace everything from `const eligible = fit.clusters.filter(...)` down to and including the deep-space block (`if (background.length > 0) { … }`) with:

```ts
  const eligible = fit.clusters.filter((c) => fits.has(c.id));
  const satellites = familySatellites(contacts, eligible);
  const geoms = eligible.map((cluster) =>
    buildClusterGeometry(fits.get(cluster.id)!, satellites.get(cluster.id))
  );
  yield;

  const affinity = buildClusterAffinity(contacts, byContactId, eligible);
  yield;
  const { centers, diskRadius } = yield* placeClusterDisks(
    geoms.map((g) => ({ id: g.cluster.id, foot: g.foot, size: g.cluster.count })),
    affinity,
    { sunClear: SUN_CLEAR, gap: CLUSTER_GAP }
  );

  const positions = new Map<string, PolarPosition>();
  const figureIds = new Set<string>();

  for (const geom of geoms) {
    const center = centers.get(geom.cluster.id)!;

    geom.fit.figureMemberIds.forEach((id, i) => {
      const p = geom.figureLocal[i] || { x: 0, y: 0 };
      figureIds.add(id);
      positions.set(id, toPosition(center.x + p.x, center.y + p.y));
    });

    for (const p of geom.scatterLocal) {
      positions.set(p.id, toPosition(center.x + p.x, center.y + p.y));
    }
  }

  // Everyone no constellation claimed drifts in a halo beyond the galaxy's edge.
  const background = contacts
    .filter((c) => !positions.has(c.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (background.length > 0) {
    const inner = Math.max(diskRadius, SUN_CLEAR) + BACKGROUND_GAP;
    for (const p of haloField(background.map((c) => c.id), inner)) {
      positions.set(p.id, toPosition(p.x, p.y));
    }
  }

  const galaxy = buildGalaxyStructure(centers, affinity, {
    sunClear: SUN_CLEAR,
    diskRadius,
  });
```

In the `nodes` array literal, delete the first element (the `{ id: "rings", type: "orbitRings", … }` object). Change the final `return { nodes, edges };` to `return { nodes, edges, galaxy };`.

Update the file's stale comments: the doc above `SUN_CLEAR` ("Clear sky between the sun and the first shell's clusters" → "…and the nearest cluster"); `BACKGROUND_GAP` ("Gap between the last shell and the deep-space rim" → "Gap between the galaxy's edge and the start of the halo").

- [ ] **Step 3: Typecheck and run the layout smokes**

Run: `npx tsc --noEmit -p . && npx tsx scripts/smoke-graph-layout.ts && npx tsx scripts/smoke-graph-family-seating.ts && npx tsx scripts/smoke-sky-layout.ts`
Expected: tsc exits 0; every smoke passes.

Known risk, in order of likelihood:
- `cluster star fields are pairwise disjoint` (smoke-graph-layout) compares centroid-based bounding circles with only an 18px slack; disks now sit exactly `CLUSTER_GAP` (104px) apart. If it fails, print the offending pair's numbers and report BLOCKED — do not change the check without a ruling.
- `Near = related` fails: tune `AFFINITY` coefficients or the `disk-placement.ts` constants (record the values tried); never weaken the assertion.
- `smoke-graph-canvas` still asserts `the rings survive` — that is Task 5's to change; run it there, not here.

- [ ] **Step 4: Commit**

```bash
git add src/lib/graph-layout.ts scripts/smoke-graph-layout.ts scripts/smoke-graph-family-seating.ts
git commit -m "feat(constellation): lay the sky out as a galaxy — related clusters near, halo beyond

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Remove the ring plumbing

**Files:**
- Modify: `src/lib/graph-layout.ts` (types), `src/components/graph/graph-nodes.tsx`, `src/components/graph/graph-canvas-flow.tsx`, `src/components/graph/sky-canvas/sky-index.ts`, `src/components/graph/sky-canvas/draw-sky.ts`, `src/lib/graph/sky-camera.ts`, `src/lib/graph/preview-sky.ts`, `src/lib/graph/preview-sky-shape.ts`, `scripts/smoke-graph-canvas.ts`

**Interfaces:**
- Consumes: the layout no longer emits a ring node (Task 4).
- Produces: no `"orbitRings"` node type, no `OrbitRingsData`, no `RING_RADII`, no `ringRadii` on the sky index, no `rings` on `PreviewSky`. `RING_LABELS` remains exported from `graph-layout.ts`.

- [ ] **Step 1: Change the canvas smoke first (failing)**

In `scripts/smoke-graph-canvas.ts`, replace `check("the rings survive", index.ringRadii.length > 0);` with:

```ts
  check(
    "there are no orbit rings to draw",
    !("ringRadii" in index) && !layout.nodes.some((n) => (n.type as string) === "orbitRings")
  );
```

Run: `npx tsx scripts/smoke-graph-canvas.ts`
Expected: FAIL at `there are no orbit rings to draw` (the index still carries `ringRadii`).

- [ ] **Step 2: Delete the plumbing**

Follow the compiler (`npx tsc --noEmit -p .`) after each file. Exact deletions, found by name:

- `src/lib/graph-layout.ts`: remove `export const RING_RADII`; remove the `OrbitRingsData` type; remove `"orbitRings"` from `LayoutNode["type"]` and `OrbitRingsData` from its `data` union. Keep `RING_LABELS` and rewrite its doc comment to "What each closeness score is called in the inspect panel."
- `src/components/graph/graph-nodes.tsx`: delete `OrbitRingsNodeComponent`, the `export const OrbitRingsNode = memo(...)` line, and the `OrbitRingsData` import; drop `RING_LABELS` from that file's import if it is now unused.
- `src/components/graph/graph-canvas-flow.tsx`: remove the `OrbitRingsNode` import, the `orbitRings: OrbitRingsNode,` entry of the node-types map, the `if (n.type === "orbitRings") { out.push(n); continue; }` branch, and `node.id === "rings" ||` in the drag/click guard (leave `node.id === STAR_DUST_ID`).
- `src/components/graph/sky-canvas/sky-index.ts`: remove the `ringRadii` field from the `SkyIndex` type, the `let ringRadii` local, the `if (node.type === "orbitRings") { … continue; }` branch, and `ringRadii` from the returned object.
- `src/components/graph/sky-canvas/draw-sky.ts`: delete the `if (index.ringRadii.length > 0) { … }` ring-drawing block and any constants only it used.
- `src/lib/graph/sky-camera.ts`: delete `if (n.type === "orbitRings") continue;`.
- `src/lib/graph/preview-sky.ts`: remove `let rings`, the `else if (n.type === "orbitRings")` branch, `rings` from the returned `PreviewSky` object, and the `OrbitRingsData` import.
- `src/lib/graph/preview-sky-shape.ts`: remove the `rings: number[]` field (and its doc line) and the `if (sky.rings.length > 0) { nodes.push({ id: "rings", … }) }` block.

Run: `npx tsc --noEmit -p . && npx eslint src/lib/graph-layout.ts src/components/graph/graph-nodes.tsx src/components/graph/graph-canvas-flow.tsx src/components/graph/sky-canvas/sky-index.ts src/components/graph/sky-canvas/draw-sky.ts src/lib/graph/sky-camera.ts src/lib/graph/preview-sky.ts src/lib/graph/preview-sky-shape.ts scripts/smoke-graph-canvas.ts`
Expected: tsc 0 errors; eslint 0 errors (a pre-existing warning in `network-graph.tsx` is not in this list). If eslint reports an unused import or constant you left behind, remove it.

- [ ] **Step 3: Run the affected smokes**

Run: `npx tsx scripts/run-smoke.ts --only smoke-graph-canvas smoke-graph-layout smoke-graph-family-seating smoke-sky-layout smoke-constellation-clusters`
Expected: all pass.

Also `grep -rn "orbitRings\|RING_RADII\|OrbitRingsData\|ringRadii" src scripts` must print nothing except the two `(n.type as string) === "orbitRings"` guard expressions in the smokes.

- [ ] **Step 4: Commit**

```bash
git add -A src scripts
git commit -m "refactor(constellation): remove the decorative orbit rings from layout and renderers

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Verification and docs

**Files:**
- Modify: `docs/superpowers/specs/2026-09-29-constellation-galaxy-design.md`
- Possibly modify: `scripts/fixtures/behavior-golden.json` (only via `--update`, only if the diff is layout-independent noise — see Step 2)

- [ ] **Step 1: Registry and targeted suite**

Run: `npx tsx scripts/run-smoke.ts --check && npx tsx scripts/run-smoke.ts --only smoke-cluster-affinity smoke-disk-placement smoke-galaxy-structure smoke-graph-layout smoke-graph-family-seating smoke-graph-canvas smoke-sky-layout smoke-constellation-clusters smoke-role-function smoke-school-key`
Expected: `--check` clean; all pass.

- [ ] **Step 2: DB-tier smokes**

Run: `npx tsx scripts/run-smoke.ts --only smoke-page-budgets smoke-behavior-golden smoke-constellation-payload-leak smoke-dashboard-aggregates`
Expected: all pass with no golden change (layout is not in any golden). If `smoke-behavior-golden` changes, do NOT re-record; report BLOCKED with the diff.

- [ ] **Step 3: Types, lint**

Run: `npx tsc --noEmit -p . && npx eslint src/lib/constellation-affinity.ts src/lib/graph/disk-placement.ts src/lib/graph/galaxy-structure.ts src/lib/graph-layout.ts scripts/smoke-cluster-affinity.ts scripts/smoke-disk-placement.ts scripts/smoke-galaxy-structure.ts scripts/smoke-graph-layout.ts scripts/smoke-graph-family-seating.ts scripts/smoke-graph-canvas.ts`
Expected: 0 errors.

- [ ] **Step 4: Layout cost and slice timing**

Whole layout: `npx tsx scripts/bench/constellation-layout.ts` — record every line. The machine is often at load ~15–20; compare against the base commit in a throwaway worktree, interleaved, exactly as the phase-1 verification did (`git worktree add --detach <scratchpad>/base 21561d5e`, symlink `node_modules`, run both alternately, remove the worktree after).

Per-slice cost (the ≤ ~15ms gate): create `scripts/.tmp-slices.ts`:

```ts
import { buildSyntheticGraphPayload } from "@/lib/graph/synthetic-network";
import { buildHybridGraphLayoutSteps } from "@/lib/graph-layout";

for (const n of [2500, 10000]) {
  const contacts = buildSyntheticGraphPayload(n, 1).contacts;
  const times: number[] = [];
  for (let rep = 0; rep < 3; rep++) {
    const steps = buildHybridGraphLayoutSteps(contacts, "You");
    const slices: number[] = [];
    let t = performance.now();
    for (;;) {
      const s = steps.next();
      const now = performance.now();
      slices.push(now - t);
      t = now;
      if (s.done) break;
    }
    times.push(Math.max(...slices));
  }
  console.log(n, "worst slice ms per rep:", times.map((x) => x.toFixed(1)).join(", "));
}
process.exit(0);
```

Run: `npx tsx scripts/.tmp-slices.ts` then delete the file.
Expected: worst slice ≤ ~15ms at 10,000 on a quiet machine (report the load average). If a slice is over, find which phase from the generator order (fit, geometry, affinity, placement seed, placement relax, positions, nodes) and report — the fix is usually a `yield;` in a loop, not an algorithm change.

- [ ] **Step 5: Correct the spec**

In `docs/superpowers/specs/2026-09-29-constellation-galaxy-design.md`, delete the bullet "Drag-position key bumps to `orbit-graph-positions-v6`, since old positions no longer mean anything." from "Removed / changed" and add: "There is no persisted drag-position key: nothing in `src` stores star positions, so nothing needs bumping." Commit:

```bash
git add docs/superpowers/specs/2026-09-29-constellation-galaxy-design.md
git commit -m "docs: constellation galaxy spec — no drag-position key exists to bump

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Visual check (controller, not a subagent)**

`preview_start {name: "orbit-demo-bench"}`, then `/bench/constellation?n=150&seed=3` and `?n=1000&seed=3` at 1440×960: related clusters (Google beside Google DeepMind where present; schools beside the companies their alumni work at) sit together; the biggest clusters are toward the middle; no rings; the unaffiliated stars fade into a soft halo instead of a dotted circle; zero console errors. Screenshot both for the PR.

---

## Self-review (against the spec)

- **Phase B seed/relax/resolve** → Task 2. **Phase C halo** → Task 4 (`haloField`). **Phase D galaxy structure** → Task 3 + Task 4 wiring. **Rings removed** → Tasks 4–5. **Affinity weights (deferred from phase 1)** → Task 1. **"Sun's clear zone empty"** → Task 2 test + existing `smoke-graph-layout` sun check. **"Related pairs sit closer than the median"** → Task 2 (synthetic families) and Task 4 (realistic network). **Determinism** → Tasks 1–3 and the existing layout determinism check. **Slice budget** → Task 6 Step 4.
- **Spec deviation, corrected in Task 6:** the drag-position key.
- **Not in this phase (by design):** petals, ring/binary/open geometry, per-member function annotations (phase 3); backdrop drawing, kind-specific looks (phase 4). `galaxy.filaments` and `coreRadius` are produced here and consumed in phase 4.
- **Type names used across tasks:** `AffinityEdge {a,b,weight}`, `AFFINITY`, `buildClusterAffinity`, `DiskInput {id,foot,size}`, `DiskPlacement {centers,diskRadius}`, `DiskOptions {sunClear,gap,iterations?}`, `placeClusterDisks`, `GalaxyFilament`, `GalaxyStructure`, `buildGalaxyStructure`, `FILAMENT_POINTS`, `MAX_FILAMENTS`, `haloField` — consistent in every task.
