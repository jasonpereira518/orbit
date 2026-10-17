# Orbit performance plan — Phase 2 proposal

Builds on `PERFORMANCE_AUDIT.md`; the B-numbers refer to its bottlenecks. Approved 2026-10-17; results are in the audit's "Phase 2 results".

## Status

| # | Fix | Status |
|---|---|---|
| 0 | Harness and `bundle-report` fix | Done (`scripts/dev/perf/`) |
| 1 | Duplicates badge | Done: the index, and the count remembered per instance for a minute |
| 2 | No cohort rebuild on read | Done |
| 3 | Contacts search | Done. Exact totals kept (no "1,000+") |
| 4 | Related contacts | Done: text scan and round 1, with a parity smoke |
| 5 | Index pack | Done (additions only; drops wait for `idx_scan`, see the runbook) |
| 6 | Landing LCP pill | Done |
| 7 | MCP / v1 follow-ups | Done (plus `getNetworkStats`) |
| 8 | Graph payload | Done: details on demand, search falls back to the server for them |
| 9 | Dashboard | Done: bounded redesign, with a parity smoke |
| 10 | Import | Done: dedupe, query counter, chunked preview and upload, paged review list |
| 11 | Neon `jit` | Runbook written; needs running on Neon |
| 12 | `LazyMotion` | Measured, no gain (+2 KB gz median); not shipped. See the audit |
| 13 | Landing CSS split | Mostly done upstream (#432) |
| 14 | Background pack | Done |

How every fix ships:
- One bottleneck per PR.
- Before and after numbers in the PR, from the same harness, against copies of the same seeded snapshots (0 / 100 / 10k / 100k).
- `smoke-behavior-golden` must stay green. Re-record only on code that is trusted.
- **Any SQL change is re-measured on native Postgres as well as PGlite.** The audit found a rewrite that was 4,500× faster on PGlite and still quadratic on PG 16 (B1).

---

## 0. Step zero: make the measurements repeatable (S, prerequisite)

Commit the audit harness under `scripts/dev/perf/`:
- `seed-sizes.ts`: the four sizes.
- `profile-ops.ts`: per-op statements, time and bytes, plus EXPLAIN with real parameters.
- `explain-suite.ts`: the named queries in audit B10, plus B1.
- `import-bench.ts`: rows/s, statements per row, peak RSS, CPU profile.
- `native-replay.py`: PGlite → native Postgres replay.

Also:
- Fix `scripts/dev/bundle-report.mjs` so it counts `rootMainFiles`. It currently under-reports first-load JS by 132 KB gz on every route.

Measurement-only. No application code changes.

---

## 1. Fixes ordered by impact ÷ effort

Effort: S ≈ ≤ ½ day, M ≈ 1–2 days, L ≈ 3+ days.

| # | Fix | Bottleneck | Impact | Effort | Projected |
|---|---|---|---|---|---|
| 1 | Expression index for duplicate names, plus a cached badge count | B1 | **Very high**: every `/contacts` render | S | 82 s → ≤ 50 ms at 10k; > 240 s → ~0.5 s (then ~0) at 100k |
| 2 | Stop rebuilding the cohort on read; score bulk creates at write; partial index on unscored | B5 | High: spikes after any sync or ingest | S–M | −2.7 s at 10k / −52 s at 100k on the first read after a bulk write |
| 3 | Contacts search: `UNION` of indexed arms, capped count | B7 | High: every keystroke | M | 195 ms → < 30 ms (10k); 1.4 s → < 50 ms (100k) |
| 4 | Related contacts: bounded, indexed candidates; off the hover path | B2 | High: every profile view **and hover** | M | 1.3 s → < 50 ms (10k); 13 s → < 100 ms (100k) |
| 5 | Index pack: `interactions (contact_id, interaction_date DESC)`; covering touch-count index; FK index on `contact_career_moves(contact_id)` | B10, B6 | Medium-high | S | 0.9–1.1 s statements → < 50 ms at 100k |
| 6 | Landing LCP: render the waitlist pill in the server HTML | B9 | High: the busiest public route | S | mobile lab LCP 6.4 s → ~2–2.5 s |
| 7 | MCP / `/api/v1` follow-ups: bounded due-list query on materialized touch counts | B6 | Medium (heavy MCP users) | M | 2.5 s → < 150 ms at 100k |
| 8 | Graph: slim star payload, details on demand | B3 | High on `/graph` | M–L | 6.6 MB → ~1.3 MB at 10k |
| 9 | Dashboard: drop the unused vocabulary statement, cache network metrics, bound `closenessById` | B4 | High: the most-visited app page | M | −50–70% loader time at 10k+ |
| 10 | Import: precomputed dedupe keys; stop retaining SQL text; chunked upload | B8 | Medium (big importers), and removes a hard failure | M (+M for upload) | ~2× rows/s at 10k+; no 40k ceiling; −24 MB per instance |
| 11 | Check `jit` on Neon and turn it off for the app role if it's on | §1.3 | Medium (every large scan) | S (config) | −1.1 s on JIT-triggering scans |
| 12 | `LazyMotion` / `m` across the shell and landing | B11 | Medium (every route) | M | −30–40 KB gz per route |
| 13 | Landing CSS split out of `globals.css` | B9 | Medium (cold, slow networks) | L | up to −0.6 s mobile lab LCP |
| 14 | Background correctness and throughput pack (see §1.14) | §4 of audit | Medium | S each | see items |

### 1.1 Duplicates badge (B1)

**Change:**
- Add `contacts_user_name_norm_idx ON contacts (user_id, lower(btrim(full_name)))` to `SCALE_DDL` and bump `SCHEMA_VERSION`. Create it `CONCURRENTLY` on Neon; see the risk note below.
- Keep the query as it is. The index alone gives the measured plan. Optionally apply the group-by rewrite, measured at 319 ms vs 458 ms at 100k.
- Cache the badge (`countDuplicatesAwaitingReview`) in a per-user row. Recompute it after imports, merges and dismissals, or lazily with a short TTL. `/contacts` reads one row.

**Re-measure:**
- `explain-suite.ts` Q14 at 10k and 100k, on PGlite **and** native PG. Expect index scans and no `Nested Loop` with `loops=N`.
- `profile-ops "count duplicates"` at 10k and 100k.
- Load `/contacts` in the browser at 10k: the document must finish streaming.

**Regression risks:**
- Index build time and lock on `contacts` at deploy. Today's `CREATE INDEX` in migrations is non-concurrent; at production sizes, build it `CONCURRENTLY`, outside the build-time migration.
- Write amplification is one more index on `contacts` inserts and updates; it is small.
- A cached count can show a stale badge. Bound it with a TTL and invalidate on merge, dismiss and import finish.

### 1.2 No cohort rebuild on read (B5)

**Change:**
- In `resolveCohortResult`, when only a few contacts are unscored, score just those rows using the stored distribution (`rescoreContact` exists) and mark the cohort dirty for the background recalibration. Never run `buildCohortResult` inside a GET when a usable snapshot exists.
- Make the bulk-create paths (`createContactsBulkForUser`, ingest finalize) score new rows at write time.
- Add `CREATE INDEX … ON contacts (user_id) WHERE closeness_computed_at IS NULL` so the per-read unscored check is index-only.

**Re-measure:** `cohort-bench.ts` at 10k and 100k (dashboard with one unscored contact must equal dashboard with all scored, ±10%); EXPLAIN Q2.

**Regression risks:**
- Scores for brand-new contacts are relative to a slightly stale distribution until the background pass. That is the tradeoff the code's own comment already accepts for staleness.
- The behavior-golden snapshot may change ordering for unscored fixtures.

### 1.3 Contacts search (B7)

**Change:**
- Build the candidate id set from a `UNION` of indexed arms:
  - `search_tsv @@`
  - `contacts_name_trgm` prefix/`LIKE` arms on name and company
  - email prefix
  - a tag arm joining `tags` on `user_id`
- Order and page over those ids only.
- Replace the exact `countContacts` with a capped count (`LIMIT 1001` and display "1,000+").

**Re-measure:** `profile-ops "contacts search"` at 10k and 100k; EXPLAIN on PGlite and native, with JIT both on and off. There must be no `Seq Scan on contacts`.

**Regression risks:**
- Result-set equality. Add a parity smoke comparing old and new id sets over a list of queries on the 10k fixture.
- Ranking order changes.
- The exact total disappears above 1,000.

### 1.4 Related contacts (B2)

**Change:**
- Candidates come from indexed signals only: same `company_id`, normalized school, shared tags (indexed), and mentions via `search_tsv` for the source's name aliases (GIN).
- Score that bounded set in JS as today.
- Render the "Related" card from a client fetch when it scrolls into view, or exclude it from full prefetch, so hovering a contact link costs nothing.
- Optionally cache per (contact, cohort `computed_at`).

**Re-measure:**
- `profile-ops "related contacts"` at 10k and 100k on PGlite, plus the native replay of each statement.
- Hover-prefetch statement count on a profile link (`DEBUG_QUERIES=1`).

**Regression risks:**
- Recall. Mention matching via tsvector tokenization differs from `translate()` plus `LIKE`, especially for non-ASCII names.
- Build a golden of the top-6 related contacts for ~50 fixture contacts and accept an agreed overlap threshold. This needs product sign-off.

### 1.5 Index pack (B10)

**Changes:**
- `interactions (contact_id, interaction_date DESC, same_day_order)` **replacing** `interactions_contact_idx`. This keeps the FK-leading rule and serves the timeline, `DISTINCT ON` last touch and per-contact reads.
- A covering index for the touch counts: `(user_id, contact_id) INCLUDE (interaction_date, interaction_type, direction)`, partial on `source IS DISTINCT FROM 'ai_derived'`.
- `contact_career_moves (contact_id)` for the FK cascade.
- Replace the correlated `max(interaction_date)` in `listContactsMatching` with `contacts.last_interaction_at`.
- **Only after** `pg_stat_user_indexes` on Neon confirms they're unused, drop the redundant prefix indexes: `contacts_user_updated_idx`, and `(user_id)` singles shadowed by composites.

**Re-measure:**
- `explain-suite.ts` Q1, Q3 (with a literal contact id), Q4 and Q12 at 100k, on both engines.
- Insert throughput in `import-bench` must not drop more than 5%.

**Regression risks:**
- Index builds lock writes; build `CONCURRENTLY`.
- Write amplification on interactions inserts during imports.
- A dropped index someone's plan relied on. Mitigate with the `idx_scan` evidence plus `pg_stat_statements` before and after on staging.

### 1.6 Landing LCP (B9)

**Change:** render `EarlyAccessPill` in the server HTML and hide it with CSS or a data attribute once the storage check finds a pass, instead of mounting it after hydration. Also confirm the hero headline is not `opacity: 0` at first paint.

**Re-measure:** Lighthouse mobile and desktop on `/`, 5 runs, median. Check the LCP element and the element-render-delay share.

**Regression risks:**
- The pill flashes for people who already joined. Use a CSS-only hide keyed on a cookie or an inline script before paint.
- Hydration mismatch warnings.

### 1.7 MCP and `/api/v1` follow-ups (B6)

**Change:**
- Serve `loadDueFollowUps` from a bounded SQL query: due/overdue contacts by `next_follow_up_at` plus closeness, `LIMIT k`.
- Back it with per-contact touch counts maintained on interaction writes (or the covering index from 1.5) instead of the full slim cohort.
- Keep `smoke-due-follow-ups-parity` as the guard.

**Re-measure:** `efficiency-bench.ts` rows `mcp due_followups` and `mcp get_network_overview` at 10k and 100k.

**Regression risks:** drift between the MCP list and the dashboard list. The parity smoke covers it.

### 1.8 Graph payload (B3)

**Change:**
- Split `GraphContact` into a slim star record (id, display name, cluster id, tier or closeness, avatar URL, dormant flag) and a details fetch for the selected star.
- Move display-only fields (summary, key facts, interests, contact links, dates) out of the initial payload.
- Consider a hard cap on drawn stars with clustering beyond it.

**Re-measure:**
- Loader payload KB (`efficiency-bench` `graph`) and the browser RSC size at 10k.
- Also add a Playwright trace on a production-like build (staging) for main-thread parse and hydrate time.

**Regression risks:**
- Features that read detail fields client-side (filters on interests or tags, search inside the chart) break silently. Inventory the readers first.
- The `smoke-graph-*` suite.

### 1.9 Dashboard (B4)

**Change:**
- Drop `getDashboardVocabularies` and the unused `graphPreview` fields, verified against behavior-golden.
- Cache network-depth metrics with the cohort snapshot.
- Restrict `closenessById` to the ids the dashboard renders.
- Make the goal-relevance read use an index or a stored column.

**Re-measure:**
- `profile-ops dashboard` at 10k and 100k.
- A CPU profile (`--cpu-prof`) of 5 iterations: GC share and app-JS share should both fall.
- Field `/dashboard` `load_ms` p50 and p75 in `/admin/analytics` for one week before and after.

**Regression risks:**
- Stats that silently depended on the full map.
- Cached metrics that go stale. Invalidate them with the cohort dirty flag.

### 1.10 Import (B8)

**Changes:**
1. **Dedupe keys.** Store the normalized name, tokens and initials on each indexed contact once, when the index is built. Use tighter fuzzy buckets: first token plus last-name initial, and a length window.
2. **Query counter.**
   - Add a counter-only mode in production that keeps the count and drops the SQL text. Capture text only under `DEBUG_QUERIES` or in smokes.
   - Make the count per job, not process-global, so concurrent jobs and continuations report correctly.
3. **Upload.** Chunked upload for Connections.csv through the existing staged-rows path (`chat-import-preview.ts`), and staging in bounded batches rather than one atomic batch.

**Re-measure:**
- `import-bench.ts` at 1k, 10k, 20k and 40k: rows/s, per-chunk ms against chunk index (must be flat), and the CPU profile's `duplicates.ts` share (target < 20%).
- `query_counter_retained` must be 0 MB in production mode.
- `smoke-import-perf` statement budgets unchanged.

**Regression risks:**
- Dedupe recall. Reuse the `smoke-import-*` fixtures and add a duplicate-recall golden: same merges before and after on a fixture with planted near-duplicates.
- Partial uploads need cleanup.

### 1.11 Postgres JIT (config)

Run `SHOW jit;` on Neon staging and production. If it's on, `ALTER ROLE <app> SET jit = off` on staging, then compare `pg_stat_statements` mean time for the top 20 queries. **Re-measure:** the native replay with JIT on and off (the audit found 1.78 s vs 0.67 s). **Risk:** a few long analytical admin queries may get slower. Compare the admin pages.

### 1.12 `motion` (B11)

**Change:** wrap the shell and landing in `<LazyMotion features={domAnimation}>`, convert `motion.*` to `m.*` (86 files; mechanical), and load `domMax` lazily only where layout animations are needed.

**Re-measure:** the fixed `bundle-report.mjs` first-load gz per route; source-map attribution of `motion-dom` and `framer-motion`.

**Risk:** components that relied on features outside `domAnimation` (layout, drag) stop animating. Visual pass on the animated components.

### 1.13 Landing CSS split

Move landing, interest and docs selectors out of `globals.css` into route-scoped CSS. The pattern already exists: `comet-streak.css`, `admin-console.css`.

**Re-measure:** the render-blocking CSS bytes on `/` (53 KB gz today) and Lighthouse LCP.

**Risk:** visual regressions. Needs screenshot diffs of the main pages.

### 1.14 Background pack (each S; code-review findings, measure as part of the fix)

- **Recruiter scans from `/recruiters`:** start them through a route handler with `maxDuration` 300 instead of `after()` under the page's 60 s. **Measure:** gaps in `imports.updated_at` for `gmail_scan` jobs.
- **Import status poll:** move `getImportJobStatus` from a Server Action to `GET /api/imports/[id]/status`. **Measure:** `open-timing.mjs` with an import running.
- **Webhook drain:** a small per-endpoint concurrency pool, and skip endpoints with consecutive timeouts in the tick. **Measure:** a fake 6 s endpoint next to a healthy one.
- **`process-stalled`:** an overall deadline, per-section durations in `cron_runs.stats`, and bounded purges.
- **Gmail discovery:** use the existing batch endpoint for headers; reuse fetched messages in the no-batch path.
- **Timeline backfill fallback:** add a deadline.
- **Capture claim staleness:** make it greater than the run's `maxDuration`.
- **`ai_result_cache` key:** include provider and model. A correctness fix; expect a one-time cache miss wave.

---

## 2. How each fix is re-measured (summary)

| Fix | Primary metric | Tool | Sizes | Engines |
|---|---|---|---|---|
| 1 | Q14 exec ms; `/contacts` stream completes | `explain-suite`, `profile-ops`, browser probe | 10k, 100k | PGlite + native |
| 2 | dashboard ms, one unscored vs all scored | `cohort-bench` | 10k, 100k | PGlite |
| 3, 4, 7, 9 | op median ms, statements, rows read | `profile-ops`, `efficiency-bench` | 0, 100, 10k, 100k | PGlite + native replay |
| 5 | exec ms and plan shape | `explain-suite` | 100k | both |
| 6, 13 | LCP, element render delay | Lighthouse (5 runs, median) | — | — |
| 8 | payload KB; RSC KB | `efficiency-bench`, browser probe | 10k, 100k | — |
| 10 | rows/s; per-chunk ms slope; dedupe CPU share; retained MB | `import-bench` plus `--cpu-prof` | 1k–40k | PGlite |
| 11 | top-20 mean ms | `pg_stat_statements` | staging | Neon |
| 12 | first-load KB gz per route | fixed `bundle-report` | — | — |

**Field confirmation after each deploy:**
- `/admin/analytics` `page_views.load_ms` p50, p75 and p95 for the touched routes, one week before and after.
- Speed Insights (Production) LCP, INP and CLS for `/`, `/dashboard`, `/contacts`, `/graph`.
- `perf.slow` rows in `error_events`.

---

## 3. Recommended performance budgets for CI

Today CI guards statement **counts** at 3k (`smoke-page-budgets`). Every regression in this audit kept its statement count: B1 is 3 statements and 82 s. So the budgets below guard **work done**, not just round trips.

Wall-clock budgets are flaky on shared CI runners, so prefer, in order:
1. **Plan and work shape**: buffers or rows examined from `EXPLAIN (ANALYZE, BUFFERS)`, which are deterministic for a fixed fixture.
2. **Payload bytes.**
3. **Growth ratios** (cost at 10k ÷ cost at 1k), which are independent of machine speed.
4. Absolute time, only with generous headroom.

### 3.1 New `smoke-scale-budgets.ts` (PGlite, 1k and 10k fixtures, per PR)

Seeding 10k takes about 16 s; the whole job is estimated at 2–3 min once B1 is fixed. Until a bottleneck is fixed, its budget runs report-only; it becomes enforcing in that fix's PR.

| Guard | Budget | Today (10k) |
|---|---|---|
| Duplicates badge: shared buffers hit | ≤ 5,000 at 10k, and **no `Nested Loop` with loops ≥ 1,000** | 75,300,942 |
| Duplicates badge: growth ratio 10k ÷ 1k | ≤ 15× | quadratic (9 ms at 100 contacts → 82 s at 10k, measured) |
| `listRelatedContacts`: rows read | ≤ 2,000 at 10k (flat in N) | 10,012 per round, plus a full text scan |
| `listRelatedContacts`: time | ≤ 150 ms | 1,299 ms |
| Contacts search (`q`): no `Seq Scan on contacts`; time | ≤ 60 ms | 195 ms |
| Graph loader payload | ≤ 1.5 MB at 10k (engaged fixture) | 6.6 MB |
| Graph loader time | ≤ 400 ms | 739 ms |
| Dashboard loader time | ≤ 400 ms at 10k; growth 10k ÷ 1k ≤ 4× | 823 ms; ≈ 12× vs 100 |
| Dashboard with one unscored contact | ≤ 1.1× the all-scored time | 4.0× |
| MCP `due_followups` / `get_network_overview` | ≤ 100 ms; rows read ≤ 5,000 | 240 ms; 19,036 rows |
| Existing statement-count budgets (`smoke-page-budgets`) | unchanged | — |

### 3.2 Import budgets (extend `smoke-import-perf`, per PR, 2k and 10k rows)

| Guard | Budget | Today |
|---|---|---|
| Statements per 1k rows | ≤ 45 | 42 |
| Per-chunk time slope (chunk 40 vs chunk 1 at 10k) | ≤ 1.5× | grows linearly |
| Rows/s at 10k | ≥ 400 now; raise to ≥ 800 after fix 10 | 482 |
| `duplicates.ts` share of CPU | ≤ 25% | 53% |
| SQL text retained by the query counter in production mode | 0 bytes | 6.1 MB at 10k |
| Peak heap at 10k | ≤ 250 MB | 135 MB |

### 3.3 Client bundle budgets (per PR, after fixing `bundle-report` to count `rootMainFiles`)

| Route group | First-load JS (gz) budget | Today |
|---|---|---|
| `/` | ≤ 280 KB now → ≤ 240 KB after fix 12 | 277 KB |
| `/pricing`, `/interest`, docs | ≤ 315 KB | 312 KB |
| App pages (each) | ≤ 520 KB now → ≤ 480 KB after fix 12; **no PR may add > 5 KB gz to every app route** | 422–513 KB |
| Global CSS | ≤ 55 KB gz now → ≤ 30 KB on `/` after fix 13 | 53 KB |
| Preloaded fonts | ≤ 3 files / 112 KB; fewer after the Fraunces italic split | 3 / 112 KB |
| New server-only packages in client chunks (e.g. `@vercel/oidc`) | 0 new | 1 (lazy) |

### 3.4 Lighthouse CI on public pages (production build with a `pk_live`-format Clerk key; mobile preset; median of 3)

| Page | LCP | TBT | CLS | Score |
|---|---|---|---|---|
| `/` | ≤ 6.5 s now → **≤ 2.5 s** after fix 6 | ≤ 400 ms | ≤ 0.05 | ≥ 0.70 → ≥ 0.85 |
| `/pricing`, `/interest`, `/privacy` | ≤ 5.0 s → ≤ 3.0 s after fix 13 | ≤ 300 ms | ≤ 0.05 | ≥ 0.75 |

### 3.5 Production budgets (alerting, not CI)

- **Speed Insights p75 per main route:** LCP ≤ 2.5 s, INP ≤ 200 ms, CLS ≤ 0.1.
- **`page_views.load_ms` in-app clicks:** p75 ≤ 450 ms for `/dashboard` and `/contacts`.
- **`perf.slow`** (calls over 10 s): alert on any `listRelatedContacts`, `findNameCollisions` or cohort rebuild. That needs `traced()` spans added around those three in fix 1, 2 and 4's PRs.

---

## 4. Proposed sequencing

1. **PR 0:** harness plus the `bundle-report` fix (no app changes).
2. **PR 1:** fix 1 (duplicates) and fix 5's FK index. Small, highest impact.
3. **PR 2:** fix 2 (cohort rebuild on read).
4. **PR 3:** fix 3 (search) and the index part of fix 5.
5. **PR 4:** fix 6 (landing LCP) plus the Lighthouse CI budgets.
6. **PR 5:** fix 4 (related contacts). Needs a product decision on the recall threshold.
7. **PR 6:** fix 7 plus fix 9 (MCP and dashboard).
8. **PR 7:** fix 8 (graph payload).
9. **PR 8:** fix 10 (import), in two parts: dedupe keys and counter first, chunked upload after.
10. **PR 9+:** fixes 11–14.

**Decisions needed from Jason before Phase 2:**
- Building the new `contacts` index `CONCURRENTLY` outside the build-time migration.
- Whether "Related" may change ranking or recall (B2).
- Turning off `jit` on Neon if it is on.
- An exact contact total vs "1,000+" in search.
- Whether the import ceiling fix (chunked upload) is in scope.
