# Constellation Galaxy — Phase 3: Cluster Anatomy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give clusters their own internal shapes: big companies become a leadership core plus one small constellation ("petal") per function; schools become rings; pairs and trios become tight binaries; role clusters keep an open figure. Also finish the leadership rule, and tighten small galaxies (deferred from phase 2).

**Architecture:** A cluster's fit stops being "one shape + members" and becomes a list of *parts* (`main`, or `core` + `petal:<fn>`), planned by a new pure module (`constellation-parts.ts`). Pure geometry helpers (`graph/cluster-anatomy.ts`) place stars on rings and arrange part disks around a core. `buildClusterGeometry` in `graph-layout.ts` builds each part with the existing figure-plus-scatter code and offsets it; the layout emits the new per-cluster `form`, per-petal labels and per-star part info for phase 4 to draw. Non-split clusters keep exactly the figure and positions they have today.

**Tech Stack:** TypeScript, smoke scripts run with `npx tsx`, suite runner `scripts/run-smoke.ts`.

**Spec:** `docs/superpowers/specs/2026-09-29-constellation-galaxy-design.md` (section 2 "Phase A — cluster-local geometry"; build phase 3).

## Global Constraints

- Forms, decided per cluster (all clusters reaching the layout have ≥ 2 members):
  - **binary**: 2–3 members, any kind. (Geometry is today's pair/triple figure; the look is phase 4.)
  - **petal**: company with ≥ 8 members AND ≥ 2 function groups of ≥ 2 non-leader members (after folding lone-function members into "Other"); otherwise **figure** (company ≥ 4).
  - **open**: role cluster with ≥ 4 members (same geometry as figure).
  - **ring**: school with ≥ 4 members.
- Petal parts: `core` = the cluster's leaders (`isLeader` from `classifyTitle`), label "Leadership"; one `petal:<fn>` per function group of non-leaders, size ≥ 2, labelled from `FUNCTION_LABELS`; a group of one is folded into "Other"; a lone "Other" is folded into the largest petal. A part's top ≤ `FIGURE_STAR_MAX` (9) members trace its figure; the rest scatter around that part. Inside a petal the figure's stars are ordered so members sharing a school sit on adjacent stars (`knotOrder`).
- Rings: stars at least `RING_SPACING` (124px, the diagonal of a label-clearance box) apart; outer ring radius clamped to [124, 420]; overflow on inner rings 124px inward while radius ≥ 124; members beyond `RING_CAPACITY` scatter outside. Ring clusters draw NO figure lines; their members are `figureRole: "figure"`.
- Parts of a petal cluster sit on disjoint footprint disks at least `PART_GAP` (64px) apart, the core at the cluster origin, petals on a ring round it. Cluster-level guarantees are unchanged: star–star ≥ 18px, star–line ≥ 12px, no label overlaps, no crossing figure lines, figures are pure similarity transforms of their shape, cluster disks ≥ 104px apart.
- A cluster that is not split (`figure`/`open`/`binary`) keeps the shape assignment, rotation and scatter positions it has today (same seeds); `assignClusterShapes` is called with every cluster under its own id first, exactly as before, and petal parts ask AFTER them under `<clusterId>#<partKey>`.
- Layout output additions only (no removals a renderer depends on): `ClusterLabelData.form`, `ClusterLabelData.petalLabels`, `GraphNodeData.partKey/partRole/leader`. No new payload fields, no DB queries. Nothing new is drawn in this phase.
- Deterministic and independent of contact order (ids as final tie-breaks, codepoint comparison, no locale-dependent sorts).
- Every new `scripts/smoke-*.ts` is registered in `scripts/run-smoke.ts` (`"pure"`).
- Commit messages end with the line `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Run commands from `/Users/jasonpereira/Projects/claude-worktrees/orbit/constellation-render-clustering-b81406`. Never `git stash`; never kill processes (a bench dev server may be running on port 3001 from this worktree — leave it). Temporary scripts go at `scripts/.tmp-*.ts` and are deleted before committing.

---

## File Structure

| File | Responsibility |
|---|---|
| Modify `src/lib/role-function.ts` | Task 1: leader rule no longer strips "Owner & Creative Director". |
| Create `src/lib/graph/cluster-anatomy.ts` | Pure geometry: `ringLayout`, `RING_CAPACITY`, `arrangeParts`. |
| Create `src/lib/constellation-parts.ts` | Pure planning: `planClusterParts` (form + parts), `knotOrder`, `FUNCTION_LABELS`. |
| Modify `src/lib/constellation-fit.ts` | `ClusterFit` gains `form` and `parts`; shapes per part; edges per part. |
| Modify `src/lib/graph-layout.ts` | Per-part geometry, petal/ring layout, new node fields, petal labels. |
| Modify `src/lib/graph/disk-placement.ts` | Task 6 only: small-galaxy tightening. |
| Create `scripts/smoke-cluster-anatomy.ts`, `smoke-constellation-parts.ts`, `smoke-constellation-fit.ts` | Pure-tier specs. |
| Modify `scripts/smoke-role-function.ts`, `smoke-graph-layout.ts`, `run-smoke.ts`, the spec | Rows, fixtures, registry, "as built". |

---

### Task 1: Leadership rule — junior titles cancel only the junior title

**Files:**
- Modify: `src/lib/role-function.ts`
- Test: `scripts/smoke-role-function.ts`

**Interfaces:**
- Produces: unchanged (`classifyTitle`, `roleClusterKey`, …). Behaviour change: `JUNIOR_EXEC` no longer removes leadership that comes from a *different* strong or weak-exec word ("Owner & Creative Director" stays a leader); it still removes it from "Assistant Vice President" (whose only leadership word is "president").

- [ ] **Step 1: Write the failing rows**

In `scripts/smoke-role-function.ts`, add to the `TABLE` (before its closing `];`):

```ts
  ["Owner & Creative Director", "design", true],
  ["Partner, Art Director", "design", true],
  ["President & Creative Director", "design", true],
  ["Creative Director", "design", false],
  ["Assistant Vice President", "other", false],
  ["Associate Director", "other", false],
```

Run: `npx tsx scripts/smoke-role-function.ts`
Expected: FAIL on `"Owner & Creative Director"` (currently not a leader).

- [ ] **Step 2: Implement**

In `src/lib/role-function.ts`, add beside `JUNIOR_EXEC`:

```ts
/**
 * The one junior title that trips FOUNDER_EXEC on its own: "Assistant Vice President" matches
 * "president". Every other junior title (associate/assistant/art/creative director) never
 * matches FOUNDER_EXEC, so it must not cancel an owner's or partner's leadership.
 */
const JUNIOR_PRESIDENT = /\bassistant vice president\b/i;
```

and in `classifyTitle`, change the weak-path clause from `!JUNIOR_EXEC.test(value)` to `!JUNIOR_PRESIDENT.test(value)`:

```ts
  const isLeader =
    STRONG_EXEC.test(value) ||
    (FOUNDER_EXEC.test(value) && !NOT_LEADER.test(value) && !JUNIOR_PRESIDENT.test(value)) ||
    isExecutive(value);
```

(`isExecutive` keeps using `JUNIOR_EXEC`, so "Creative Director" alone stays a non-leader.)

- [ ] **Step 3: Verify**

Run: `npx tsx scripts/smoke-role-function.ts && npx tsx scripts/smoke-event-relevance.ts && npx tsc --noEmit -p .`
Expected: both smokes pass; tsc clean.

- [ ] **Step 4: Commit**

```bash
git add src/lib/role-function.ts scripts/smoke-role-function.ts
git commit -m "fix(role-function): junior directors no longer strip an owner's leadership

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Anatomy geometry — rings and part arrangement

**Files:**
- Create: `src/lib/graph/cluster-anatomy.ts`
- Test: `scripts/smoke-cluster-anatomy.ts`
- Modify: `scripts/run-smoke.ts` (beside `"smoke-galaxy-structure": "pure",`)

**Interfaces:**
- Consumes: `hashUnit(seed: string, salt: number): number` from `@/lib/hash`.
- Produces:
  - `const RING_SPACING = 124`, `RING_MIN_RADIUS = 124`, `RING_MAX_RADIUS = 420`
  - `function ringCapacity(radius: number, spacing?: number): number`
  - `const RING_CAPACITY: number` (stars the rings hold at most; 43)
  - `type RingLayout = { positions: Array<{ x: number; y: number }>; radius: number }`
  - `function ringLayout(count: number, seed: string): RingLayout` — places exactly `min(count, RING_CAPACITY)` stars, first ring at `radius` (the outermost), further rings 124px inward.
  - `type PartDisk = { key: string; foot: number }`
  - `type PartArrangement = { centers: Map<string, { x: number; y: number }>; foot: number }`
  - `function arrangeParts(core: PartDisk | null, petals: PartDisk[], gap: number, seed: string): PartArrangement` — core at (0,0), petals on a ring; every pair of disks ≥ `gap` apart edge to edge; `foot` = radius of the disk holding everything.

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-cluster-anatomy.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/smoke-cluster-anatomy.ts`
Expected: FAIL — `Cannot find module '../src/lib/graph/cluster-anatomy'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/graph/cluster-anatomy.ts`:

```ts
/**
 * The geometry of a cluster's parts, on plain numbers.
 *
 * Two shapes need real geometry beyond "a figure plus scatter":
 *   - a school is a RING: members on a circle (and inner circles when there are many), so the
 *     cluster reads as a school rather than a constellation;
 *   - a big company is a CORE with PETALS: the parts' footprint disks sit round the core, each
 *     part built by the ordinary figure-plus-scatter code, and this module says where.
 *
 * Every spacing here is chosen so name labels cannot overlap: two stars need a centre distance
 * of at least the diagonal of a label-clearance box (112 × 44 → ~120), not merely 112 sideways.
 */

