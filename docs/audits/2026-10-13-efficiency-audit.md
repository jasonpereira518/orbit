# Efficiency audit — cold start, page switching, feature load (Oct 13 2026)

Audited at `da1ac82f` (main = production). Plan: budgets, then measure, then small fix PRs with
before/after numbers. Previous passes: nav-speed #222–#226, perceived loading #297, cold start #314.
561 commits have landed since #314.

## How it was measured

- **Local production build** (`next build` in a scratch copy, demo mode via the two measurement-only
  patches), PGlite seeded with **3,000** and **25,000** synthetic contacts (`scripts/seed-scale.ts`),
  `ORBIT_SIM_DB_LATENCY_MS=50` so render time ≈ sequential round trips.
- Tools: `page-depth.mjs`, `nav-timing.mjs` (plain click, and a 250 ms hover-then-click variant),
  `cold-start-report.mjs` (+ `--trace`), `bundle-report.mjs`, a Playwright mount-request recorder, and
  a statement/depth probe for the AI-status chain on the **production** policy path (demo mode skips it).
- **Caveat:** the machine was on battery with load average 30–177 from other sessions. Byte counts,
  statement counts, request counts and depth are reliable. Millisecond timings are inflated; only
  interleaved A/B comparisons are used for before/after claims.
- **Production:** `iad1` (beside Neon us-east-1); first `/api/health` 1.26 s, then 0.16 s. The
  signed-in tour (Oct 13, one admin account) and `/admin/analytics` field data are below.

## Production field data (`page_views.load_ms`, `/admin/analytics`, Oct 13)

| Route | Kind | n | p50 | p75 | p95 |
|---|---|---|---|---|---|
| /dashboard | in-app click | 76 | **524 ms** | **784 ms** | 1.5 s |
| /capture | in-app click | 51 | 320 ms | 398 ms | 703 ms |
| /chat | in-app click | 31 | 312 ms | 329 ms | 859 ms |
| /settings | in-app click | 24 | 282 ms | 423 ms | 1.0 s |
| /radar | in-app click | 5 | 312 ms | 321 ms | 1.4 s |
| /contacts | in-app click | 59 | 64 ms | 325 ms | 397 ms |
| /graph | in-app click | 39 | 49 ms | 323 ms | 1.0 s |
| /reminders | in-app click | 36 | 27 ms | 36 ms | 357 ms |
| /contacts/duplicates | in-app click | 2 | 3.0 s | 3.8 s | 4.5 s |
| / (landing) | full load | 200 | 1.5 s | **3.6 s** | **9.9 s** |
| /dashboard | full load | 34 | 1.7 s | 2.7 s | 4.8 s |
| /graph | full load | 5 | 4.4 s | 4.9 s | 5.3 s |
| /settings | full load | 3 | 2.8 s | 4.2 s | 5.3 s |

What the field data says:
- **Capture, chat, settings and radar always show a skeleton.** Their p50 of ~300 ms is React's
  hold, so they're never prefetched in time.
- **Dashboard is the slowest in-app page by far.**
- **The landing page's tail (p95 9.9 s on the busiest route) is a separate, unaudited problem.**

Live tour, warm vs first hit (TTFB / complete):
- Dashboard: 319–582 / 789–841 ms warm, against 895 ms / 3.5 s on the first hit.
- Other app pages: 125–234 ms TTFB warm, against 0.6–1.0 s on each route's first hit (cold
  instance).
- A cold hard load of /dashboard reached its load event at 6.0 s, and no mount effect ran before it.
  Warm, the same load is interactive at ~635 ms.
- The pulse double-fire reproduces in prod: two action POSTs at 625 and 822 ms.

## Scorecard

