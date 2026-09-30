# Constellation Galaxy — Phase 4: Visuals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Draw what phases 1–3 laid out: a galaxy backdrop (bulge, disk haze, dust filaments), a distinct look per cluster form (petal washes and names, ring-nebula schools, untinted dotted role clusters, glow-less binaries), a leadership tint, and the halo — in BOTH renderers (desktop React Flow with a worker-drawn bitmap; mobile/preview canvas).

**Architecture:** The layout gains the few extra facts a renderer needs (per-cluster `form`, each part's disk, ring radius, per-star tints, per-form line styles, `anchorsLines`, a role subtitle, bottom-anchored petal labels). Pure modules do the drawing maths so both renderers share one code path: `galaxy-dust.ts` (dust and lanes along the filaments) and `sky-bitmap-draw.ts` (already pure; gains a `galaxy` job and form-aware washes). Desktop draws the backdrop as one more worker-encoded `<img>` below the stars, exactly like the wash and dust bitmaps; mobile bakes the same drawing once into a bitmap and blits it. Petal names render as children of the existing cluster-name node, so no new node type is mounted per cluster.

**Tech Stack:** TypeScript, React Flow (desktop), 2D canvas (mobile/preview), a Web Worker with `OffscreenCanvas` for bitmaps, smoke scripts run with `npx tsx`.

**Spec:** `docs/superpowers/specs/2026-09-29-constellation-galaxy-design.md` (section 3, "Visual design"; section 4; build phase 4).

## Global Constraints

- **Performance rules that already govern this sky (do not break):** no `<canvas>` beneath the stars (bitmaps go through the worker as `<img>`; a canvas is the fallback only until the first image decodes); no blurred `box-shadow`; no per-star opacity transitions; no looping per-star animation; `will-change` only while the camera moves; nodes must carry `measured`; one node per LAYER type, never one per cluster; the cluster-name node's unpinned form has no cluster-sized box. Mobile: no `shadowBlur`, no per-frame gradient construction (bake into sprites/bitmaps), the canvas stays pane-sized, zero frames when idle. Adding the backdrop adds exactly ONE layer on desktop; verify (Task 11).
- **Redraw policy:** bitmaps redraw only when the camera stops, at quarter-octave zoom steps, latest-wins, first draw never skipped.
- **Forms and looks** (from the spec, section 3): company **petal** = brand wash over the cluster + lighter wash per petal, core figure lines/stars warm white, petal figures in lightened brand colour, company name above and petal names smaller/dimmer; company **figure** = as today; school **ring** = annulus glow in the school colour, stars on the ring, no lines; role **open** = no shared wash, each star tinted by its own company's brand, dotted white lines at ~35% alpha, label "Founders · across 7 companies", star subtitle always the company; **binary** = one solid line, no wash; **halo** = tiny faint dots, hover names (unchanged). Star SIZE keeps meaning relationship score; comets, overdue rings, hover/select/search emphasis are unchanged.
- **Level of detail:** far = galaxy backdrop + washes + biggest cluster names + headcounts (existing summary view and caps unchanged); mid (label zoom ≥ 0.25) = petal names; near (≥ 0.5, today's thresholds) = star names and subtitles.
- **Data contract:** no new payload fields, no DB queries. The layout output gains fields only (below). Everything remains deterministic and independent of contact order.
- **Behaviour changes on purpose:** (1) a company splits only if it has ≥ 2 NAMED function petals (Task 1: Jason has not answered the "Other" question; this is the recommended default and is one constant to revert); (2) `clearNames` applies to every figure (Task 3: moves existing constellations by ≤ ~4% scale, fixes ~4% latent same-cluster label clashes); (3) optional: the home view fits the galaxy disk rather than every halo star (Task 10, easy to revert).
- Every new `scripts/smoke-*.ts` is registered in `scripts/run-smoke.ts` (`"pure"`). Commit messages end with the line `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Run commands from `/Users/jasonpereira/Projects/claude-worktrees/orbit/constellation-render-clustering-b81406`. Never `git stash`; never kill processes (a bench dev server may be running on port 3001 from this worktree — leave it; it hot-reloads, so console errors that predate your last edit are stale). Temporary scripts go at `scripts/.tmp-*.ts` and are deleted before committing.
- The machine is often heavily loaded by other sessions: timings are only meaningful as interleaved ratios against a base commit (`git worktree add --detach <scratchpad>/base <sha>`, symlink `node_modules`, remove after).

---

## File Structure

| File | Responsibility |
|---|---|
| Modify `src/lib/constellation-parts.ts` | Task 1: ≥ 2 named petals; Task 4: `CORE_TINT` constant. |
| Create `src/lib/graph/cluster-geometry.ts` | Task 2: `figureGeometry`, `ringGeometry`, `buildClusterGeometry`, `scatterField`, `ClearanceGrid` moved out of `graph-layout.ts`. |
| Modify `src/lib/graph-layout.ts` | Tasks 2–4: uses the moved code; new render data (see Task 4). |
| Modify `src/lib/constellation-fit.ts` | Task 4: `FitEdge` gains `form`, `partRole`. |
| Modify `src/lib/graph/star-style.ts` | Task 4/7: role subtitle. |
| Create `src/lib/graph/galaxy-dust.ts` | Task 5: dust and lanes along the filaments; `GalaxyBackdropData`. |
| Modify `src/lib/graph/sky-bitmap-draw.ts` | Tasks 5–6: `galaxy` job; form-aware washes. |
| Modify `src/components/graph/graph-nodes.tsx`, `graph-canvas-flow.tsx` | Tasks 5–7: backdrop node, wash data, star/label/line changes. |
| Modify `src/components/graph/sky-canvas/{sky-index,sky-sprites,draw-sky}.ts`, `graph-canvas-mobile.tsx` | Task 8: mobile parity. |
| Modify `src/lib/graph/preview-sky.ts`, `preview-sky-shape.ts`, `src/components/dashboard/constellation-preview-canvas.tsx` | Task 9: preview parity. |
| Modify `src/lib/graph/sky-camera.ts` (+ caller) | Task 10: optional home fit. |
| Create `scripts/smoke-galaxy-dust.ts`, `scripts/smoke-sky-bitmap-draw.ts` | Pure-tier specs. |
| Modify `scripts/smoke-graph-layout.ts`, `smoke-graph-canvas.ts`, `smoke-constellation-parts.ts`, `run-smoke.ts`, the spec | Fixtures, rows, registry, "as built". |

---

### Task 1: "Other" does not make a company split

**Files:**
- Modify: `src/lib/constellation-parts.ts`
- Test: `scripts/smoke-constellation-parts.ts`

**Interfaces:**
- Produces: `PETAL_MIN_NAMED = 2` (exported). `planClusterParts` returns `figure` for a company whose only petals are one named function plus "Other".

- [ ] **Step 1: Write the failing rows.** In `scripts/smoke-constellation-parts.ts`, in the "Petals" section add:

```ts
  const oneNamed = company([...many(5, "Software Engineer", 0), ...many(3, "Chef", 5)]);
  check("one named function plus 'Other' is not petals", oneNamed.form === "figure" && oneNamed.parts.length === 1);
  const twoNamedPlusOther = company([...many(4, "Software Engineer", 0), ...many(4, "Product Designer", 4), ...many(3, "Chef", 8)]);
  check("two named functions plus 'Other' are still petals", twoNamedPlusOther.form === "petal" && twoNamedPlusOther.parts.some((p) => p.key === "petal:other"));
  const foldOnly = company([...many(5, "Software Engineer", 0), { id: "m05", title: "Data Scientist" }, { id: "m06", title: "Account Executive" }, ...many(1, "Chef", 7)]);
  check("a company split only by folded loners is not petals", foldOnly.form === "figure");
```

Run: `npx tsx scripts/smoke-constellation-parts.ts` — Expected: FAIL on the first new row (currently `petal`).

- [ ] **Step 2: Implement.** In `planCompany`, after `petals` is computed and before sorting, replace `if (petals.length < 2) return null;` with:

```ts
  // "Other" is where blank and unrecognised titles land, so it can be the biggest group in a
  // company whose titles are mostly empty. It rides along once a company really has functions,
  // but it never makes a company split by itself.
  if (petals.filter(([fn]) => fn !== "other").length < PETAL_MIN_NAMED) return null;
```

and export `export const PETAL_MIN_NAMED = 2;` beside `PETAL_MIN_GROUP`.

- [ ] **Step 3: Verify.** `npx tsx scripts/smoke-constellation-parts.ts && npx tsx scripts/smoke-constellation-fit.ts && npx tsx scripts/smoke-graph-layout.ts && npx tsc --noEmit -p .` — all pass (the fit and layout fixtures' Northwind has three named functions).

- [ ] **Step 4: Commit.**

```bash
git add src/lib/constellation-parts.ts scripts/smoke-constellation-parts.ts
git commit -m "fix(constellation): 'Other' never makes a company split into petals

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Move cluster geometry out of graph-layout.ts

**Files:**
- Create: `src/lib/graph/cluster-geometry.ts`
- Modify: `src/lib/graph-layout.ts`

**Interfaces:**
- Produces (moved, unchanged signatures): `figureGeometry`, `ringGeometry`, `buildClusterGeometry`, `scatterField`, `ClearanceGrid`, types `PartGeometry`, `ClusterGeometry`, `LocalPart`, and the layout constants they use (`LABEL_WIDTH`, `LABEL_HEIGHT`, `LABEL_CLEAR_X`, `LABEL_CLEAR_Y`, `SCATTER_CLEAR`, `SCATTER_FIELD_WIDTH`, `FOOT_MARGIN`, `FIGURE_STAR_MIN`, `FIGURE_MAX_UPSCALE`, `PART_GAP`). `graph-layout.ts` re-exports `buildClusterGeometry`, `ClusterGeometry`, `PartGeometry` so existing importers keep working.

This is a pure move: **the layout must not change by a single bit.**

- [ ] **Step 1: Record the fingerprint BEFORE moving.** Create `scripts/.tmp-fp.ts`:

```ts
import { createHash } from "node:crypto";
import { buildSyntheticGraphPayload } from "@/lib/graph/synthetic-network";
import { buildHybridGraphLayout } from "@/lib/graph-layout";
for (const [n, seed] of [[150, 3], [1000, 3], [2500, 1]] as const) {
  const l = buildHybridGraphLayout(buildSyntheticGraphPayload(n, { seed }).contacts, "You");
  console.log(n, seed, createHash("sha1").update(JSON.stringify(l)).digest("hex"));
}
process.exit(0);
```

Run `npx tsx scripts/.tmp-fp.ts` and save the three lines under the scratchpad directory. Also run `npx tsx scripts/smoke-graph-layout.ts` (baseline green).

- [ ] **Step 2: Move.** Cut the following from `src/lib/graph-layout.ts` into the new `src/lib/graph/cluster-geometry.ts`, keeping every comment: `ClearanceGrid` (and `GRID_OFFSET`/`GRID_STRIDE`), `scatterField`, `PartGeometry`, `ClusterGeometry`, `LocalPart`, `figureGeometry`, `ringGeometry`, `buildClusterGeometry`, and the constants listed above. `haloField` stays in `graph-layout.ts` and imports `ClearanceGrid`, `LABEL_CLEAR_X`, `LABEL_CLEAR_Y` from the new file. Export what `graph-layout.ts` and the smokes import; add `export { buildClusterGeometry, type ClusterGeometry, type PartGeometry } from "@/lib/graph/cluster-geometry";` to `graph-layout.ts`. Avoid a cycle: the new file must not import from `graph-layout.ts` — types it needs from there (`GraphContactInput`) come via `import type` only; if a runtime value is needed, move it into the new file too.

- [ ] **Step 3: Prove nothing moved.** Re-run `npx tsx scripts/.tmp-fp.ts`: the three hashes must be IDENTICAL to Step 1. Then `npx tsc --noEmit -p . && npx eslint src/lib/graph-layout.ts src/lib/graph/cluster-geometry.ts && npx tsx scripts/run-smoke.ts --only smoke-graph-layout smoke-graph-family-seating smoke-sky-layout smoke-graph-canvas smoke-constellation-fit smoke-disk-placement`. Delete the scratch script. `graph-layout.ts` should drop from ~1,000 lines to roughly 600.

- [ ] **Step 4: Commit.**

```bash
git add src/lib/graph-layout.ts src/lib/graph/cluster-geometry.ts
git commit -m "refactor(constellation): move cluster geometry out of graph-layout.ts (layout byte-identical)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: No label clashes inside any figure

**Files:**
- Modify: `src/lib/graph/cluster-geometry.ts`
- Test: `scripts/smoke-graph-layout.ts`

**Interfaces:**
- Consumes/Produces: `figureGeometry`'s `clearNames` flag becomes always-on (delete the parameter; the name-clearing scale bump applies to every figure).

Phase 3 kept `clearNames` to petals so existing constellations would not move. Phase 4 redraws everything, so this is the moment to fix the latent clashes (≈4% of non-split figures; the plain-circle scale rule ignores that labels are 104×30 boxes).

- [ ] **Step 1: Failing test.** In `scripts/smoke-graph-layout.ts` add a section "No label clashes within a cluster" that builds `buildSyntheticGraphPayload(2500, { seed: 1 }).contacts`, lays it out, and asserts that for every pair of stars **in the same cluster** the label boxes do not overlap: `Math.abs(dx) >= LABEL_WIDTH || Math.abs(dy) >= LABEL_HEIGHT` (use the smoke's existing constants). Print the clash count. Run: expected FAIL (≈ 2–7 clashes at this size).

- [ ] **Step 2: Implement.** Make the `clearNames` bump unconditional in `figureGeometry` (remove the flag and its plumbing from `buildClusterGeometry`). Update the doc comment: the bump is a single uniform scale, so figures stay pure similarity transforms.

- [ ] **Step 3: Verify.** Run the new section (0 clashes), then `npx tsc --noEmit -p . && npx tsx scripts/run-smoke.ts --only smoke-graph-layout smoke-graph-family-seating smoke-sky-layout smoke-constellation-fit smoke-disk-placement smoke-graph-canvas`. Positions of most clusters are unchanged; a fraction move by ≤ ~4% scale. Report how many of the 2,500-contact clusters changed footprint (throwaway script comparing `foot` before/after via `git stash`-free means: build with the flag forced false in a temp copy).

- [ ] **Step 4: Commit.**

```bash
git add src/lib/graph/cluster-geometry.ts scripts/smoke-graph-layout.ts
git commit -m "fix(constellation): names can't clash inside any figure, not just petals

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Give the layout what the renderers need

**Files:**
- Modify: `src/lib/graph-layout.ts`, `src/lib/graph/cluster-geometry.ts`, `src/lib/constellation-fit.ts`, `src/lib/constellation-parts.ts`, `src/lib/graph/star-style.ts`
- Test: `scripts/smoke-graph-layout.ts`, `scripts/smoke-graph-canvas.ts`

**Interfaces:**
- Produces:
  - `export const CORE_TINT = "#ffe9c2"` in `constellation-parts.ts` (warm white, the leadership signal).
  - `NebulaData` gains `form: ClusterForm` and `parts?: Array<{ key: string; role: PartRole; x: number; y: number; radius: number }>` — absolute layout coordinates. Petal: one entry per part (`radius` = the part's footprint). Ring: exactly one entry `{ key: "main", role: "main", x, y, radius }` where `x,y` is the ring's centre and `radius` its OUTER ring radius. Otherwise `undefined`.
  - `PartGeometry` gains `ringRadius?: number` (set by `ringGeometry`'s `radius`).
  - `GraphNodeData` gains `anchorsLines?: boolean` (true when the star is an endpoint of some figure line); star `clusterColor` becomes per-star: core stars `CORE_TINT`; stars in a **role** cluster their own company's brand (`brandOf(company, "company")`), falling back to the cluster's silver when they have no company; everyone else the cluster's colour, as now.
  - `LayoutEdge.data` gains `dash?: [number, number]`; `FitEdge` gains `form: ClusterForm` and `partRole: PartRole`. Edge styles: core lines `withAlpha(CORE_TINT, 0.85)`; role lines `stroke "rgba(255,255,255,0.9)"`, `style.opacity 0.35`, `style.strokeDasharray "2 5"`, `data.dash [2, 5]`; petal, figure and binary lines as today.
  - `ClusterLabelData` gains `subtitle?: string` (role clusters only: `"across N companies"`, N = distinct trimmed lower-cased member companies, ≥ 1; `"across 1 company"` singular) and `petalLabels[].anchor` now means **the top-centre of the label text** and sits **below its part**: `y = partBottom + PETAL_LABEL_GAP (22) − boxTop` (this removes any collision with the cluster name, which sits above the topmost star).
  - `starSubtitle(data)` (star-style.ts): for `clusterKind === "role"` the company comes first — `(company||"").trim() || (title||"").trim() || null`; otherwise unchanged (`title || company`).

- [ ] **Step 1: Write the failing assertions.**

In `scripts/smoke-graph-layout.ts`, in the "Cluster anatomy" section, add (adapt the local names to the file's existing `layout`, `posById`, `fit`, `contactNodes`):

```ts
  const nebula = (name: string) =>
    layout.nodes.find((n) => n.type === "nebula" && (n.data as NebulaData).company === name)!.data as NebulaData;
  check("nebulae carry their cluster's form", nebula("Northwind").form === "petal" && nebula("Chapel Hill").form === "ring" && nebula("Google").form === "figure");
  const nwParts = nebula("Northwind").parts!;
  check("a petal nebula lists its parts, absolute and inside the sky", nwParts.map((p) => p.key).join() === "core,petal:engineering,petal:design,petal:sales" && nwParts.every((p) => p.radius > 0 && Number.isFinite(p.x)));
  check("…and every part disk contains its stars", nw.parts.every((p, i) => [...p.figureMemberIds, ...p.scatterMemberIds].every((id) => Math.hypot(posById.get(id)!.x - nwParts[i].x, posById.get(id)!.y - nwParts[i].y) <= nwParts[i].radius + 1e-6)));
  const chN = nebula("Chapel Hill");
  check("a ring nebula has one part: the ring's centre and outer radius", chN.parts!.length === 1 && chN.parts![0].radius >= RING_MIN_RADIUS && ch.cluster.contactIds.every((id) => Math.hypot(posById.get(id)!.x - chN.parts![0].x, posById.get(id)!.y - chN.parts![0].y) <= chN.parts![0].radius + 1e-6));
  check("figures and binaries have no parts", nebula("Google").parts === undefined);

  const star2 = (id: string) => contactNodes.find((n) => n.id === id)!.data as GraphNodeData;
  check("core stars are warm white", star2("nw-l0").clusterColor === CORE_TINT);
  check("petal stars keep the company's colour", star2("nw-e0").clusterColor !== CORE_TINT && star2("nw-e0").clusterColor === star2("nw-d0").clusterColor);
  check("figure stars anchor lines; ring stars do not", star2("g0").anchorsLines === true && ch.cluster.contactIds.every((id) => star2(id).anchorsLines === false));
  const dashed = layout.edges.filter((e) => e.data?.dash);
  check("role clusters draw dotted, faint lines", dashed.length > 0 && dashed.every((e) => e.style?.strokeDasharray === "2 5" && Number(e.style?.opacity) === 0.35 && e.data?.reason === "role"));
  const coreIds = new Set(nw.parts.find((p) => p.role === "core")!.figureMemberIds);
  const coreEdges = layout.edges.filter((e) => coreIds.has(e.source) && coreIds.has(e.target));
  check("core lines are warm white", coreEdges.length > 0 && coreEdges.every((e) => /255,\s*233,\s*194/.test(String(e.style?.stroke))));
  // A petal's name sits below its lowest star (so it can never collide with the cluster name,
  // which sits above the topmost star), and still inside the node's box.
  const box = label("Northwind").box!;
  const petalOk = nw.parts.filter((p) => p.role !== "main").every((p) => {
    const l = petalLabels.find((x) => x.key === p.key)!;
    const ids = [...p.figureMemberIds, ...p.scatterMemberIds];
    const bottom = Math.max(...ids.map((id) => posById.get(id)!.y));
    const boxTop = Math.min(...nw.cluster.contactIds.map((id) => posById.get(id)!.y)) - CLUSTER_NAME_HEAD_ALLOWANCE;
    return l.anchor.y + boxTop > bottom && l.anchor.y <= box.height;
  });
  check("petal names sit below their part, inside the box", petalOk);
```

(`CLUSTER_NAME_HEAD_ALLOWANCE` above is the layout's `CLUSTER_LABEL_GAP + CLUSTER_LABEL_HEAD` = 22 + 48 = 70; if the layout exports those constants import them instead of hard-coding, otherwise declare `const CLUSTER_NAME_HEAD_ALLOWANCE = 70` at the top of the smoke with that comment.)

Also add a role-cluster case to the smoke's fixture: `contact("rl1", { company: "Acme Robotics", title: "Backend Engineer" })` and `rl2` at `Nimbus Labs` already exist as `r1`/`r2` — assert their `clusterColor`s differ from each other (different companies) and that the "Engineers" cluster label carries `subtitle === "across 2 companies"`.

In `scripts/smoke-graph-canvas.ts`, in the star-parity section add: `starSubtitle` with `clusterKind: "role", company: "Stripe", title: "Engineer"` returns `"Stripe"`; with `clusterKind: "company"` returns `"Engineer"`; role with no company falls back to the title.

Run both: expected FAIL (`form` undefined etc.).

- [ ] **Step 2: Implement.**

`constellation-parts.ts`: add `export const CORE_TINT = "#ffe9c2";` with a comment (warm white marks leadership).

`cluster-geometry.ts`: `ringGeometry` returns `ringRadius: radius`; `LocalPart` and `PartGeometry` carry the optional `ringRadius`; `buildClusterGeometry`'s single-part path copies it.

`constellation-fit.ts`: `FitEdge` gets `form: fit.form` and `partRole: part.role` in `constellationFitEdges`.

`graph-layout.ts`:
  - In the cluster-node loop, build the nebula's `form` and `parts` (petal → per part `{ key, role, x: center.x + g.center.x, y: center.y + g.center.y, radius: g.foot }` using the cluster's placed `center`; ring → `[{ key: "main", role: "main", x: center.x, y: center.y, radius: geom.parts[0].ringRadius! }]`).
  - Petal label anchors: bottom of the part's member positions plus `PETAL_LABEL_GAP = 22`, minus `boxTop` (replace the old `pTop - CLUSTER_LABEL_GAP - boxTop`); use a plain loop (already done) and keep x centred.
  - `subtitle` for role clusters.
  - Contact node `clusterColor`: implement the three-way rule above using `brandOf`.
  - After the edges loop: `const lineEnds = new Set(edges.flatMap((e) => [e.source, e.target]))` and set `anchorsLines` on every contact node's data.
  - Edge styles per the interface (import `CORE_TINT`, `withAlpha`).
`graph-layout.ts` types: add the fields to `NebulaData`, `GraphNodeData`, `ClusterLabelData`, `LayoutEdge.data`.
`star-style.ts`: the role-first `starSubtitle`.

- [ ] **Step 3: Verify.** `npx tsc --noEmit -p . && npx eslint <touched files> && npx tsx scripts/run-smoke.ts --only smoke-graph-layout smoke-graph-canvas smoke-graph-family-seating smoke-sky-layout smoke-constellation-fit smoke-constellation-parts smoke-cluster-anatomy smoke-disk-placement`. Note `smoke-sky-layout`'s fingerprint now covers the new fields (fine: sliced vs sync still equal). Layout timing must not move (`npx tsx scripts/bench/constellation-layout.ts`, compare to the previous commit on a quiet machine).

- [ ] **Step 4: Commit.**

```bash
git add -A src scripts
git commit -m "feat(constellation): layout emits what the renderers draw — forms, part disks, tints, line styles

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The galaxy backdrop (desktop)

**Files:**
- Create: `src/lib/graph/galaxy-dust.ts`, `scripts/smoke-galaxy-dust.ts`, `scripts/smoke-sky-bitmap-draw.ts`
- Modify: `src/lib/graph/sky-bitmap-draw.ts`, `src/components/graph/graph-nodes.tsx`, `src/components/graph/graph-canvas-flow.tsx`, `scripts/run-smoke.ts`

**Interfaces:**
- Consumes: `GalaxyStructure` (`coreRadius`, `diskRadius`, `filaments[{from,to,weight,path}]`), `hashUnit`.
- Produces:
  - `type GalaxyLane = { path: Array<{ x: number; y: number }>; width: number; alpha: number }`
  - `type GalaxyDust = { x: number[]; y: number[]; alpha: number[]; radius: number[]; lanes: GalaxyLane[] }`
  - `type GalaxyBackdropData = { kind: "galaxyBackdrop"; coreRadius: number; diskRadius: number; dust: GalaxyDust; minX: number; minY: number; width: number; height: number }`
  - `function galaxyBackdropData(galaxy: GalaxyStructure): GalaxyBackdropData` — box: a square about the origin, half-side `max(diskRadius·1.15, coreRadius·2, 400)`; up to 70 dust points per filament (count ∝ length × (0.6 + min(weight, 1.5)), min 14); up to 14 lanes from the heaviest filaments.
  - `SkyBitmapJob` gains `{ kind: "galaxy"; data: GalaxyBackdropData; zoom; dpr; maxBackingPx }`; `drawSkyBitmap` handles it; new export `drawGalaxyBackdrop(ctx, data, zoom)`.
  - `GALAXY_BACKDROP_ID = "galaxy-backdrop"`, node type `galaxyBackdrop`, `zIndex: -2`, pointer-transparent, ignored by the click handlers like the wash and dust ids.

- [ ] **Step 1: Write the failing tests.**

Create `scripts/smoke-galaxy-dust.ts`:

```ts
/**
 * The galaxy backdrop's raw material: dust and dark lanes along the filaments.
 * Pure: no DOM. Run: npx tsx scripts/smoke-galaxy-dust.ts
 */
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
check("independent of filament order", JSON.stringify(galaxyBackdropData({ ...galaxy, filaments: [...filaments].reverse() }).dust.x.slice().sort()) === JSON.stringify(d.dust.x.slice().sort()));
const empty = galaxyBackdropData({ coreRadius: 180, diskRadius: 0, filaments: [] });
check("an empty galaxy still has a box and no dust", empty.dust.x.length === 0 && empty.dust.lanes.length === 0 && empty.width >= 800);
console.log("\ngalaxy-dust: all checks passed");
process.exit(0);
```

Create `scripts/smoke-sky-bitmap-draw.ts`:

```ts
/**
 * What the worker bitmaps draw, checked with a recording context: the galaxy backdrop, and a
 * different wash per cluster form. Pure: no DOM. Run: npx tsx scripts/smoke-sky-bitmap-draw.ts
 */
import { galaxyBackdropData } from "../src/lib/graph/galaxy-dust";
import { drawSkyBitmap, skyBitmapSize, type SkyBitmapJob } from "../src/lib/graph/sky-bitmap-draw";
import type { NebulaWashCluster, NebulaWashData } from "../src/components/graph/graph-nodes";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

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

const cluster = (over: Partial<NebulaWashCluster>): NebulaWashCluster => ({
  seed: "Acme", color: "#3aa3ff", x: 0, y: 0, radius: 300, opacity: 1, ...over,
});
const wash = (clusters: NebulaWashCluster[]): NebulaWashData => ({
  kind: "nebulaWash", clusters, minX: -2000, minY: -2000, width: 4000, height: 4000,
});
const job = (clusters: NebulaWashCluster[]): SkyBitmapJob => ({ kind: "wash", data: wash(clusters), zoom: 1, dpr: 1, maxBackingPx: 2048 });
const gradientsFor = (clusters: NebulaWashCluster[]) => {
  const r = recorder();
  drawSkyBitmap(r.ctx, job(clusters));
  return r.count("createRadialGradient");
};

console.log("\nWashes by form");
const parts = [
  { key: "core", role: "core" as const, x: 0, y: 0, radius: 150 },
  { key: "petal:engineering", role: "petal" as const, x: 400, y: 0, radius: 200 },
  { key: "petal:design", role: "petal" as const, x: -400, y: 0, radius: 200 },
];
const figure = gradientsFor([cluster({})]);
check("a figure keeps its five lobes", figure === 5, String(figure));
check("a cluster with no form is a figure", gradientsFor([cluster({ form: "figure" })]) === figure);
check("a petal cluster adds five lobes per part", gradientsFor([cluster({ form: "petal", parts })]) === 5 + 5 * parts.length);
check("a ring is one annulus glow", gradientsFor([cluster({ form: "ring", parts: [{ key: "main", role: "main", x: 0, y: 0, radius: 200 }] })]) === 1);
check("a role cluster has no shared wash", gradientsFor([cluster({ form: "open" })]) === 0);
check("a binary has no wash", gradientsFor([cluster({ form: "binary" })]) === 0);
check("a ring with no parts still draws something sane", gradientsFor([cluster({ form: "ring" })]) === 1);

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
```

Register both in `scripts/run-smoke.ts` (`"smoke-galaxy-dust": "pure"`, `"smoke-sky-bitmap-draw": "pure"`). Run: expected FAIL (`Cannot find module galaxy-dust`).

- [ ] **Step 2: Implement `galaxy-dust.ts`.**

```ts
/**
 * The galaxy backdrop's raw material: where the dust sits, and which dark lanes cross it.
 *
 * `galaxy-structure.ts` says WHICH relatedness chains to trace (filaments, each a bowed 6-point
 * path between two clusters). This turns each into a soft band of dust — denser along stronger
 * links — plus a few dark lanes over the strongest. Pure numbers, so the desktop worker and the
 * mobile bake draw the same sky from the same data.
 */

import type { GalaxyStructure } from "@/lib/graph/galaxy-structure";
import { hashUnit } from "@/lib/hash";

export type GalaxyLane = { path: Array<{ x: number; y: number }>; width: number; alpha: number };
export type GalaxyDust = { x: number[]; y: number[]; alpha: number[]; radius: number[]; lanes: GalaxyLane[] };
export type GalaxyBackdropData = {
  kind: "galaxyBackdrop";
  coreRadius: number;
  diskRadius: number;
  dust: GalaxyDust;
  /** World-space box the bitmap covers: a square about the sun. */
  minX: number;
  minY: number;
  width: number;
  height: number;
};

const LANES = 14;
const DUST_MIN = 14;
const DUST_MAX = 70;
const BOX_MARGIN = 1.15;
const MIN_HALF = 400;

/** The point `t` (0–1) along a polyline, with the direction of the segment it falls on. */
function along(path: Array<{ x: number; y: number }>, lengths: number[], total: number, t: number) {
  let d = t * total;
  for (let i = 0; i < lengths.length; i++) {
    if (d <= lengths[i] || i === lengths.length - 1) {
      const u = lengths[i] > 0 ? Math.min(1, d / lengths[i]) : 0;
      const a = path[i];
      const b = path[i + 1];
      return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, nx: -(b.y - a.y) / (lengths[i] || 1), ny: (b.x - a.x) / (lengths[i] || 1) };
    }
    d -= lengths[i];
  }
  const last = path[path.length - 1];
  return { x: last.x, y: last.y, nx: 0, ny: 1 };
}

export function galaxyBackdropData(galaxy: GalaxyStructure): GalaxyBackdropData {
  const half = Math.max(galaxy.diskRadius * BOX_MARGIN, galaxy.coreRadius * 2, MIN_HALF);
  const dust: GalaxyDust = { x: [], y: [], alpha: [], radius: [], lanes: [] };

  for (const f of galaxy.filaments) {
    if (f.path.length < 2) continue;
    const lengths = f.path.slice(1).map((p, i) => Math.hypot(p.x - f.path[i].x, p.y - f.path[i].y));
    const total = lengths.reduce((s, l) => s + l, 0);
    if (total <= 0) continue;
    const strength = 0.6 + Math.min(f.weight, 1.5);
    const count = Math.max(DUST_MIN, Math.min(DUST_MAX, Math.round((total / 45) * strength)));
    const spread = 10 + total * 0.05;
    const seed = `${f.from}|${f.to}`;
    for (let k = 0; k < count; k++) {
      const p = along(f.path, lengths, total, (k + hashUnit(seed, k * 4)) / count);
      // Two draws averaged: a soft band, densest on the filament's own line.
      const off = (hashUnit(seed, k * 4 + 1) + hashUnit(seed, k * 4 + 2) - 1) * spread;
      dust.x.push(Math.max(-half, Math.min(half, p.x + p.nx * off)));
      dust.y.push(Math.max(-half, Math.min(half, p.y + p.ny * off)));
      dust.alpha.push(0.05 + 0.17 * hashUnit(seed, k * 4 + 3) * Math.min(1, 0.4 + f.weight));
      dust.radius.push(2 + 5 * hashUnit(seed, k * 4 + 1000));
    }
  }

  [...galaxy.filaments]
    .sort((a, b) => b.weight - a.weight || (a.from < b.from ? -1 : a.from > b.from ? 1 : 0))
    .slice(0, LANES)
    .forEach((f) => {
      const seed = `${f.from}|${f.to}`;
      dust.lanes.push({
        path: f.path,
        width: 18 + 24 * hashUnit(seed, 5000),
        alpha: 0.16 + 0.14 * hashUnit(seed, 5001),
      });
    });

  return { kind: "galaxyBackdrop", coreRadius: galaxy.coreRadius, diskRadius: galaxy.diskRadius, dust, minX: -half, minY: -half, width: half * 2, height: half * 2 };
}
```

- [ ] **Step 3: Implement the drawing.** In `sky-bitmap-draw.ts` extend the union and dispatch, and add:

```ts
export type SkyBitmapJob =
  | { kind: "wash"; data: NebulaWashData; zoom: number; dpr: number; maxBackingPx: number }
  | { kind: "dust"; data: StarDustData; zoom: number; dpr: number; maxBackingPx: number }
  | { kind: "galaxy"; data: GalaxyBackdropData; zoom: number; dpr: number; maxBackingPx: number };

// in drawSkyBitmap:
  if (job.kind === "wash") drawWash(ctx, job.data, scale);
  else if (job.kind === "dust") drawDust(ctx, job.data, job.zoom);
  else drawGalaxyBackdrop(ctx, job.data, job.zoom);

/**
 * The galaxy behind everything: a cool disk haze, a warm bulge, dark lanes across the strongest
 * relatedness chains, and dust along all of them. Every gradient fades to its OWN colour at zero
 * alpha (never `transparent`, which is black), as the washes do.
 */
export function drawGalaxyBackdrop(ctx: Ctx, data: GalaxyBackdropData, zoom: number) {
  if (data.diskRadius > 0) {
    const disk = ctx.createRadialGradient(0, 0, 0, 0, 0, data.diskRadius);
    disk.addColorStop(0, "rgba(150,175,255,0.085)");
    disk.addColorStop(0.5, "rgba(130,160,255,0.05)");
    disk.addColorStop(1, "rgba(130,160,255,0)");
    ctx.fillStyle = disk;
    ctx.beginPath();
    ctx.arc(0, 0, data.diskRadius, 0, Math.PI * 2);
    ctx.fill();
  }
  const bulgeR = data.coreRadius * 1.8;
  const bulge = ctx.createRadialGradient(0, 0, 0, 0, 0, bulgeR);
  bulge.addColorStop(0, "rgba(255,240,205,0.34)");
  bulge.addColorStop(0.3, "rgba(245,200,106,0.16)");
  bulge.addColorStop(1, "rgba(245,200,106,0)");
  ctx.fillStyle = bulge;
  ctx.beginPath();
  ctx.arc(0, 0, bulgeR, 0, Math.PI * 2);
  ctx.fill();

  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const lane of data.dust.lanes) {
    ctx.strokeStyle = `rgba(3,5,10,${lane.alpha.toFixed(3)})`;
    ctx.lineWidth = lane.width;
    ctx.beginPath();
    lane.path.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.stroke();
  }

  // Dust in six alpha bands, one path and one fill each: thousands of dots, a handful of draws.
  const minRadius = 0.75 / Math.max(zoom, 0.01);
  const bands: number[][] = [[], [], [], [], [], []];
  data.dust.alpha.forEach((a, i) => bands[Math.min(5, Math.floor(a / 0.04))].push(i));
  bands.forEach((indices, band) => {
    if (indices.length === 0) return;
    ctx.globalAlpha = 0.04 * band + 0.02;
    ctx.fillStyle = "rgb(190,208,255)";
    ctx.beginPath();
    for (const i of indices) {
      const r = Math.max(minRadius, data.dust.radius[i]);
      ctx.moveTo(data.dust.x[i] + r, data.dust.y[i]);
      ctx.arc(data.dust.x[i], data.dust.y[i], r, 0, Math.PI * 2);
    }
    ctx.fill();
  });
}
```

(Import `GalaxyBackdropData` from `@/lib/graph/galaxy-dust`. The recording test expects exactly two gradients, one `stroke` per lane, and 3–12 `fill` calls including the disk and bulge — six alpha bands plus two is within bounds.)

- [ ] **Step 4: Mount it on desktop.**
  - `graph-nodes.tsx`: export `useSkyBitmap` (it is module-private today) or move it into its own file with the drawn-canvas helpers, keeping behaviour identical; add `GalaxyBackdropNodeComponent`/`GalaxyBackdropNode` modelled exactly on `NebulaWashNodeComponent` (same quarter-octave `zoom`, `useCameraMoving`, `alreadyDrawn`, `drawNowUnlessHidden`, canvas-until-image pattern) with `render({ kind: "galaxy", data, zoom, dpr, maxBackingPx: GALAXY_BACKDROP_MAX_BACKING_PX = 2048 })`, class `constellation-galaxy-backdrop pointer-events-none`, and a comment: coarse on purpose — a haze and dust, smooth everywhere.
  - `graph-canvas-flow.tsx`: register `galaxyBackdrop: GalaxyBackdropNode` in `nodeTypes`; add `GALAXY_BACKDROP_ID`; a `useMemo` `galaxyBackdrop = galaxyBackdropData(sky.layout.galaxy)` keyed on `sky.layout.galaxy`; a node `{ id, type: "galaxyBackdrop", position: { x: data.minX + data.width / 2, y: data.minY + data.height / 2 }` (mirror how `nebulaWashNode` positions its centre), `data`, `measured: { width, height }, zIndex: -2, selectable: false, draggable: false, focusable: false, style: { pointerEvents: "none" } }` pushed FIRST in the node list; ignore the id wherever `NEBULA_WASH_ID`/`STAR_DUST_ID` are ignored (click handlers, hover/cluster-circle logic, window/mount logic, camera extents — the backdrop must not widen the camera bounds; check `computeSunExtents` skips it, adding a type/id guard if not).
  - The dashboard-preview and search paths must not break: grep for `NEBULA_WASH_ID` and mirror each use.

- [ ] **Step 5: Verify.** `npx tsx scripts/smoke-galaxy-dust.ts && npx tsx scripts/smoke-sky-bitmap-draw.ts && npx tsc --noEmit -p . && npx eslint <touched files> && npx tsx scripts/run-smoke.ts --check && npx tsx scripts/run-smoke.ts --only smoke-graph-canvas smoke-graph-layout smoke-sky-layout`. Then **look at it**: with the bench server (`preview_start {name: "orbit-demo-bench"}` or the running one on 3001) open `/bench/constellation?n=1000&seed=3` and `?n=2500&seed=1` at 1440×960, screenshot, and confirm a warm bulge round the sun, a faint cool disk, dust following chains of clusters, no console errors (a stale earlier error is not a failure). The backdrop must sit BELOW the stars and washes and must not change what a click on empty sky does.

- [ ] **Step 6: Commit.**

```bash
git add -A src scripts
git commit -m "feat(constellation): the galaxy backdrop — bulge, disk haze, dust and lanes, drawn in the worker

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: A different wash for each cluster form

**Files:**
- Modify: `src/components/graph/graph-nodes.tsx` (types), `src/lib/graph/sky-bitmap-draw.ts`, `src/components/graph/graph-canvas-flow.tsx` (wash data)
- Test: `scripts/smoke-sky-bitmap-draw.ts` (written in Task 5; it already asserts these counts)

**Interfaces:**
- Produces: `NebulaWashCluster` gains `form?: ClusterForm` and `parts?: NebulaData["parts"]`. `drawWash`: **figure** (or no form) as today; **petal** = the cluster's five lobes at full alpha, then five lobes per part at `PART_WASH_ALPHA = 0.7` of the lobe alpha, seeded `${seed}#${part.key}`, the core in `CORE_TINT`; **ring** = one annulus gradient centred on the ring's centre; **open** and **binary** = nothing.

- [ ] **Step 1: The tests exist** (Task 5's `smoke-sky-bitmap-draw.ts` "Washes by form" section). Run it now: expected FAIL — `form` is not on the type yet, and every case draws five lobes.

- [ ] **Step 2: Implement.** In `sky-bitmap-draw.ts` replace `drawWash` with:

```ts
/** A part's wash is lighter than the cluster's, so the parts read as pools within one cloud. */
const PART_WASH_ALPHA = 0.7;

function drawLobes(ctx: Ctx, scale: number, seed: string, color: string, cx: number, cy: number, radius: number, alphaScale: number) {
  for (const lobe of nebulaLobes(seed, radius)) {
    // Under half a backing pixel there is nothing to draw, and a zero-radius gradient throws.
    if (lobe.rx * scale < 0.5 || lobe.ry * scale < 0.5) continue;
    const a = lobe.alpha * alphaScale;
    const fill = ctx.createRadialGradient(0, 0, 0, 0, 0, lobe.rx);
    fill.addColorStop(0, withAlpha(color, a));
    fill.addColorStop(NEBULA_LOBE_MID, withAlpha(color, a * 0.45));
    // The cluster's own colour at zero alpha, not `transparent` (transparent BLACK drags the hue).
    fill.addColorStop(NEBULA_LOBE_EDGE, withAlpha(color, 0));
    fill.addColorStop(1, withAlpha(color, 0));
    ctx.save();
    ctx.translate(cx + lobe.x, cy + lobe.y);
    ctx.scale(1, lobe.ry / lobe.rx);
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(0, 0, lobe.rx, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

/** A school: a soft annulus that peaks on the outer ring, so the stars sit in a halo of their own colour. */
function drawRing(ctx: Ctx, scale: number, cluster: NebulaWashCluster) {
  const part = cluster.parts?.[0];
  const ringR = part?.radius ?? cluster.radius * 0.5;
  const cx = part?.x ?? cluster.x;
  const cy = part?.y ?? cluster.y;
  const outer = ringR * 1.3;
  if (outer * scale < 0.5) return;
  const fill = ctx.createRadialGradient(cx, cy, 0, cx, cy, outer);
  fill.addColorStop(0, withAlpha(cluster.color, 0.05));
  fill.addColorStop(0.3, withAlpha(cluster.color, 0.06));
  fill.addColorStop(1 / 1.3, withAlpha(cluster.color, 0.12)); // the outer ring itself
  fill.addColorStop(1, withAlpha(cluster.color, 0));
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.arc(cx, cy, outer, 0, Math.PI * 2);
  ctx.fill();
}

function drawWash(ctx: Ctx, data: NebulaWashData, scale: number) {
  for (const cluster of data.clusters) {
    const form = cluster.form ?? "figure";
    // A role cluster spans companies and a binary is two or three stars: neither has a cloud of
    // its own, so neither is washed.
    if (form === "open" || form === "binary") continue;
    // The cluster's dim is applied to all its pieces together (instant, not a fade — a canvas
    // redraws, it does not transition).
    ctx.globalAlpha = cluster.opacity;
    if (form === "ring") {
      drawRing(ctx, scale, cluster);
      continue;
    }
    drawLobes(ctx, scale, cluster.seed, cluster.color, cluster.x, cluster.y, cluster.radius, 1);
    if (form === "petal") {
      for (const part of cluster.parts ?? []) {
        drawLobes(ctx, scale, `${cluster.seed}#${part.key}`, part.role === "core" ? CORE_TINT : cluster.color, part.x, part.y, part.radius * 0.9, PART_WASH_ALPHA);
      }
    }
  }
}
```

  (Import `CORE_TINT` from `@/lib/constellation-parts` and `NebulaWashCluster` as a type from graph-nodes.) Extend `NebulaWashCluster` in graph-nodes.tsx with `form?` and `parts?`. In graph-canvas-flow.tsx's `nebulaWash` `useMemo` (the one iterating `type === "nebula"` nodes), pass `form: d.form, parts: d.parts` through, and widen the box so ring/part washes fit (`max(radius, ...parts.map(p => Math.hypot(p.x - x, p.y - y) + p.radius))`, times the existing 2× box factor).

- [ ] **Step 3: Verify.** `npx tsx scripts/smoke-sky-bitmap-draw.ts && npx tsc --noEmit -p . && npx eslint <touched> && npx tsx scripts/run-smoke.ts --only smoke-graph-canvas smoke-sky-layout smoke-graph-layout`. Screenshot `/bench/constellation?n=2500&seed=1` zoomed on a big company (petals should sit in pools of lighter cloud with a warm one at the core) and on a school (a soft ring glow). No console errors.

- [ ] **Step 4: Commit.**

```bash
git add -A src scripts
git commit -m "feat(constellation): a wash for each form — petal pools, school rings, none for roles and binaries

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Desktop stars, lines and names

