# Constellation galaxy: clustering, layout and cluster design

**Date:** 2026-09-29 · **Branch:** `claude/constellation-render-clustering-b81406` · **Status:** approved design, pre-plan

## Why

The `/graph` sky today is a packed atlas: one cluster per person (company → school → Deep Space),
clusters packed on concentric shells around the sun. Measured on the synthetic Zipf networks
(`src/lib/graph/synthetic-network.ts`):

- It reads as a bullseye — decorative rings, and a perfect dotted circle of Deep Space at the rim.
- 15–24% of people land in that rim.
- At 1,000 contacts, 46% of clustered people are anonymous scatter: a figure is capped at 9 stars,
  so a 136-person Google is 9 figure stars and 127 dots in a disk.
- ~26% of people have both a company and a school; the school tie is invisible.
- ~Half of all clusters are 2–3 people, each with a full wash and label.
- Company and school clusters look identical; "MIT" and "Massachusetts Institute of Technology"
  are two clusters.

History to respect: a July spiral-arm layout was removed (fb03da3d) because position implied
closeness and did not mean it. This design gives position one honest meaning: **near = related.**

## Decisions (settled with Jason)

| Question | Decision |
|---|---|
| What position means | Near = related (company family, alumni overlap, shared tags/interests). No radial meaning, no rings. |
| Grouping hierarchy | Company is the cluster; inside it, function; inside a function, school. |
| People outside a company cluster | Role clusters across companies, then school, then halo. |
| "Role" | Function, with founders/execs/VPs pulled into a leadership core. |
| Galaxy form | Flocculent disk: affinity decides placement; arm fragments are drawn along related chains. |
| Big-cluster anatomy | Petals: leadership core figure + one ≤9-star figure per function. |
| Kind design | Distinct objects per kind (petal company, ring-nebula school, open role cluster, binary pair, halo dust). |
| Engine | Clusters-first: local geometry → seeded affinity placement of disks → strict overlap removal. |

## 1. Grouping model

### Tiers (first match wins, each person gets exactly one home)

