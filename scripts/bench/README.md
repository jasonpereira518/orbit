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