import { hashUnit } from "@/lib/hash";

export const RING_SPACING = 124;
export const RING_MIN_RADIUS = 124;
export const RING_MAX_RADIUS = 420;

/** Stars that fit on a ring of `radius` with centres at least `spacing` apart. */
export function ringCapacity(radius: number, spacing = RING_SPACING): number {
  const half = Math.min(1, spacing / (2 * radius));
  return Math.floor(Math.PI / Math.asin(half) + 1e-9);
}

function ringRadii(outer: number): number[] {
  const radii: number[] = [];
  for (let r = outer; r >= RING_MIN_RADIUS - 1e-9; r -= RING_SPACING) radii.push(r);
  return radii;
}

/** The most stars the rings ever hold: a full-size outer ring and every ring inside it. */
export const RING_CAPACITY = ringRadii(RING_MAX_RADIUS).reduce((sum, r) => sum + ringCapacity(r), 0);

export type RingLayout = {
  positions: Array<{ x: number; y: number }>;
  /** The outermost ring's radius. */
  radius: number;
};

/**
 * `count` stars on rings. The outer ring is just big enough for them all (or the largest
 * allowed); what does not fit goes on rings further in. Places at most `RING_CAPACITY` — the
 * caller scatters the rest. The seed only rotates the whole figure.
 */
export function ringLayout(count: number, seed: string): RingLayout {
  const n = Math.min(count, RING_CAPACITY);
  const outer = Math.min(
    RING_MAX_RADIUS,
    Math.max(RING_MIN_RADIUS, RING_SPACING / (2 * Math.sin(Math.PI / Math.max(3, n))))
  );
  const start = hashUnit(seed, 41) * Math.PI * 2;
  const positions: Array<{ x: number; y: number }> = [];
  let left = n;
  ringRadii(outer).forEach((radius, ring) => {
    if (left <= 0) return;
    const k = Math.min(left, ringCapacity(radius));
    // Alternate rings are offset by half a step, so stars on neighbouring rings do not line up.
    const offset = start + (ring % 2 ? Math.PI / k : 0);
    for (let i = 0; i < k; i++) {
      const angle = offset + (i / k) * Math.PI * 2;
      positions.push({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
    }
    left -= k;
  });
  return { positions, radius: outer };
}

export type PartDisk = { key: string; foot: number };
export type PartArrangement = {
  centers: Map<string, { x: number; y: number }>;
  /** Radius of the disk, centred on the cluster origin, that holds every part. */
  foot: number;
};

const codepoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Place the core at the origin and the petals on a ring round it, no two footprint disks
 * closer than `gap`.
 *
 * Big and small petals alternate round the ring (two giants side by side would set the radius
 * for everyone). The ring's radius is the smallest whose adjacent-pair arcs fit in a circle,
 * then a verification pass grows it until EVERY pair — not just neighbours — clears, because a
 * big disk can reach past its neighbour to the next one.
 */
export function arrangeParts(
  core: PartDisk | null,
  petals: PartDisk[],
  gap: number,
  seed: string
): PartArrangement {
  const centers = new Map<string, { x: number; y: number }>();
  const coreFoot = core?.foot ?? 0;
  if (core) centers.set(core.key, { x: 0, y: 0 });
  if (petals.length === 0) return { centers, foot: coreFoot };
  const start = hashUnit(seed, 43) * Math.PI * 2;

  const sorted = [...petals].sort((a, b) => b.foot - a.foot || codepoint(a.key, b.key));
  const order: PartDisk[] = [];
  for (let lo = 0, hi = sorted.length - 1; lo <= hi; lo++, hi--) {
    order.push(sorted[lo]);
    if (lo !== hi) order.push(sorted[hi]);
  }
  const n = order.length;
  const f = order.map((p) => p.foot);

  if (n === 1) {
    const d = core ? coreFoot + f[0] + gap : 0;
    centers.set(order[0].key, { x: Math.cos(start) * d, y: Math.sin(start) * d });
    return { centers, foot: Math.max(coreFoot, d + f[0]) };
  }

  const need = (i: number) => f[i] + f[(i + 1) % n] + gap;
  const arcs = (radius: number) => {
    let total = 0;
    for (let i = 0; i < n; i++) total += 2 * Math.asin(Math.min(1, need(i) / (2 * radius)));
    return total;
  };
  let R = Math.max(
    ...Array.from({ length: n }, (_, i) => need(i) / 2),
    core ? coreFoot + Math.max(...f) + gap : 0
  );
  if (arcs(R) > Math.PI * 2) {
    let lo = R;
    let hi = R * 2;
    while (arcs(hi) > Math.PI * 2) hi *= 2;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (arcs(mid) > Math.PI * 2) lo = mid;
      else hi = mid;
    }
    R = hi;
  }

  const place = (radius: number) => {
    const slack = Math.max(0, Math.PI * 2 - arcs(radius)) / n;
    const out: Array<{ x: number; y: number }> = [];
    let theta = start;
    for (let i = 0; i < n; i++) {
      out.push({ x: Math.cos(theta) * radius, y: Math.sin(theta) * radius });
      theta += 2 * Math.asin(Math.min(1, need(i) / (2 * radius))) + slack;
    }
    return out;
  };
  const clear = (pts: Array<{ x: number; y: number }>) => {
    for (let i = 0; i < n; i++) {
      if (core && Math.hypot(pts[i].x, pts[i].y) < coreFoot + f[i] + gap - 1e-6) return false;
      for (let j = i + 1; j < n; j++) {
        if (Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y) < f[i] + f[j] + gap - 1e-6) return false;
      }
    }
    return true;
  };
  let pts = place(R);
  for (let tries = 0; tries < 200 && !clear(pts); tries++) {
    R *= 1.04;
    pts = place(R);
  }
  order.forEach((p, i) => centers.set(p.key, pts[i]));
  return { centers, foot: Math.max(coreFoot, R + Math.max(...f)) };
}
```

- [ ] **Step 4: Register the smoke**

In `scripts/run-smoke.ts`, beside `"smoke-galaxy-structure": "pure",`:

```ts
  "smoke-cluster-anatomy": "pure",
```

- [ ] **Step 5: Run the test and lint**

Run: `npx tsx scripts/smoke-cluster-anatomy.ts && npx tsc --noEmit -p . && npx eslint src/lib/graph/cluster-anatomy.ts scripts/smoke-cluster-anatomy.ts`
Expected: ends with `cluster-anatomy: all checks passed`; tsc and eslint clean.

If a ring check fails on the exact-chord boundary (a count that should fit by one), the culprit is float rounding in `ringCapacity`'s `+ 1e-9` — widen the epsilon in the code, never loosen a test.

- [ ] **Step 6: Commit**

```bash
git add src/lib/graph/cluster-anatomy.ts scripts/smoke-cluster-anatomy.ts scripts/run-smoke.ts
git commit -m "feat(constellation): ring layout and part arrangement geometry

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Part planning

**Files:**
- Create: `src/lib/constellation-parts.ts`
- Test: `scripts/smoke-constellation-parts.ts`
- Modify: `scripts/run-smoke.ts`