1. **Company cluster** — ≥2 contacts share the canonical company (`canonicalCompanyClusterName`, aliases collapse as today).
2. **Family satellite** — a lone contact whose company has a known family root (`companyFamilyRoot`) is seated in that family's largest cluster's field (today's `familySatellites`, unchanged). Kept ahead of role: sister-company is a stronger tie than function.
3. **Role cluster** — among the remaining people, ≥2 sharing a function form a cross-company cluster. Names: *Founders & Execs, Engineers, Product, Designers, Data & Research, Sales & BD, Marketing, People & Recruiting, Operations*. Leaders at one-off companies go to Founders & Execs. Unknown function never forms a cluster; it falls through.
4. **School cluster** — ≥2 remaining people share a normalized school key.
5. **Halo** — everyone else: unnamed field stars.

`ClusterKind` becomes `"company" | "role" | "school" | "other"` (`other` = halo). Search, the cluster
list, payload leak smoke and `toNamedGraphClusters` must treat `role` as a named cluster.

### Inside a company cluster

Every member gets `{ fn: RoleFunction, isLeader: boolean, schoolKey: string | null }`.

- `isLeader` members form the **core**.
- Non-leaders group by `fn` into **petals**. A function with a single member joins an `other` petal.
- Within a petal, members are ordered so shared `schoolKey`s are adjacent (the school *knot*), then by today's `orderConstellationMembers` rules (active before dormant, score, name).
- Top ≤9 of each petal (and of the core) trace its figure; the rest scatter around that petal.

Petal form applies when the cluster has ≥8 members and ≥2 petals of ≥2; otherwise the cluster keeps
today's single figure + scatter.

### New shared modules

- `src/lib/role-function.ts` — `classifyTitle(title) → { fn, isLeader }`, deterministic regexes.
  Recruiter checked first (the `seniorityOf` trap: "Technical Recruiting Lead" is a recruiter).
  `FOUNDER_EXEC` / `LEADER` regexes move here from `src/lib/events/relevance.ts`, which imports them.
  VP/Head-of/Director/C-suite/Founder/Partner ⇒ `isLeader`; plain "Manager", "Lead", "Staff" do not.
- `src/lib/school-key.ts` — `schoolKeys()` extracted from `events/relevance.ts` (both import it).
  Cluster key = the member's primary key; display name = the most common spelling among members,
  ties broken alphabetically.

### Affinity

Per cluster pair, one O(n) bucketing pass (no all-pairs scan):

- **family** — same `companyFamilyKey`: fixed strong weight.
- **alumni** — count of members of A whose school key is B's key, plus count of school keys shared by members of A and B.
- **tags/interests** — bucket members by lowercased tag/interest; a value shared by ≤20 clusters adds to each pair of clusters it spans. Values spanning >20 clusters are too generic and ignored.

Weight = Σ(signal × coefficient) / √(sizeA·sizeB). Coefficients live in one exported constant.

All inputs (`title`, `school`, `tags`, `sharedInterests`, `company`) are already in the graph
payload, so there are **no new queries** (`loadGraphData` is at its statement cap) and no new
payload fields for the leak smoke to consider.

`src/lib/constellation-fit.ts` remains the single source of truth: it now also returns per-member
`{ fn, isLeader, petal }`, per-cluster petals with their figure/scatter split, and the affinity list.

## 2. Galaxy layout

`buildHybridGraphLayoutSteps` keeps its generator shape (yield between phases, ≤~15ms each).

### Phase A — cluster-local geometry

| Shape | When | Geometry |
|---|---|---|
| `petal` | company, petal form | Core figure at origin. Petal footprints on a ring around it, angular spacing by the existing chord budget (`pairArc`), petal footprint radius by headcount. Each petal = figure + scatter via today's `buildClusterGeometry` pieces. |
| `figure` | company with ≥4 members, not petal form | Today's undistorted figure + scatter. |
| `open` | role cluster with ≥4 members | Same geometry as `figure`; differs only in rendering. |
| `ring` | school | Members on a ring of radius growing with count; overflow on an inner concentric ring; label-clearance enforced. |
| `binary` | any cluster of 2–3 | Tight pair/triple, no scatter. |

Output per cluster: local positions + footprint radius `foot`.

**As built (phase 3).** Forms are decided by `planClusterParts`: binary for 3 or fewer members; petal needs a company of at least 8 with at least 2 function groups of at least 2 non-leaders, lone functions folding into "Other" and a lone "Other" folding into the largest petal; open = role cluster of at least 4; ring = school of at least 4. Petals are arranged by `arrangeParts`: alternating big and small round the core, every pair verified, growing the ring until clear. Rings use a 124px spacing so labels cannot overlap and hold 43 stars before scattering the rest. Parts of one company keep 64px between footprints, and petal parts use a small "clear names" scale bump so tilted figures cannot clash labels. `layout` emits `form`, `petalLabels`, and per-star `partKey`, `partRole` and `leader`.

### Phase B — disk placement

1. **Seed** — biggest cluster first. Each next cluster (size order, id tiebreak) is placed tangent to its strongest already-placed neighbour at a hash-seeded angle; clusters with no affinity take the next sunflower (golden-angle) slot.
2. **Relax** — fixed N iterations (start 200; tune by bench): spring attraction along affinity edges, disk repulsion via a uniform grid (neighbours only), and a size-weighted pull to the origin so big clusters form the core. The sun's `SUN_CLEAR` disk repels.
3. **Resolve** — strict push-apart until every pair has ≥ `CLUSTER_GAP` between footprints and nothing intrudes on `SUN_CLEAR`. After an iteration cap, any cluster still in conflict is moved radially outward to the first clear spot, so non-overlap is a guarantee.

Deterministic: seeded hashes only, fixed iteration counts, stable ordering.

**As built.** Seeding places clusters in size order, with each cluster's strongest already-placed relatives seated right after it (top 3 by affinity, plus any family-strength link). Relaxing runs 20 force steps, and legalization mirrors the seed order. Independence from contact order is a tested property: affinity weights are quantized to 1e-9, summation order is fixed, and member ordering breaks ties by id.

**Small-galaxy tightening (phase 3, Task 6).** About 200 configurations of the placement constants moved the relatedness numbers by noise only. The "related-pair distance ÷ median pair distance" target proved ill-posed at ~150 contacts: with 17–23 clusters, 50–66% of all cluster pairs are linked, so the mean over linked pairs is about the mean over all pairs. Relatedness is guaranteed structurally by seeding (strongest relatives seated adjacent) and by the family-adjacency fixtures, so no constants were changed; `smoke-disk-placement` gained a "small galaxy stays tight" regression case (density ≥ 0.30, biggest cluster's near edge ≤ sunClear + 3·gap).

### Phase C — halo

Field stars sit beyond `diskRadius` with density falling off exponentially and hash-noised angles,
so the halo thins out instead of forming a ring. Same `ClearanceGrid` label clearance.

### Phase D — galaxy structure

The layout additionally returns:

```ts
galaxy: {
  coreRadius: number;       // warm bulge glow around the sun
  diskRadius: number;       // soft outer falloff
  filaments: Array<{ from: string; to: string; weight: number; path: Array<{ x: number; y: number }> }>;
}
```

Filaments = maximum spanning tree of the affinity graph plus up to k extra strongest edges, each a
gently bowed curve between cluster centres, width ∝ weight.

### Removed / changed

- `RING_RADII` and the `orbitRings` node are removed.
- Cluster label nodes gain `shape` and optional petal sub-labels (`petalLabels: Array<{ label, anchor }>`).
- There is no persisted drag-position key: nothing in `src` stores star positions, so nothing needs bumping.

## 3. Visual design

### Galaxy backdrop (worker bitmap, `sky-bitmap-draw.ts`)

- Core bulge: warm radial glow (`#fff6d6` → `#f5c86a` → transparent) sized by `coreRadius`.
- Disk: very faint cool haze to `diskRadius` with a soft edge.
- Filaments: dust points scattered along each path (cool blue-white, density ∝ weight) and a few thin dark dust lanes over the strongest.
- Screen-space starfield stays.

### Per kind

- **Company · petal** — brand wash over the cluster, lighter wash per petal. Core figure lines and stars warm-white (the leadership signal — star *size* still means score). Petal figures in lightened brand colour. Company name above; petal names smaller and dimmer.
- **Company · figure** — as today.
- **School · ring** — soft annulus glow in the school colour, stars on the ring, no lines, name inside the ring.
- **Role · open** — no shared wash; each star tinted by its own company's `clusterBrandColor`; dotted white lines ~35% alpha; label "Founders · across 7 companies"; star subtitle always shows company.
- **Binary** — one solid line, no wash, small label from mid zoom.
- **Halo** — tiny faint dots, label on hover only.

### Level of detail

- **Far** — galaxy glow, filaments, company washes, biggest cluster names + headcounts (existing summary view, 450-star window, existing label caps).
- **Mid (zoom ≥0.2)** — figure and petal lines, petal names, small-cluster names.
- **Near (zoom ≥0.5, today's thresholds)** — star names and subtitles.

Label collision priority: search hit > cluster > petal > star.

### Unchanged

Star size = score, comets, overdue ring, hover/select/search emphasis (petals join the dimming:
hovering a petal lights its figure). Profile photos stay out of scope.

## 4. Rendering, performance, testing

### Renderers

- **Desktop (React Flow):** `graph-nodes.tsx` — new cluster shapes, petal label nodes, dotted role lines; per-star tint is just data. Galaxy, filaments and ring nebulae in `sky-bitmap-draw.ts`.
- **Mobile canvas:** `draw-sky.ts` + `sky-sprites.ts` — bulge/disk/filaments baked into the background sprite; a ring-nebula sprite.
- **Shared geometry:** filament/dust point generation in one module (e.g. `src/lib/graph/galaxy-dust.ts`) consumed by both renderers, so mobile and desktop cannot drift as the washes already have (`nebula-lobes.ts` vs `sky-sprites.ts`).

### Performance rules kept

No canvas / blurred shadow / `will-change` under stars; no per-star looping animation; summary
view, star window and label caps unchanged.

### Gates before merge

- `scripts/bench/constellation-layout.ts` — layout at 10k ≤ today's ~50ms total, every phase slice ≤15ms.
- `constellation-interactions.mjs --ab` at 1k / 2.5k / 10k (on AC) — zoom not worse than main; TTI within +10%.

### Tests

- `scripts/smoke-graph-layout.ts` extended: determinism; disk non-overlap with gap; star–star / star–line clearance including across petals; no crossings between different figures (the four-star Crux template crosses itself by design); figure fidelity (pure similarity transform); every contact placed exactly once; `SUN_CLEAR` empty; **affinity honesty** — mean distance of related cluster pairs < median of all pairs.
- New `scripts/smoke-role-function.ts` — title table incl. "Technical Recruiting Lead", "Staff Engineer", "VP Engineering", "Co-founder & CEO", empty title.
- School normalization — "MIT" ≡ "Massachusetts Institute of Technology"; display name = majority spelling.
- `smoke-constellation-payload-leak` passes unchanged.
- New smokes registered in the suite (an unregistered smoke fails the run).

## Build phases

Each phase is independently mergeable:

1. **Grouping** — role classifier, school keys, role clusters, tier order, affinity. Ships on the current layout.
2. **Galaxy layout** — disk placement, halo, rings removed, `galaxy` output.
3. **Cluster anatomy** — petal / ring / binary / open geometry.
4. **Visuals** — backdrop, filaments, kind-specific drawing in both renderers.

## Out of scope

Profile photos on stars; how-met / event affinity; closeness-as-position; AI-based title
classification; changes to the dashboard preview sky beyond what shared modules carry.