**Files:**
- Modify: `src/components/graph/graph-nodes.tsx`, `src/components/graph/graph-canvas-flow.tsx`

**Interfaces:**
- Consumes: Task 4's fields on `GraphNodeData` / `ClusterLabelData` / `LayoutEdge`.
- Produces: no new exports. Behaviour: (1) a star mounts line handles only if `data.anchorsLines` (fall back to `figureRole === "figure"` when the field is absent, for preview data); (2) role stars show the company as subtitle (via `starSubtitle`, Task 4 — nothing else to do); (3) figure lines honour `style.strokeDasharray` and per-edge opacity (verify; they pass through today); (4) the cluster-name node shows `subtitle` under the name (role clusters) at `0.82em`, `text-white/55`, in both summary and normal views; (5) **petal names**: for a cluster with `petalLabels`, render each as a small dim label at its anchor while `labelZoom >= PETAL_LABEL_MIN_ZOOM (0.25)` and the cluster is not in summary view and its name is shown; core label in warm white (`CORE_TINT` at 70%), petal labels `text-white/55`, uppercase, `tracking-[0.14em]`, font `0.7 ×` the cluster-name scale (`clusterNameScale`), not pinned.

Constraint: petal labels render **inside the existing cluster-name node** (both the plain unpinned div and `PinnableClusterName`), positioned absolutely from the node's origin: the node's origin is the name's anchor, so a petal label at `petalLabels[i].anchor` (box-relative) is at `dx = anchor.x − data.anchor.x`, `dy = anchor.y − data.anchor.y` from it. They are `pointer-events-none`, have no per-label element of their own beyond the text span, and are omitted entirely (not hidden) when not shown, so a 10,000-contact sky mounts a handful. Do not give the unpinned name a cluster-sized box (that halved the frame rate at 870 clusters).