**Interfaces:**
- Consumes: `classifyTitle`, `RoleFunction` from `@/lib/role-function`; `ClusterKind` (type) from `@/lib/constellation-clusters`.
- Produces:
  - `type ClusterForm = "petal" | "figure" | "ring" | "binary" | "open"`
  - `type PartRole = "main" | "core" | "petal"`
  - `type PartPlan = { key: string; label: string | null; role: PartRole; memberIds: string[] }` (`key`: `"main"`, `"core"` or `petal:<fn>`)
  - `type PlanInput = { id: string; title?: string | null }`
  - `const FUNCTION_LABELS: Record<RoleFunction, string>`
  - `const PETAL_MIN_MEMBERS = 8`, `PETAL_MIN_GROUP = 2`
  - `function planClusterParts(cluster: { kind: ClusterKind; count: number }, ordered: PlanInput[]): { form: ClusterForm; parts: PartPlan[] }` — `ordered` is already in placement order (best first); every part's `memberIds` keeps that relative order; every member appears in exactly one part.
  - `function knotOrder(ids: string[], schoolOf: (id: string) => string | null): string[]` — members sharing a school key made adjacent (each school's run placed where its first member appeared); members with no school stay in place.

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-constellation-parts.ts`:

```ts
/**
 * What a cluster is made of: its form, and — for a big company — a leadership core and one
 * petal per function. Pure: no DB, no network.
 * Run: npx tsx scripts/smoke-constellation-parts.ts
 */
import {
  FUNCTION_LABELS,
  knotOrder,
  planClusterParts,
  type PlanInput,
} from "../src/lib/constellation-parts";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const people = (titles: Array<string | null>, prefix = "m"): PlanInput[] =>
  titles.map((title, i) => ({ id: `${prefix}${String(i).padStart(2, "0")}`, title }));
const many = (n: number, title: string | null, from = 0, prefix = "m") =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}${String(from + i).padStart(2, "0")}`, title }));
const company = (members: PlanInput[]) => planClusterParts({ kind: "company", count: members.length }, members);
const covers = (members: PlanInput[], parts: Array<{ memberIds: string[] }>) => {
  const ids = parts.flatMap((p) => p.memberIds).sort();
  return JSON.stringify(ids) === JSON.stringify(members.map((m) => m.id).sort());
};

console.log("\nForms by kind and size");
{
  check("2 members are a binary", planClusterParts({ kind: "company", count: 2 }, many(2, null)).form === "binary");
  check("3 members are a binary, whatever the kind", ["company", "role", "school"].every((kind) => planClusterParts({ kind: kind as "company", count: 3 }, many(3, null)).form === "binary"));
  check("a company of 5 with no titles is a figure", company(many(5, null)).form === "figure");
  check("a role cluster of 4 is open", planClusterParts({ kind: "role", count: 4 }, many(4, "Engineer")).form === "open");
  check("a school of 4 is a ring", planClusterParts({ kind: "school", count: 4 }, many(4, null)).form === "ring");
  const single = company(many(6, null));
  check("a non-split cluster has one 'main' part holding everyone", single.parts.length === 1 && single.parts[0].key === "main" && single.parts[0].role === "main" && single.parts[0].label === null && covers(many(6, null), single.parts));
}

console.log("\nPetals");
{
  const m = [...many(2, "VP Engineering", 0), ...many(6, "Software Engineer", 2), ...many(4, "Product Designer", 8), ...many(3, "Account Executive", 12)];
  const plan = company(m);
  check("a company with leaders and several functions is a petal cluster", plan.form === "petal");
  check("its first part is the leadership core", plan.parts[0].key === "core" && plan.parts[0].role === "core" && plan.parts[0].label === "Leadership" && plan.parts[0].memberIds.join() === "m00,m01");
  check("the petals follow, biggest first", plan.parts.slice(1).map((p) => p.key).join() === "petal:engineering,petal:design,petal:sales");
  check("petals are labelled by function", plan.parts[1].label === FUNCTION_LABELS.engineering && plan.parts[2].label === "Design");
  check("everyone is in exactly one part", covers(m, plan.parts));
  check("members keep their placement order inside a part", plan.parts[1].memberIds.join() === "m02,m03,m04,m05,m06,m07");

  const noLeaders = company([...many(4, "Software Engineer", 0), ...many(4, "Product Designer", 4)]);
  check("no leaders means no core", noLeaders.form === "petal" && noLeaders.parts.every((p) => p.role === "petal"));
  const oneLeader = company([...many(1, "CEO", 0), ...many(4, "Software Engineer", 1), ...many(4, "Product Designer", 5)]);
  check("a single leader is a core of one", oneLeader.parts[0].role === "core" && oneLeader.parts[0].memberIds.length === 1);

  check("7 members are too few for petals", company([...many(4, "Software Engineer", 0), ...many(3, "Product Designer", 4)]).form === "figure");
  check("one function is not petals", company(many(10, "Software Engineer")).form === "figure");
  check("leaders plus one function are not petals", company([...many(3, "CEO", 0), ...many(8, "Software Engineer", 3)]).form === "figure");
}

console.log("\nFolding lone members");
{
  const m = [...many(4, "Software Engineer", 0), ...many(4, "Product Designer", 4), { id: "m08", title: "Data Scientist" }, { id: "m09", title: "Account Executive" }];
  const plan = company(m);
  check("two lone functions fold into 'Other'", plan.form === "petal" && plan.parts.some((p) => p.key === "petal:other" && p.memberIds.join() === "m08,m09"));

  const one = company([...many(4, "Software Engineer", 0), ...many(4, "Product Designer", 4), { id: "m08", title: "Data Scientist" }]);
  check("a lone 'Other' joins the largest petal", one.form === "petal" && !one.parts.some((p) => p.key === "petal:other") && one.parts[0].memberIds.includes("m08") && covers([...many(4, "Software Engineer", 0), ...many(4, "Product Designer", 4), { id: "m08", title: "Data Scientist" }], one.parts));
  check("ties for 'largest' go to the earlier function key (no leaders, so it is the first part)", one.parts[0].key === "petal:design" && one.parts[0].memberIds.length === 5);
}

console.log("\nSchool knots");
{
  const school: Record<string, string | null> = { a: "mit", b: "waterloo", c: "mit", d: null, e: "waterloo", f: "mit" };
  const out = knotOrder(["a", "b", "c", "d", "e", "f"], (id) => school[id] ?? null);
  check("members of one school become adjacent", out.join() === "a,c,f,b,e,d", out.join());
  check("nobody is dropped or duplicated", [...out].sort().join() === "a,b,c,d,e,f");
  check("with no schools nothing moves", knotOrder(["x", "y", "z"], () => null).join() === "x,y,z");
}

console.log("\nDeterminism");
{
  const m = [...many(2, "VP Engineering", 0), ...many(6, "Software Engineer", 2), ...many(4, "Product Designer", 8)];
  check("planning is deterministic", JSON.stringify(company(m)) === JSON.stringify(company(m)));
}

console.log("\nconstellation-parts: all checks passed");
process.exit(0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/smoke-constellation-parts.ts`
Expected: FAIL — `Cannot find module '../src/lib/constellation-parts'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/constellation-parts.ts`:

```ts
/**
 * What a cluster is made of.
 *
 * Most clusters are one figure. A big company is not: 300 people at Google drawn as nine
 * stars and 290 dots is a blob, so it is split into a leadership CORE (the people who lead) and
 * one PETAL per function, each a small constellation of its own. This module decides that
 * split from titles alone — pure, no geometry — so the fit, the layout and the tests all read
 * one decision.
 *
 * `ordered` arrives in placement order (active before dormant, closest first). Every part
 * keeps that relative order, so a part's top members are its best ones.
 */

import type { ClusterKind } from "@/lib/constellation-clusters";
import { classifyTitle, type RoleFunction } from "@/lib/role-function";

export type ClusterForm = "petal" | "figure" | "ring" | "binary" | "open";
export type PartRole = "main" | "core" | "petal";
export type PartPlan = {
  key: string;
  label: string | null;
  role: PartRole;
  memberIds: string[];
};
export type PlanInput = { id: string; title?: string | null };

export const FUNCTION_LABELS: Record<RoleFunction, string> = {
  founders: "Founders & Execs",
  engineering: "Engineering",
  product: "Product",
  design: "Design",
  data: "Data & Research",
  sales: "Sales & BD",
  marketing: "Marketing",
  people: "People & Recruiting",
  operations: "Operations",
  other: "Other",
};

/** A company needs this many people, and… */
export const PETAL_MIN_MEMBERS = 8;
/** …at least two function groups of this many, to be worth splitting. */
export const PETAL_MIN_GROUP = 2;

const codepoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function planCompany(ordered: PlanInput[]): PartPlan[] | null {
  if (ordered.length < PETAL_MIN_MEMBERS) return null;
  const rank = new Map(ordered.map((m, i) => [m.id, i]));
  const byRank = (a: string, b: string) => rank.get(a)! - rank.get(b)!;

  const leaders: string[] = [];
  const groups = new Map<RoleFunction, string[]>();
  for (const m of ordered) {
    const { fn, isLeader } = classifyTitle(m.title);
    if (isLeader) {
      leaders.push(m.id);
    } else {
      const list = groups.get(fn) ?? [];
      list.push(m.id);
      groups.set(fn, list);
    }
  }

  // A function with one person is no petal: they join "Other".
  const other = [...(groups.get("other") ?? [])];
  for (const [fn, ids] of [...groups]) {
    if (fn !== "other" && ids.length < PETAL_MIN_GROUP) {
      other.push(...ids);
      groups.delete(fn);
    }
  }
  other.sort(byRank);
  if (other.length > 0) groups.set("other", other);
  else groups.delete("other");

  // …and a lone "Other" joins the largest real petal, if there is one.
  if (other.length > 0 && other.length < PETAL_MIN_GROUP) {
    const target = [...groups]
      .filter(([fn, ids]) => fn !== "other" && ids.length >= PETAL_MIN_GROUP)
      .sort((a, b) => b[1].length - a[1].length || codepoint(a[0], b[0]))[0];
    if (target) {
      target[1].push(...other);
      target[1].sort(byRank);
      groups.delete("other");
    }
  }

  const petals = [...groups].filter(([, ids]) => ids.length >= PETAL_MIN_GROUP);
  if (petals.length < 2) return null;
  petals.sort((a, b) => b[1].length - a[1].length || codepoint(a[0], b[0]));

  const parts: PartPlan[] = [];
  if (leaders.length > 0) {
    parts.push({ key: "core", label: "Leadership", role: "core", memberIds: leaders });
  }
  for (const [fn, ids] of petals) {
    parts.push({ key: `petal:${fn}`, label: FUNCTION_LABELS[fn], role: "petal", memberIds: ids });
  }
  return parts;
}

export function planClusterParts(
  cluster: { kind: ClusterKind; count: number },
  ordered: PlanInput[]
): { form: ClusterForm; parts: PartPlan[] } {
  const main = (form: ClusterForm) => ({
    form,
    parts: [
      { key: "main", label: null, role: "main" as const, memberIds: ordered.map((m) => m.id) },
    ],
  });
  if (ordered.length <= 3) return main("binary");
  if (cluster.kind === "role") return main("open");
  if (cluster.kind === "school") return main("ring");
  const petals = cluster.kind === "company" ? planCompany(ordered) : null;
  return petals ? { form: "petal", parts: petals } : main("figure");
}

/**
 * Members who share a school made adjacent: each school's run sits where its first member was.
 * Applied to a petal's figure stars, so classmates are joined by a figure line rather than
 * scattered across the shape. Members with no school stay where they are.
 */
export function knotOrder(ids: string[], schoolOf: (id: string) => string | null): string[] {
  const bySchool = new Map<string, string[]>();
  for (const id of ids) {
    const school = schoolOf(id);
    if (!school) continue;
    const run = bySchool.get(school) ?? [];
    run.push(id);
    bySchool.set(school, run);
  }
  const out: string[] = [];
  const emitted = new Set<string>();
  for (const id of ids) {
    if (emitted.has(id)) continue;
    const school = schoolOf(id);
    for (const member of school ? bySchool.get(school)! : [id]) {
      emitted.add(member);
      out.push(member);
    }
  }
  return out;
}
```

