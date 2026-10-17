# Orbit performance audit

Audited at `eb5d69d` (main) on 2026-10-17. Nothing in the application was changed. Every number below was
measured on local seeded data, never production. Each claim is marked **[measured]**, or
**[code review, not measured]** where a measurement was not possible in this environment.

Read alongside `docs/performance.md`, the existing guards, and `docs/audits/2026-10-13-efficiency-audit.md`,
whose fixes PRs #425, #427, #428 and #430 have landed. This audit starts from the code as it is after them.

---

## Phase 2 results (2026-10-17)

Fixes are on `claude/serene-cerf-0is3sb`, one commit per bottleneck. Every before/after below is an
interleaved A/B on copies of the same seeded snapshot (PGlite), or a replay on native Postgres 16
holding the same 100k rows. The machine ran slower in this session than in Phase 1, so compare the
two columns of a row, not a row against Phase 1's tables. `smoke-behavior-golden` was re-recorded
once, with every difference checked (§ "Behavior changes" below).

| # | Change | Before | After |
|---|---|---|---|
| B1 | Expression index for the duplicates badge (`contacts_user_name_norm_idx`) | 10k: 82,355 ms. 100k (PG 16): cancelled at 240 s | 10k: **63 ms**. 100k (PG 16): **458 ms** |
| B5 | No full cohort rebuild inside a read | 10k, 1 unscored contact: 4.0× the all-scored dashboard. 100k: +52 s | 10k: **1.3×** (scores just that row). 20+ unscored: recalibrated after the response |
| B7 | Contacts search through one indexed arm per branch, plus an email prefix index | 100k: 1,777 ms per keystroke. Count on PG 16: 509 ms | 100k: **333 ms**. Count on PG 16: **41 ms**. Identical id sets for 20 queries |
| B2 | Related-contacts mention prefilter as indexable functions (trigram GIN plus partial index) | 10k ~2.0 s; 100k 21.0 s (text scan alone 11 s on PG 16) | 10k **275 ms**; 100k **2.9 s** (text scan **167 ms** on PG 16). Identical results for 32 sources, adversarial rows included |
| B10 | `interactions_user_contact_date_idx` INCLUDE (type, direction, source); `contacts_unscored_idx`; `contacts_goal_relevance_idx`; FK index on `contact_career_moves` | PG 16, 100k: touch counts 1,169 ms; last touch 298 ms; unscored count 73 ms; goal-aligned 60 ms | **186 / 74 / 0.03 / 0.15 ms** |
| B6 | Due follow-ups rank from the candidates' stored tiers; network stats count the inner circle in SQL | 100k: `due_followups` 3,454 ms; `get_network_overview` 3,624 ms; `getNetworkStats` 3,432 ms | **108–147 / 602 / 502 ms**. Byte-identical output at 10k |
| B4 | Dashboard stops running the unread vocabulary GROUP BY | 100k: 8.9–9.2 s | 8.5 s. The rest is three whole-network row sets (see below) |
| B3 | Graph tags in one grouped query instead of a correlated subquery per contact | 100k: scan 2,651 ms; loader 12.4 s | Scan **1,581 ms**; loader 11.4 s. Payload byte-identical |
| B9 | Waitlist pill rendered in the server HTML | Mobile lab LCP 6,371 ms; score 0.70 | **3,633 ms; ~0.83**. CLS 0 |
| B8 | Fuzzy dedupe checks company/title before the edit distance; the import counts without keeping SQL text | 10k rows 358 rows/s; 20k rows 240 rows/s; 6.1–24 MB of SQL text retained | **610 / 574 rows/s; 0 MB**. Statements per job unchanged |
| — | `bundle-report.mjs` counts the framework runtime | `/dashboard` reported as 382 KB gz | Reports 514 KB gz (the true figure) |
| — | AI result cache keyed on the selected provider and model | A model switch served the old model's answers for up to 90 days | Misses after a switch (new smoke check fails before the fix, passes after) |

**Behavior changes, all deliberate:**
- `getDashboardData` no longer returns `graphPreview.companies/schools/tags/clusters` or
  `summary.companyCount`. Nothing rendered them.
- Hybrid search's full-text arm breaks equal ranks by closeness, then id. They were broken by plan
  order, which the new indexes changed: an MCP search for "OpenAI" put David Kim above Sarah Chen.
  The tie-break restores Sarah first. One fused relevance moved 0.4841 → 0.4766, with order unchanged.
- Map and array order in the dashboard and graph loaders follows the new plans. They are
  order-only differences, checked entry by entry.
- AI result cache entries written before the fix miss once.

**Round 3 (same branch, approved as "do the rest"):**

