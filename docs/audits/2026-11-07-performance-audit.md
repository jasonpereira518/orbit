# Performance audit, 2026-11-07

Base: `a416933b` (main). Branch: `perf/audit-2026-11`. Every number below was measured on local seeded data
in this session, never production. Where a number is noisy or a change did not hold up, it says so.

Read after `PERFORMANCE_AUDIT.md`, `LATENCY_REPORT.md` and `docs/performance.md`. Those three rounds already took the
database, dashboard, graph, import and prefetching work as far as it goes; this audit starts from the code after them,
re-measures every page, and looks for what is left.

## Summary

The app was already fast. Navigation between app pages is near-instant, the worst interaction at 4x CPU was 80 ms, and
server work is cheap. What this audit found and shipped is small and specific; what it found and did **not** ship matters
as much.

| | Before | After | Evidence |
|---|---|---|---|
| Layout shift on `/meetings` (cold load) | CLS 0.055 | **0.005** | 5 of 5 alternating rounds, both datasets |
| Search: last keystroke to settled results, 10k contacts | 364 / 524 / 537 / 637 ms (`ai` / `sarah` / no match / `engineer at acme`) | **250 / 468 / 490 / 555 ms** | 2 interleaved passes, 5 runs each |
| Landing page revisit: revalidation requests for hero images | 10 | **0** | CDP network log, second load |
| Landing page revisit, mobile profile: LCP | 714 ms | **294 ms** (-59%) | pass 1, both sides at similar load |
| Profile page revisit, mobile profile: LCP | 714 ms | **240 ms** (-66%) | pass 1 |
| First-load JS on every route | unchanged | unchanged | page-bench: within +-1% on all 22 routes (largest move: `/meetings` +6 KB gz) |

Not shipped: a fix for the dashboard's layout shift (CLS 0.141) did not hold up under test and was reverted. See
"Tried and reverted".

## Scope and method