- [ ] **Step 4: Register the smoke**

In `scripts/run-smoke.ts`, beside `"smoke-cluster-anatomy": "pure",`:

```ts
  "smoke-constellation-parts": "pure",
```

- [ ] **Step 5: Run the test and lint**

Run: `npx tsx scripts/smoke-constellation-parts.ts && npx tsc --noEmit -p . && npx eslint src/lib/constellation-parts.ts scripts/smoke-constellation-parts.ts`
Expected: ends with `constellation-parts: all checks passed`; tsc and eslint clean.

If a `classifyTitle` expectation in the test surprises you (a title landing in a different function than the fixture assumes), check the title against `scripts/smoke-role-function.ts`'s table first — those rows are the spec.

- [ ] **Step 6: Commit**

```bash
git add src/lib/constellation-parts.ts scripts/smoke-constellation-parts.ts scripts/run-smoke.ts
git commit -m "feat(constellation): plan a cluster's form and parts — core, petals, rings

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The fit carries parts

**Files:**
- Modify: `src/lib/constellation-fit.ts`
- Test: `scripts/smoke-constellation-fit.ts`
- Modify: `scripts/run-smoke.ts`

**Interfaces:**
- Consumes: `planClusterParts`, `knotOrder`, `ClusterForm`, `PartRole` (Task 3); `RING_CAPACITY` (Task 2); `schoolGroupKeys` from `@/lib/school-key`; `assignClusterShapes`, `figureStarCount`, `ConstellationShape` from `@/lib/constellation-shapes`.
- Produces:
  - `type FitPart = { key: string; label: string | null; role: PartRole; shape: ConstellationShape; figureMemberIds: string[]; scatterMemberIds: string[] }`
  - `const RING_SHAPE: ConstellationShape` (`{ id: "ring", name: "Ring", stars: [], edges: [] }`)
  - `ClusterFit` gains `form: ClusterForm` and `parts: FitPart[]`; its existing `shape` / `figureMemberIds` / `scatterMemberIds` stay as aggregates (`shape` = first part's; the id lists are the parts' lists concatenated in part order).
  - `constellationFitEdges` draws each part's own shape edges (a ring has none).

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-constellation-fit.ts`:

```ts
/**
 * The fit: which stars trace which figure, per part. Pure: no DB, no network.
 * Run: npx tsx scripts/smoke-constellation-fit.ts
 */
import {
  buildConstellationFit,
  constellationFitEdges,
  RING_SHAPE,
} from "../src/lib/constellation-fit";
import { RING_CAPACITY } from "../src/lib/graph/cluster-anatomy";
import type { GraphContactInput } from "../src/lib/graph-layout";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

let n = 0;
function person(over: Partial<GraphContactInput>): GraphContactInput {
  n += 1;
  return {
    id: `p${String(n).padStart(3, "0")}`,
    fullName: `Person ${n}`,
    company: null,
    title: null,
    relationshipScore: 3,
    lastInteractionAt: "2026-08-20T00:00:00.000Z",
    nextFollowUpAt: null,
    tags: [],
    aiSummary: null,
    keyFacts: null,
    orbitScore: 1 + (n % 5),
    ...over,
  };
}
const group = (count: number, over: Partial<GraphContactInput>) => Array.from({ length: count }, () => person(over));

const contacts: GraphContactInput[] = [
  // A company big enough to split: 3 leaders, 10 engineers, 7 designers, 5 sales.
  ...group(1, { company: "Northwind", title: "VP Engineering", school: "MIT" }),
  ...group(1, { company: "Northwind", title: "CTO" }),
  ...group(1, { company: "Northwind", title: "Co-founder" }),
  ...group(10, { company: "Northwind", title: "Software Engineer" }).map((c, i) => ({ ...c, school: i % 2 ? "MIT" : i % 3 ? "Waterloo" : null })),
  ...group(7, { company: "Northwind", title: "Product Designer" }),
  ...group(5, { company: "Northwind", title: "Account Executive" }),
  // A plain company, a pair, a school, a big school.
  ...group(6, { company: "Plainco" }),
  ...group(2, { company: "Pairco" }),
  ...group(14, { school: "Chapel Hill" }),
  ...group(60, { school: "State U" }),
];
const fit = buildConstellationFit(contacts);
const byName = (name: string) => [...fit.fits.values()].find((f) => f.cluster.name === name)!;

console.log("\nForms");
{
  check("Northwind is split into petals", byName("Northwind").form === "petal");
  check("Plainco stays a figure", byName("Plainco").form === "figure");
  check("Pairco is a binary", byName("Pairco").form === "binary");
  check("Chapel Hill is a ring", byName("Chapel Hill").form === "ring");
  check("State U is a ring", byName("State U").form === "ring");
}

console.log("\nParts");
{
  const nw = byName("Northwind");
  check("Northwind has a core and three petals", nw.parts.map((p) => p.key).join() === "core,petal:engineering,petal:design,petal:sales");
  check("every member is in exactly one part, as figure or scatter", JSON.stringify(nw.parts.flatMap((p) => [...p.figureMemberIds, ...p.scatterMemberIds]).sort()) === JSON.stringify([...nw.cluster.contactIds].sort()));
  check("each part's figure is at most its shape's size and at most 9", nw.parts.every((p) => p.figureMemberIds.length === Math.min(p.shape.stars.length, p.figureMemberIds.length) && p.figureMemberIds.length <= 9));
  const eng = nw.parts.find((p) => p.key === "petal:engineering")!;
  check("a petal with 10 members traces a 9-star figure and scatters one", eng.figureMemberIds.length === 9 && eng.scatterMemberIds.length === 1);
  check("the aggregates are the parts joined", nw.figureMemberIds.join() === nw.parts.flatMap((p) => p.figureMemberIds).join() && nw.shape === nw.parts[0].shape);

  const plain = byName("Plainco");
  check("a figure has one 'main' part holding all 6 members", plain.parts.length === 1 && plain.parts[0].key === "main" && plain.figureMemberIds.length + plain.scatterMemberIds.length === 6 && plain.figureMemberIds.length <= 9);

  const ring = byName("Chapel Hill");
  check("a ring's members are all figure stars on the ring shape", ring.parts[0].shape === RING_SHAPE && ring.figureMemberIds.length === 14 && ring.scatterMemberIds.length === 0);
  const big = byName("State U");
  check("a huge school scatters what the rings cannot hold", big.figureMemberIds.length === RING_CAPACITY && big.scatterMemberIds.length === 60 - RING_CAPACITY);
}

console.log("\nEdges");
{
  const edges = constellationFitEdges(fit);
  const ofCluster = (name: string) => edges.filter((e) => e.clusterName === name);
  check("a ring draws no lines", ofCluster("Chapel Hill").length === 0 && ofCluster("State U").length === 0);
  check("a figure draws lines", ofCluster("Plainco").length > 0);
  const nw = byName("Northwind");
  const partOf = new Map<string, string>();
  for (const p of nw.parts) for (const id of p.figureMemberIds) partOf.set(id, p.key);
  const nwEdges = ofCluster("Northwind");
  check("petal clusters draw lines", nwEdges.length > 0);
  check("a line never joins two different parts", nwEdges.every((e) => partOf.get(e.source) === partOf.get(e.target)));
}

console.log("\nStability");
{
  const again = buildConstellationFit(contacts);
  check("deterministic", JSON.stringify([...again.fits.entries()]) === JSON.stringify([...fit.fits.entries()]));
  const reversed = buildConstellationFit([...contacts].reverse());
  const sig = (f: typeof fit) => JSON.stringify([...f.fits.entries()].sort().map(([id, x]) => [id, x.form, x.parts.map((p) => [p.key, p.shape.id, p.figureMemberIds, p.scatterMemberIds])]));
  check("independent of contact order", sig(reversed) === sig(fit));
  const knot = byName("Northwind").parts.find((p) => p.key === "petal:engineering")!;
  const schools = knot.figureMemberIds.map((id) => contacts.find((c) => c.id === id)!.school ?? null);
  let runs = 0;
  for (let i = 0; i < schools.length; i++) if (schools[i] && schools[i] !== schools[i - 1]) runs += 1;
  const distinct = new Set(schools.filter(Boolean)).size;
  check(`classmates sit on adjacent stars (${runs} runs for ${distinct} schools)`, runs === distinct);
}

console.log("\nconstellation-fit: all checks passed");
process.exit(0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/smoke-constellation-fit.ts`
Expected: FAIL — `RING_SHAPE` is not exported / `byName("Northwind").form` is undefined.