| Change | Before | After |
|---|---|---|
| Duplicates badge count remembered per instance for a minute; every writer forgets it | 458 ms per `/contacts` render at 100k | One count per minute per viewer |
| Related contacts round 1: SQL keeps only rows that could earn a reason (superset prefilters), JS still decides | 100k: 2.9 s a lookup, 100,000 rows / 22 MB as JSON | 100k: **0.48 s** (PGlite), statement **342 ms** on PG 16 returning 4 rows. 10k: 553 → **180 ms**. 0 differences on 47 sources with adversarial rows; new `smoke-related-contacts-parity` |
| Dashboard: peer-link analysis remembered by input hash; top-750 sample without a full sort; cluster labels once per spelling | 100k: 4.9–5.8 s; 10k: 1.75–1.81 s | 100k: 4.5–4.7 s; 10k: **1.16–1.25 s** |
| Dashboard bounded redesign: eligibility, clusters, sample, histogram asked of Postgres (`dashboard-network.ts`); preview fetched by group with early-stop laterals | PG 16, 100k: 5.6 s of statements, **56 MB** moved; result object 18.5 MB | **1.6 s, 1.9 MB**; result object 0.68 MB. Output identical at 0/100/10k/100k and with unscored contacts, pins, thresholds and the filter off; new `smoke-dashboard-parity` |
| Graph: contact details fetched when a star is opened | 10k: 6.78 MB, 694 B a contact | **4.80 MB, 480 B**. Panel checked in a browser |
| LinkedIn connections: parsed in the browser, duplicates checked in 5k-row chunks, rows staged in 2k-row chunks | Preview answer 8.9 MB at 30k rows (over the 4.5 MB response limit); hard ceiling ~39,900 rows | No ceiling: 6 checks at 30k, largest request 0.88 MB; 45k-row export staged whole in `smoke-linkedin-connections-chunked`. Review list draws 500 rows at a time |
| Webhook drain: four endpoints at a time, an endpoint deferred after two failures in a row | One hanging endpoint next to a healthy one: 40.2 s, 8/10 healthy delivered | **10.0 s, 10/10** |
| Background pack | Recruiter scans killed at the page's 60 s; import poll queued behind Server Actions; `process-stalled` unbounded overall; timeline fallback without a deadline; capture claims stale before `maxDuration`; Gmail headers one GET each | Scans kicked into a 300 s invocation; `GET /api/imports/[id]/status`; stages stop starting past 180 s, with per-stage timings in `cron_runs`; fallback inside the budget; 5.5 min claims; headers 50 to a batch request |

**Measured and not shipped:**
- **`LazyMotion`.** Converting all 77 files to `m` with `domMax` loaded asynchronously made every
  route 0–12 KB gz *larger* (median +2 KB). The async features chunk was ~3 KB: `AnimatePresence`,
  `useAnimate`, `useScroll`/`useTransform` and friends already pull the animation engine into the
  shared bundle. A saving would mean replacing those hooks, not just the components. Reverted.

**Still open:**
- **Neon `jit` and unused indexes:** settings on Neon itself. The commands are in
  `docs/RUNBOOK.md` ("Neon one-time settings", "Database performance checks").
- **Signed-in INP and LCP** still need a staging build with Clerk test keys, or Speed Insights.
- The dashboard's eligibility statement still aggregates every touch (~0.7 s on PG 16 at 100k);
  storing the tallies with the scores would remove it.

---

## 1. How this was measured

### Environment

| | |
|---|---|
| Machine | 4 vCPU, 16 GB, otherwise idle. Some runs overlapped and are flagged where it matters. |
| Runtime | Node 24.22 (matches `engines`), Next 16.3.8 (Turbopack), production builds |
| Database | PGlite 0.5.4 (Postgres 17 in WASM), the repo's local driver. Calibrated against native **Postgres 16.15** loaded with the same 100k data (§1.3). |
| Browser | Playwright's bundled Chromium (build 1194), Lighthouse 12 (default mobile preset: simulated Slow 4G and 4× CPU; and the desktop preset) |

### Data: four account sizes, all for `demo-user`

| Size | Contacts | Interactions | Tag links | Reminders | Notes |
|---|---|---|---|---|---|
| **0** | 0 | 0 | 0 | 0 | settings row only |
| **100** | 100 | 220 | ~19 | 2+ | 25-person demo workspace plus 75 generated contacts |
| **10k** | 10,000 | 29,925 | 2,494 | 200+ | demo workspace plus the `scaleContactRows` generator |
| **100k** | 100,000 | 299,922 | 24,994 | 2,000+ | same |

- The generator is the repo's own `scripts/lib/scale-fixture.ts`, with about 3 interactions per contact, 30% of contacts carrying ~2 KB notes and 2% carrying inline base64 avatars.
- Each benchmark ran against a fresh copy of a pristine snapshot.
- Coming-soon surfaces (radar, events, find, outreach) were switched live with `live:` rows in `app_surface_flags` so they could be measured.

**Known fixture biases:**
- **Engagement is high.** Most contacts have a logged note or meeting, so almost every contact qualifies for the constellation. That is the worst case for `/graph`; a LinkedIn-heavy real account has fewer engaged contacts.
- **Names are low-variety.** There are 25 first names and 20 surnames, so fuzzy-dedupe buckets during import are larger than in real data. Treat import CPU as an upper bound.
- **No embeddings.** PGlite has no pgvector, so semantic search arms and HNSW plans are not measured here.

### Tools

| What | Tool |
|---|---|
| Server work per page and endpoint | A loader profiler that calls each page's data loaders and route handlers directly (the same approach as `scripts/dev/efficiency-bench.ts`). It wraps the PGlite client at runtime to record every statement's SQL, parameters, time, rows and bytes, then runs `EXPLAIN (ANALYZE, BUFFERS)` on the slowest with their real parameters. Reported times are the median of 5 warm calls; "cold" is the first call in a fresh process. |
| Round-trip depth | `scripts/dev/efficiency-bench.ts`. Depth is wall time at 25 ms per statement ÷ 25, which approximates sequential neon-http round trips. |
| Bundles | `next build`, then `scripts/dev/bundle-report.mjs`, plus source-map attribution of every first-load chunk, plus `next experimental-analyze --output` |
| Public-page Core Web Vitals | Lighthouse against `next start` on a production build with a `pk_live`-format Clerk key, as production is configured. Medians of 3 to 5 runs. |
| Signed-in pages (CLS, payload bytes) | Playwright against `next dev` in demo mode at 10k contacts. This is the repo's e2e approach; a production build cannot render signed-in pages without real Clerk keys. **Dev-mode LCP and INP are not comparable to production, so they are not reported.** |
| Imports | Synthetic LinkedIn `Connections.csv` at 1k, 10k, 20k and 40k rows, driven through `parseLinkedInConnectionsCsv`, `stageImportRows` and `runLinkedInImportJob`. Records peak RSS and a `--cpu-prof` profile. |

The harness scripts are in the session scratchpad. Committing them under `scripts/dev/` is step 0 of the plan.

