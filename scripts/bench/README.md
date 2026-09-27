# Constellation benchmarks

Repeatable measurements for `/graph`, so "is it smooth at N contacts" has an answer that can be
compared across branches and months rather than re-argued from feel.

## Running them

```bash
# The chart, in a production build, at several network sizes.
ORBIT_BENCH=1 npx next build --profile        # adds src/app/bench/** (see pageExtensions)
node scripts/bench/serve-static-bench.mjs 3417 &
node scripts/bench/constellation-browser.mjs 100,500,1000,2500 --label after --out after.json
node scripts/bench/constellation-browser.mjs 1000 --soak --soak-ms 180000   # memory over time
node scripts/bench/constellation-browser.mjs 1500 --trace                   # frame breakdown

# The rest of the app, before and after opening the chart (demo-mode dev server).
node scripts/bench/app-responsiveness.mjs http://localhost:3001 never,opened,refresh

# The layout alone, plus a fingerprint of every star position.
npx tsx scripts/bench/constellation-layout.ts
```

### Open, zoom and pan — the before/after method

`constellation-interactions.mjs` measures the three core interactions the same way every time,
so two builds can be compared. Full method in the script's header; in short:

```bash
npx tsx scripts/bench/constellation-fixtures.ts 100,1000,2500,5000,10000   # payloads, .bench-data/
ORBIT_BENCH=1 npx next build --profile
node scripts/bench/serve-static-bench.mjs 3417 --h2 &                       # HTTP/2, as production
# the other build (e.g. a worktree at the base commit), same server code:
BENCH_NEXT_DIR=/path/to/base/.next node scripts/bench/serve-static-bench.mjs 3418 --h2 &
node scripts/bench/constellation-interactions.mjs 100,1000,2500,5000,10000 --reps 5 \
  --ab before=https://localhost:3418/bench/constellation,after=https://localhost:3417/bench/constellation --out ab.json
node scripts/bench/constellation-report.mjs ab.json
```

- **Open**: the payload is fetched (`?data=fetch`) with 40ms emulated RTT and a cold cache; the
  app's own `constellation:*` performance marks split it into data → renderer → layout → paint
  → interactive (`src/lib/graph/open-marks.ts`; also visible in DevTools' Timings track).
- **Zoom**: 0.05 → 2.4 (and back) about the sun over exactly 3s on an exponential curve.
- **Pan**: a 240px circle at the opening framing, and a 1,800px line at zoom 0.5, 3s each.
- Per gesture: average FPS, minimum FPS (1000 ÷ longest frame), long tasks (> 50ms).
- `--ab` interleaves the two builds, alternating which goes first; medians of `--reps`.

### Frames against a 120Hz budget — `--suite frame`

A 60fps average hides what a ProMotion display shows: at 120Hz a frame has 8.3ms, and one that
takes 20ms drops two. `--suite frame` scores each frame's main-thread cost (from its rAF to a
message posted from it, which runs after style, layout and paint) against that budget, with the
input real hardware sends:

- `summary-cross`: zoom 0.09 ↔ 0.25, across the summary view's enter/exit and the cluster-name
  threshold; `pinch-trackpad`: ctrl-wheel, 2 small events a frame, 0.05 → 1 → 0.05;
  `wheel-notch`: ±100 ticks every 180ms, then every 90ms, at zoom 0.3.
- `hover-sweep` (a star a frame at 0.5), `hover-drift`, `search-type` ("stri", 120ms a key, with
  the camera flight), `cluster-click` (the flight in, with its star-mount batches).
- Reports frames over 8.3ms, p95 and worst frame, Long Animation Frames, and React commits per
  input event.

```bash
node scripts/bench/constellation-interactions.mjs 100,500,1000,2500 --reps 5 --suite frame \
  --ab before=…,after=… --out frame.json
node scripts/bench/constellation-report.mjs frame.json
```

Headless Chrome stays at 60Hz on purpose: it keeps input rates realistic, and the cost per frame
is what the budget needs. `--uncapped` lifts the cap, for diagnosis only (it inflates event rates).

Run long benchmarks under `caffeinate -dimsu`: headless Chrome on macOS paces rAF from the
display, so when the display sleeps an in-page rAF loop never finishes.

`--ablate` strips one visual layer at a time (`nolabels`, `nonebula`, `nodust`, `noanim`,
`notwinkle`, `novpwill`, …) to price it. It is a diagnostic, not a
measurement of the product: it answers "which part of the sky costs the frames".

## Why it is built this way

- **Synthetic networks, not the seeded fixture.** `src/lib/graph/synthetic-network.ts` draws
  companies from a power law, because layout and render cost follow cluster structure, not
  headcount. `scripts/lib/scale-fixture.ts` spreads everyone over 16 companies, which at 10,000
  contacts is sixteen 600-person clusters and nothing like a real export.
- **A production build with `--profile`**, so React's `<Profiler>` reports real commit costs
  (the numbers React DevTools shows) without development-build overhead.
- **Headless Chrome with the GPU on** (`launch({ gpu: true })`). Software raster would bill
  paint to the CPU and understate frame rates. Each run prints a control fps from an empty
  page: if that is not ~60, the machine is the ceiling and the run is noise.
- **Phases drive themselves from inside the page.** CDP input costs ~110ms an event on a loaded
  machine, which would be the bottleneck being measured. Frame times are rAF deltas.

## Measured on an M4 Pro, 1440x900, September 2026

Before → after the optimisation pass (see git log for the changes). fps.