- [ ] **Step 3: Implement**

In `src/lib/constellation-fit.ts`:

Add imports:

```ts
import {
  knotOrder,
  planClusterParts,
  type ClusterForm,
  type PartRole,
} from "@/lib/constellation-parts";
import { RING_CAPACITY } from "@/lib/graph/cluster-anatomy";
import { schoolGroupKeys } from "@/lib/school-key";
```

Replace the `ClusterFit` type with:

```ts
/** A ring's stars are drawn with no figure lines: a school is a place, not a picture. */
export const RING_SHAPE: ConstellationShape = { id: "ring", name: "Ring", stars: [], edges: [] };

/** One figure in a cluster: the whole of a small cluster, or a core / petal of a big company. */
export type FitPart = {
  key: string;
  label: string | null;
  role: PartRole;
  shape: ConstellationShape;
  /** figureMemberIds[i] traces shape.stars[i], in placement order. */
  figureMemberIds: string[];
  /** Members beyond the figure cap; they scatter around this part. */
  scatterMemberIds: string[];
};

export type ClusterFit = {
  cluster: BuiltCluster;
  form: ClusterForm;
  parts: FitPart[];
  /**
   * Aggregates over `parts`, for callers that only need "who is a figure star and who is
   * scatter": `shape` is the first part's, the id lists are the parts' lists joined in part
   * order. Anything that pairs ids with shape stars must go through `parts`.
   */
  shape: ConstellationShape;
  figureMemberIds: string[];
  scatterMemberIds: string[];
};
```

Replace `buildConstellationFit` with:

```ts
export function buildConstellationFit(
  contacts: GraphContactInput[]
): ConstellationFitResult {
  const { clusters, byContactId } = buildConstellationClusters(contacts);
  const contactsById = new Map(contacts.map((c) => [c.id, c]));

  // Plan every cluster's parts first: how many shapes to ask for depends on it.
  const planned: Array<{
    cluster: BuiltCluster;
    members: GraphContactInput[];
    plan: ReturnType<typeof planClusterParts>;
  }> = [];
  for (const cluster of clusters) {
    if (!isWedgeEligible(cluster)) continue;
    const members = cluster.contactIds
      .map((id) => contactsById.get(id))
      .filter((c): c is GraphContactInput => Boolean(c));
    if (members.length < 2) continue;
    const ordered = orderConstellationMembers(members);
    planned.push({
      cluster,
      members: ordered,
      plan: planClusterParts(cluster, ordered),
    });
  }

  // Every cluster asks for a shape under its own id, exactly as before, so a cluster that is
  // not split keeps the figure it always had. The parts of a split company ask after everyone.
  const requests = clusters.map((c) => ({ id: c.id, contactIds: c.contactIds }));
  for (const { cluster, plan } of planned) {
    if (plan.form !== "petal") continue;
    for (const part of plan.parts) {
      requests.push({ id: `${cluster.id}#${part.key}`, contactIds: part.memberIds });
    }
  }
  const shapes = assignClusterShapes(requests);

  const fits = new Map<string, ClusterFit>();
  for (const { cluster, members, plan } of planned) {
    // Classmates get adjacent stars inside a petal: school keys, grouped by spelling.
    const schoolKey = new Map<string, string | null>();
    if (plan.form === "petal") {
      const groups = schoolGroupKeys(
        members.map((m) => (m.school ?? "").trim()).filter(Boolean)
      );
      for (const m of members) schoolKey.set(m.id, groups.get((m.school ?? "").trim()) ?? null);
    }

    const parts: FitPart[] = [];
    for (const p of plan.parts) {
      const shape =
        plan.form === "ring"
          ? RING_SHAPE
          : shapes.get(plan.form === "petal" ? `${cluster.id}#${p.key}` : cluster.id);
      if (!shape) break;
      const figureCount =
        plan.form === "ring"
          ? Math.min(p.memberIds.length, RING_CAPACITY)
          : Math.min(shape.stars.length, figureStarCount(p.memberIds.length));
      let figureMemberIds = p.memberIds.slice(0, figureCount);
      if (p.role === "petal") {
        figureMemberIds = knotOrder(figureMemberIds, (id) => schoolKey.get(id) ?? null);
      }
      parts.push({
        key: p.key,
        label: p.label,
        role: p.role,
        shape,
        figureMemberIds,
        scatterMemberIds: p.memberIds.slice(figureCount),
      });
    }
    if (parts.length !== plan.parts.length) continue;

    fits.set(cluster.id, {
      cluster,
      form: plan.form,
      parts,
      shape: parts[0].shape,
      figureMemberIds: parts.flatMap((p) => p.figureMemberIds),
      scatterMemberIds: parts.flatMap((p) => p.scatterMemberIds),
    });
  }

  return { clusters, byContactId, fits };
}
```

Replace the body of `constellationFitEdges` with:

```ts
export function constellationFitEdges(fit: ConstellationFitResult): FitEdge[] {
  const out: FitEdge[] = [];
  for (const { cluster, parts } of fit.fits.values()) {
    for (const { shape, figureMemberIds } of parts) {
      for (const [ai, bi] of shape.edges) {
        const a = figureMemberIds[ai];
        const b = figureMemberIds[bi];
        if (!a || !b || a === b) continue;
        out.push({
          source: a,
          target: b,
          clusterId: cluster.id,
          clusterName: cluster.name,
          clusterKind: cluster.kind,
        });
      }
    }
  }
  return out;
}
```

Update the file's header comment to say the fit is per part ("which members trace each part's figure").

- [ ] **Step 4: Register the smoke**

In `scripts/run-smoke.ts`, beside `"smoke-constellation-parts": "pure",`:

```ts
  "smoke-constellation-fit": "pure",
```

- [ ] **Step 5: Run everything that reads the fit**

Run: `npx tsx scripts/smoke-constellation-fit.ts && npx tsc --noEmit -p . && npx tsx scripts/run-smoke.ts --only smoke-graph-layout smoke-graph-family-seating smoke-graph-canvas smoke-sky-layout smoke-constellation-clusters smoke-cluster-affinity smoke-disk-placement`
Expected: the new smoke passes; tsc clean; the existing layout smokes still pass unchanged (their fixtures contain no clusters that split or form rings, so shapes, seeds and positions are the same).

If `smoke-graph-layout` fails on a cluster of ≥ 4 members with no company (a school!), that is expected NOT to happen only if the fixture has none: the fixture's `MIT` school has 3 members (binary). If one exists, report it — Task 5 adds ring handling to the layout and updates that smoke.

- [ ] **Step 6: Commit**

```bash
git add src/lib/constellation-fit.ts scripts/smoke-constellation-fit.ts scripts/run-smoke.ts
git commit -m "feat(constellation): the fit carries parts — core, petals, rings

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Build the parts in the layout

**Files:**
- Modify: `src/lib/graph-layout.ts`
- Modify: `scripts/smoke-graph-layout.ts`