### 1.3 Calibration: PGlite vs native Postgres

Every slow statement captured at 100k was replayed with its real parameters on native Postgres 16 holding the same rows and indexes:

| Statement (100k) | PGlite | Native PG 16 |
|---|---|---|
| Dashboard goal-relevance scan | 225 ms | 137 ms |
| Dashboard counts aggregate | 165 ms | 64 ms |
| Cohort touch aggregate (graph, MCP) | 435 ms | 412 ms |
| `DISTINCT ON` last touch (network stats) | 460 ms | 425 ms |
| Related-contacts text scan (profile) | 10.4–21.7 s | **11.0 s** |
| Contacts search page query | 685 ms | 1,780 ms with JIT on / **669 ms** with JIT off |

**Conclusions:**
- Native Postgres is **1.0–2.6× faster** per statement, so PGlite DB times are a slightly pessimistic but faithful proxy. Plan shapes matched in every case checked.
- JS CPU time (row mapping, scoring, GC) is unaffected by the driver.
- In production each statement also costs a neon-http round trip, which is what the "depth" column measures.
- **Unexpected finding:** with Postgres's default `jit = on`, large sequential scans spent **1.09 s compiling** before running (contacts search: 1.78 s vs 0.67 s). Neon's `jit` setting should be checked (`SHOW jit;`).

---

## 2. Baseline numbers

### 2.1 Server: per page (loader time, local, median ms) [measured]

"—" means the loader needs the demo workspace, which the empty account does not have.

| Page | Loader | Statements | n0 | n100 | n10k | n100k | Cold (100k) |
|---|---|---|---|---|---|---|---|
| every app page | (app) layout: entitlements + surface flags | 2 | 9 | 7 | 7 | 6 | 9 |
| every app page | layout: org brand colors (memoized per instance for 5 min) | 0 warm | 0 | 0 | 0 | 0 | **230** |
| every app page | app pulse (every 90 s per tab) | 14 | 35 | 31 | 35 | 33 | 40 |
| `/dashboard` | `getDashboardData` | 15 | — | 68 | **823** | **6,880** | 7,097 |
| `/dashboard`, `/radar` | `getNetworkStats` | 9 | 25 | 15 | 241 | **2,536** | 4,587 |
| `/contacts` | first page | 3 | — | 10 | 14 | 107 | 114 |
| `/contacts` | search (`q=hopper`) | 7 | — | 25 | 195 | **1,421** | 1,606 |
| `/contacts` | letters / school options | 2 / 3 | 5 / 7 | 6 / 8 | 13 / 14 | 137 / 123 | — |
| `/contacts` | **duplicates badge** (`countDuplicates`) | 3 | 8 | 9 | **82,355** | **> 240,000** (cancelled by `statement_timeout` on native PG; PGlite ran 35 CPU-min without finishing) | — |
| `/contacts/[id]` | `getContactForProfile` | 2 | 8 | 10 | 11 | 8 | 11 |
| `/contacts/[id]` | **`listRelatedContacts`** | 8 | 16 | 33 | **1,299** | **13,038** | 13,405 |
| `/contacts/[id]` | stored profile + health | 3 | 7 | 5 | 6 | 7 | — |
| `/graph` | `loadGraphData` | 9 | — | 28 | **739** | **8,549** | 8,773 |
| `/reminders` | page + rail + suggested | 12 | 29 | 28 | 30 | 41 | — |
| `/knowledge` | base / people | 5 / 4 | — / 11 | 14 / 16 | 78 / 23 | **526** / 93 | — |
| `/chat` | threads | 3 | 15 | 9 | 8 | 9 | — |
| `/settings` | `getSettings` | 4 | 14 | 14 | 12 | 12 | — |
| `/imports` | `listImports` | 2 | 6 | 6 | 5 | 5 | — |
| `/events` | by tab + connections + co-attendees | 13 | 39 | 38 | 37 | 34 | — |

Notes:
- `/events` and `/meetings` have no seeded rows, so their flat numbers say nothing about scale.
- `fetchDashboard` and `fetchRadar` call `after()` and cannot run outside a request. Their component loaders are covered above. Radar's run path was not measured.

### 2.2 Server: round trips, payload and CPU on the hot paths (`efficiency-bench.ts`) [measured]

| Path | Statements | Result KB (100 / 10k / 100k) | CPU ms (100 / 10k / 100k) | Depth at 25 ms (100 / 10k / 100k) |
|---|---|---|---|---|
| dashboard | 15 | 123 / 1,997 / **16,777** | 65 / 908 / 6,481 | 4.1 / 33 / 253 |
| graph | 8 | 76 / 6,623 / **66,337** | 25 / 849 / 8,751 | 1.8 / 34 / 345 |
| notification panel | 11 | 12 / 63 / 63 | 25 / 32 / 38 | 5.0 / 5.3 / 5.1 |
| knowledge base | 5 | 105 / 147 / 143 | 12 / 70 / 499 | 3.6 / 5.5 / 26 |
| contacts page | 3 | 27 / 26 / 26 | 9 / 13 / 93 | 2.5 / 2.6 / 6.2 |
| contacts search | 7 | 2 / 27 / 27 | 20 / 214 / 1,358 | 5.0 / 12 / 60 |
| MCP `search_contacts` | 8 | 2 / 5 / 5 | 22 / 94 / 121 | 6.3 / 8.9 / 11 |
| MCP `get_contact` / `get_timeline` | 6 / 7 | ~3 | ~15 | 4.8 |
| MCP `who_do_i_know_at` | 7 | 1 / 2 / 2 | 16 / 28 / 208 | 5.9 / 6.5 / 14 |
| MCP **`due_followups`** | 11 | 4 | 23 / 240 / **2,390** | 6.2 / 14 / 100 |
| MCP **`get_network_overview`** | 14 | 2 | 26 / 234 / **2,583** | 6.7 / 15 / 110 |
| MCP `find_path_to` | 12 | 4 | 28 / 95 / 437 | 7.4 / 11 / 24 |
| extension `me` / `resolve` / `search` | 5 / 5 / 3 | ≤ 4 | 91 / 225 / 9 at 100k | 7 / 15 / 4 |