Pages: 7 public routes, 17 signed-in routes, the profile page, and `/graph`. Seeded accounts of 100 and 10,000 contacts
(the repo's `scripts/dev/perf/seed-sizes.ts`).

- **Build:** production `next build`, `next start`, demo mode. This needs two measurement-only edits (`isLocalhost()`
  and the proxy's production 503, gated on `ORBIT_MEASURE=1`). They were applied to both builds and never committed.
- **Database latency:** `ORBIT_SIM_DB_LATENCY_MS=20` on every statement, to stand in for Neon.
- **Profiles:** `desktop` is unthrottled 1440x900. `mobile` is 412x823, 4x CPU slowdown, 150 ms RTT, 1.6 Mbps.
- **Cold** is a fresh Chrome profile with an empty HTTP cache. **Warm** is a second load in the same browser.
- **A/B:** the baseline is a frozen worktree at `origin/main`, served beside the changed build from copies of the same
  snapshot. Runs alternate between the two.

**Limits you should know about:**
- **Shared machine.** Another agent's CPU-heavy work kept the load average between 8 and 40 for the whole session,
  and it reached 242 during one stretch. Desktop timings on a localhost server sit at tens of milliseconds, which is below
  that noise. Across two passes, routes I never touched swung by -50% to +50%. **No desktop-timing improvement is
  claimed.** Deterministic metrics (CLS, bytes, request counts, JS size) and the throttled mobile profile are the
  evidence.
- **Clerk is absent.** Demo mode has no Clerk, so Clerk's browser script is missing from every number. Signed-in LCP and
  INP in production will be slower than shown here.
- **Pass 2 is not a clean interleave.** The baseline half of pass 2 was rerun hours after the changed half, after a
  benchmark process hung. Headline warm-LCP numbers use pass 1.
- **No embeddings and no pgvector** in PGlite; semantic search arms are not measured.

## Baseline

### Core Web Vitals, mobile profile (100 contacts, median of 2 passes x 2 runs)

| Route | FCP | LCP | Interactive | TBT | JS gz |
|---|---|---|---|---|---|
| `/` | 1196 | 2459 | 2690 | 61 | 365 KB |
| `/pricing` | 1846 | 1846 | 3001 | 34 | 511 KB |
| `/terms` | 1251 | 1251 | 2154 | 11 | 412 KB |
| `/dashboard` | 1708 | 1708 | 3894 | 353 | 673 KB |
| `/contacts` | 1636 | **4771** | 4089 | 287 | 666 KB |
| `/contacts/[id]` | 1662 | 2909 | 4205 | 176 | 708 KB |
| `/graph` | 1666 | **4504** | 3567 | 226 | 664 KB |
| `/chat` | 1688 | **5280** | 3592 | 157 | 651 KB |
| `/capture` | 1672 | 1672 | 3780 | 141 | 838 KB |
| `/reminders` | 1676 | 1676 | 3841 | 211 | 680 KB |
| `/meetings` | 1670 | **4768** | 3572 | 141 | 792 KB |
| `/settings` | 1669 | 1756 | 3876 | 141 | 706 KB |

(milliseconds). Desktop cold loads on localhost are 80-350 ms to FCP and 100-400 ms to interactive on every route at both
account sizes, except `/graph` at 10k contacts (about 550 ms to interactive).

What drives the mobile numbers:
- **Interactive (3.5-4.2 s on app routes)** tracks transferred JS. At 1.6 Mbps, 650 KB is about 3.2 s of transfer. The
  framework is ~150 KB gz; the shared signed-in shell adds ~190 KB (`@base-ui` Tooltip/Dialog 32, Clerk 39,
  `@tanstack/query-core` 9, the rest in 0.5-5 KB pieces).
- **Late LCP (4.5-5.3 s) on `/contacts`, `/chat`, `/meetings`, `/graph`.** The LCP element is the page's real content
  (`<h1>`, or the graph canvas), which is streamed in the same pipe as ~650 KB of scripts and so arrives behind them.
- **Public pages** load ~410 KB gz of JS for static text (`/terms`, `/privacy`, `/contact`), over 60 requests.

### Server
Per-operation profile at 10k contacts (`profile-ops.ts`; PGlite serializes statements, so read operation totals, not
individual statements):

| Operation | Statements | Median | Payload |
|---|---|---|---|
| dashboard | 15 | 242 ms | 134 KB |
| graph | 9 | 305 ms | 4.7 MB |
| contacts search | 8 | 154 ms | 27 KB |
| knowledge base | 5 | 40 ms | 142 KB |
| every other page loader / MCP tool / extension route | 1-17 | 1-65 ms | under 80 KB |

Sequential depth at 20 ms per statement (`page-depth.mjs`): `/dashboard` 16.5, `/graph` 22.7, `/contacts/[id]` 6.4,
`/contacts` 5.2, everything else 2.7-4.5. The dashboard and graph depths are CPU-bound at 10k, not round-trip-bound.

### Interaction responsiveness (INP-style, 4x CPU, 10k contacts)
Worst event duration: search typing 16 ms, Sort menu 80 ms, Company filter 64 ms, ⌘K 72 ms, dashboard button 64 ms, chat
composer 32 ms. All well under the 200 ms "good" threshold. Nothing to fix.

### Layout shift (desktop)
- `/dashboard`: 0.141 (100 contacts), 0.088-0.141 (10k). A 219 px "Finish setting up" card streams in above the stats row.
- `/meetings`: 0.032-0.055. The lazy-loading placeholder is ~220 px taller than the card it becomes.

### Search (10k contacts)
364-637 ms from the last keystroke to settled results. 250 ms of that is the debounce; the rest is the server render
(80-320 ms).

### Repeat visits
Landing page: 10 `304` revalidations per revisit (the hero planets and meteor), because `public/` images are served
`max-age=0`. App pages: 0.

## Prioritized plan

Ordered by expected impact over risk, and by whether a result could be measured honestly here.

| # | Change | Impact | Risk | Verdict |
|---|---|---|---|---|
| 1 | Image caching for `public/` (scoped by directory and extension) | Repeat-visit round trips on the busiest public page | Low | **Shipped** |
| 2 | Search debounce 250 -> 150 ms | -100 ms on every search | Low (a few more superseded renders for slow typists) | **Shipped** |
| 3 | Meetings placeholder sized like the card | CLS 0.055 -> 0.005 | Low | **Shipped** |
| 4 | Dashboard leading cards finish before the first flush | CLS 0.141 -> 0 for anyone mid-onboarding | Medium | **Reverted** (see below) |
| 5 | Marketing stylesheet preloaded on every app route (root `not-found.tsx` imports `site.css`) | 30 KB gz per app load | Medium: risks the 404 page's styling | Not shipped; effect not distinguishable from noise (-0 to -200 ms LCP on 3 routes) |
| 6 | Cut shell JS (lazy watchers, base-ui) | Mobile interactive | Medium | Not shipped; the shell is 0.5-5 KB pieces with no large deferrable block |
| 7 | Contacts list: defer per-row tooltip/popover hydration | `/contacts` TBT (~290 ms mobile) | Medium: accessibility | Not shipped; needs its own design |
| 8 | `/graph` payload (4.7 MB at 10k, ~480 B per contact) | Server 300 ms, mobile LCP | High | **Shipped** (columnar wire): 5.17 -> 1.79 MB raw, 748 -> 423 KB gz, 448 -> 309 KB brotli at 10k; encode 4 ms, decode 6 ms; the 3k payload now has a 1.2 MB tripwire |

## What shipped

1. **`next.config.ts`:** `Cache-Control: public, max-age=86400, stale-while-revalidate=604800` for images under `/landing`,
   `/guides`, `/avatars`, `/integrations`, `/imports`, `/waitlist` (by extension) and `/orbit-logo.png`. The files are not
   fingerprinted, so they cannot be `immutable`; a change shows up on the next view after the first stale one. Scoped so
   `/waitlist/<slug>` (a page) and `/imports` (a redirect) are untouched; `orbit-sw.js` is not listed. Checked on a running
   build: images carry the header, `/imports` still 307s to `/capture?mode=imports` with no cache header added, and `orbit-sw.js` keeps `max-age=0`.
2. **`contacts-filters.tsx`:** `SEARCH_DEBOUNCE_MS` 250 -> 150 (the command palette uses 140, the composer menu 180).
3. **`capture-flow-lazy.tsx`, `page-skeletons.tsx`:** the Meetings variant gets `MeetingCaptureSkeleton`, built with the
   same box model as the real card (and its AI-key notice row when the card will show one), instead of the ~570 px capture
   form skeleton. `/capture` is unchanged.
4. **Harness** (`scripts/dev/perf/`): `page-bench.mjs`, `search-bench.mjs`, `inp-bench.mjs`, `compare.mjs`,
   `bundle-attribution.mjs`, `serve-demo.sh`. See the README there.
5. **`lib/graph-wire.ts`:** `getGraphData`/`getFullGraphData` hand the client a columnar wire form (one column per field,
   dictionaries for company/school/title/industry/tier/tags, cluster members as contact indexes) and `NetworkGraph`
   decodes it. Measured on the 10,000-contact fixture: 5.17 MB -> 1.79 MB raw, 748 -> 423 KB gz, 448 -> 309 KB brotli,
   with a 4 ms encode and 6 ms decode; the round trip is structurally identical (`smoke-graph-wire`).

## Results

### Layout shift, `/meetings` (alternating base/changed, 5 rounds per dataset)
| Dataset | Before | After |
|---|---|---|
| 100 contacts | 0.055 (3 of 5 rounds), 0.005 (2 of 5) | 0.005 (4 of 5), 0 (1 of 5) |
| 10k contacts | 0.032 / 0.055 | 0 / 0.005 |

### Search, last keystroke to settled, 10k contacts (median of 2 passes x 5 runs)
| Query | Before | After | Change |
|---|---|---|---|
| `ai` (server render ~85 ms) | 364 ms | 250 ms | -31% |
| `sarah` | 524 ms | 468 ms | -11% |
| no match | 537 ms | 490 ms | -9% |
| `engineer at acme` | 637 ms | 555 ms | -13% |

`ai` is the clean case: it is nearly all debounce, and it fell by 114 ms, which is the change. The others also carry
server-render variance of about +-40 ms between the two servers.

### Repeat visits, mobile profile, pass 1 (both sides at similar load)
| Route | Warm LCP before | after |
|---|---|---|
| `/` | 714 ms | 294 ms (-59%) |
| `/contacts/[id]` | 714 ms | 240 ms (-66%) |

Passes 1 and 2 agree on direction and size. Routes with no changed images moved within noise (`/terms` +10%,
`/graph` +14% in pass 1; the sign flips between passes).

### Unchanged by design
First-load JS: within +-1% on all routes (22 desktop, 12 mobile); `/meetings` grew 6 KB gz for the new placeholder. Cold FCP/LCP/interactive on the mobile profile: within
+-3% on every route except where noted.

## Tried and reverted

**Dashboard layout shift.** The optional cards at the top of the dashboard (today's meetings, LinkedIn nudge, agent drafts,
setup checklist) each sit in `<Suspense fallback={null}>`. When one renders, it lands above the already-painted stats and
pushes the page down 219 px. I started all four with the page and waited up to 120 ms for them before the first flush, so
whatever finished rendered in place.

A warm single run showed CLS 0.000, but that was one lucky run. In five alternating rounds, CLS stayed at **0.141 in all 5
rounds** on the 100-contact account, and in 4 of 5 on the 10k account, while first paint got **32 ms later** on the
100-contact account. Under this machine's load the cards miss a 120 ms bound, and the shift comes back. A change that cannot
be shown to help and that costs first paint was reverted.

The CLS is real and affects new accounts most, so this is the first thing to fix next. A time-bound will not do it;
the fix has to be structural. Two options, neither tried:
- Render the card's slot from data already in the layout's settings row (onboarding state), with a skeleton only when the
  account is likely to show the card.
- Hold the content below the header behind a single boundary that reveals together with the cards, so nothing paints under
  them first.

Either needs measuring on a quiet machine, and ideally against Neon, where the cards' queries run in parallel instead of
queueing on PGlite's single connection.

## Remaining bottlenecks and recommendations

1. **Mobile interactive (3.5-4.2 s) on app routes.** It is bytes. ~150 KB framework, ~190 KB shell, 80-250 KB per route.
   Real gains would come from the Clerk dependency (39 KB gz in the shell), a lighter tooltip/popover layer, or a leaner
   per-route client tree, not from further lazy-loading of the small pieces already there. Measure with the real
   `Speed Insights` data before taking that on.
2. **Mobile LCP on `/contacts`, `/chat`, `/meetings`, `/graph` (4.5-5.3 s).** The content waits behind scripts in the same
   pipe. Fewer first-load bytes helps all four; streaming the shell's own scripts later would too.
3. **`/contacts` hydration.** 50 rows, ~6 KB of markup each, each with a tooltip and popover trigger. TBT ~290 ms at 4x CPU.
4. **`/graph` payload.** The columnar wire form cut the 10k transfer 31% brotli and 65% raw. What remains is the scan
   itself (4.2 s to load 10k on PGlite here) and the client's parse and allocation of 1.8 MB rather than 5.2 MB.
5. **Marketing stylesheet on every app page.** Move the 404's styles out of `site.css`, or have the root `not-found`
   own a small stylesheet, so app routes stop preloading ~30 KB gz of marketing CSS. Measure on a quiet machine first.
6. **Public static pages** carry ~410 KB gz of JS (`WarpProvider`, motion, sonner, base-ui). `LazyMotion` was tried
   earlier and did not help; the root layout's providers are the place to look.
7. **Signed-in field data.** Signed-in LCP, INP and CLS need a staging build with Clerk test keys, or Speed Insights.
   Nothing here can stand in for that.

## Validation

- `npx tsc --noEmit`, `eslint` on the changed files, and `next build`: clean, on the committed code (the
  measurement-only edits are not in it).
- `npx tsx scripts/run-smoke.ts --ci`: **661 of 663 passed** (664 s). The two failures are not from this change:
  - `smoke-growth-trends` ("a cohort with a three-day-old member draws no week 0") failed the same way on the untouched
    baseline worktree. Root cause found later: `retentionCurves` stepped months with `generate_series` over a
    `timestamptz`, so in a non-UTC session every cohort landed a day early and the current month fell out of the
    series. It was a real product bug, not a flake; fixed in #571.
  - `smoke-radar-run` ("after release, both are") failed once in the full run and passed 3 of 3 alone on this branch and
    on the baseline. The branch touches nothing in radar; I read it as a load or ordering flake, but did not rerun the
    whole suite to confirm.
- The Playwright e2e suite (`npm run test:e2e`) was not run.

## Not changed
No change to visuals, animation, accessibility, features or data. The landing hero's late LCP on mobile is its own 700 ms
entrance animation starting after the main thread frees; it was left alone on purpose.