**Interfaces:**
- Consumes: `ClusterFit`, `FitPart`, `RING_SHAPE` (Task 4); `ringLayout`, `arrangeParts`, `RING_CAPACITY` (Task 2); `classifyTitle` from `@/lib/role-function`; `PartRole`, `ClusterForm` from `@/lib/constellation-parts`.
- Produces:
  - `type PartGeometry = { part: FitPart; center: {x,y}; figureLocal: Array<{x,y}>; scatterLocal: Array<{id,x,y}>; foot: number }` (positions are cluster-local, already offset by `center`)
  - `ClusterGeometry = { cluster: BuiltCluster; fit: ClusterFit; parts: PartGeometry[]; foot: number }` — replaces the `figureLocal` / `figureExtent` / `scatterLocal` fields
  - `ClusterLabelData` gains `form?: ClusterForm` and `petalLabels?: Array<{ key: string; label: string; role: "core" | "petal"; count: number; anchor: { x: number; y: number } }>` (anchor: bottom-centre of the name, px from the node box's top-left, like `anchor`)
  - `GraphNodeData` gains `partKey?: string`, `partRole?: PartRole`, `leader?: boolean` (leader only for stars in a core or petal)

- [ ] **Step 1: Extend the layout smoke first (failing)**

In `scripts/smoke-graph-layout.ts`:

1. Add to the fixture array (just before the `// Singleton company → background rim` comment — keep the existing comment/`solo` entry after them):

```ts
  // A company big enough to split into a leadership core and function petals.
  ...["VP Engineering", "CTO", "Co-founder"].map((title, i) =>
    contact(`nw-l${i}`, { company: "Northwind", title, orbitScore: 5 - i })
  ),
  ...Array.from({ length: 11 }, (_, i) =>
    contact(`nw-e${i}`, {
      company: "Northwind",
      title: "Software Engineer",
      school: i % 2 ? "MIT" : i % 3 ? "Waterloo" : null,
      orbitScore: 1 + ((i * 3) % 5),
    })
  ),
  ...Array.from({ length: 8 }, (_, i) =>
    contact(`nw-d${i}`, { company: "Northwind", title: "Product Designer", orbitScore: 1 + ((i * 2) % 5) })
  ),
  ...Array.from({ length: 5 }, (_, i) =>
    contact(`nw-s${i}`, { company: "Northwind", title: "Account Executive", orbitScore: 1 + (i % 5) })
  ),
  // A school with enough alumni to be a ring, and one too big for its rings.
  ...Array.from({ length: 14 }, (_, i) =>
    contact(`ch${i}`, { school: "Chapel Hill", orbitScore: 1 + (i % 5) })
  ),
  ...Array.from({ length: 52 }, (_, i) =>
    contact(`su${i}`, { school: "State U", orbitScore: 1 + ((i * 2) % 5) })
  ),
```

2. Add `type ClusterLabelData` to the smoke's existing import from `../src/lib/graph-layout` (no second import from that module). In the "Fit assignment" section, replace the `figure size matches shape` loop with a per-part one:

```ts
  for (const f of fit.fits.values()) {
    for (const p of f.parts) {
      if (f.form === "ring") {
        check(`ring keeps every member it can (${f.cluster.name})`, p.figureMemberIds.length === Math.min(f.cluster.count, RING_CAPACITY));
        continue;
      }
      check(
        `figure size matches shape (${f.cluster.name}/${p.key})`,
        p.figureMemberIds.length === Math.min(p.shape.stars.length, p.figureMemberIds.length),
        `${p.figureMemberIds.length} vs ${p.shape.stars.length}`
      );
    }
  }
```

(import `RING_CAPACITY` from `../src/lib/graph/cluster-anatomy`.) In the "Shape fidelity" section, iterate `for (const f of fit.fits.values()) for (const part of f.parts)` using `part.figureMemberIds` / `part.shape.stars.slice(0, part.figureMemberIds.length)`, skip when `f.form === "ring"`, and put `${f.cluster.name}/${part.key}` in the label. Anywhere else the smoke reads `f.figureMemberIds` / `f.scatterMemberIds` for *membership only* (the figureRole and galaxy sections) leave as is.

3. Add a new section before "The galaxy":

```ts
// ---------------------------------------------------------------------------
console.log("\nCluster anatomy");

{
  const label = (name: string) =>
    layout.nodes.find((n) => n.type === "clusterLabel" && (n.data as { label?: string }).label === name)!
      .data as ClusterLabelData;
  const nw = [...fit.fits.values()].find((f) => f.cluster.name === "Northwind")!;
  check("Northwind is a petal cluster with a core and three petals", nw.form === "petal" && nw.parts.map((p) => p.key).join() === "core,petal:engineering,petal:design,petal:sales");
  check("its label node says so", label("Northwind").form === "petal");
  const petalLabels = label("Northwind").petalLabels ?? [];
  check("…with a label for the core and each petal", petalLabels.map((l) => l.label).join() === "Leadership,Engineering,Design,Sales & BD");
  check("…each anchored inside the node's box", petalLabels.every((l) => {
    const box = label("Northwind").box!;
    return l.anchor.x >= 0 && l.anchor.x <= box.width && l.anchor.y >= 0 && l.anchor.y <= box.height;
  }));
  check("a plain figure has no petal labels", label("Google").petalLabels === undefined && label("Google").form === "figure");

  // Parts sit on disjoint footprints: each part's stars stay apart from the other parts'.
  const partStars = nw.parts.map((p) => [...p.figureMemberIds, ...p.scatterMemberIds].map((id) => posById.get(id)!));
  let apart = Infinity;
  for (let a = 0; a < partStars.length; a++)
    for (let b = a + 1; b < partStars.length; b++)
      for (const p of partStars[a]) for (const q of partStars[b]) apart = Math.min(apart, Math.hypot(p.x - q.x, p.y - q.y));
  check(`stars of different parts keep clear (${apart.toFixed(0)}px ≥ 120)`, apart >= 120);

  const star = (id: string) => contactNodes.find((n) => n.id === id)!.data as GraphNodeData;
  check("stars know their part", star("nw-l0").partKey === "core" && star("nw-l0").partRole === "core" && star("nw-e0").partKey === "petal:engineering");
  check("…and whether they lead", star("nw-l0").leader === true && star("nw-e0").leader === false);
  check("a star in an ordinary cluster is 'main' and carries no leader flag", star("aws0").partRole === "main" && star("aws0").leader === undefined);

  const ch = [...fit.fits.values()].find((f) => f.cluster.name === "Chapel Hill")!;
  check("Chapel Hill is a ring", ch.form === "ring" && label("Chapel Hill").form === "ring");
  check("a ring draws no figure lines", !layout.edges.some((e) => ch.cluster.contactIds.includes(e.source)));
  check("ring members are figure stars", ch.cluster.contactIds.every((id) => (star(id).figureRole === "figure")));
  const ringR = ch.cluster.contactIds.map((id) => posById.get(id)!);
  const cx = ringR.reduce((s, p) => s + p.x, 0) / ringR.length;
  const cy = ringR.reduce((s, p) => s + p.y, 0) / ringR.length;
  const radii = ringR.map((p) => Math.hypot(p.x - cx, p.y - cy));
  check(`ring members lie on one circle (spread ${(Math.max(...radii) - Math.min(...radii)).toFixed(1)}px)`, Math.max(...radii) - Math.min(...radii) < 3);
  const su = [...fit.fits.values()].find((f) => f.cluster.name === "State U")!;
  check("a school too big for its rings scatters the rest", su.scatterMemberIds.length === 52 - Math.min(52, RING_CAPACITY) && su.figureMemberIds.length === Math.min(52, RING_CAPACITY));
}
```

Run: `npx tsx scripts/smoke-graph-layout.ts`
Expected: FAIL early (the layout still builds one figure per cluster: `label("Northwind").form` is undefined, or a shape/part mismatch).

- [ ] **Step 2: Refactor `buildClusterGeometry` into per-part geometry**

In `src/lib/graph-layout.ts`:

Add imports (add `type FitPart` to the existing `@/lib/constellation-fit` import rather than a second one):

```ts
import type { ClusterForm, PartRole } from "@/lib/constellation-parts";
import { arrangeParts, ringLayout } from "@/lib/graph/cluster-anatomy";
import { classifyTitle } from "@/lib/role-function";
import type { ConstellationShape } from "@/lib/constellation-shapes";
```

Add near the other layout constants:

```ts
/** Clear space between two parts of one company (its core and petals), edge to edge. */
const PART_GAP = 64;
```

Replace the `ClusterGeometry` type, and `buildClusterGeometry` and its doc, with the following. `figureGeometry` is the OLD body of `buildClusterGeometry` with `cluster.id` replaced by a `seed` argument and `fit.shape` / the member lists by arguments — keep its arithmetic (scale, upscale, rotation, `scatterField` call) byte-for-byte so a non-split cluster's positions do not change:

```ts
/** One part's local geometry: its figure stars plus a scatter field. */
export type PartGeometry = {
  part: FitPart;
  /** Where the part's own origin sits in the cluster's local space. */
  center: { x: number; y: number };
  /** Cluster-local, already offset by `center` (index ↔ part.figureMemberIds). */
  figureLocal: Array<{ x: number; y: number }>;
  scatterLocal: Array<{ id: string; x: number; y: number }>;
  /** The part's own footprint radius about `center`. */
  foot: number;
};

/** One cluster's local geometry: its parts and the disk that holds them all. */
export type ClusterGeometry = {
  cluster: BuiltCluster;
  fit: ClusterFit;
  parts: PartGeometry[];
  /** Footprint radius: everything the cluster draws stays inside this disk. */
  foot: number;
};

type LocalPart = Omit<PartGeometry, "part" | "center">;

/**
 * A figure and its scatter, in the part's own space. The asterism renders at its natural scale
 * with a mild seeded tilt — never warped — and is scaled up only if a template packs two stars
 * closer than FIGURE_STAR_MIN. Overflow members scatter through an annulus fully outside the
 * figure's extent, which guarantees clearance from every figure star and line by construction.
 */
function figureGeometry(
  shape: ConstellationShape,
  figureMemberIds: string[],
  scatterIds: string[],
  seed: string
): LocalPart {
  const count = figureMemberIds.length;
  const baseScale = scaleForStarCount(count);
  let scale = baseScale;
  const rotation = (hashUnit(seed, 11) - 0.5) * Math.PI * 0.5;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);

  const stars = shape.stars.slice(0, count);
  if (count > 1) {
    let minDist = Infinity;
    for (let i = 0; i < stars.length; i++) {
      for (let j = i + 1; j < stars.length; j++) {
        minDist = Math.min(minDist, Math.hypot(stars[i].x - stars[j].x, stars[i].y - stars[j].y));
      }
    }
    if (minDist > 0 && minDist * scale < FIGURE_STAR_MIN) {
      // Open the figure up until its tightest pair clears a label, but never
      // so far that one cluster swallows the sky.
      scale = Math.min(FIGURE_STAR_MIN / minDist, baseScale * FIGURE_MAX_UPSCALE);
    }
  }

  const figureLocal = stars.map((s) => ({
    x: (s.x * cos - s.y * sin) * scale,
    y: (s.x * sin + s.y * cos) * scale,
  }));
  const figureExtent = figureLocal.reduce((m, p) => Math.max(m, Math.hypot(p.x, p.y)), scale * 0.3);

  const { placed: scatterLocal, outer } = scatterField(
    scatterIds,
    seed,
    figureExtent + SCATTER_CLEAR,
    SCATTER_FIELD_WIDTH,
    figureLocal
  );
  const outermost = scatterLocal.length > 0 ? outer : figureExtent;
  return { figureLocal, scatterLocal, foot: outermost + FOOT_MARGIN };
}

/** A school: members on rings, the overflow scattered outside them. */
function ringGeometry(figureMemberIds: string[], scatterIds: string[], seed: string): LocalPart {
  const { positions, radius } = ringLayout(figureMemberIds.length, seed);
  const { placed: scatterLocal, outer } = scatterField(
    scatterIds,
    seed,
    radius + SCATTER_CLEAR,
    SCATTER_FIELD_WIDTH,
    positions
  );
  const outermost = scatterLocal.length > 0 ? outer : radius;
  return { figureLocal: positions, scatterLocal, foot: outermost + FOOT_MARGIN };
}

/**
 * Build a cluster's local geometry, part by part.
 *
 * A cluster that is not split is one part built exactly as it always was (same seed, so the
 * same tilt and scatter). A petal company builds each part — the leadership core and every
 * function petal — the same way under its own seed, then `arrangeParts` seats the core at the
 * origin and the petals round it on disjoint footprints.
 */
export function buildClusterGeometry(
  fit: ClusterFit,
  /**
   * People seated in this cluster's field without being members of it: loners from the same
   * company family (see `familySatellites`). Placed after the members, so further out — in the
   * largest petal, for a company that is split.
   */
  satelliteIds: string[] = []
): ClusterGeometry {
  const { cluster, form, parts } = fit;
  const roomiest = parts.reduce(
    (best, p, i) =>
      p.role !== "core" && p.figureMemberIds.length + p.scatterMemberIds.length >
        best.size
        ? { i, size: p.figureMemberIds.length + p.scatterMemberIds.length }
        : best,
    { i: 0, size: -1 }
  ).i;

  const built = parts.map((part, i) => {
    const seed = form === "petal" ? `${cluster.id}#${part.key}` : cluster.id;
    const scatterIds = [...part.scatterMemberIds, ...(i === roomiest ? satelliteIds : [])];
    return form === "ring"
      ? ringGeometry(part.figureMemberIds, scatterIds, seed)
      : figureGeometry(part.shape, part.figureMemberIds, scatterIds, seed);
  });

  if (form !== "petal") {
    return {
      cluster,
      fit,
      parts: [{ part: parts[0], center: { x: 0, y: 0 }, ...built[0] }],
      foot: built[0].foot,
    };
  }

  const coreIndex = parts.findIndex((p) => p.role === "core");
  const arranged = arrangeParts(
    coreIndex >= 0 ? { key: parts[coreIndex].key, foot: built[coreIndex].foot } : null,
    parts
      .map((p, i) => ({ key: p.key, foot: built[i].foot, role: p.role }))
      .filter((p) => p.role === "petal")
      .map(({ key, foot }) => ({ key, foot })),
    PART_GAP,
    cluster.id
  );
  return {
    cluster,
    fit,
    foot: arranged.foot,
    parts: parts.map((part, i) => {
      const center = arranged.centers.get(part.key)!;
      return {
        part,
        center,
        foot: built[i].foot,
        figureLocal: built[i].figureLocal.map((p) => ({ x: center.x + p.x, y: center.y + p.y })),
        scatterLocal: built[i].scatterLocal.map((p) => ({ id: p.id, x: center.x + p.x, y: center.y + p.y })),
      };
    }),
  };
}
```

- [ ] **Step 3: Use the parts in the layout generator**

In `buildHybridGraphLayoutSteps`, replace the position loop with:

```ts
  const positions = new Map<string, PolarPosition>();
  const figureIds = new Set<string>();
  const partOf = new Map<string, { key: string; role: PartRole }>();

  for (const geom of geoms) {
    const center = centers.get(geom.cluster.id)!;
    for (const g of geom.parts) {
      const role = { key: g.part.key, role: g.part.role };
      g.part.figureMemberIds.forEach((id, i) => {
        const p = g.figureLocal[i] || { x: 0, y: 0 };
        figureIds.add(id);
        partOf.set(id, role);
        positions.set(id, toPosition(center.x + p.x, center.y + p.y));
      });
      for (const p of g.scatterLocal) {
        // Family satellites are seated here without belonging to the cluster.
        if (g.part.scatterMemberIds.includes(p.id)) partOf.set(p.id, role);
        positions.set(p.id, toPosition(center.x + p.x, center.y + p.y));
      }
    }
  }