Depth well above the statement count means CPU or DB time, not round trips, is the cost. That is the case for every path that grows.

### 2.3 Server: full documents in a browser, 10k contacts (`next dev`, demo mode) [measured]

| Route | HTML | RSC payload | CLS (hard load, 10 s) | DOM nodes |
|---|---|---|---|---|
| `/dashboard` | 523 KB | 116 KB | 0 | 1,099 |
| `/contacts` | — | — | **did not commit within 120 s** (see B1) | — |
| `/contacts/[id]` | 334 KB | 86 KB | 0.003 | 888 |
| **`/graph`** | **7,508 KB** | **6,698 KB** | 0 | 309 |
| `/reminders` | 427 KB | 78 KB | 0 | 1,807 |
| `/chat` | 147 KB | 39 KB | 0 | 472 |
| `/capture` | 153 KB | 38 KB | 0 | 421 |
| `/settings` | 243 KB | 80 KB | 0 | 781 |
| `/knowledge` | 539 KB | 117 KB | 0 | 3,339 |
| **`/imports`** | 154 KB | 36 KB | **0.078** (the "Your people" section appears ~5.5 s in) | 518 |

Dev-mode payloads include some debug metadata. The `/graph` figure is dominated by contact data, which §3 attributes field by field.

### 2.4 Frontend: JavaScript and fonts (production build) [measured]

**`bundle-report.mjs` under-reports first-load JS.** It counts only a route's `entryJSFiles`. The framework runtime (`rootMainFiles`: React DOM, the router, the Turbopack runtime) adds **440 KB raw / 132 KB gzipped** to every route. True first-load, root plus route entries:

| Route | First-load JS (gz) | `bundle-report` says | Preloaded fonts |
|---|---|---|---|
| `/` (landing) | **277 KB** (871 KB raw) | 147 KB | 3 files, 112 KB |
| `/pricing` | 312 KB | 182 KB | 112 KB |
| `/dashboard` | **511 KB** (1,596 KB raw) | 382 KB | 112 KB |
| `/contacts` | 472 KB | 342 KB | 112 KB |
| `/contacts/[id]` | **513 KB** | 383 KB | 112 KB |
| `/graph` | 425 KB | 295 KB | 112 KB |
| `/chat` | 422 KB | 292 KB | 112 KB |
| `/capture` | 428 KB | 297 KB | 112 KB |
| `/reminders` | 495 KB | 365 KB | 112 KB |
| `/settings` | 496 KB | 366 KB | 112 KB |
| `/imports` | 478 KB | 348 KB | 112 KB |
| `/knowledge` | 439 KB | 309 KB | 112 KB |

The Oct 13 audit recorded app pages at 278–368 KB gz with the old counting, against 290–383 now, so they have grown about 12–15 KB.

**Composition of `/dashboard` first-load JS** (raw bytes, from source maps):

| Share | Package |
|---|---|
| 29% | Next and React runtime |
| **15%** | `@base-ui/react` (234 KB). Real usage: floating-ui 64, menu 31, select 30, popover, tooltip, dialog. Already tree-shaken. |
| **9%** | `motion` (`motion-dom` 108 KB + `framer-motion` 35 KB). Full `motion.*` components with no `LazyMotion`; also 156 KB raw (18%) of the landing page. |
| 8% | Clerk (`@clerk/react` 66 + `@clerk/shared` 61) |
| 2% each | sonner (33), `@tanstack/query-core` (31, via Clerk), tailwind-merge (26), date-fns (23), lucide (22) |
| ~20% | app code: dashboard, layout, ui, notifications, capture, radar, reminders |

**Lazy-only, not on first load:**
- `zod`: one 255 KB raw lazy chunk.
- `@vercel/oidc`: 67 KB raw inside the email compose dialog's chunk, pulled in through `@vercel/blob`. This is a server-oriented package shipped to the browser.
- pdfjs, three, xyflow and react-markdown are lazy, as intended.

**Unused dependencies:** none. Every `dependencies` entry is imported by `src/`, CSS or `next.config.ts`. **[code review]**

**CSS:** a single render-blocking stylesheet on every route, **53 KB gz** on the wire (331 KB raw, from `globals.css` at 3,358 lines). Lighthouse estimates 590 ms of savings on mobile `/`.

### 2.5 Frontend: Core Web Vitals, public pages (Lighthouse lab, production build) [measured]

| Page | Mobile perf score | FCP | **LCP** | TBT | CLS | Desktop LCP | Desktop TBT |
|---|---|---|---|---|---|---|---|
| `/` | 0.70 | 1.37 s | **6.37 s** (n=5, range 5.8–6.5) | 103–416 ms | 0 | 1.20 s | 0 |
| `/pricing` | 0.79 | 1.66 s | **4.79 s** | 190 ms | 0 | 0.95 s | 0 |
| `/interest` | 0.82 | 1.37 s | 4.58 s | 256 ms | 0 | 0.88 s | 0 |
| `/privacy` | 0.84 | 1.37 s | 4.17 s | 152 ms | 0 | 0.85 s | 0 |
| `/sign-in` | not measurable | | | | | | |

- `/sign-in` cannot paint without clerk-js, which cannot load in this sandbox. `/pricing` numbers are optimistic for the same reason (no clerk-js).
- **Landing LCP diagnosis [measured]:**
  - The LCP element is the fixed "Join the waitlist →" pill (`src/components/landing/early-access-pill.tsx`).
  - It renders `null` in the server HTML and appears only after hydration and a `localStorage` check, so LCP equals hydration time.
  - Lighthouse attributes LCP almost entirely to *element render delay*. TTFB is 20 ms.
  - This matches the Oct 13 field data: landing `load_ms` p75 3.6 s, p95 9.9 s.