- [ ] **Step 1: Failing check.** There is no DOM harness for these components; write the pure part as a testable function and test it. Add to `src/lib/graph/star-style.ts`:

```ts
/** Petal names show once the camera is close enough to read them and the sky is not summarised. */
export const PETAL_LABEL_MIN_ZOOM = 0.25;

/** Where a petal label sits relative to the cluster name's origin, in layout px. */
export function petalLabelOffset(
  anchor: { x: number; y: number },
  petal: { x: number; y: number }
) {
  return { dx: petal.x - anchor.x, dy: petal.y - anchor.y };
}
```

and in `scripts/smoke-graph-canvas.ts` add a section asserting `petalLabelOffset({x:100,y:48},{x:140,y:300})` is `{dx:40,dy:252}` and `PETAL_LABEL_MIN_ZOOM === 0.25`. Run: FAIL (not exported yet).

- [ ] **Step 2: Implement.** The pure helpers above; then the component changes in `graph-nodes.tsx` per the interface list (follow how `ClusterNameText` computes its scale and how `PinnableClusterName` positions itself; put the petal labels in one small `PetalLabels` component used by both variants). In `graph-canvas-flow.tsx`, the label-node pass (≈ lines 1606–1657) must pass `showPetals = labelZoom >= PETAL_LABEL_MIN_ZOOM && !summary && shown` in the `data` spread.