```

(`includes` on a per-part list is fine: parts hold ≤ a few hundred ids; if profiling ever shows it, build a `Set` per part.)

Extend the types:

```ts
// in GraphNodeData:
  /** Which part of its cluster the star belongs to (see `constellation-parts.ts`). */
  partKey?: string;
  partRole?: PartRole;
  /** In a split company: whether the title puts them in the leadership core's league. */
  leader?: boolean;
```

```ts
// in ClusterLabelData:
  /** How the cluster is drawn — see `constellation-parts.ts`. */
  form?: ClusterForm;
  /** A split company's core and petal names, anchored like `anchor`. */
  petalLabels?: Array<{
    key: string;
    label: string;
    role: "core" | "petal";
    count: number;
    anchor: { x: number; y: number };
  }>;
```

In the cluster-node loop, after `boxLeft/boxTop/...` are computed, build the petal labels and put both fields into the `clusterLabel` node's `data`:

```ts
    const petalLabels =
      geom.fit.form === "petal"
        ? geom.parts
            .filter((g) => g.part.label && g.part.role !== "main")
            .map((g) => {
              const pts = [...g.part.figureMemberIds, ...g.part.scatterMemberIds]
                .map((id) => positions.get(id))
                .filter((p): p is PolarPosition => Boolean(p));
              const pLeft = Math.min(...pts.map((p) => p.x));
              const pRight = Math.max(...pts.map((p) => p.x));
              const pTop = Math.min(...pts.map((p) => p.y));
              return {
                key: g.part.key,
                label: g.part.label!,
                role: g.part.role as "core" | "petal",
                count: g.part.figureMemberIds.length + g.part.scatterMemberIds.length,
                anchor: {
                  x: (pLeft + pRight) / 2 - boxLeft,
                  y: pTop - CLUSTER_LABEL_GAP - boxTop,
                },
              };
            })
        : undefined;
```

and in the node's `data: { kind: "clusterLabel", …, box, anchor }` add `form: geom.fit.form, petalLabels,`.

In the contact-node data, add (beside `clusterColor`):

```ts
          partKey: partOf.get(c.id)?.key,
          partRole: partOf.get(c.id)?.role,
          leader:
            partOf.get(c.id) && partOf.get(c.id)!.role !== "main"
              ? classifyTitle(c.title).isLeader
              : undefined,
```

Delete anything the compiler now reports unused (the old `figureLocal`/`figureExtent` references).

- [ ] **Step 4: Typecheck and run the layout smokes**

Run: `npx tsc --noEmit -p . && npx tsx scripts/smoke-graph-layout.ts && npx tsx scripts/smoke-graph-family-seating.ts && npx tsx scripts/smoke-sky-layout.ts && npx tsx scripts/smoke-graph-canvas.ts && npx tsx scripts/smoke-disk-placement.ts`
Expected: tsc clean; all pass, including the new "Cluster anatomy" section and every existing no-overlap check now running over the split company and the ring schools (star–star ≥ 18, labels, star–line ≥ 12, no crossing lines, similarity per part).

Known risks, in order of likelihood:
- **"cluster star fields are pairwise disjoint"** (a heuristic on centroid circles) can fail for a petal cluster whose centroid sits far from its disk's centre. If it does, print the offending pair; do NOT relax it — report BLOCKED with the numbers so the check can be replaced by one against the placed disks.
- **"stars of different parts keep clear ≥ 120"** failing means `PART_GAP` + `FOOT_MARGIN` is too small for the label box; raise `PART_GAP` and say so.
- A ring-school label check failing means `RING_SPACING` needs to grow.

- [ ] **Step 5: Layout cost**

Run `npx tsx scripts/bench/constellation-layout.ts` (record the 2,500 / 10,000 lines and `uptime`). The synthetic network has no titles worth splitting into petals beyond its 13 fixed ones, so cost should be ~unchanged from the pre-task figure (10k ≈ 90–100ms). A rise over ~10% needs an explanation in the report.

- [ ] **Step 6: Commit**

```bash
git add src/lib/graph-layout.ts scripts/smoke-graph-layout.ts
git commit -m "feat(constellation): build petals and rings — parts, petal labels, star part info

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Tighten small galaxies

Deferred from phase 2 (final-review recommendation): at 150 contacts the relax step barely improves relatedness and the disk comes out looser than the spec's "big clusters form the core". This task tunes the placement, against *measured* targets, without touching its guarantees.

**Files:**
- Modify: `src/lib/graph/disk-placement.ts` (constants and, if needed, search granularity in `legalize` only)
- Test: `scripts/smoke-disk-placement.ts` (add the small-galaxy case below)

**Interfaces:**
- Consumes/Produces: unchanged public API (`placeClusterDisks`, `DISK_ITERATIONS`, …). The exact-gap, sun-clear, determinism and order-independence checks must keep passing untouched.

- [ ] **Step 1: Measure the baseline**

Create `scripts/.tmp-galaxy-metrics.ts` (delete before committing):