- **INP:** lab tools cannot measure it. TBT (above) is the proxy. Signed-in INP needs field data: Vercel Speed Insights, filtered to Production.

---

## 3. Ranked bottlenecks

Ranked by (users affected × time lost), with the account size at which each starts to hurt.

### B1. The duplicates badge is a quadratic self-join on every `/contacts` render [measured]

**Where:** `findNameCollisions` (`src/lib/duplicate-review.ts:168`), called by `countDuplicatesAwaitingReview` from `DuplicatesButton` (`contacts/page.tsx:167`) on **every `/contacts` render**, and on `/contacts/duplicates`.

**Evidence:**
- Plan: `Nested Loop → Index Scan using contacts_pkey (id > a.id)`, filter `lower(btrim(full_name)) = …`. That is 10,000 outer loops × 5,000 rows removed each, with **75.3M buffer hits**.
- **82,355 ms at 10k** contacts. At 100k it **does not finish**: native Postgres 16 cancelled it at a 240 s `statement_timeout`, and PGlite ran 35 CPU-minutes before I stopped it.
- `LIMIT 99` only helps when 99 collisions exist. An account with fewer same-name pairs (most accounts) pays the full N²/2.
- In the browser, `/contacts` at 10k never finished streaming. PGlite serializes statements, so it blocked the whole server. On Neon it does not block other requests, but every render starts a minute-plus query that burns compute.

**Same results, measured alternatives:**

| Variant | 10k (PGlite) | 100k (native PG 16) |
|---|---|---|
| Original query, no index | 82,355 ms | **cancelled at 240 s** |
| Rewrite: group names `HAVING count(*) > 1`, then join within groups | **18 ms** | **cancelled at 120 s**. PG 16 inlines the CTE and reorders back into the quadratic loop. |
| Same rewrite with `WITH … AS MATERIALIZED` | — | **cancelled at 120 s** |
| **Expression index `(user_id, lower(btrim(full_name)))`, original query** | **49 ms** | **458 ms** (two index scans, then an anti-join) |
| Expression index plus the rewrite | — | 319 ms |
| Hash join forced (`enable_nestloop=off`) | 66 ms | — (not a fix) |

A query rewrite alone is **not plan-robust**: it was fast on PGlite and still quadratic on native Postgres. The expression index is the fix.

**Projected gain:**
- 82 s → ~50 ms at 10k, and > 240 s → ~0.5 s at 100k.
- Caching the badge count, which is only "is there anything, and is it 99+", removes the remaining per-render cost.

### B2. A contact profile scans every contact's text, on every view and every hover prefetch [measured]

**Where:** `listRelatedContacts` (`src/actions/contacts.ts:1630`).

**What it does:**
- Round 1 reads all N contacts (9 columns) and scores them in JS.
- Round 2 runs `replace(translate(ai_summary || notes || key_facts || shared_interests)) LIKE ANY(…)` plus per-row `jsonb_array_elements` subplans over **every** contact.

**Evidence:**
- **1,299 ms at 10k, 13,038 ms at 100k**, of which the round-2 statement is 10.4 s.
- Native Postgres: **11.0 s**. The plan is a Seq Scan with 99,997 rows removed and a SubPlan executed 99,998 times.

**Why it matters more than the number suggests:**
- The result streams into a Suspense boundary, so the shell isn't blocked.
- But profile links are `IntentLink`s, which **full-prefetch the whole page on hover** (`docs/performance.md`). Hovering a name in a list at 100k therefore starts this 11 s scan. **[inferred from code and docs; not traced]**
- It also runs for the knowledge dossier pane.

**Projected gain:**
- Bounding the candidate set with indexed signals (shared company, school or tag through existing indexes; mentions through the `search_tsv` GIN index, or a precomputed mention-token column) should give tens of ms at any size.
- Not on the hover path at all if the related card is fetched only when visible.

### B3. `/graph` ships every engaged contact, wide, to the browser [measured]

**Where:** `loadGraphData` (`src/lib/graph-data.ts`), then `GraphIsland`, then `NetworkGraphLazy initialData` (a client component).

**Evidence:**
- Payload is **6.6 MB at 10k** (9,249 contacts visible) and **66 MB at 100k**.
- In the browser at 10k: a **7.5 MB HTML** document and a **6.7 MB RSC** payload.
- Loader time is 739 ms at 10k and 8,549 ms at 100k: 43% DB, 13% Drizzle row mapping, 18% GC (CPU profile).

**Why the existing bound doesn't work:**
- The "drawn contacts only" filter (`constellationEligibility`) is the only bound, and any contact with a note or meeting passes it.
- Per contact (~680 B), the biggest fields are: `lastInteractionAt` 425 KB, `linkedinUrl` 419, `id` 397, `dateMet` 334, `aiSummary` 305, `fullName` 291, `closeness` 282, `email` 238, `sharedInterests` 233, `keyFacts` 229, `profileImageUrl` 217 (totals at 10k).
- Many of these are only needed in a detail panel.

**Projected gain:**
- A slim star record (`id`, name, cluster, tier or closeness, avatar URL, dormant) plus details on demand: about 120–150 B per star, so **≈ 1.2–1.4 MB at 10k** (−80%).
- Server-side layout, or a hard cap on drawn stars, bounds it absolutely.
- Also removes JSON parse and hydration cost on the main thread. That is not measured; see P-plan.

### B4. Dashboard loader time grows linearly, and is mostly allocation and whole-network scans [measured]

**Where:** `getDashboardData` (`src/lib/reminders.ts`), with `getNetworkStats` alongside.