- [ ] **Step 3: Verify.** `npx tsx scripts/smoke-graph-canvas.ts && npx tsc --noEmit -p . && npx eslint <touched>`. Screenshots at 2,500 contacts (seed 1): zoomed out (cluster names only), mid zoom into a company with petals (petal names appear below their parts, warm "LEADERSHIP" under the core, clearly separate from the company name above), zoomed into "Engineers" (dotted faint lines, each star a different colour, subtitle shows the company, "across N companies" under the name), zoomed into a school ring (no lines, stars on a glowing ring). No console errors. Ring stars must no longer mount handles (`.react-flow__handle` count near a ring is zero — check with `document.querySelectorAll`).

- [ ] **Step 4: Commit.**

```bash
git add -A src scripts
git commit -m "feat(constellation): stars, lines and names by form — petal names, role subtitles, dotted role lines

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The mobile canvas draws all of it

**Files:**
- Modify: `src/components/graph/sky-canvas/sky-index.ts`, `sky-sprites.ts`, `draw-sky.ts`, `src/components/graph/graph-canvas-mobile.tsx`
- Test: `scripts/smoke-graph-canvas.ts`

**Interfaces:**
- Produces:
  - `SkyIndex` gains `galaxy?: GalaxyStructure`; `NebulaEntry` gains `form: ClusterForm` and `parts?: NebulaData["parts"]`; `ClusterLabelEntry` gains `subtitle?: string` and `petals?: Array<{ key: string; label: string; role: "core" | "petal"; x: number; y: number }>` (WORLD coordinates of each label's top-centre: `labelNode.position − data.anchor + petal.anchor`); `EdgeEntry` gains `dash?: [number, number]`.
  - `galaxyBackdropBitmap(galaxy, size = 1024)` in `sky-sprites.ts`: bakes `drawGalaxyBackdrop` (the SAME function the desktop worker uses) once per `GalaxyStructure` object into an offscreen canvas of `size × size` covering `galaxyBackdropData(galaxy)`'s box, cached in a `WeakMap`, cleared by `clearSpriteCaches`.
  - `drawSky` (layer order): clear → background (screen space) → **galaxy backdrop blit** (one `drawImage` mapping the box through `worldToScreen`, skipped if fully off screen) → nebula sprites (now form-aware) → edges (dashed via `setLineDash([dash[0]*k... ])` — dash lengths in SCREEN px: `[2, 5]` stays `[2,5]`) → stars → sun → cluster names (+ subtitle line) → **petal labels** (only when `camera.k >= PETAL_LABEL_MIN_ZOOM`, at most `PETAL_LABEL_CAP = 40` per frame, nearest the view centre first, drawn `600 10px` uppercase, colour white/55, core warm) → sun label → star labels → selection ring.
  - Nebula drawing by form: figure = `nebulaSprite` as today; petal = the cluster sprite plus a smaller sprite per part (`nebulaSprite(color, `${seed}#${key}`)` at `part.radius·0.9·4·k` square, `globalAlpha·0.7`, core in `CORE_TINT`); ring = a baked annulus sprite (`ringSprite(color)`, 128px radial gradient with the same stops as the desktop `drawRing`, drawn at `outer·2·k` square); open/binary = skipped.

- [ ] **Step 1: Failing tests.** In `scripts/smoke-graph-canvas.ts`, in the index section, build a layout from a new shared fixture `scripts/lib/anatomy-fixture.ts` (export `anatomyFixture(): GraphContactInput[]`: a Northwind-like 27-person company with leaders/engineers/designers/sales titles, a 6-person school, a pair, and 4 engineers at four different one-off companies; Task 9 reuses it) and assert: `index.galaxy` equals `layout.galaxy`; the Northwind `NebulaEntry` has `form: "petal"` and 4 `parts`; the school's entry has `form: "ring"` and one part; each role/binary entry has the right form; the Northwind `ClusterLabelEntry.petals` has 4 entries with finite world coordinates, each lying **below** every star of its part; the "Engineers" label has `subtitle === "across 4 companies"`; a role cluster's `EdgeEntry`s have `dash: [2, 5]` and `opacity 0.35`; other edges have no `dash`. Also add a **recording-context test** for the backdrop: call the exported drawing entry with a Proxy recording context (as in `smoke-sky-bitmap-draw.ts`) and assert exactly one `drawImage` for the galaxy when the box is on screen and none when the camera looks elsewhere (if `drawSky` cannot be driven by a stub without a real canvas, test the small pure helper you extract for "is this box on screen" instead and say so).

Run: FAIL.

- [ ] **Step 2: Implement** the interface list above, following existing patterns (sprite caches keyed as `starSprite` is; no `shadowBlur`; no per-frame gradient construction; strokeText for label legibility as today). `graph-canvas-mobile.tsx`: pass `layout.galaxy` into `buildSkyIndex` (its parameter type is structural — extend it with the optional `galaxy`).

- [ ] **Step 3: Verify.** `npx tsx scripts/smoke-graph-canvas.ts && npx tsc --noEmit -p . && npx eslint <touched> && npx tsx scripts/run-smoke.ts --only smoke-graph-canvas smoke-sky-layout smoke-graph-layout`. Visual: in the bench page's mobile mode (`resize_window` preset `mobile`, reload; `useSmallSky` picks the canvas renderer under 768px) screenshot 1,000 and 2,500 contacts: backdrop visible behind the sky, forms as on desktop, petal names at mid zoom, no console errors. Reset the viewport with `resize_window {preset: "desktop"}` afterwards.

- [ ] **Step 4: Commit.**

```bash
git add -A src scripts
git commit -m "feat(constellation): the phone canvas draws the galaxy, the forms and petal names too

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Dashboard preview parity (light)