| Budget | Target | Measured (local, 50 ms/statement) | Status |
|---|---|---|---|
| Soft nav to a hot page, after a hover | ≤ 150 ms, no skeleton | p50 64 ms, p75 100 ms; Capture → Dashboard 366–371 ms **with** skeleton | mostly ✅, Dashboard ❌ |
| Soft nav, no hover (keyboard / fast click) | ≤ 450 ms | ~345 ms everywhere (React's 300 ms reveal hold); Dashboard 675–690 ms (held twice) | ✅ / Dashboard ❌ |
| Server depth to the first shell, hard load | ≤ 3 round trips | 3.4 floor (layout chain); dashboard 5, graph 5.7, profile 4.3 at 3k | ❌ |
| The same at 25k contacts | — | dashboard TTFB 774 ms, graph 1,038 ms, profile 349 ms (complete 674) | ❌ scales with network size |
| Cold module load per route | median ≤ 130 ms | ~200 ms (inflated by load; #314 measured 111 ms on a quiet machine) | re-measure on a quiet machine |
| Mount-time Server Actions in the first 2 s | ≤ 1 | **2** (the same pulse action, twice, serialized) + a 3rd at ~4 s | ❌ |
| Client JS, first load | no growth | 278–368 KB gz per app page; 3 preloaded fonts (112 KB) on every route | baseline recorded |

## Findings, ranked (users affected × time)

1. **The dashboard, graph and contact profile scale with network size.** At 25k contacts:
   - `/graph`: TTFB 1,038 ms and a **13 MB** RSC payload. It scans every contact, wide, and serializes
     all of `visibleContacts` (`src/lib/graph-data.ts`).
   - `/dashboard`: TTFB 774 ms, complete 982 ms.
   - Contact profile: `listRelatedContacts` reads **every contact** (nine columns) on every profile
     view and matches in JS (`src/actions/contacts.ts:1584`). Complete goes 367 → 674 ms from 3k to
     25k.
2. **The (app) layout runs a whole-network query on every full load.** `loadOrgBrandColors` (all
   companies plus a regex GROUP BY over every contact's school) costs 118 ms of DB time at 25k with
   no added latency. It also re-runs on every `router.refresh()`. That's why every page's TTFB grows
   35–40 ms from 3k to 25k (`src/app/(clerk)/(app)/layout.tsx:148`).
3. **The AI-status chain is sequential on the production path.**
   - `getAiAccessStatus` costs **4.2** round trips on Pro, **5.3** on Free, and **7.6** on Free when
     the pool memo is cold (5–8 statements).
   - Free's read path INSERTs the starter grant on every call (`credits/ledger.ts:155`).
   - Chat, capture, settings and the contact profile wait for it, behind the user_settings read.
4. **Mount-time work blocks the action queue.** Every hard load:
   - The pulse action fires **twice**: `offline-sync.tsx:69` forces a refresh even with an empty
     queue. Server Actions run one at a time per tab, so any action-backed click in the first
     ~0.65 s queues behind both.
   - `getMeetingCandidates` (Google Calendar, as a Server Action) fires at ~4 s.
   - avatar-backfill, presence and two track beacons also fire at mount.
5. **Cold start: three imports put the import engine and the AI graph in every page.** A string
   constant imported from the LinkedIn messages adapter (`linkedin-reminder.ts`), and two imports of
   the `admin-operations` barrel (`constellation-config.ts`, `site-invites.ts`) — the same trap #314
   fixed. The (app) layout's server graph had grown from 44 files (#314) to **147 files / 44.9k
   lines**. → **Fixed in PR 1.**
6. **The dashboard's in-app p50 of 524 ms is server time, not a double skeleton.**
   - Locally at 3k contacts, its loading.tsx and card skeletons do pay React's hold twice.
   - At a realistic account size (85 contacts) the cards resolve inside the first reveal window, in
     both the base and the variant that waits for the bundle (~370 ms either way).
   - Making the page await its shared bundle was tried and dropped: no gain at real sizes, slower
     at 3k.
   - What's left is the render itself (warm prod: shell 271–571 ms, complete 337–688 ms), which
     outlasts a normal hover. Next: profile which of its ~33 statements is slowest on Neon.
7. **Pending drafts UPDATE before they SELECT** (`agent-sends.ts:231`): 2 sequential round trips and a
   write on every dashboard view.
8. **Phone "More" sheet has no intent prefetch.** It uses plain `<Link>` (`mobile-nav.tsx:664`), so
   Meetings, Events, Knowledge, Radar, Imports and phone Reminders get no prefetch.
9. **First visit to Chat shows two skeleton phases.** The page skeleton, then the lazy `ChatPanel`
   chunk; nothing warms that chunk on hover.

Ruled out:
- **Proxy stealth read:** one Neon round trip on a cold instance, overlapping the Neon wake the page
  pays anyway.
- **Twilio, Stripe, AI SDKs, pdfjs, Sentry:** already lazy.
- **`ai.ts`:** still reachable from most pages, but its module self-time is ~1 ms.

## Fixes

| PR | Content | Status / evidence |
|---|---|---|
| **1** #425 `claude/perf-server-graph` | Leaf module for the LinkedIn import types; `recordAdminAction` from `admin-audit`; lazy relationship-engine runner in `actions/settings.ts`; `smoke-server-graph` guard | Layout graph **147 → 68 files** (44.9k → 22.9k lines). `/graph` cold evaluation **1,083 → 887 module factories**. Mean layout+page eval across 28 app routes **64 → 53 ms** (interleaved A/B, 21/28 faster). The guard fails 19 checks on main, passes after. |
| **2** #427 `claude/perf-round-trips` | Credit balance in one round (writes only when due); pool-state reads in parallel; drafts expiry beside the SELECT; per-instance brand-color memo | getAiAccessStatus **Free 5.3 → 2.4, Pro 4.2 → 2.3** rounds; getSettings chain **6.6 → 3.6 / 5.3 → 3.7**; drafts **2.2 → 1.1**. Tried and dropped: the dashboard awaiting its bundle (no gain at real sizes, slower at 3k). |
| **3** #428 `claude/perf-mount-and-nav` | Pulse only after a reconnect/replay; calendar nudge via `GET /api/meetings/candidates`; phone More sheet `IntentLink`; Chat chunk warmed on hover and rendered directly once loaded | Hard-load Server Actions **2 (+1 at 3.7 s) → 1**, lane free at **570 vs 1,108 ms**; first Chat visit after a hover **350–379 ms → 49 ms**, no skeleton. |
| 4 | Graph payload (slim cohort, drawn contacts only; target < 3 MB at 25k); bounded related-contacts read on the profile; radar first run streamed; explicit profile columns; Suspense around the AI notice | next — graph part after the galaxy stack (#372→#395) lands |
| 5 | Client bundle (`LazyMotion`, one notifications panel, font preload) | only items ≥ 15 KB gz |

Decisions for Jason, each with the number behind it:
- **`FreshOnArrival` 2 s threshold:** it re-renders the full tree after a prefetched click.
- **Route fade:** the exit phase adds 120 ms to every navigation.
- **Dark-mode starfield:** a 30 fps canvas under a 28 px backdrop blur.
- **Neon scale-to-zero:** keeping compute warm costs money.

## Cache Components / Partial Prefetching (deferred, recorded)

Next 16.3's "Instant Navigation" would show each route's App Shell on click and stream the rest. That
removes most of the 300 ms skeleton hold above without hover-dependent full prefetches.
`partialPrefetching` requires `cacheComponents`.

The cost is the reason it stays deferred:
- the (app) layout redirects before render (onboarding, stealth, auth gates), which Cache Components
  needs restructured;
- 63 `force-dynamic` segment configs have to go;
- every page's data reads need `"use cache"` lifetimes or Suspense placement.

Revisit after PRs 2–4: once the per-page server depth is ≤ 3 round trips, the remaining gap is mostly
that 300 ms hold, and this is the tool that removes it.

## Re-running this audit

```bash
npx tsx scripts/seed-scale.ts --user demo-user 3000          # own ORBIT_PGLITE_DIR
ORBIT_SIM_DB_LATENCY_MS=50 npx next start -p 3417             # in a patched scratch build
node scripts/dev/page-depth.mjs http://localhost:3417 --latency=50
node scripts/dev/nav-timing.mjs http://localhost:3417 --latency=40 --rounds=2
node scripts/dev/cold-start-report.mjs --runs 3 --filter "(app)"   # A/B: interleave two builds
npx tsx scripts/smoke-server-graph.ts
```