**Evidence:**
- **823 ms at 10k, 6,880 ms at 100k.** 15 statements, 312k rows read at 100k.
- Result object: 2.0 MB at 10k and 16.8 MB at 100k, server-side only. `closenessById` holds every contact (1.26 MB at 10k), and `graphPreview` is 495 KB at 10k but is reduced to dots on the server (`DashboardGraphPreview`).
- CPU profile at 10k: GC 33%, DB 29%, app JS 20%.
  - The capped (750-contact) network-metrics pair loop is ~13% (~110 ms), recomputed on every render.
- Slowest statements at 100k:
  - goal-relevance seq scan (137 ms native)
  - company/school vocabulary `UNION` over all contacts (530 ms PGlite). The code-review agent believes `graphPreview.companies/schools/tags/clusters` are unread; **verify against `smoke-behavior-golden`**.
  - counts aggregate (64 ms native)
- `getNetworkStats` costs 2.5 s at 100k (`DISTINCT ON` last touch per contact: 425 ms native, plus JS over every breakdown).

**Production signal:** the Oct 13 audit had `/dashboard` as the slowest in-app page (p50 524 ms) at typical sizes.

**Projected gain:**
- Bounded reads, the unused vocabulary statement dropped, network metrics cached per account, and `closenessById` limited to rendered ids: est. **−50–70% at 10k+**. Re-measure each step.

### B5. One unscored contact turns the next read into a full cohort rebuild inside a GET [measured]

**Where:** `resolveCohortResult` (`src/lib/closeness-cohort.ts:313`). If `countUnscoredContacts > 0`, it runs `buildCohortResult` and `persistCohortResult` before answering. That runs on dashboard, graph, MCP, `/api/v1` and radar reads.

**Evidence:**
- At 10k, `/dashboard` goes from **902 ms to 3,637 ms** (26 → 41 statements) after one contact's `closeness_computed_at` is cleared.
- At 100k: **11.9 s → 64.3 s** (222 statements). This run overlapped another job, so both numbers are inflated; the quiet dashboard baseline is 6.9 s.
- `recalibrateCloseness` itself takes 3.7 s at 10k (26 statements), and about 56 s at 100k during seeding, which was contended.
- The unscored check is a seq scan on every cohort read: 358 ms at 100k (PGlite).

**Why it happens:** the backend agent found bulk creates (sync, inbound mail, MCP create, event ingest) deliberately leave rows unscored **[code review]**, so this triggers in normal use.

**Projected gain:**
- Remove multi-second spikes on the first read after any bulk write.
- Score at write time (cheap per row) or in the background, and add a partial index `(user_id) WHERE closeness_computed_at IS NULL`.

### B6. MCP and `/api/v1` follow-up tools rebuild the cohort on every call [measured]

**Where:** `loadDueFollowUps`, MCP `due_followups` and `get_network_overview`, `/api/v1/followups`, the `followup.due` webhook.

**Evidence:**
- **~2.5 s each at 100k** (240 ms at 10k), to return ≤ 25 rows.
- They read every contact's closeness breakdown, plus the touch aggregate over all interactions (`GroupAggregate` over 300k rows: 412 ms native).
- `cache()` is a pass-through in route handlers, so nothing is shared.

**Projected gain:** per-contact touch counts maintained at write time, or an index-only covering index (see B10), plus a bounded due-list query: est. **< 150 ms at 100k**.

### B7. Contacts search scans the whole network twice per keystroke [measured]

**Where:** `listContactsPage` with `q`: `contactSearchCondition` (`src/lib/contact-search-rank.ts`) plus `countContacts`.

**Evidence:**
- **195 ms at 10k, 1,421 ms at 100k.**
- Both the page query and the count are a Seq Scan with 96,667 rows removed. An `OR` of the tsvector, the trigram `LIKE`s, the email `LIKE` and a correlated tag `EXISTS` prevents a BitmapOr.
- 685 + 637 ms at 100k on PGlite.
- On native Postgres with `jit=on`, the page query takes **1.78 s**, 1.09 s of it JIT compilation.

**Projected gain:**
- A `UNION` of indexable arms (tsvector GIN, `contacts_name_trgm`, email equality or prefix, a tag arm that joins `tags` by `user_id`), plus a capped count ("1,000+"): est. **< 50 ms at 100k**.

### B8. Import throughput degrades with network size, and large exports cannot be imported [measured]

**Evidence (LinkedIn Connections, comped plan, PGlite):**

| Rows | CSV | Fits one request? | Parse | Stage | Engine | Rows/s | Statements per 1k rows | Peak RSS | SQL text retained by the query counter |
|---|---|---|---|---|---|---|---|---|---|
| 1k | 100 KB | yes | 10 ms | 95 ms | 1.3 s | **763** | 58 | 749 MB | 0.7 MB |
| 10k | 1.0 MB | yes | 87 ms | 670 ms | 20.7 s | **482** | 42 | 894 MB | 6.1 MB |
| 20k | 2.0 MB | yes | 322 ms | 3.1 s | 116 s | **172** (contended) | 41 | — | — |
| 40k | 4.06 MB | **no** (ceiling 4,147 KB) | 274 ms | 2.7 s | 205 s | **196** | 42 | 1,002 MB | **23.8 MB** |
| 100k (engine only) | 10.2 MB | **no** | — | — | **2,089 s (35 min), 8 self-continuations** | **48** (contended) | — | **1,559 MB** (heap 753 MB) | reset on each pass |

**Findings:**
- **Per-chunk time grows with network size:** 0.44 s per 250-row chunk at 10k vs 1.2 s at 40k, so total import time is ≈ O(N²).
  - A CPU profile of the 20k import attributes **53% of CPU to fuzzy dedupe** (`src/lib/duplicates.ts`): `nameSimilarity` 36%, `normalizeName` 11% (names re-normalized on every comparison), `findDuplicateCandidatesIndexed` 6%.
  - The database (PGlite WASM) is about 27%.
  - Fuzzy buckets grow with N (with the fixture bias noted in §1).