**Files:**
- Modify: `src/lib/graph/preview-sky.ts`, `src/lib/graph/preview-sky-shape.ts`, `src/components/dashboard/constellation-preview-canvas.tsx`
- Test: `scripts/smoke-preview-sky.ts` (new, "pure"), `scripts/run-smoke.ts`

**Interfaces:**
- Produces: `buildPreviewSky` skips washes for `open` and `binary` clusters (a nebula whose `form` is one of those); `PreviewLineStyle` gains a fifth element `dash: number` (0 = solid, else the on/off length used as `[dash, dash*2.5]`) so role lines stay dotted; `expandPreviewSky` reads it back into `LayoutEdge.style.strokeDasharray` and `data.dash`. Ring and petal clusters keep the ordinary preview wash (the preview is a small card; the galaxy backdrop, part pools and petal names are deliberately NOT carried — say so in the module header).

- [ ] **Step 1: Failing test.** Create `scripts/smoke-preview-sky.ts`: lay out the shared fixture from `scripts/lib/anatomy-fixture.ts` (created in Task 8), call `buildPreviewSky(contacts, "You")`, then `expandPreviewSky(sky)`, and assert (a) the number of washes equals the number of nebulae whose form is not open/binary, (b) the role cluster's lines round-trip with `strokeDasharray` set and the other lines' `strokeDasharray` undefined, (c) star count and line count unchanged from before, (d) `expandPreviewSky` output has no `rings` node. Register as `"smoke-preview-sky": "pure"`. Run: FAIL.

