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

`--ablate` strips one visual layer at a time (`nolabels`, `nonebula`, `noglow`, `noanim`,
`nobreathe`, `nocomet`, `notwinkle`, `vpwill`, …) to price it. It is a diagnostic, not a
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