- **Hard ceiling:** about **39,900 connections** per `Connections.csv` (~104 B per row against `IMPORT_TEXT_MAX_BYTES` = 4.05 MB). Larger exports are refused before upload. There is no chunked upload (a `ponytail` note says so).
- **The query counter retains every statement's SQL text during an import, in production.** `runImportJob` calls `startQueryCount()`, and the counter captures SQL for *every* statement in the process until the next start.
  - That is ~24 MB after a 40k import (~14 KB per statement).
  - **Corrected in Phase 2:** the engine writes its count to `stats` before handing off to a continuation, so `stats.statements` does accumulate across passes. The 249 above was the benchmark reading the process-wide counter, not the job's stats. What stands is the text retention, and that two jobs on one instance share one counter.
- Staging writes every row in one atomic batch (1,000 rows per INSERT). Neon's HTTP batch-size limit for ~40 MB of jsonb was not verified. **[code review]**

**Projected gain:**
- Precompute normalized names and tokens in the duplicate index, and tighten buckets: about 2× throughput at 10k+, and flattened growth.
- Chunked upload (the staged-rows path in `chat-import-preview.ts` already exists) removes the 40k ceiling.
- Count statements without retaining text in production: −24 MB.

### B9. Landing LCP is gated on hydration [measured]

**Evidence:**
- Mobile lab LCP **6.37 s**, FCP 1.37 s. Desktop LCP 1.20 s.
- The LCP element is the client-only waitlist pill (§2.5).
- A render-blocking CSS file of 53 KB gz (590 ms estimated savings).
- 277 KB gz of JS, which includes motion (~18% of raw).

**Projected gain:**
- Render the pill (or another hero element) in the server HTML, hidden by CSS after the storage check rather than mounted by it. LCP moves to about FCP plus the font swap: est. **~2.0–2.5 s mobile lab**.
- Splitting landing CSS out of `globals.css` saves up to ~0.6 s more on slow connections.

### B10. Missing indexes on whole-history aggregates [measured]

EXPLAIN at 10k and 100k (PGlite, user `demo-user`):

| Query | 10k | 100k | Plan problem |
|---|---|---|---|
| Cohort touch counts (`closeness-cohort.ts:375`) | 96 ms | **1,090 ms** | aggregate over every interaction; no covering index |
| `DISTINCT ON (contact_id)` last touch (`reminders.ts:240`, network stats) | 38 ms | **1,012 ms** | Incremental Sort over all interactions (no `(contact_id, interaction_date DESC)` index) |
| Profile timeline (`ORDER BY interaction_date DESC LIMIT 20`) | 23 ms | 917 ms\* | `interactions_contact_idx` plus a top-N sort |
| Unscored count (`closeness-materialize.ts:262`) | 15 ms | 358 ms | seq scan; wants a partial index |
| Knowledge-base search (`ILIKE '%q%'`) | 22 ms | 625 ms | walks the user's history, no trigram |
| Knowledge-base stats | — | 384 ms | detoasts every note and summary |
| `listContactsMatching` | 16 ms | 297 ms | correlated `max(interaction_date)` per row, though `contacts.last_interaction_at` exists |
| Global memory-backfill sweep (`memory-backfill.ts`) | 12 ms | 257 ms | no user filter, `md5()` per row, every process-stalled tick |
| Export page, `OFFSET 20000` | 16 ms | 43 ms | quadratic over a full export |
| FK probe on `contact_career_moves.contact_id` | < 1 ms | — | table empty in the fixture; **unindexed FK** (cascades seq-scan) **[code review]** |

\* Q3 includes a subquery that picks the busiest contact via a full GROUP BY. The timeline part itself should be re-measured with a literal id.

**Redundant indexes [code review]:**
- `contacts_user_updated_idx` is a prefix of `contacts_user_recent_idx`. Both are written on every contact update, which prevents HOT updates.
- About a dozen `(user_id)` and `(fk)` single-column indexes are prefixes of composites.
- Write amplification was not measured; confirm with `pg_stat_user_indexes.idx_scan` on Neon before dropping anything.

### B11. Client JS: no budgets, a mis-measuring report, and full `motion` everywhere [measured]

**Evidence:**
- App pages ship 422–513 KB gz on first load, and the report under-counts them by 132 KB.
- motion is 143–156 KB raw on every route, the landing page included.
- The two largest app-page costs, base-ui and Clerk, are legitimate.

**Projected gain:**
- `LazyMotion` with `m`, loading `domAnimation` features: est. **−30 to −40 KB gz on every route** (re-measure).
- Fixing `bundle-report.mjs` to count `rootMainFiles` makes budgets honest.

### B12. Smaller measured items

- **Org brand colors** take 230 ms on a cold instance at 100k, on every app page's layout, per instance per 5 minutes.
- **Knowledge base** takes 526 ms at 100k: the stats aggregate detoasts every note, and `kindCounts` is awaited before the parallel batch. **[code review for the serial part]**
- **`/imports` CLS 0.078.** The "Your people" section mounts late. This is within "good" (< 0.1), but it is the only measurable shift.
- **Postgres JIT** (§1.3). If Neon runs with `jit=on`, every large seq scan pays ~1 s of compilation.

---

## 4. Background work [measured where marked]