- [ ] **Step 2: Implement** per the interface; keep the tuple compact (`lineStyles` are deduplicated by `join("|")`, so adding a numeric element is free).

- [ ] **Step 3: Verify.** `npx tsx scripts/smoke-preview-sky.ts && npx tsc --noEmit -p . && npx eslint <touched> && npx tsx scripts/run-smoke.ts --only smoke-graph-canvas smoke-sky-layout smoke-dashboard-aggregates`. Look at the dashboard preview on the bench (`/bench/preview` needs `ORBIT_BENCH=1`, which the bench server has): no console errors.

- [ ] **Step 4: Commit.**

```bash
git add -A src scripts
git commit -m "feat(constellation): the dashboard preview skips role/binary washes and keeps dotted role lines

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Open on the galaxy, not on the farthest halo star (optional, easy to revert)

**Files:**
- Modify: `src/lib/graph/sky-camera.ts` (and the call sites that compute the home fit in `graph-canvas-flow.tsx` / `graph-canvas-mobile.tsx`)
- Test: `scripts/smoke-graph-canvas.ts`

**Interfaces:**
- Produces: `computeSunExtents`/the home-fit helper accept an optional `galaxy?: { diskRadius: number }`; when given, the framed extents are the sun's clear zone plus the disk (`diskRadius · 1.1`) instead of every star's reach. Pan bounds are unchanged (all stars stay reachable). `HOME_FIT_TO_GALAXY = true` is a named constant so the behaviour can be turned off in one line.

At 1,000 contacts the sky occupied about a third of the canvas width at home because a few halo stars far out set the zoom. This trades that for: halo stars beyond the disk start just outside the first view.

- [ ] **Step 1: Failing test.** In `scripts/smoke-graph-canvas.ts` framing section: build a layout at 1,000 contacts (seed 3), compute the home zoom with and without the galaxy for a 1440×900 pane, and assert (a) with the galaxy the zoom is larger, (b) every cluster's centre is still inside the viewport at that zoom, (c) the pan clamp still allows reaching the farthest star. Run: FAIL.

- [ ] **Step 2: Implement** per the interface (read `computeSunExtents` and its callers first; the home fit and the "atHome" check in `graph-canvas-flow.tsx` must use the same extents or the Home button and the initial view disagree).

- [ ] **Step 3: Verify + look.** Tests, tsc, eslint; screenshots at 1,000 and 2,500 contacts: the galaxy fills the frame with some breathing room; halo dots visible near the edge. State the before/after home zoom in the report.

- [ ] **Step 4: Commit.**

```bash
git add -A src scripts
git commit -m "feat(constellation): open on the galaxy, not on the farthest halo star

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Verification and docs

