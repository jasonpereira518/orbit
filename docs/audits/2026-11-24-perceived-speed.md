# Perceived page speed audit — 2026-11-24

Harness-led pass for soft-nav, profile opens, people search, and interaction stickiness.
Design: `docs/superpowers/specs/2026-11-24-perceived-speed-design.md`.

## Method

- Production `next build` + `next start` in demo mode (`ORBIT_MEASURE=1` patches, never committed).
- PGlite fixtures: 100 and 10,000 contacts (`scripts/dev/perf/seed-sizes.ts`).
- `ORBIT_SIM_DB_LATENCY_MS=20`, client CDP latency 20 ms where noted.
- Chrome via `scripts/dev/cdp.mjs` (resolves Linux Chrome / `CHROME_PATH`).
- Interleaved A/B only for claiming millisecond wins; skeleton rates and INP under `--cpu=4` are trusted.

## Baseline (before fixes)

### open-timing (dwell 150 ms, latency 20, rounds 5)

| Interaction | 100 contacts content_ms | 10k content_ms | Notes |
|---|---:|---:|---|
| nav → /contacts | 80 | 86 | Prefetch after dwell works |
| nav → /reminders | 44 | 72 | |
| nav → /dashboard | 120 | 125 | settled 366 → 960 at 10k |
| nav → /settings | 468 | 495 | Skeleton then slow content |
| profile ← contacts list | 64 | 64 | Intent handlers on rows work |
| profile ← dashboard | 42 | 68 | |
| profile revisit (back) | 36 | 38 | |
| ⌘K first open | 14 | 16 | |

### nav-timing (no dwell — fast click)

| | 100 contacts | 10k |
|---|---:|---:|
| ready p50 | 344 ms | 344 ms |
| ready p75 | 351 ms | 349 ms |

Most clicks showed a skeleton at ~40–55 ms then ready ≈ React’s ~300 ms reveal hold.

### search-bench (rounds 5)

| Query | 100 settled | 10k settled | 10k server |
|---|---:|---:|---:|
| ai | 246 | 260 | 102 |
| sarah | 294 | 454 | 287 |
| engineer at acme | 309 | 583 | 409 |
| zzzz-no-match | 254 | 444 | 296 |

### inp-bench (`--cpu=4`)

All interactions worst ≤ 144 ms (100) / ≤ 128 ms (10k). Under the 200 ms “good” bar.

## Changes shipped

1. **RouteProgress mounted** in `AppShell` — instant top-bar feedback on every in-app link (was implemented, never mounted; LATENCY_PLAN CLI-5).
2. **Desktop idle full-prefetch** of daily `prefetchFull` routes (Dashboard / Contacts / Reminders) ~1.5 s after sidebar mount — kills the ~300 ms skeleton hold on fast clicks without hover.
3. **IntentLink `pointerdown` full prefetch** — upgrades before click completes when hover never rested.
4. **IntentLink / progress on hot profile entry** — today-meetings, radar autopilot + empty state, find-people saved link, recommendation “Open contact”, graph compact star click (`beginRouteProgress` + prefetch on hover/click).
5. **Contacts search** — list query streams behind Suspense so filter chrome stays painted; `startTransition` + `aria-busy` on the search pill. Debounce left at 150 ms (server-bound at 10k).
6. **Harness** — `scripts/dev/cdp.mjs` resolves Linux Chrome / `CHROME_PATH` (+ sandbox flags) so benches run off macOS.

**Not shipped:** contact profile first-content rewrite (open-timing already ~64 ms with dwell); INP micro-opts (still green); settings streaming (not a named daily journey).

## After

### nav-timing (same flags)

| | 100 before → after | 10k before → after |
|---|---|---|
| ready p50 | 344 → **116 ms** (−66%) | 344 → **111 ms** (−68%) |
| ready p75 | 351 → 335 ms | 349 → **126 ms** |

Daily routes (contacts / reminders / dashboard) now show `skeleton_ms: null` after the idle warm. Graph / chat still pay the ~300 ms hold (not in `prefetchFull`, by design).

### open-timing at 10k (dwell 150 ms)

| Interaction | Before content_ms | After content_ms |
|---|---:|---:|
| nav → /contacts | 86 | 94 |
| nav → /reminders | 72 | 76 |
| nav → /dashboard | 125 | 119 (settled 960 → 679) |
| nav → /settings | 495 | 484 |
| profile ← contacts list | 64 | 65 |
| profile ← dashboard | 68 | 55 |
| profile revisit (back) | 38 | 40 (recheck; one noisy run discarded) |
| ⌘K first open | 16 | 15 |

### search-bench at 10k

| Query | Before settled | After settled | Notes |
|---|---:|---:|---|
| ai | 260 | 303 | Within noise; server ~100 ms |
| sarah | 454 | 459 | Still server-bound (~298 ms) |
| engineer at acme | 583 | 605 | Still server-bound (~414 ms) |
| zzzz-no-match | 444 | 478 | |