| Job | State | Evidence |
|---|---|---|
| LinkedIn import engine | **B8**: O(N²) dedupe CPU, 40k ceiling, query-counter retention | [measured] |
| Closeness recalibration | 3.7 s at 10k, ~56 s at 100k (contended), run by process-stalled (60 s cap), merges of more than `RESCORE_ONE_BY_ONE_MAX` contacts (inline, in the user's action), import finish and ingest | [measured] timing; callers [code review] |
| Import status poll | A Server Action every 1.5 s for a job's lifetime, holding the per-tab action queue | [code review] |
| Gmail/Outlook recruiter scan from `/recruiters` | Started with `after()` under `maxDuration = 60`, but budgets 4.5 min, so it is killed at ~60 s and resumed only by the hourly stall sweep | [code review] |
| Gmail scan discovery | 200 header GETs per page at concurrency 8, while a batch endpoint exists in the same file; refetches messages on the no-batch-API path | [code review] |
| LinkedIn timeline backfill | Fallback path runs up to 100 LLM calls with no deadline (> `maxDuration`) | [code review] |
| `process-stalled` | One 300 s serial grab-bag with no overall deadline; several unbounded purges | [code review] |
| Webhook drain | Serial deliveries with a 5 s timeout each, so one dead endpoint stalls everyone (about 8 timeouts per tick) | [code review] |
| Capture jobs | Claim staleness 4 min against a 300 s run, so a long run could execute twice | [code review] |
| Google/Outlook contacts import | The whole address book is fetched twice (preview, then confirm), 200 per page, serially | [code review] |
| Sync scheduler, radar nightly, embedding backfill, Drive import | Batched, with concurrency limits and deadlines; no issue found | [code review] |

## 5. Caching [inventory: code review; costs: measured where marked]

**What is cached today:**

| Cache | Key and TTL | Invalidation | Assessment |
|---|---|---|---|
| React `cache()` (about 25 helpers) | per render | — | Correct on pages. A pass-through in route handlers and Server Actions, which is why MCP and `/api/v1` re-derive the cohort (B6, measured). |
| Org brand colors | userId, 5 min, ≤ 500 entries, per instance | learning pass, this instance only | Cold cost 230 ms at 100k [measured]. A new company's color shows up to 5 min late (cosmetic). |
| Surface flags, constellation config, site mode | global, 10–15 s, per instance | local | Fine |
| Closeness cohort (`closeness_cohorts` table plus per-contact columns) | materialized | dirty flag; **rebuild on read if any contact is unscored** | B5 [measured] |
| Query embeddings | sha256(user, backend, query), 1 h, 500 entries | key | Correct |
| `ai_result_cache` table | (user, operation, sha256(system, user, temperature, maxTokens)), ≤ 90 days | prune | **The key omits model and provider**, although its comment says "model tier" (`src/lib/ai-result-cache.ts:117`). After switching model, a user keeps getting the old model's answers for the TTL. Correctness, not speed. [code review] |
| Radar rerank | via `ai_result_cache`, 7 days | key | Fine |
| Client router cache | `staleTimes` dynamic 30 s, static 60 s | any `revalidatePath` purges the whole client cache (292 call sites) | Deliberate. Most mutations discard every prefetch. |
| Avatars (`/api/avatars/[id]`) | `max-age=86400` on an unversioned URL (only the list adds `?t=`) | none | A replaced data-URL photo can be stale for 24 h. Low. |
| `brand-colors` `LEARNED` map | org name, process-wide | none | **No size cap**, so it grows with distinct org names per instance |

**What should be cached and isn't:**
1. **Network-depth metrics.** Recomputed on every dashboard render (~110 ms at 10k, measured), but they change only when contacts change. Store them with the cohort snapshot.
2. **Related contacts per contact** (B2). Cache keyed by (contact, cohort `computed_at`), or precompute in the background.
3. **Per-contact touch counts** (B6, B10). Maintain them on interaction writes instead of aggregating 300k rows per read.
4. **Import preview.** The CSV is uploaded, parsed and deduped twice (preview, then start); Google/Outlook address books are fetched twice. **[code review]**
5. **Auth bootstrap per Server Action.** Each action re-reads `user_settings`. The 1.5 s import poll pays it continuously. **[code review]**

---

## 6. Projected gains summary

| # | Bottleneck | Baseline (10k / 100k) | Projected after fix | Confidence |
|---|---|---|---|---|
| B1 | Duplicates badge | 82 s / > 240 s (timeout) | 49 ms / 458 ms with the index; ~0 with a cached count | **High** (measured on both engines) |
| B2 | Related contacts | 1.3 s / 13 s (11 s native) | < 50 ms | Medium (design-dependent) |
| B3 | Graph payload | 6.6 MB / 66 MB; 0.74 s / 8.5 s | ≈ 1.3 MB / bounded | Medium |
| B4 | Dashboard | 0.82 s / 6.9 s | −50–70% | Medium |
| B5 | Rebuild on read | +2.7 s at 10k / +52 s at 100k | 0 (moved off reads) | High |
| B6 | MCP follow-ups and overview | 0.24 s / 2.5 s | < 150 ms | Medium |
| B7 | Contacts search | 0.2 s / 1.4 s | < 50 ms | Medium-high |
| B8 | Import | 482 / 196 rows/s; 40k ceiling | ~2× throughput; no ceiling | Medium |
| B9 | Landing LCP (mobile lab) | 6.4 s | ~2.0–2.5 s | Medium-high |
| B10 | Aggregate indexes | 0.3–1.1 s per statement at 100k | index-only, < 50 ms | Medium |
| B11 | Client JS | 422–513 KB gz | −30–40 KB gz per route | Medium |

## 7. Not measured here, and how to get it

- **Signed-in INP and LCP on a production build.** Needs either Clerk test keys in a staging build or Speed Insights field data. Graph filter interactions and the contacts list without virtualization (unbounded DOM growth on infinite scroll) are the INP candidates **[code review]**.
- **App-wide re-renders.** `AppShell` re-renders on every navigation through `usePathname`, and the `ViewerPlan` provider value is rebuilt on each `router.refresh()`. Measure with the React Profiler on a staging build **[code review]**.
- **Neon specifics.** `SHOW jit`; `pg_stat_user_indexes` for unused indexes; `pg_stat_statements` top 20 by total time on staging after replaying this audit's paths.
- **Embeddings and HNSW plans** need pgvector (Neon staging).