**Files:**
- Modify: `docs/superpowers/specs/2026-09-29-constellation-galaxy-design.md`

- [ ] **Step 1: Suites.** `npx tsx scripts/run-smoke.ts --check && npx tsx scripts/run-smoke.ts --only smoke-role-function smoke-school-key smoke-constellation-clusters smoke-cluster-affinity smoke-disk-placement smoke-galaxy-structure smoke-cluster-anatomy smoke-constellation-parts smoke-constellation-fit smoke-galaxy-dust smoke-sky-bitmap-draw smoke-preview-sky smoke-graph-layout smoke-graph-family-seating smoke-graph-canvas smoke-sky-layout`, then `npx tsx scripts/run-smoke.ts --only smoke-page-budgets smoke-behavior-golden smoke-constellation-payload-leak smoke-dashboard-aggregates`, then `npx tsc --noEmit -p .` and eslint on every file changed since the phase-3 head. The golden must NOT change.

- [ ] **Step 2: Cost.** Layout timing (`npx tsx scripts/bench/constellation-layout.ts`) interleaved against the phase-3 head at 2,500 and 10,000 contacts: within ~10%. Draw cost: on a quiet machine run the frame suite once, interleaved against the phase-3 head build if time allows (`ORBIT_BENCH=1 npx next build --profile`, then `node scripts/bench/constellation-interactions.mjs 1000,2500 --suite frame --reps 3 --ab before=…,after=…` per `scripts/bench/README.md`), and report frames over 8.3ms and the compositor layer count. **Layer budget:** the backdrop adds exactly one layer; measure with a `javascript_tool` probe or the trace if the frame suite is impractical, and say which.