| Contacts | Reveal ms | Idle | Pan | Zoom | Hover | Heap MB | DOM nodes |
|---------:|----------:|-----:|----:|-----:|------:|--------:|----------:|
|      100 |  643 →  508 | 60 → 60 | 60 → 60 | 46 → 59 | 60 → 60 | 10.8 → 10.6 |  2,063 →  1,999 |
|      500 |  614 →  542 | 28 → 59 | 24 → 56 | 15 → 58 | 28 → 60 | 25.1 → 23.9 |  8,125 →  7,659 |
|    1,000 |  987 →  794 | 13 → 58 | 11 → 30 | 5.5 → 30 | 11 → 57 | 42.6 → 38.1 | 15,406 →  9,358 |
|    1,500 | 1,223 →  946 | 8.9 → 55 | 6.9 → 18 | 3.1 → 17 | 7.4 → 38 | 59.6 → 52.8 | 22,645 → 13,529 |
|    2,000 | 1,487 → 1,135 | 5.5 → 48 | 3.8 → 13 | 2.0 → 15 | 4.1 → 32 | 73.8 → 65.2 | 28,645 → 16,911 |
|    2,500 | 1,675 → 1,312 | 4.9 → 44 | 2.9 → 9.2 | 2.0 → 14 | 5.2 → 26 | 83.5 → 73.4 | 32,307 → 18,842 |
|    5,000 | 2,523 → 1,979 | 32 → 56 | 1.6 → 3.1 | 1.4 → 8.7 | 4.4 → 11 | 109 → 93.6 | 51,499 → 29,313 |
|   10,000 | 4,154 → 3,306 | 29 → 46 | 1.5 → 1.8 | 1.2 → 4.8 | 3.9 → 7.6 | 133 → 121.5 | 54,737 → 34,743 |

Three minutes of continuous pan/zoom/hover at 1,000 contacts: heap after GC 39.0 → 40.6 MB,
DOM nodes 9,358 → 9,181, listeners 3,900 → 3,830, frame rates flat. No leak.

**The comfortable ceiling is around 1,000–1,200 contacts** (pan and zoom ~30fps). It is choppy
by 1,500–2,000 and unusable past ~2,500, where the chart still mounts thousands of DOM stars.
Going higher is a renderer question, not a tuning one — `graph-canvas-mobile.tsx` already draws
the same sky on one canvas for phones.

### Summary view, still sky, in-place refresh (September 17, 2026)

Main vs. this pass, back to back on the same machine and build flags. Control 60fps throughout.
Every sky from 1,000 up opens at the minimum zoom (0.05), which is now the summary view: clusters
with headcounts plus one canvas of dots. `@0.3` is after wheeling in to zoom 0.3 (80–140 real
stars on screen); `zoomin` is the wheel-in itself, so it includes the crossing out of the summary.

| Contacts | Opens in (ms) | Idle | Pan | Zoom | Hover | Search | zoomin | Pan @0.3 | Layers | DOM nodes | Heap MB |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
|  1,000 |   794 → 470 | 57 → 60 | 32 → 60  | 32 → 60  | 59 → 60  | 39 → 42  | 53 → 58  | 60 → 60 | 1,577 → 81  |  9,358 → 1,817 |  38 → 10 |
|  2,500 | 1,276 → 509 | 43 → 60 | 8.7 → 60 | 12 → 60  | 31 → 60  | 14 → 20  | 36 → 54  | 60 → 60 | 3,002 → 121 | 18,842 → 2,970 |  73 → 14 |
|  5,000 | 1,952 → 490 | 53 → 60 | 4.7 → 60 | 7.4 → 60 | 8.9 → 60 | 2.2 → 19 | 24 → 48  | 59 → 58 | 4,488 → 168 | 29,313 → 4,386 |  94 → 21 |
| 10,000 | 3,226 → 600 | 37 → 60 | 1.8 → 59 | 4.8 → 60 | 6.1 → 60 | 1.4 → 15 | 6.7 → 35 | 60 → 53 | 5,655 → 281 | 34,743 → 6,506 | 121 → 31 |

The layer count is the one to watch: GPU memory follows it, and running out is what made the
sidebar's tiles drop and flash blank. Search is the weak spot left — each keystroke redraws the
dots and flies the camera, with stalls of up to ~1.1s at 10,000 — and so is the first wheel into
the close-up view at 10,000 (one ~1.4s commit as the visible stars mount).

### The cluster washes, on one canvas (September 17, 2026)

The standard `zoom` phase above swings about 2.2x either side of home and never reaches the
close-up, so it reported 60fps while a full-range zoom still stuttered. Measured instead by
wheeling from the home framing all the way to 2.4 and back, one tick a frame, three passes each
(control 60fps throughout, M4 Pro, 1440x900):

| Contacts | Zoom in | Zoom out | Frames over 33ms, per sweep |
|---:|---:|---:|---|
|    100 | 60 → 60 | 48 → 60 | in 0 → 0, out 4-5 → 0 |
|  2,500 | 55-56 → 59-60 | 55-56 → 60 | in 2-3 → 0-1, out 2 → 0 |
| 10,000 | 34 → 59-60 | 46 → 60 | in 13-14 → 0-1, out 9-12 → 0 |

What it cost was the existence of the wash boxes, not the gradients in them: flattening all five
lobes to one changed nothing, `background: none` with the boxes still in the DOM changed nothing,
and capping their count did not help because the large ones (four cluster radii across, up to
~10,500 world px) are the expensive ones. They are now one canvas node — see `NebulaWashNode` in
`graph-nodes.tsx`, which draws them the way `StarDustNode` draws the stars.

The structural numbers, from `constellation-browser.mjs` on the same two builds:

| Contacts | Layers | DOM nodes | Heap MB |
|---:|---:|---:|---:|
|  2,500 |  94 → 41 | 1,210 → 636 | 12.5 → 10.6 |
| 10,000 | 196 → 34 | 2,067 → 559 | 25.9 → 21.5 |

`--ablate nonebula` now hides the canvas (`.constellation-nebula-wash`) rather than the boxes.

### Frame rate: zoom, hover, search and clicks against 120Hz (September 25, 2026)

`--suite frame --ab`, 5 repetitions per build and size, PR #296's head (1654afba) against this
branch, on AC power; no repetition dropped (control ≥ 55fps). What changed, in the order the
baseline's traces ranked the cost:

- **One composited layer per star.** The two sky canvases were GPU layers under every star, so
  Chrome had to give each star its own layer above them (307 mid-zoom at 1,000 contacts; "Layerize"
  was ~580ms of every 3s summary zoom). The washes and dust are now drawn in a worker
  (`sky-bitmap.worker.ts`, `OffscreenCanvas` → PNG) and shown as `<img>`, which paints into its
  parent layer; the edges' `will-change` while moving went for the same reason (97 → 17 layers).
- **Every star re-rendered every 0.05 of zoom.** Each star now selects the size relief it draws and
  whether labels show (`graph-nodes.tsx`), so it re-renders only when those change.
- **Two full commits per star-mount batch.** Measured sizes go to a map rather than state, the
  summary view builds only the nodes it draws, and the per-transform setters only set on change.
- **More than one zoom per frame.** Wheel events after the first in a frame are summed into one
  (d3's wheel zoom is exponential in delta, so the final zoom is identical).
- Smaller: the invisible `<Background>` dot grid is gone; the end of movement is debounced 120ms
  (mouse notches no longer promote and demote every tick); no-op canvas redraws are skipped;
  hovering no longer redraws the washes.

| Gesture | Contacts | Frames over 8.3ms: before | after | Change | p95 frame ms: before | after | Worst frame ms: before | after | Long frames (LoAF): before | after | Commits/event: before | after |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Zoom across the summary view (0.09 ↔ 0.25) | 100 | 7 (3.9%) | 1 (0.6%) | -85.7% | 8.2 | 6.8 | 15.5 | 13.6 | 0 | 0 | — | — |
| Zoom across the summary view (0.09 ↔ 0.25) | 500 | 112 (67.9%) | 54 (30.5%) | -51.8% | 26.5 | 13.8 | 50.3 | 35.7 | 0 | 0 | — | — |
| Zoom across the summary view (0.09 ↔ 0.25) | 1,000 | 86 (49.4%) | 34 (19.2%) | -60.5% | 19.5 | 10.9 | 45.4 | 35.2 | 0 | 0 | — | — |
| Zoom across the summary view (0.09 ↔ 0.25) | 2,500 | 117 (74.1%) | 56 (31.6%) | -52.1% | 30.8 | 15.6 | 55.2 | 37.5 | 0 | 0 | — | — |
| Trackpad pinch (0.05 → 1 → 0.05) | 100 | 5 (2.8%) | 0 (0.0%) | -100.0% | 7.7 | 3.3 | 10.0 | 6.0 | 0 | 0 | 1.40 | 0.96 |
| Trackpad pinch (0.05 → 1 → 0.05) | 500 | 56 (34.6%) | 20 (11.7%) | -64.3% | 30.7 | 10.0 | 51.2 | 37.6 | 0 | 0 | 1.47 | 1.16 |
| Trackpad pinch (0.05 → 1 → 0.05) | 1,000 | 44 (26.0%) | 12 (7.0%) | -72.7% | 23.6 | 15.0 | 45.8 | 35.4 | 0 | 0 | 1.21 | 0.97 |
| Trackpad pinch (0.05 → 1 → 0.05) | 2,500 | 62 (39.0%) | 23 (13.4%) | -62.9% | 34.0 | 16.0 | 53.3 | 34.3 | 0 | 1 | 1.45 | 1.14 |
| Mouse-wheel notches | 100 | 19 (10.6%) | 18 (10.0%) | -5.3% | 12.3 | 12.7 | 22.5 | 19.8 | 0 | 0 | 4.08 | 2.75 |
| Mouse-wheel notches | 500 | 26 (14.4%) | 21 (11.7%) | -19.2% | 14.8 | 14.5 | 25.8 | 26.0 | 0 | 0 | 5.08 | 2.75 |
| Mouse-wheel notches | 1,000 | 10 (5.6%) | 11 (6.1%) | +10.0% | 8.4 | 9.2 | 13.3 | 16.4 | 0 | 0 | 3.75 | 2.25 |
| Mouse-wheel notches | 2,500 | 26 (14.4%) | 21 (11.7%) | -19.2% | 16.4 | 15.4 | 29.4 | 28.5 | 0 | 0 | 4.88 | 2.75 |
| Hover star to star | 100 | 0 (0.0%) | 0 (0.0%) | 0% | 1.8 | 2.0 | 2.4 | 3.7 | 0 | 0 | 1.97 | 1.95 |
| Hover star to star | 500 | 0 (0.0%) | 0 (0.0%) | 0% | 2.1 | 2.0 | 3.0 | 4.2 | 0 | 0 | 1.95 | 1.97 |
| Hover star to star | 1,000 | 0 (0.0%) | 0 (0.0%) | 0% | 1.2 | 2.5 | 2.8 | 3.1 | 0 | 0 | 1.97 | 1.97 |
| Hover star to star | 2,500 | 0 (0.0%) | 0 (0.0%) | 0% | 1.4 | 1.9 | 4.8 | 3.2 | 0 | 0 | 1.96 | 1.95 |
| Pointer drifting over the sky | 100 | 0 (0.0%) | 0 (0.0%) | 0% | 3.9 | 3.8 | 5.4 | 5.3 | 0 | 0 | 0.04 | 0.03 |
| Pointer drifting over the sky | 500 | 0 (0.0%) | 0 (0.0%) | 0% | 1.9 | 1.8 | 6.6 | 5.0 | 0 | 0 | 0.08 | 0.06 |
| Pointer drifting over the sky | 1,000 | 0 (0.0%) | 0 (0.0%) | 0% | 1.5 | 1.5 | 2.1 | 2.0 | 0 | 0 | 0.00 | 0.00 |
| Pointer drifting over the sky | 2,500 | 0 (0.0%) | 0 (0.0%) | 0% | 1.9 | 2.0 | 7.6 | 3.4 | 0 | 0 | 0.07 | 0.07 |
| Typing a search + camera flight | 100 | 7 (4.7%) | 4 (2.7%) | -42.9% | 8.2 | 6.1 | 40.0 | 36.5 | 0 | 0 | 18.50 | 14.00 |
| Typing a search + camera flight | 500 | 4 (2.7%) | 4 (2.7%) | 0.0% | 3.6 | 2.7 | 29.1 | 24.4 | 0 | 0 | 10.25 | 6.00 |
| Typing a search + camera flight | 1,000 | 4 (2.7%) | 1 (0.7%) | -75.0% | 3.4 | 2.6 | 17.3 | 15.2 | 0 | 0 | 9.75 | 5.25 |
| Typing a search + camera flight | 2,500 | 4 (2.7%) | 3 (2.0%) | -25.0% | 3.3 | 2.4 | 23.2 | 17.0 | 0 | 0 | 9.50 | 5.50 |
| Clicking a cluster (flight in) | 100 | 4 (4.4%) | 1 (1.1%) | -75.0% | 8.0 | 5.3 | 18.0 | 17.0 | 0 | 0 | 56.00 | 41.00 |
| Clicking a cluster (flight in) | 500 | 8 (8.9%) | 7 (7.8%) | -12.5% | 9.0 | 8.9 | 13.3 | 11.3 | 0 | 0 | 78.00 | 86.00 |
| Clicking a cluster (flight in) | 1,000 | 6 (6.7%) | 5 (5.6%) | -16.7% | 8.4 | 7.6 | 14.9 | 10.7 | 0 | 0 | 76.00 | 78.00 |
| Clicking a cluster (flight in) | 2,500 | 8 (8.9%) | 8 (8.9%) | 0.0% | 11.5 | 9.9 | 19.1 | 13.4 | 0 | 0 | 79.00 | 83.00 |

Frame cost = main-thread time from a frame's rAF to after its paint; over 8.33ms drops a frame at 120Hz. Medians over the repetitions kept (before/after) — 100: 5/5, 500: 5/5, 1,000: 5/5, 2,500: 5/5. Dropped for a control frame rate under 55fps: none.

- Zoom is where the frames were, and where they came back: summary zoom and pinch lose 52–73% of
  their over-budget frames at 500–2,500, with p95 roughly halved.
- **Not fixed:** 12–30% of zoom frames are still over 8.3ms. What remains is React Flow's
  per-node store selectors and React commits, which grow with the mounted stars.
- **Slightly worse:** mouse-wheel notches at 1,000 (10 → 11 frames, p95 8.4 → 9.2ms), inside the
  noise of the other sizes, which improved. Commits per notch fell from ~4–5 to 2.75.
- Hover, search and cluster clicks were already mostly within budget and stay there. The plan's
  hover/search rework (CSS dimming, isolating `NetworkGraph` re-renders, batching summary hits)
  was not built: the measurements gave it nothing to win.

The open suite on the same two builds, to check nothing else paid for it (zoom out and both pans
were 60.0 avg / 59.5 min fps with 0 long tasks on both builds at every size):

| Scenario | Contacts | Metric | before | after | Change |
|---|---:|---|---:|---:|---:|
| Open | 1,000 | Time to interactive (ms) | 314 | 298 | -5.1% |
| Open | 1,000 | Data fetch start → interactive (ms) | 172 | 159 | -7.6% |
| Open | 1,000 | Long tasks until interactive | 0 | 0 | 0% |
| Open | 2,500 | Time to interactive (ms) | 332 | 329 | -0.9% |
| Open | 2,500 | Data fetch start → interactive (ms) | 197 | 187 | -5.1% |
| Open | 2,500 | Long tasks until interactive | 0 | 0 | 0% |
| Open | 10,000 | Time to interactive (ms) | 418 | 432 | +3.3% |
| Open | 10,000 | Data fetch start → interactive (ms) | 284 | 292 | +2.8% |
| Open | 10,000 | Long tasks until interactive | 0 | 0 | 0% |
| Zoom in (0.05 → 2.4, 3s) | 1,000 | Avg FPS | 60.0 | 60.0 | 0.0% |
| Zoom in (0.05 → 2.4, 3s) | 1,000 | Min FPS | 59.5 | 59.5 | 0.0% |
| Zoom in (0.05 → 2.4, 3s) | 1,000 | Long tasks (>50ms) | 0 | 0 | 0% |
| Zoom in (0.05 → 2.4, 3s) | 2,500 | Avg FPS | 59.0 | 60.0 | +1.7% |
| Zoom in (0.05 → 2.4, 3s) | 2,500 | Min FPS | 29.9 | 59.5 | +99.0% |
| Zoom in (0.05 → 2.4, 3s) | 2,500 | Long tasks (>50ms) | 0 | 0 | 0% |
| Zoom in (0.05 → 2.4, 3s) | 10,000 | Avg FPS | 59.3 | 60.0 | +1.2% |
| Zoom in (0.05 → 2.4, 3s) | 10,000 | Min FPS | 30.0 | 59.5 | +98.3% |
| Zoom in (0.05 → 2.4, 3s) | 10,000 | Long tasks (>50ms) | 0 | 0 | 0% |

At 10,000 contacts, open is +14ms (+8ms from the data fetch): paint is 9ms faster, but a frame of
work now lands after the first paint ("settle" 2 → 16ms), where the sky's first images are made.
The zoom-in minimum of 30fps at 2,500 and 10,000 is gone.

### Final: the open pass and its fixes, before → after (September 25, 2026)

This supersedes the September 24 table below, which measured the open pass before its regressions
were fixed (see "What got worse, and how it was fixed"). `--ab` with 5 repetitions per build and
size, the base commit (68077a34: instrumentation and method only) against the branch head, on AC
power (on battery, Chrome caps headless rAF at 30fps, and two earlier attempts were discarded for
it). Every repetition's control frame rate was 59.8–60.8fps.

2,500–10,000, from one uninterrupted run:

| Scenario | Contacts | Metric | before | after | Change |
|---|---:|---|---:|---:|---:|
| Open | 2,500 | Time to interactive (ms) | 680 | 312 | -54.1% |
| Open | 2,500 | Data fetch start → interactive (ms) | 541 | 174 | -67.8% |
| Open | 2,500 | Long tasks until interactive | 0 | 0 | 0% |
| Open | 5,000 | Time to interactive (ms) | 696 | 373 | -46.4% |
| Open | 5,000 | Data fetch start → interactive (ms) | 556 | 233 | -58.1% |
| Open | 5,000 | Long tasks until interactive | 0 | 0 | 0% |
| Open | 10,000 | Time to interactive (ms) | 730 | 435 | -40.4% |
| Open | 10,000 | Data fetch start → interactive (ms) | 592 | 303 | -48.8% |
| Open | 10,000 | Long tasks until interactive | 1 | 0 | -100.0% |
| Zoom in (0.05 → 2.4, 3s) | 2,500 | Avg FPS | 58.7 | 58.3 | -0.7% |
| Zoom in (0.05 → 2.4, 3s) | 2,500 | Min FPS | 29.9 | 29.9 | 0.0% |
| Zoom in (0.05 → 2.4, 3s) | 2,500 | Long tasks (>50ms) | 0 | 0 | 0% |
| Zoom in (0.05 → 2.4, 3s) | 5,000 | Avg FPS | 59.0 | 58.0 | -1.7% |
| Zoom in (0.05 → 2.4, 3s) | 5,000 | Min FPS | 29.9 | 29.9 | 0.0% |
| Zoom in (0.05 → 2.4, 3s) | 5,000 | Long tasks (>50ms) | 0 | 0 | 0% |
| Zoom in (0.05 → 2.4, 3s) | 10,000 | Avg FPS | 58.7 | 58.7 | 0.0% |
| Zoom in (0.05 → 2.4, 3s) | 10,000 | Min FPS | 29.9 | 29.9 | 0.0% |
| Zoom in (0.05 → 2.4, 3s) | 10,000 | Long tasks (>50ms) | 0 | 0 | 0% |
| Zoom out (2.4 → 0.05, 3s) | 2,500 | Avg FPS | 60.0 | 60.0 | 0.0% |
| Zoom out (2.4 → 0.05, 3s) | 2,500 | Min FPS | 59.5 | 59.5 | 0.0% |
| Zoom out (2.4 → 0.05, 3s) | 2,500 | Long tasks (>50ms) | 0 | 0 | 0% |
| Zoom out (2.4 → 0.05, 3s) | 5,000 | Avg FPS | 60.0 | 60.0 | 0.0% |
| Zoom out (2.4 → 0.05, 3s) | 5,000 | Min FPS | 59.5 | 59.5 | 0.0% |
| Zoom out (2.4 → 0.05, 3s) | 5,000 | Long tasks (>50ms) | 0 | 0 | 0% |
| Zoom out (2.4 → 0.05, 3s) | 10,000 | Avg FPS | 60.0 | 60.0 | 0.0% |
| Zoom out (2.4 → 0.05, 3s) | 10,000 | Min FPS | 59.5 | 59.5 | 0.0% |
| Zoom out (2.4 → 0.05, 3s) | 10,000 | Long tasks (>50ms) | 0 | 0 | 0% |
| Pan, overview (circle, 3s) | 2,500 | Avg FPS | 60.0 | 60.0 | 0.0% |
| Pan, overview (circle, 3s) | 2,500 | Min FPS | 59.5 | 59.5 | 0.0% |
| Pan, overview (circle, 3s) | 2,500 | Long tasks (>50ms) | 0 | 0 | 0% |
| Pan, overview (circle, 3s) | 5,000 | Avg FPS | 60.0 | 60.0 | 0.0% |
| Pan, overview (circle, 3s) | 5,000 | Min FPS | 59.5 | 59.5 | 0.0% |
| Pan, overview (circle, 3s) | 5,000 | Long tasks (>50ms) | 0 | 0 | 0% |
| Pan, overview (circle, 3s) | 10,000 | Avg FPS | 60.0 | 60.0 | 0.0% |
| Pan, overview (circle, 3s) | 10,000 | Min FPS | 59.5 | 59.5 | 0.0% |
| Pan, overview (circle, 3s) | 10,000 | Long tasks (>50ms) | 0 | 0 | 0% |
| Pan, close-up @0.5 (1,800px, 3s) | 2,500 | Avg FPS | 60.0 | 60.0 | 0.0% |
| Pan, close-up @0.5 (1,800px, 3s) | 2,500 | Min FPS | 59.5 | 59.5 | 0.0% |
| Pan, close-up @0.5 (1,800px, 3s) | 2,500 | Long tasks (>50ms) | 0 | 0 | 0% |
| Pan, close-up @0.5 (1,800px, 3s) | 5,000 | Avg FPS | 60.0 | 60.0 | 0.0% |
| Pan, close-up @0.5 (1,800px, 3s) | 5,000 | Min FPS | 59.5 | 59.5 | 0.0% |
| Pan, close-up @0.5 (1,800px, 3s) | 5,000 | Long tasks (>50ms) | 0 | 0 | 0% |
| Pan, close-up @0.5 (1,800px, 3s) | 10,000 | Avg FPS | 60.0 | 60.0 | 0.0% |
| Pan, close-up @0.5 (1,800px, 3s) | 10,000 | Min FPS | 59.5 | 59.5 | 0.0% |
| Pan, close-up @0.5 (1,800px, 3s) | 10,000 | Long tasks (>50ms) | 0 | 0 | 0% |

**Open, by stage** (median ms; `constellation:*` marks)

| Contacts | TTI before (range) | TTI after (range) | boot ms | data ms | code + layout ms | paint ms | settle ms |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 2,500 | 680 (663–681) | 312 (299–346) | 139 → 138 | 47 → 49 | 147 → 52 | 334 → 64 | 15 → 11 |
| 5,000 | 696 (680–731) | 373 (363–397) | 141 → 144 | 51 → 57 | 165 → 64 | 324 → 104 | 15 → 5 |
| 10,000 | 730 (709–749) | 435 (428–465) | 138 → 135 | 60 → 63 | 208 → 91 | 314 → 146 | 15 → 2 |

Medians over the repetitions kept per size (before/after) — 2,500: 5/5, 5,000: 5/5, 10,000: 5/5. Dropped for a control frame rate under 55fps: none. Median control FPS on an empty page (before / after): 2,500: 60.4 / 60.4, 5,000: 60.5 / 60.4, 10,000: 60.2 / 60.5.
Opening zoom (before / after) — the framing must not change: 2,500: 0.05 / 0.05, 5,000: 0.05 / 0.05, 10,000: 0.05 / 0.05.

100 and 1,000, from the run before it (same method, same graph code; it died at 2,500 when the
machine went onto battery, so these come from its log rather than its JSON; the baseline lost one
1,000 repetition to a timeout, so that cell is 4 runs):

| Contacts | TTI before | TTI after | Change | Data fetch → interactive | Data ms | Long tasks during open | Zoom / pan (avg/min fps, long tasks) |
|---:|---:|---:|---:|---:|---:|---:|---|
| 100 | 664 | 332 | −50.0% | 526 → 192 | 44 → 45 | 0 → 0 | 60/59.5/0 both, every gesture |
| 1,000 | 663 | 298 | −55.1% | 516 → 157 | 50 → 47 | 0 → 0 | 60/59.5/0 both, every gesture |

#### What got worse, and how it was fixed

The first cut of the open pass (6a533241) opened 33–50% sooner but made five things worse. Each
was fixed in 90382b72, and the run above measures the fixed build:

| Got worse | Fix | Now |
|---|---|---|
| Long tasks during open at 5,000 (0 → 1) and 10,000 (1 → 2, ~150ms of blocking): with the Suspense boundaries gone, layout and the first render ran as one task | The opening layout is computed before the chart mounts, in ≤10ms slices between its phases (`buildHybridGraphLayoutSteps`, `src/lib/graph/sky-layout.ts`); the canvases' first draws wait a task while the stage is still hidden | 0 long tasks at every size; 10,000 went 1 → 0 against the base |
| Data stage 6–13ms slower: the preloaded chunks were requested first and evaluated in the payload's way | The speculative preload starts at background priority, behind the page's own work | +2 / +6 / +3ms at 2,500 / 5,000 / 10,000, −3 to +1 below that: mostly, not entirely, recovered |
| A speculative ~200KB download, wasted if you leave before the payload lands | Skipped on Save-Data and 2G connections; elsewhere it stays in the HTTP cache (`/_next/static` is `immutable`) for the next visit | — |
| ~150B gzip more JS on /contacts, /contacts/[id] and /dashboard (a brand-colour memo in `school-color.ts`, then `hashUnitStream` in `hash.ts`) | The memo is scoped to one layout inside `graph-layout.ts`; `hashUnitStream` has its own module. Both shared files are back to main | Every non-graph route's client JS is within ±11B gzip of main (build-ID noise), comparing builds made at the same path |
| /graph's own up-front JS +681B gzip (later +993B with the fixes) | The renderer hook and the first-paint helper moved into the lazy chunks | +830B gzip (+0.3%): the preload and layout-gate code, which used to come free from Next's shared `next/dynamic` runtime |

Not improved: zoom and pan (already at the frame-rate ceiling; the 5,000 zoom-in average reads
59.0 → 58.0fps, inside the 58.0–59.3 spread of both builds' repetitions, with minimum fps and long
tasks unchanged, and nothing in the change touches zooming), and the layout still runs on every
open (it needs every contact, so a partial payload cannot draw a stable first frame).

### Open, zoom and pan, before → after the open pass (September 24, 2026)

`constellation-interactions.mjs --ab`, the base commit (instrumentation and method only) against
the fixes, interleaved, M4 Pro, 1440x900, HTTP/2 with 40ms RTT, cold cache. Machine under heavy
unrelated load (load average 8–41), which the interleaving and the control filter are for.

| Scenario | Contacts | Metric | before | after | Change |
|---|---:|---|---:|---:|---:|
| Open | 100 | Time to interactive (ms) | 689 | 425 | -38.3% |
| Open | 100 | Data fetch start → interactive (ms) | 532 | 190 | -64.3% |
| Open | 100 | Long tasks until interactive | 0 | 0 | 0% |
| Open | 1,000 | Time to interactive (ms) | 655 | 330 | -49.6% |
| Open | 1,000 | Data fetch start → interactive (ms) | 515 | 176 | -65.8% |
| Open | 1,000 | Long tasks until interactive | 0 | 0 | 0% |
| Open | 2,500 | Time to interactive (ms) | 678 | 347 | -48.8% |
| Open | 2,500 | Data fetch start → interactive (ms) | 523 | 210 | -59.8% |
| Open | 2,500 | Long tasks until interactive | 0 | 0 | 0% |
| Open | 5,000 | Time to interactive (ms) | 698 | 381 | -45.4% |
| Open | 5,000 | Data fetch start → interactive (ms) | 563 | 232 | -58.8% |
| Open | 5,000 | Long tasks until interactive | 0 | 1 | new |
| Open | 10,000 | Time to interactive (ms) | 697 | 465 | -33.3% |
| Open | 10,000 | Data fetch start → interactive (ms) | 565 | 331 | -41.4% |
| Open | 10,000 | Long tasks until interactive | 1 | 2 | +100.0% |
| Zoom in (0.05 → 2.4, 3s) | 100 | Avg FPS | 60.0 | 60.0 | 0.0% |
| Zoom in (0.05 → 2.4, 3s) | 100 | Min FPS | 59.5 | 59.5 | 0.0% |
| Zoom in (0.05 → 2.4, 3s) | 100 | Long tasks (>50ms) | 0 | 0 | 0% |
| Zoom in (0.05 → 2.4, 3s) | 1,000 | Avg FPS | 60.0 | 60.0 | 0.0% |
| Zoom in (0.05 → 2.4, 3s) | 1,000 | Min FPS | 59.5 | 59.5 | 0.0% |
| Zoom in (0.05 → 2.4, 3s) | 1,000 | Long tasks (>50ms) | 0 | 0 | 0% |
| Zoom in (0.05 → 2.4, 3s) | 2,500 | Avg FPS | 58.7 | 58.7 | 0.0% |
| Zoom in (0.05 → 2.4, 3s) | 2,500 | Min FPS | 29.9 | 29.9 | 0.0% |
| Zoom in (0.05 → 2.4, 3s) | 2,500 | Long tasks (>50ms) | 0 | 0 | 0% |
| Zoom in (0.05 → 2.4, 3s) | 5,000 | Avg FPS | 59.0 | 59.0 | 0.0% |
| Zoom in (0.05 → 2.4, 3s) | 5,000 | Min FPS | 29.9 | 29.9 | 0.0% |
| Zoom in (0.05 → 2.4, 3s) | 5,000 | Long tasks (>50ms) | 0 | 0 | 0% |
| Zoom in (0.05 → 2.4, 3s) | 10,000 | Avg FPS | 58.7 | 59.0 | +0.5% |
| Zoom in (0.05 → 2.4, 3s) | 10,000 | Min FPS | 20.0 | 29.9 | +49.5% |
| Zoom in (0.05 → 2.4, 3s) | 10,000 | Long tasks (>50ms) | 1 | 0 | -100.0% |
| Zoom out (2.4 → 0.05, 3s) | 100 | Avg FPS | 60.0 | 60.0 | 0.0% |
| Zoom out (2.4 → 0.05, 3s) | 100 | Min FPS | 59.5 | 59.5 | 0.0% |
| Zoom out (2.4 → 0.05, 3s) | 100 | Long tasks (>50ms) | 0 | 0 | 0% |
| Zoom out (2.4 → 0.05, 3s) | 1,000 | Avg FPS | 60.0 | 60.0 | 0.0% |
| Zoom out (2.4 → 0.05, 3s) | 1,000 | Min FPS | 59.5 | 59.5 | 0.0% |
| Zoom out (2.4 → 0.05, 3s) | 1,000 | Long tasks (>50ms) | 0 | 0 | 0% |
| Zoom out (2.4 → 0.05, 3s) | 2,500 | Avg FPS | 60.0 | 60.0 | 0.0% |
| Zoom out (2.4 → 0.05, 3s) | 2,500 | Min FPS | 59.5 | 59.5 | 0.0% |
| Zoom out (2.4 → 0.05, 3s) | 2,500 | Long tasks (>50ms) | 0 | 0 | 0% |
| Zoom out (2.4 → 0.05, 3s) | 5,000 | Avg FPS | 60.0 | 60.0 | 0.0% |
| Zoom out (2.4 → 0.05, 3s) | 5,000 | Min FPS | 59.5 | 59.5 | 0.0% |
| Zoom out (2.4 → 0.05, 3s) | 5,000 | Long tasks (>50ms) | 0 | 0 | 0% |
| Zoom out (2.4 → 0.05, 3s) | 10,000 | Avg FPS | 60.0 | 60.0 | 0.0% |
| Zoom out (2.4 → 0.05, 3s) | 10,000 | Min FPS | 59.5 | 59.5 | 0.0% |
| Zoom out (2.4 → 0.05, 3s) | 10,000 | Long tasks (>50ms) | 0 | 0 | 0% |
| Pan, overview (circle, 3s) | 100 | Avg FPS | 60.0 | 60.0 | 0.0% |
| Pan, overview (circle, 3s) | 100 | Min FPS | 59.5 | 59.5 | 0.0% |
| Pan, overview (circle, 3s) | 100 | Long tasks (>50ms) | 0 | 0 | 0% |
| Pan, overview (circle, 3s) | 1,000 | Avg FPS | 60.0 | 60.0 | 0.0% |
| Pan, overview (circle, 3s) | 1,000 | Min FPS | 59.5 | 59.5 | 0.0% |
| Pan, overview (circle, 3s) | 1,000 | Long tasks (>50ms) | 0 | 0 | 0% |
| Pan, overview (circle, 3s) | 2,500 | Avg FPS | 60.0 | 60.0 | 0.0% |
| Pan, overview (circle, 3s) | 2,500 | Min FPS | 59.5 | 59.5 | 0.0% |
| Pan, overview (circle, 3s) | 2,500 | Long tasks (>50ms) | 0 | 0 | 0% |
| Pan, overview (circle, 3s) | 5,000 | Avg FPS | 60.0 | 60.0 | 0.0% |
| Pan, overview (circle, 3s) | 5,000 | Min FPS | 59.5 | 59.5 | 0.0% |
| Pan, overview (circle, 3s) | 5,000 | Long tasks (>50ms) | 0 | 0 | 0% |
| Pan, overview (circle, 3s) | 10,000 | Avg FPS | 60.0 | 60.0 | 0.0% |
| Pan, overview (circle, 3s) | 10,000 | Min FPS | 59.5 | 59.5 | 0.0% |
| Pan, overview (circle, 3s) | 10,000 | Long tasks (>50ms) | 0 | 0 | 0% |
| Pan, close-up @0.5 (1,800px, 3s) | 100 | Avg FPS | 60.0 | 60.0 | 0.0% |
| Pan, close-up @0.5 (1,800px, 3s) | 100 | Min FPS | 59.5 | 59.5 | 0.0% |
| Pan, close-up @0.5 (1,800px, 3s) | 100 | Long tasks (>50ms) | 0 | 0 | 0% |
| Pan, close-up @0.5 (1,800px, 3s) | 1,000 | Avg FPS | 60.0 | 60.0 | 0.0% |
| Pan, close-up @0.5 (1,800px, 3s) | 1,000 | Min FPS | 59.5 | 59.5 | 0.0% |
| Pan, close-up @0.5 (1,800px, 3s) | 1,000 | Long tasks (>50ms) | 0 | 0 | 0% |
| Pan, close-up @0.5 (1,800px, 3s) | 2,500 | Avg FPS | 60.0 | 60.0 | 0.0% |
| Pan, close-up @0.5 (1,800px, 3s) | 2,500 | Min FPS | 59.5 | 59.5 | 0.0% |
| Pan, close-up @0.5 (1,800px, 3s) | 2,500 | Long tasks (>50ms) | 0 | 0 | 0% |
| Pan, close-up @0.5 (1,800px, 3s) | 5,000 | Avg FPS | 60.0 | 60.0 | 0.0% |
| Pan, close-up @0.5 (1,800px, 3s) | 5,000 | Min FPS | 59.5 | 59.5 | 0.0% |
| Pan, close-up @0.5 (1,800px, 3s) | 5,000 | Long tasks (>50ms) | 0 | 0 | 0% |
| Pan, close-up @0.5 (1,800px, 3s) | 10,000 | Avg FPS | 60.0 | 60.0 | 0.0% |
| Pan, close-up @0.5 (1,800px, 3s) | 10,000 | Min FPS | 59.5 | 59.5 | 0.0% |
| Pan, close-up @0.5 (1,800px, 3s) | 10,000 | Long tasks (>50ms) | 0 | 0 | 0% |

**Open, by stage** (median ms; `constellation:*` marks)

| Contacts | TTI before (range) | TTI after (range) | boot ms | data ms | renderer ms | layout ms | paint ms | settle ms |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 100 | 689 (659–826) | 425 (314–447) | 157 → 232 | 45 → 46 | 116 → 27 | 4 → 3 | 350 → 103 | 14 → 11 |
| 1,000 | 655 (631–694) | 330 (314–346) | 140 → 167 | 48 → 54 | 121 → 16 | 14 → 10 | 317 → 66 | 15 → 16 |
| 2,500 | 678 (663–681) | 347 (327–360) | 147 → 140 | 48 → 55 | 120 → 18 | 22 → 17 | 315 → 103 | 16 → 14 |
| 5,000 | 698 (679–713) | 381 (364–398) | 140 → 140 | 55 → 64 | 126 → 18 | 39 → 28 | 328 → 114 | 16 → 16 |
| 10,000 | 697 (696–747) | 465 (446–472) | 134 → 137 | 60 → 73 | 135 → 23 | 73 → 53 | 286 → 175 | 7 → 4 |

Medians over the repetitions kept per size (before/after) — 100: 4/3, 1,000: 4/5, 2,500: 5/5, 5,000: 5/5, 10,000: 5/5. Dropped for a control frame rate under 55fps: before 100: 1, after 100: 2. Median control FPS on an empty page (before / after): 100: 60.3 / 60.6, 1,000: 60.25 / 60.4, 2,500: 60.4 / 60.3, 5,000: 60.7 / 60.6, 10,000: 60.2 / 60.6.
Opening zoom (before / after) — the framing must not change: 100: 0.157 / 0.157, 1,000: 0.05 / 0.05, 2,500: 0.05 / 0.05, 5,000: 0.05 / 0.05, 10,000: 0.05 / 0.05.

What moved the open, stage by stage:

- **paint** (−180 to −250ms, the largest): the chart's two `next/dynamic` boundaries suspended
  after the payload arrived, and React holds a boundary's content until 300ms after its fallback
  appeared. The sky was ready by ~440ms and shown at ~640ms. `constellation-modules.ts` renders
  the chart once its modules are loaded, with no Suspense fallback. The rest is the first
  framing's refine waiting two animation frames for React Flow's measurements, not a flat 100ms.
- **renderer** (−100ms): the shell and renderer chunks are preloaded from `ConstellationIntro`,
  alongside the payload, instead of after it and one after the other.
- **layout** (−20ms at 10,000, −25%): numeric clearance-grid keys and `hashUnitStream`. The same
  positions: every `constellation-layout.ts` fingerprint is unchanged.
- **data** got slightly slower (+6 to +13ms): the payload now shares the connection and the main
  thread with the chunk downloads it used to wait for.

Not improved, and why:

- **Zoom and pan** were already at the frame-rate ceiling from the passes above. The source-mapped
  profile of a full zoom at 2,500 has the main thread ~72% idle, with no long tasks and React
  commits under 6ms. What is left is one dropped frame per zoom-in at 2,500 and up, in the
  0.18–0.25 band where ~250 labelled stars mount (style and layerize, not script). Rare 100–250ms
  frames with no main-thread work behind them came and went with machine load, on both builds.
- **Long tasks at 5,000–10,000 went up** (0 → 1, 1 → 2; ~150ms total at 10,000 against ~75ms).
  Without the Suspense boundaries, layout and the first render run back to back in one task
  instead of being spread across the throttled reveal. The open is 230ms sooner, but at 10,000
  the page is unresponsive for up to ~90ms at a time during it. A layout worker would move the
  53ms layout off the main thread (but not off the critical path); not done here.
- **Layout is still recomputed from scratch** on every open. The whole-sky layout needs every
  contact (clusters pack by size), so a partial payload cannot draw a stable first frame.

### The rest of the app

Pressing the chart's Refresh and navigating away used to leave its loop running (Next issues a
client's server actions one at a time, so everything else queued behind it):

| Press Refresh, then leave | Before | After |
|---|---:|---:|
| Server-action POSTs | 261 | 12 |
| `/contacts` navigation | >120,000 ms | 1,088 ms |
| Idle main thread | 137% busy | 3.9% |
| Scrolling | 3.2 fps | 57.9 fps |

Simply opening and closing the chart was, and is, indistinguishable from never opening it: no
leaked timers, listeners, DOM or heap.
