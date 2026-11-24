# Perceived page speed (harness-led)

Status: approved approach from brainstorming, Nov 24 2026. Implementation tracks
`docs/audits/2026-11-24-perceived-speed.md`.

## Intent

Make signed-in Orbit *feel* faster on daily journeys — soft-nav between pages, opening a
profile, searching people, interacting — and prove every win with interleaved before/after
benches from the existing harness.

## Goals

- Soft-nav between app pages: fewer skeleton flashes when the user gave intent (hover/focus/touch).
- Contacts list → profile: time-to-content drops under the same harness.
- People search: last-keystroke → settled results improves (debounce already 150 ms; target remaining RSC settle).
- Interactions: no INP regression; fix only if `inp-bench` shows a sticky control.
- Every shipped change has numbers in one audit doc.

## Non-goals

- Marketing / landing LCP.
- Graph 100k architecture or Neon statement ratchets unless the open/nav harness points there.
- Broad Suspense rewrites of settings/recruiters without a measured journey calling for them.

## Anti-goals

- Shipping on vibes or non-interleaved desktop ms on a noisy machine.
- Breaking `IntentLink` / `staleTimes` / `FreshOnArrival` contracts in `docs/performance.md`.
- CLS regressions from streaming experiments (dashboard leading-cards already reverted once).

## Constraints

- Reuse existing harness only — no new bench framework.
- Fixture sizes: **100** and **10k** contacts via `scripts/dev/perf/seed-sizes.ts`;
  `ORBIT_SIM_DB_LATENCY_MS=20` (match Nov 7 audit).
- Demo serve via measurement-only `ORBIT_MEASURE=1` patches (never commit) +
  `scripts/dev/perf/serve-demo.sh`.
- Prefer intent-prefetch, streaming islands, and URL/search settle work over new dependencies.
- Trust: skeleton presence, request counts, bytes, CLS, throttled mobile / `--cpu` INP, and
  **same-machine interleaved A/B**. Desktop localhost ms alone is not a claim.

## Approaches considered

1. **Harness-led perceived speed** — chosen. Freeze baselines, fix only what the numbers name,
   re-bench into one audit.
2. Streaming rewrite of blocking pages — deferred unless baseline names them.
3. Shell JS / hydration cut — deferred (Nov 7 found no large deferrable chunk).

## Measurement loop

Seed 100 and 10k → baseline JSON → pick worst journey → small PR → interleaved A/B → update
audit → repeat.

Commands:

- `node scripts/dev/open-timing.mjs <url> --latency=20 --rounds=5 --json=…`
- `node scripts/dev/nav-timing.mjs <url> --latency=20 --rounds=5`
- `node scripts/dev/perf/search-bench.mjs <url> --rounds=5 --json=…`
- `node scripts/dev/perf/inp-bench.mjs <url> --rounds=5 --cpu=4 --json=…`

## Likely fix wave (drop any the numbers do not support)

1. Prefetch gaps on hot profile / nav entry paths.
2. Soft-nav skeleton flash where nav-timing still shows hold after intent.
3. Contacts search settle without blind debounce cuts.
4. Profile first-content path only if still slow after prefetch.
5. INP only if baseline under `--cpu=4` is red (~200 ms).

## Builder calls

- One concern per PR; re-bench that PR’s journeys before merging.
- New dynamic links use `IntentLink` or `useIntentPrefetchHandlers`.
- If a streaming change worsens CLS, revert.
