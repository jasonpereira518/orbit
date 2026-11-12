# Constellation drag-pan frames — findings and plan (Nov 11, 2026)

## How it was measured

`constellation-interactions.mjs --suite pan` (new): drag-pans scored per frame against the 120Hz
budget (8.3ms, main-thread cost from a frame's rAF to after its paint), same method as
`--suite frame`. Four gestures, 3s each: a 240px circle at home, 1,200px at zoom 0.3 (cluster
names showing), 1,800px at 0.5 and 1,800px back. Production build with `--profile`, synthetic
networks of 2,500 and 10,000, `--ab` interleaved. An in-page MutationObserver probe counted
which nodes mounted, unmounted or moved during a pan.

The old `--suite open` pans read 60fps average and hid all of this: average fps at a 60Hz
headless cap cannot see a 20ms frame among fast ones.

## What a pan costs today (baseline, 2,500 contacts, zoom 0.3)

A pan should be a transform change and nothing else. Instead, in 3s:

- 532 star nodes mounted and 400 unmounted; the DOM changed in 131 of 179 frames.
- ~250 React commits (~1.4 a frame).
- 12–25% of frames over 8.3ms (load-dependent), p95 ~14ms, worst ~25–40ms.
- Trace: ~380ms of script, ~160ms Layerize, ~80ms style, ~75ms layout per 3s.

## Causes, in order of cost

1. **The star-dust node is rebuilt and remounted at every star-window move.** A pan moves the
   window every ~6% of the view. Each move made `rampActive` true for a few frames, which
   (a) rebuilt the dots over every contact in the sky, (b) mounted the dust node, whose first
   draw paints every dot on a main-thread canvas up to 2048² — an accelerated canvas, which also
   promotes the stars above it to layers — before the worker's image replaces it, then
   (c) removed the node again once the window filled.
2. **React Flow's `onlyRenderVisibleElements` culls at the exact screen edge.** Large skies
   already hand React Flow only a window of ≤450 stars (view + 25% margin), but React Flow
   mounts/unmounts each as it crosses the screen edge: a NodeRenderer re-render, new DOM, a
   ResizeObserver measure and a relayer on most frames.
3. **Re-added nodes move the whole list.** `useHiddenBeforeRemoved` parks a leaving node at the
   END of the list for one commit. If it returns (the dust node, by cause 1), React reconciles it
   from last to first and moves every node after it: 400–640 DOM moves in one frame. Hidden by
   culling today; it surfaces as 40–100ms frames the moment culling is off.
4. **Each star-mount batch re-renders the whole chart.** 16 stars a frame while moving; every
   batch re-runs `GraphCanvasFlow` and React Flow re-adopts every node.

Smaller: the highlighted cluster's pinned name re-renders on every pan frame (only with a
highlight); `setSkyDrift` calls `matchMedia` once a frame.

## Plan

| # | Change | Expected effect | Status |
|---|---|---|---|
| 1 | Build the dots once per sky for every large sky; keep the dust node mounted and hide it (`visibility: hidden`) instead of removing it. Hidden, it neither rebuilds for a search nor redraws for a zoom; it catches up on the render that shows it | No O(N) rebuild, no main-thread canvas draw, no layer promotion per window move | **Shipped** |
| 2 | Turn React Flow's edge culling off for large skies, where the star window already culls | No per-frame mount/unmount while panning inside the window | **Rejected** — measured worse (below) |
| 3 | Stop hidden-but-subscribed wrappers and the end-of-list reorder | Only needed if 2 shipped | Not needed |
| 4 | Cheaper mount batches / per-node selectors | Fewer full-chart commits per window move | **Not built** — see "What is left" |

## Results

`--suite pan --ab`, base (main bedd0dc6) against this branch, 3 interleaved repetitions per size,
every control 59.4–60.9fps. Medians:

| Gesture | Contacts | Frames over 8.3ms: before | after | Change | p95 frame ms: before | after | Worst frame ms: before | after | Long frames (LoAF): before | after | Commits/event: before | after |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Drag-pan at home (240px circle) | 2,500 | 0 (0.0%) | 0 (0.0%) | 0% | 2.3 | 2.2 | 5.6 | 5.3 | 0 | 0 | — | — |
| Drag-pan at home (240px circle) | 10,000 | 0 (0.0%) | 0 (0.0%) | 0% | 3.0 | 3.3 | 4.8 | 6.0 | 0 | 0 | — | — |
| Drag-pan @0.3, names showing (1,200px) | 2,500 | 11 (6.1%) | 6 (3.3%) | -45.5% | 8.4 | 7.5 | 11.7 | 10.4 | 0 | 0 | — | — |
| Drag-pan @0.3, names showing (1,200px) | 10,000 | 8 (4.4%) | 6 (3.3%) | -25.0% | 6.6 | 6.6 | 15.8 | 10.9 | 0 | 0 | — | — |
| Drag-pan @0.5, close-up (1,800px) | 2,500 | 0 (0.0%) | 0 (0.0%) | 0% | 3.5 | 3.4 | 7.0 | 7.4 | 0 | 0 | — | — |
| Drag-pan @0.5, close-up (1,800px) | 10,000 | 4 (2.2%) | 1 (0.6%) | -75.0% | 4.1 | 4.2 | 18.4 | 8.5 | 0 | 0 | — | — |
| Drag-pan @0.5, back over drawn sky | 2,500 | 3 (1.7%) | 3 (1.7%) | 0.0% | 5.8 | 4.6 | 10.3 | 15.2 | 0 | 0 | — | — |
| Drag-pan @0.5, back over drawn sky | 10,000 | 3 (1.7%) | 1 (0.6%) | -66.7% | 3.6 | 4.9 | 16.1 | 8.4 | 0 | 0 | — | — |