```ts
import { buildSyntheticGraphPayload } from "@/lib/graph/synthetic-network";
import { buildHybridGraphLayout, buildClusterGeometry } from "@/lib/graph-layout";
import { buildConstellationFit } from "@/lib/constellation-fit";
import { buildClusterAffinity } from "@/lib/constellation-affinity";
import type { NebulaData } from "@/lib/graph-layout";

for (const [n, seed] of [[150, 1], [150, 3], [150, 7], [600, 3], [1000, 1]] as const) {
  const contacts = buildSyntheticGraphPayload(n, { seed }).contacts;
  const layout = buildHybridGraphLayout(contacts, "You");
  const fit = buildConstellationFit(contacts);
  const eligible = fit.clusters.filter((c) => fit.fits.has(c.id));
  const feet = eligible.map((c) => buildClusterGeometry(fit.fits.get(c.id)!).foot);
  // How much of the disk the clusters fill: 1 = solid, small = loose.
  const density = feet.reduce((s, f) => s + f * f, 0) / (layout.galaxy.diskRadius ** 2);
  const links = buildClusterAffinity(contacts, fit.byContactId, eligible);
  const at = new Map(layout.nodes.filter((x) => x.type === "nebula").map((x) => [(x.data as NebulaData).clusterId!, x.position] as const));
  const d = (a: string, b: string) => Math.hypot(at.get(a)!.x - at.get(b)!.x, at.get(a)!.y - at.get(b)!.y);
  const ids = [...at.keys()];
  const all: number[] = [];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) all.push(d(ids[i], ids[j]));
  all.sort((a, b) => a - b);
  const rel = links.filter((l) => at.has(l.a) && at.has(l.b));
  const ratio = rel.reduce((s, l) => s + d(l.a, l.b), 0) / Math.max(1, rel.length) / all[Math.floor(all.length / 2)];
  // The biggest cluster's distance from the sun, over the galaxy's radius: small = it anchors the middle.
  const big = eligible[0];
  const bc = at.get(big.id)!;
  const core = Math.hypot(bc.x, bc.y) / layout.galaxy.diskRadius;
  console.log(`${n}/s${seed}: density ${density.toFixed(2)}  related/median ${ratio.toFixed(2)}  biggest-from-sun ${core.toFixed(2)}  clusters ${ids.length}`);
}
process.exit(0);
```

Run: `npx tsx scripts/.tmp-galaxy-metrics.ts` and record the table (this is the "before").

- [ ] **Step 2: Tune**

Targets (all five rows, deterministic synthetic data):
- `density` at the three 150-contact rows ≥ 0.30, and no row's density falls versus its baseline;
- `related/median` ≤ 0.85 at 150 (each seed), ≤ 0.65 at 600, ≤ 0.55 at 1,000;
- `biggest-from-sun` ≤ 0.35 at every row (the biggest cluster anchors the middle);
- layout time at 10,000 contacts (`npx tsx scripts/bench/constellation-layout.ts`) no more than +10% over the value measured immediately before this task;
- every guarantee test green: `smoke-disk-placement` (exact 104px gap, sun clear, determinism, order independence), `smoke-graph-layout` (incl. contact-reversal identity, near = related, crowded halo), `smoke-graph-family-seating` (incl. the busy-Google case), `smoke-sky-layout`.

Levers, in order of how little they touch: `GRAVITY` and `DISK_ITERATIONS`; the relax step's cap `MAX_STEP`; then, inside `legalize` ONLY, the search granularity (its plain nearest-free search is coarser than seeding's — a finer step brings a moved cluster back closer to where relaxation wanted it). Do not touch `free()`, the seed/legalize visiting order, or anything that decides overlap. Record each attempt's table row in the report; stop when the targets hold. If a target cannot be reached without breaking a guarantee or the time budget, report the best table you got and which target failed, instead of relaxing the target.

- [ ] **Step 3: Pin it with a test**

Add to `scripts/smoke-disk-placement.ts` a section that regression-guards the *shape* of the result on a small synthetic galaxy without needing the layout: 40 disks with footprints 90–330 and sizes proportional to footprint, a ring of family links among the 8 smallest, and assert (a) density (Σfoot² / diskRadius²) ≥ 0.30 and (b) the biggest disk's near edge is within `sunClear + 3·gap`. Use the numbers the tuned code produces with ~10% slack, and put the measured values in a comment.

- [ ] **Step 4: Verify and commit**

Run: `npx tsc --noEmit -p . && npx eslint src/lib/graph/disk-placement.ts scripts/smoke-disk-placement.ts && npx tsx scripts/run-smoke.ts --only smoke-disk-placement smoke-graph-layout smoke-graph-family-seating smoke-sky-layout smoke-cluster-anatomy smoke-constellation-fit` and paste the "after" metrics table into the report. Delete the scratch script.

```bash
git add src/lib/graph/disk-placement.ts scripts/smoke-disk-placement.ts
git commit -m "tune(constellation): tighter small galaxies — measured density and relatedness targets

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Verification and docs

**Files:**
- Modify: `docs/superpowers/specs/2026-09-29-constellation-galaxy-design.md`

- [ ] **Step 1: Registry and targeted suite**

Run: `npx tsx scripts/run-smoke.ts --check && npx tsx scripts/run-smoke.ts --only smoke-role-function smoke-school-key smoke-constellation-clusters smoke-cluster-affinity smoke-disk-placement smoke-galaxy-structure smoke-cluster-anatomy smoke-constellation-parts smoke-constellation-fit smoke-graph-layout smoke-graph-family-seating smoke-graph-canvas smoke-sky-layout`
Expected: `--check` clean; all pass.

- [ ] **Step 2: DB-tier and types**

Run: `npx tsx scripts/run-smoke.ts --only smoke-page-budgets smoke-behavior-golden smoke-constellation-payload-leak smoke-dashboard-aggregates` then `npx tsc --noEmit -p . && npx eslint` on every file this phase touched.
Expected: all pass; the golden must NOT change (layout output is not in any golden). If it changes, stop and report the diff.

- [ ] **Step 3: Layout cost**

Run the interleaved base-vs-head measurement used in phase 2 (`git worktree add --detach <scratchpad>/base <phase-2-head-sha>`, symlink `node_modules`, alternate 5 reps each, remove the worktree after). Expected: 10k contacts within ~10% of the phase-2 figure (91–101ms); worst yield-to-yield slice ≤ 17ms.

- [ ] **Step 4: Spec "as built"**

At the end of the spec's "Phase A — cluster-local geometry" section add a paragraph: forms are decided by `planClusterParts` (binary ≤ 3; petal needs a company of ≥ 8 with ≥ 2 function groups of ≥ 2 non-leaders, lone functions folding into "Other"; open = role ≥ 4; ring = school ≥ 4); petals are arranged by `arrangeParts` (alternating big/small round the core, every pair verified); rings use a 124px spacing so labels cannot overlap and hold 43 stars before scattering; parts of one company keep 64px between footprints; `layout` emits `form`, `petalLabels`, and per-star `partKey`/`partRole`/`leader`. Also update the phase-2 "As built" note if the disk-placement constants changed in Task 6. Commit:

```bash
git add docs/superpowers/specs/2026-09-29-constellation-galaxy-design.md
git commit -m "docs: constellation galaxy spec — phase 3 as built

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 5: Visual check (controller, not a subagent)**

The bench server (`preview_start {name: "orbit-demo-bench"}`; it may already be running on 3001 from this worktree) serves `/bench/constellation?n=150&seed=3` and `?n=1000&seed=3`. The synthetic network has too few titles to split a company into petals, so this check confirms no regressions only: no overlaps, no console errors, schools that are big enough draw as rings. Petals and rings themselves are covered by the hand-built fixtures in `smoke-graph-layout`; seeing them needs real data, which is a phase 4 concern (nothing draws petal names or core tints yet).

---

## Self-review (against the spec)

- **Spec Phase A forms** → Tasks 3 (decision), 4 (fit), 5 (geometry). **petal arrangement "spaced with the chord-budget math"** → Task 2 (`arrangeParts`, re-derived since phase 2 deleted `pairArc`). **"Petal size follows headcount"** → each part's footprint comes from its own scatter field. **School knots** → Task 3 `knotOrder` + Task 4. **Leader tweak** (parked in phase 1) → Task 1. **Per-member annotations deferred from phase 1** → Task 5 (`partKey`/`partRole`/`leader`). **Petal sub-labels** → Task 5. **Small-galaxy looseness deferred from phase 2** → Task 6.
- **Not in this phase (by design):** drawing any of it (petal names, core tint, ring nebula glow, dotted role lines) — phase 4; home-view trimming of outlying stars — phase 4.
- **Known risk:** the synthetic network does not exercise petals or rings much (13 fixed titles; schools mostly absorbed by role clusters), so correctness rests on the hand-built smoke fixtures. Real data should be checked once the app can be pointed at it.
- **Type names used across tasks:** `ClusterForm`, `PartRole`, `PartPlan`, `PlanInput`, `planClusterParts`, `knotOrder`, `FUNCTION_LABELS`, `FitPart`, `RING_SHAPE`, `ringLayout`, `RING_CAPACITY`, `RING_SPACING`, `arrangeParts`, `PartDisk`, `PartArrangement`, `PartGeometry`, `ClusterGeometry.parts`, `petalLabels`, `partKey`, `partRole`, `leader` — consistent in every task.
