# Latency report (Phase 2)

Branch `claude/fervent-cray-e1bnwj`. Not merged, not deployed. The baseline is in
`LATENCY_BASELINE.md`, the plan and finding IDs are in `LATENCY_PLAN.md`, and the harness is in
`latency/`. Every number below comes from local or seeded fake data (PGlite tiers of
500 / 5,000 / 50,000 contacts, a mock AI provider with fixed delays, `next dev` for browser
runs). Nothing touched production or a real provider.

Each fix is one commit. Its message has its own before/after numbers and names its regression
test. After each change I ran typecheck, lint and `next build`, plus the related smoke tests.

## Before and after

Server numbers are `latency/server-ops.ts` CPU on PGlite. Production adds sequential depth ×
RTT; neon-http is one HTTPS round trip per statement.

| What | Tier | Before | After | Fix |
|---|---|---|---|---|
| `/contacts` duplicate-name count | 500 | 12.7 ms | 13.6 ms | DB-16 |
| | 5,000 | **28,367 ms** | **58.7 ms** | DB-16 |
| | 50,000 | ~50 min (never finished) | **256 ms** | DB-16 |
| Avatar-backfill probe (every full page load) | 500 | 130.8 ms | 5.0 ms | SRV-16 |
| | 5,000 | 835 ms | **17.5 ms** | SRV-16 |
| | 50,000 | **8,455 ms** | **338 ms** | SRV-16 |
| Graph, default scope | 5,000 | 778 ms | 505 ms | DB-4 |
| | 50,000 (same-data A/B) | 7,999 ms | **5,591 ms** | DB-4 |
| Dashboard bundle | 5,000 | 939 ms | 795 ms | DB-4 |
| | 50,000 (same-data A/B) | 5,177 ms | 4,852 ms | DB-4 |
| Profile: related contacts | 500 | 183 ms | 42 ms | DB-8 |
| | 5,000 | **1,740 ms** | **300 ms** | DB-8 |
| | 50,000 | **15,800 ms** | **2,303 ms** | DB-8 |
| Contacts search "engineer at acme": sequential round trips | 500 | 7.9 | 4.5 | DB-6 |
| | 5,000 | 7.3 | 5.9 | DB-6 |
| Contacts first page: sequential round trips | 5,000 | 2.7 | 1.7 | DB-15 |
| Capture, 5-person note → review ready (mock: 4 s per large call) | 500 | 12.19 s | **8.17 s** | AI-5 |
| | 5,000 | 12.29 s | **8.33 s** | AI-5 |
| Chat first token, open question | 5,000 | 3.97 s | 3.99 s (unchanged: #2/#3 deferred) | not done |
| Contacts search: route renders per search (browser) | 500 | 2 | 1 | CLI-3 |
| Contacts search: settled after last keystroke (dev) | 500 | 677–847 ms | 427–650 ms | CLI-3 |
| Log interaction: extra route render after save | 500 | 1 | 0 | SRV-1 |
| `/contacts` repeat visit: avatar function calls | 500 | 13 | 0–7 (median 5) | NET-1 |
| `/contacts` repeat visit: uncached photo redirects | 500 | 13 | 0–3 (median 1) | NET-1 |
| Server Actions queued during a capture extraction (12 s) | 500 | 5 | 2 | SRV-5 |
| Preloaded fonts per page (production build) | all | 3, 112 KB | **2, 67 KB** | NET-3 |
| First-load JS per route (production build, gz) | all | unchanged (max 382 KB) | unchanged | not done |

Consolidated before/after tables are in `latency/results/after/REPORT.md`
(`node latency/report.mjs latency/results/baseline latency/results/after`). Notes on reading them:
- Server ops, AI and bundle were re-run in full. Page and browser numbers come from each fix's
  own script (`latency/avatar-requests.mjs`, `renders.mjs`, `poll-queue.mjs`), with before and
  after runs on the same data.
- The 50,000-contact PGlite directory slowed by about 100 ms per statement between the baseline
  and the after run. The base commit `fe11204`, run against it now, is just as slow on untouched
  ops (contacts first page 164–172 ms on both). So the 50k comparisons above are same-data A/B
  runs of `fe11204` against head (`latency/results/after/ab-50000-*.json`), not after vs baseline.
- Depth estimates for CPU-heavy ops at 5k+ are noisy, because they subtract a noisy CPU time.
  The exact counter in `scripts/smoke-latency-depth.ts` is authoritative for round trips.

## Findings closed

| ID | What changed | Commit | Regression test |
|---|---|---|---|
| DB-16 | The duplicate-name scan self-joins only names that occur more than once | `18dab69` | `smoke-duplicate-review`: same pairs as the plain self-join; < 1 s at 1,500 contacts |
| NET-1 | Avatar route URLs versioned by photo; a versioned redirect is `private, max-age=86400` | `4d9545c` | `smoke-avatar-route-cache`: a new photo gets a new URL; no cross-tenant serving |
| SRV-16, DB-4 | Photo classification reads an 11-character prefix, not the whole base64 photo | `f87d03a` | `smoke-avatar-sql-classify`: identical answers over 13 kinds of value; < 300 ms probe |
| DB-8 | Related-contacts lowering uses `lower(… COLLATE "C")` + `replace` instead of `translate()` | `f238f66` | `smoke-related-sql-lower`: identical strings over Unicode edge cases; ≥ 3× faster |
| AI-5 | The two-pass capture detail batches run concurrently, merged in order | `ac893ad` | `smoke-ai-shared-prefix`: batches in flight together; order and fields preserved |
| SRV-1, CLI-3 | No `router.refresh()` after actions that already revalidate the page; none after search | `424580e` | `smoke-no-double-render`: the client stopped refreshing **and** the actions still revalidate |
| NET-3 | Fraunces italic is its own declaration with `preload: false` | `03cdec7` | `smoke-font-preload` |
| SRV-5 | Capture and import progress polls go through route handlers, not the action queue | `9408b32` | `smoke-poll-routes`: same answers as the actions; cross-origin and cross-tenant refused |
| DB-6, DB-15 | Lexical search arms start without waiting for the embedding; the count runs beside the page | `7651138` | `smoke-hybrid-search` 4b; `smoke-latency-depth` |

Supporting commits:
- `0957464`: the CI guardrails described below.
- `e41399a`: a line-number allowlist shifted by the capture change.
- `93563a3`: a pre-existing nondeterminism in meeting prep. It read the meeting's contacts
  without an ORDER BY, which the new scripts' position in CI shard 1 exposed.

## Deferred, and why

| # | Item | Why it is not done |
|---|---|---|
| 2, 3 | Chat first token (thinking level, rerank cap/skip, rewrite-only semantic arm) | Every saving changes what retrieval returns or how the answer is reasoned. Verifying needs `scripts/eval-ai.ts` against a real provider, which this work must not call. Decisions D-3 and D-5. |
| 5, 11 | `(app)` layout, request-scoped settings | Measured smaller than estimated: warm layout reads are 16–19 ms CPU at ~3 round trips, and a cold brand-color read adds 60 ms at 5,000 contacts. What remains is about one round trip and touches the auth gate. The ops are now in `latency/server-ops.ts`. |
| 7 (rest), 8 | Stored `avatar_kind`/`has_notes`; bounded dashboard and graph | The prefix fix got the backfill without a migration. The dashboard (795 ms at 5k) and graph (5.9 s at 50k) have no single hotspot; the fix is precomputed per-user aggregates and a bounded graph scope, which changes what is shown. Decision D-9 plus a product call. |
| 9, 23 | New indexes (`CONCURRENTLY`), tenant-led GIN | Single-tenant PGlite plans prefer sequential scans, so no gain can be shown locally. Measure on Neon staging first (commands in the baseline). |
| 12 | `LazyMotion`, one nav per viewport | 86 files, and a hydration and SSR-default question. JS per route is unchanged; the CI budget now stops it growing. |
| 13 (CSS half) | Scope `globals.css` | Not started. |
| 14 (rest) | `lower(email)`/tag indexes; no count on search pages | An index is a schema change; dropping the count changes the page. |
| 15, 16, 26 | Route progress, dashboard placeholders, starfield/beacon | Baseline CLS is 0 on every page, so #16 has no measurable gain. #15 and #26 are perceived or dark-mode only, and not measurable with this harness. |
| 17 | `after()` for post-save work, optimistic UI | Ordering risk (cohort dirty flag) and decision D-12. |
| 19 | Import: stage from the preview, chunked staging | Changes the job lifecycle. First progress is not observable on PGlite, so the gain cannot be measured locally. |
| 20 | Semantic search (pgvector) | Only measurable on Neon. |
| 24, 25, 28, 29, 31, 32–35 | Credit holds, cold-start probe, upload/after, third-party stalls, small N+1s, navigation choreography, freshness | Billing, migration safety, providers not configured locally, or decisions D-7 and D-8. #31 (extension slug) would narrow the match candidate set. |

## Verification

```bash
git checkout claude/fervent-cray-e1bnwj
npm ci --legacy-peer-deps            # the lockfile's peer set needs it on this machine
npm run typecheck && npm run lint
npm run build && npm run perf:bundle # bundle and font budget
npm test                             # full smoke suite (CI runs it in three shards)

# The benchmarks (seeds are local PGlite; never point these at a real database)
npx tsx latency/seed.ts --tier 5000
TIERS="500 5000" BENCHES="ops ai" bash latency/run-all.sh after
node latency/report.mjs latency/results/baseline latency/results/after
```

Full suite on the branch head, run as CI's three shards: 179/183, 178/183 and 177/182, so 534 of
548 pass.
- Every one of the 14 failures also fails on the base commit `fe11204`, run in this environment
  (526/541 there).
- They are network-bound tests: avatar tiers, CalDAV, web-read, radar feeds, job feed, and similar.
- `smoke-meeting-prep` was a real order-dependent failure introduced by the manifest
  change, and is fixed in `93563a3`.
- `smoke-provider-exhaustive` was a shifted line allowlist, fixed in `e41399a`.

## CI guardrails added

- **Bundle and font budget** (`scripts/check-bundle-budget.mjs`, a CI step after `npm run build`).
  It fails when:
  - a non-admin route ships more than 400 KB gz of first-load JS (today's max is 382);
  - a marketing page ships more than 200 KB gz (today's max is 181);
  - any route preloads more than 2 fonts or 70 KB of fonts.
- **Round-trip depth** (`scripts/smoke-latency-depth.ts`, in the smoke shards). It counts
  sequential round trips exactly, without timing them. The ceilings are today's depths:
  - contacts first page: 1
  - prefix search: 1
  - "engineer at acme": 3
  - duplicate-name scan: 1
  - avatar probe: 1

  The code before this branch reads 2, 2 and 5 on the three contacts paths.
- **One regression test per fix** (table above), all in the smoke manifest.

## Monitoring after merge

Read these on production after a deploy; fields are blank on purpose.

| Signal | Where | Expect | Reading |
|---|---|---|---|
| `/contacts` server time p75 | Vercel → Observability → Functions, route `/contacts` | No 30 s+ invocations | |
| `POST /api/contacts/avatar-backfill` duration p95 | Vercel Functions, that route | Down by the decompression share; < 100 ms for most accounts | |
| `/api/avatars/[contactId]` invocations per day | Vercel Functions, invocation count | Falls once browsers hold versioned redirects | |
| New `/api/capture/jobs/[id]/status` and `/api/imports/[id]/status` | Vercel Functions | Poll traffic moves here from the page's action POSTs | |
| Profile page TTFB p75 at large accounts | Speed Insights → `/contacts/[id]` | Lower for networks of several thousand | |
| LCP and INP p75 on `/contacts`, `/dashboard` | Speed Insights | INP on `/contacts` down (one render per search) | |
| Slowest statements | `pg_stat_statements` top 20 by mean (query in `LATENCY_BASELINE.md`) | `findNameCollisions` and the related-contacts text scan gone from the top | |
| Provider spend on capture | Admin usage, operation `capture.parse.details` | Input tokens per capture up for notes with 3+ batches (concurrent calls do not reuse the prompt cache) | |

## Decisions still open

These are from `LATENCY_PLAN.md` §6:
- D-1: region pinning.
- D-2: `CLERK_JWT_KEY`.
- D-3, D-5: chat thinking level and research rounds.
- D-7: navigation choreography.
- D-8: freshness versus renders.
- D-9: caching layer for the dashboard and graph aggregates.
- D-12: optimistic UI.
- D-13: a staging URL and test user for production-build page numbers.

New from this phase:
- **Capture cost versus speed.** Concurrent detail batches save 4 s per extra batch, and give
  up prompt-cache reads on notes with 3 or more batches. Keep concurrent, or concurrent only
  when the provider is not Anthropic?