Frame cost = main-thread time from a frame's rAF to after its paint; over 8.33ms drops a frame at 120Hz. Medians over the repetitions kept (before/after) — 2,500: 3/3, 10,000: 3/3. Dropped for a control frame rate under 55fps: none.

The same direction held in all three A/B runs made during the work (close-up worst frame at
10,000: 12.6→6.6, 16.6→8.5, 18.4→8.5ms; at zoom 0.3 frames over budget −25% to −45% in two of
three, the third flat). Single worst frames are noisy in both directions — the 2,500 back-pass
read 10.3 → 15.2ms here and 11.6 → 8.8ms in an earlier run; frames over budget are the steadier
measure.

**No regressions elsewhere.** `--suite frame` on the same builds: zoom, pinch, wheel, hover,
drift, search and cluster clicks move within run-to-run noise (the baseline alone swung 15→46
frames over budget for a 10,000 pinch between runs). A focused 6-rep check of the two gestures
that read worst once: pinch 50 → 47 frames over budget, summary zoom 98 → 103, with both builds'
repetitions spanning the same 95–111. An intermediate build that still redrew the hidden dots
made a search's worst frame at 10,000 worse (32 → 48ms); the hidden-dots freeze fixed it
(81 → 55ms in the final run).

### At a real 120Hz (Nov 12)

Headless Chrome is capped at 60Hz, so the pan suite was re-run in a real Chrome window on the
MacBook's ProMotion display (`--headful`, DPR 2): rAF really runs at 120 there. Frames skipped
per ~360-frame pan (interval > 12.5ms), 3 repetitions each, before → after:

| Pan | 2,500 | 10,000 |
|---|---|---|
| Home (circle) | 0,0,0 → 0,0,0 | 0,0,0 → 0,0,1 |
| Zoom 0.3, names showing | 2,0,1 → 6,3,1 | 7,14,2 → 4,4,6 |
| Close-up 0.5 | 1,0,0 → 2,0,0 | 1,5,1 → 0,1,0 |
| Close-up 0.5, back | 0,0,0 → 0,0,0 | 1,0,0 → 0,0,0 |

- **Home and close-up pans hold 120fps** (117.5–120 average, worst frame 9.4ms in nearly every
  run). **Every pan holds 60**: across 24 runs, 3 frame intervals over 25ms — all at zoom 0.3
  or in a lone stall (below).
- **Zoom 0.3 does not hold 120**: ~118fps average, 1–6 skipped frames per pan, now and then a
  25–50ms hitch, in both builds (fix 1 does not touch it: at 0.3 the window holds more than
  450 stars, so the dots never left). Each over-budget frame is a blend — ~2–3ms of React
  mounting the stars and their names that cross the screen edge, ~1–2ms of input and store
  selectors, 1–3ms Layerize, some paint — with no single cause to remove.
- One 150–170ms stall in each build (2,500, one repetition each) had no main-thread frame over
  budget: a system or GPU hiccup, not the chart.

### Fix 2, measured and rejected

Culling off (patched into a build of fix 1) took commits from ~255 to ~61 a pan and churn
frames from 134 to 27 — and still lost: at zoom 0.3, frames over budget 4% → 8–11%, worst
frame 12 → 25–49ms. Keeping every window star mounted (400–640 nodes against ~100–260) costs
more in style, layout and Layerize than React Flow's edge churn does. Before fix 1 it was worse
still: each window move re-ordered every node (cause 3).

### What is left

At zoom 0.3 a pan still drops ~3% of frames at 120Hz (p95 6.6–7.5ms). A CPU profile shows no
hotspot above ~1% of the pan: it is React Flow's per-node and per-edge store selectors running on
every camera update, d3's `getBoundingClientRect` per mousemove, NodeRenderer commits as stars
cross the edge, and Layerize. That is the DOM-stars ceiling the bench README already names; the
next real step is drawing stars on a canvas (as `graph-canvas-mobile.tsx` does), not tuning.