Settle wall-clock did not drop (query time dominates). Perceived win is the search pill and shell staying interactive while the list Suspense streams.

### inp-bench (`--cpu=4`, 10k)

| Interaction | Before worst | After worst |
|---|---:|---:|
| search typing | 32 | 24 |
| Sort menu | 128 | 120 |
| Company filter | 120 | 112 |
| ⌘K | 128 | 128 |
| dashboard button | 96 | 88 |
| chat composer | 56 | 56 |

No regressions; all remain under 200 ms.

## Verdict

The harness named soft-nav without hover as the real gap. Idle daily-route prefetch + RouteProgress cut fast-click ready time by ~2/3. Profile opens and INP were already healthy; search chrome now streams without claiming a server-time win.

---

## Follow-up: contacts search — first results fast, complete results unchanged

The first cut of this follow-up (#747) made the `/contacts?q=` list lexical-only and dropped the
count, which bought settle time by removing meaning matches, work-history matches, their "why"
labels, relevance order and the exact total. This revision keeps all of it and splits the search in
two **steps that stream in one response**:

1. **First results** — `listContactsPage(…, { search: "lexical" })`: the literal matches, ordered as
   the one-shot search orders them, in ONE statement (tags ride in the page query; no ranking, no
   count in front of it).
2. **Complete results** — `enrichContactsSearch`, started beside the page query and streamed as a
   promise prop (`ContactsList` folds it in; the subtitle swaps "Showing matches" for "N people
   match"): the matches found by meaning/work history, their labels, the final relevance order, the
   exact total (literal count + the few ranked-only contacts), one analytics event with that total.
   Folding it in keeps the rows under the pointer/focus (and everything in view once scrolled) in place.

Held to the original by `scripts/smoke-contacts-search-enrichment.ts` against a frozen copy of the
one-shot implementation (`scripts/lib/legacy-contacts-page.ts`): 640 query × sort × filter × ranker
combinations, paging through to the end, the exact total, cursors, labels, analytics and supersession.

Also: a finished ranking is cached 15 s (`rankContactsCached`), so Back, a refresh, a retyped query and
"load more" neither re-run the retrieval arms nor show the two-step reorder (the page is final on first
paint). A newer, different search by the same account stops the older enrichment at its next step.

### Plan fix found on the way

At 50k contacts a broad query ("engineer at acme", 2,940 matches) hash-joined the matched ids against a
**sequential scan of every contact**, running the non-person regex filters on all 50,000 rows, in both
the page and the count. `contactSearchIdsCondition` now reads `id = any(array(…))`, which drives from the
matched ids (EXPLAIN ANALYZE at 50k: page 588 → 95 ms, count 236 → 59 ms; narrow queries unchanged).
`scripts/dev/perf/contacts-search-explain.ts` reproduces it.

### Server-side search bench (`scripts/dev/perf/contacts-search-bench.ts`, median of 5, ms)

`orig` = the one-shot search as it was before this work (hybrid ranking awaited, exact count): the
first AND last paint of the old page. `first`/`complete` = this revision (first paint / list exactly
equal to the one-shot result). Every round asserts the final order and total equal the one-shot's.
`ORBIT_SIM_DB_LATENCY_MS=20` models production's one HTTPS round trip per statement.

| contacts | query | matches | orig | **first** | complete |
|---|---|---:|---:|---:|---:|
| 1k | sarah | 4 | 109 | **32** | 94 |
| 1k | engineer at acme | 83 | 124 | **40** | 117 |
| 10k | sarah | 4 | 225 | **71** | 234 |
| 10k | engineer at acme | 587 | 310 | **98** | 354 |
| 10k | zzzz-no-match | 0 | 227 | **85** | 209 |
| 50k | sarah | 4 | 245 | **38** | 111 |
| 50k | engineer at acme | 2,940 | 454 | **103** | 406 |
| 50k | marcus | 3 | 289 | **60** | 190 |

Queries under 3 characters (`ai`) never ranked; they are unchanged (≈50 ms).

How to read it: **time to first results drops 2–4×** at every size. **Time to complete is about the
same as the one-shot** here, not better: PGlite is one connection, so the page query and the
enrichment queue behind each other and the extra page query is pure added work (up to ~+30% at 10k
raw-DB). On production's HTTP driver the statements run concurrently, so complete should land at the
one-shot's time or earlier (no count round trip, ranking started beside the page) — not measured: this
run has no Neon access and no embedding provider, so the semantic arm (a LOWER bound on hybrid cost) is
absent. Repeats of a search are final on first paint.

Not verified: a real-LinkedIn/real-embedding run, the browser-level `search-bench.mjs` on a production
build, and Neon timings.
