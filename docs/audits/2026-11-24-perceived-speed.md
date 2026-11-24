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

## Follow-up: contacts search settle (lexical list)

Same method (prod demo build, 10k fixture, `ORBIT_SIM_DB_LATENCY_MS=20`). Change: `listContactsPage` is lexical-only (no `await rankContacts`), skips `count(*)` when `q` is set, and the contacts page no longer awaits letters/plan/schools before starting the list.

### search-bench at 10k

| Query | Settled before | Settled after | Server before | Server after |
|---|---:|---:|---:|---:|
| ai | 303 | **256** | ~97 | **85** |
| sarah | 459 | **291** (−37%) | ~298 | **120** (−60%) |
| engineer at acme | 605 | **402** (−34%) | ~414 | **203** (−51%) |
| zzzz-no-match | 478 | **295** (−38%) | ~296 | **132** (−55%) |

`sarah` lands at ~debounce (150) + lexical server (~120). Tradeoff: meaning-only matches no longer widen the `/contacts` list (still available via ⌘K / chat).