- [ ] **Step 3: Spec "as built".** Add a phase-4 paragraph to section 3 of the spec: what each form looks like as built (with the constants: `CORE_TINT`, `PART_WASH_ALPHA`, `PETAL_LABEL_MIN_ZOOM`, backdrop gradient stops), that the backdrop is a worker bitmap on desktop and a baked blit on mobile sharing `drawGalaxyBackdrop`, the "Other" rule, global `clearNames`, the preview's deliberately reduced parity, and (if Task 10 landed) the home fit. Commit:

```bash
git add docs/superpowers/specs/2026-09-29-constellation-galaxy-design.md
git commit -m "docs: constellation galaxy spec — phase 4 as built

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Look (controller).** Screenshots desktop and mobile at 150, 1,000 and 2,500 contacts for the PR; confirm no console errors after a reload with a listener armed, and that the Home button returns to the initial framing.

---

## Self-review (against the spec)

- **Backdrop** (bulge, disk haze, filaments, dark lanes) → Task 5, both renderers (Tasks 5, 8). **Per kind:** petal wash + part pools + warm core + petal names → Tasks 4, 6, 7, 8; ring nebula → 6, 8; role open cluster (no wash, per-company tints, dotted lines, "across N companies", company subtitle) → 4, 6, 7, 8; binary (no wash) → 6; halo → unchanged. **LOD** → petal labels at label zoom ≥ 0.25 (Tasks 7, 8), existing summary/caps unchanged. **Unchanged behaviours** (size = score, comets, overdue, emphasis) are untouched.
- **Deferred items from phase 3:** petal-label vs name collision (bottom anchor, Task 4); "Other" (Task 1); global `clearNames` (Task 3); ring handles (Task 4 `anchorsLines` + Task 7); `graph-layout.ts` split (Task 2); 10k home zoom (Task 10 + Task 11 look).
- **Not in this phase:** profile photos; how-met affinity; retuning placement; the dashboard preview's backdrop/part pools/petal names (documented as reduced parity).
- **Type names used across tasks:** `GalaxyBackdropData`, `galaxyBackdropData`, `GalaxyDust`, `GalaxyLane`, `drawGalaxyBackdrop`, `SkyBitmapJob["galaxy"]`, `NebulaWashCluster.form/parts`, `NebulaData.form/parts`, `CORE_TINT`, `PETAL_LABEL_MIN_ZOOM`, `petalLabelOffset`, `anchorsLines`, `ClusterLabelData.subtitle`, `petalLabels[].anchor` (top-centre, below the part), `galaxyBackdropBitmap`, `ringSprite`, `HOME_FIT_TO_GALAXY` — consistent in every task.
- **Known risk:** the renderer tasks (5–8) edit large, performance-sensitive files whose tests are mostly pure helpers plus screenshots; the smokes cannot see a regression in DOM layer count or frame time, which is why Task 11 measures both against the phase-3 head.
