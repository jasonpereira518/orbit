# Orbit production performance plan

**Status:** draft for Jason's review, 2026-09-03. Nothing here is implemented.
**Goal:** every page and action in Orbit is fast for real users, without trading away accuracy (stale or wrong data) or reliability (killed functions, silent failures).
**Scope:** the web app on Vercel Hobby + Neon. The Chrome extension is out of scope except where it shares a server path.

This plan builds on the six-phase production-readiness plan approved on 2026-09-02. That plan is fully implemented but **not merged**: it sits on a stack of eight PRs (#108 to #115) that is four commits behind `main`. Section 1 records what was measured; Section 2 maps which findings the stack already fixes; the phases from Section 4 on are the new work.

---

## 1. Where production stands today (measured 2026-09-03)

### Traffic and latency

| Measurement | Value | Source |
|---|---|---|
| Visitors, last 14 days | 17 (about 550 pageviews, roughly 40 a day) | Vercel Web Analytics |
| Most-visited routes | `/dashboard` 90 views, `/` 88, `/settings` 54, `/contacts` 36 | Vercel Web Analytics |
| `/` TTFB, cold function | **2.83 s** | curl against orbit.jasonpereira.live |
| `/` TTFB, warm function | 0.20 s | same |
| `/pricing`, `/privacy`, `/terms`, `/sign-in` TTFB warm | 0.13 to 0.28 s | same |
| CDN cache on every public page | `x-vercel-cache: MISS`, `cache-control: private, no-store` | same |
| Runtime errors, last 7 days | 4 groups: one 60 s timeout on `/dashboard` (Sep 2), a failed `CREATE INDEX contacts_user_x_idx` (Aug 28), a Clerk webhook signature failure (Sep 2), a Stripe test-mode price on `/upgrade` (Aug 27) | Vercel runtime errors |
| Functions per deployment | 7 (Turbopack groups routes) | Vercel deployment metadata |

Two conclusions follow. First, at forty pageviews a day, instances go idle between sessions, so most sessions start on a **cold function** and the 2.8 s cold TTFB is what a typical visitor feels on their first page. Second, the public pages are rendered on every request because they call `auth()`; the CDN never serves them.

### Build baseline (`main` at #118, local production build, 45 s)

| Measurement | Value |
|---|---|
| Client JavaScript, all chunks | 4.7 MB raw, 1.4 MB gzipped |
| Shared root JavaScript every page loads | 447 KB raw, 130 KB gzipped |
| Page-segment client chunks (raw): `/` 547 KB, `/dashboard` 819 KB, `/contacts` 870 KB, `/graph` 667 KB, `/chat` 668 KB | on top of the shared root |
| Largest client chunks | three.js 523 KB (landing globe, lazy, correct); landing + warp 284 KB; xyflow + date-fns 247 KB (graph, lazy, correct); jszip + Next runtime 215 KB; react-dom + motion 198 KB; **motion 132 KB twice**; react-markdown 113 KB (lazy, correct); Clerk 109 KB |
| Server chunks | 90 MB on disk. One 4.1 MB SSR chunk carries the **Twilio and Resend SDKs**; OpenAI rides with `sharp` in a 455 KB chunk; Stripe and `@clerk/backend` share a 333 KB chunk; Anthropic 160 KB; JSZip 120 KB. All are evaluated on cold start whether or not the request needs them. |
| Static routes | locally `/`, `/pricing`, `/privacy`, `/terms`, `/contact` prerender, but only because Clerk keys are absent; in production `auth()` makes them dynamic |

### Data layer facts that shape everything

- The database driver is `neon()` over HTTP with no `neonConfig`, no pool, no transactions anywhere (`src/db/index.ts:1-2`, `:1723-1727`). **Every statement is its own HTTPS round trip**, so "a page issues 12 queries" means 12 serial or parallel TLS requests to Neon, and a `Promise.all` of three reads is three requests, not one.
- Every cold start blocks its first request on **three serial round trips** before any page work: `CREATE TABLE IF NOT EXISTS schema_migrations`, `SELECT version`, `SELECT extname FROM pg_extension` (`src/db/index.ts:975-1006`). The stack does not change this.
- Every authenticated navigation runs the `(app)` layout chain as **three serial awaits** (settings row, onboarding check, then entitlements + surface flags), 2 to 5 round trips before the page starts (`src/app/(app)/layout.tsx:50`, `:77`, `:93`). The `app_surface_flags` config table is read from Postgres on every navigation for every user.
- There is no caching layer above React's per-request `cache()`: zero `unstable_cache`, zero `"use cache"`, zero `revalidate` exports. Every `(app)` route is `force-dynamic`.

---

## 2. What the unmerged stack already fixes

The eight PRs contain most of the P0 work. Landing them is Phase 0 of this plan and is worth more than anything below it.

| Finding (confirmed in the audits of `main`) | Fixed by |
|---|---|
| 60 s timeouts on `/dashboard` and `/graph`: scans select `notes` and base64 `profile_image_url` for every contact | #109: wide columns dropped, avatar URL computed in SQL, `perf.slow` traces, 3,000-contact page budgets in `scripts/smoke-page-budgets.ts` |
| Always-mounted avatar backfill loads every contact then resolves photos one at a time with 15 to 20 s timeouts | #109: SQL-selected candidates, `LIMIT 25`, 15 s wall-clock budget, 8 s network timeouts |
| Notification panel reads 300 arbitrary rows and drops due follow-ups past that | #109: indexed `next_follow_up_at` query, 100-row cap |
| Cron and self-continuation routes rejected by Clerk and fail-open on a missing `CRON_SECRET` | #108 |
| Contact create, update, and logged notes wait on the embedding provider | #113: `embedding_stale_at` marker plus `after()` rebuild, hourly backfill as backstop, `smoke-write-path.ts` guard |
| Three separate shell polls (120 s panel, 90 s watcher, 75 s plan check) | #113: one `loadAppPulse` every 90 s per visible tab |
| Marketing pages dynamic because of `auth()` | #113: static `/`, `/privacy`, `/terms`, `/contact`; `/pricing` revalidates every 5 min; signed-in state resolves after hydration |
| Landing planet PNGs (1.24 MB) | #113: AVIF 129 KB and WebP 197 KB via `<picture>` |
| `/graph` blocks on everything, no Suspense | #113: heading streams, scan suspends |
| Chat: six sequential awaits, whole-answer response, no timeout on any AI call | #114: parallel retrieval, SSE streaming, 45 s `AbortSignal` on every provider call |
| No rate limits on AI-calling surfaces, no security headers | #115: Postgres-backed buckets for chat, capture, avatar resolution; report-only CSP |
| No CI, no harness isolation from Neon, migrations at runtime that log-and-continue | #111, #112 |
| No error tracking, health probe, or alerting | #110 |
| No Core Web Vitals data | #113: Speed Insights |

---

## 3. Principles

These are the accuracy and reliability guardrails. Every phase is written against them.

1. **Remove work before caching it.** A query that is not issued cannot be stale. Caching is reserved for config-shaped data with explicit invalidation (surface flags, lifetime sale count). No `cacheComponents`, no client `staleTimes`, no time-based caching of user data.
2. **Every optimization ships with a guard.** A page-budget assertion, a write-path smoke, a bundle-size check, or an EXPLAIN plan pasted into the PR. An optimization without a guard regresses silently within a month.
3. **Reads never write.** A GET that recomputes and persists scores is a latency bug and a correctness hazard under concurrency. Recompute in `after()` or in the scheduled job.
4. **Bound every scan.** No `findMany` on a per-user-growing table without a `columns` projection and either a `limit` or a documented reason (export is the one exception).
5. **One HTTPS request per group of independent statements.** On `neon-http`, `db.batch([...])` sends N statements in one request inside one transaction. It replaces `Promise.all` of reads (fewer round trips, a consistent snapshot) and makes multi-statement writes atomic.
6. **Nothing external is unbounded.** Every provider call has a timeout shorter than the route's `maxDuration`, and a typed error the UI already knows how to render.
7. **Additive schema only**, via the DDL template plus a `SCHEMA_VERSION` bump, indexes created `CONCURRENTLY`, verified by `smoke-schema-ddl` and the build-time migrate from #112.

---

## 4. Phase 0: land the stack (prerequisite)

**Goal:** production runs #108 through #115. Nothing in Phases 1 to 5 should start before this, because every later PR would conflict with the same files.

**State on 2026-09-03 01:51 EDT:** all eight branches received a fresh commit ("Defuse the fake webhook secrets") minutes before this audit, so another session is actively rebasing them. A dry-run merge of the top of the stack onto `main` conflicts in five files: `scripts/schema-ddl.lock.json`, `src/actions/capture.ts`, `src/actions/contacts.ts`, `src/actions/reminders.ts`, `src/app/api/webhooks/stripe/route.ts`. Twelve more files were touched on both sides but merge cleanly.

**Work**

1. Merge in order, #108 first, rebasing each remaining branch as its base lands. Resolve the five conflicts as unions: `main`'s note-processing rewrite of `capture.ts` and `reminders.ts` and the Money-section rewrite of the Stripe webhook keep their bodies; the stack adds `traced()` wrappers, the throttled `signature_invalid` row, and the `isInternalRequest` gate on top.
2. **Schema version collision.** `main` is at `SCHEMA_VERSION = 20`, the stack at 21, PR #117 at 20. Each number means different DDL on each side. The merge must bump to **22**, regenerate `scripts/schema-ddl.lock.json`, and pass `scripts/smoke-schema-upgrade.ts` (from #112) against a fixture at 20. This is the exact failure #118 hit and documented in its merge commit.
3. Verify in production after the deploy: `curl -i https://orbit.jasonpereira.live/api/health` returns 200 with the new sha; `curl -sI /privacy` twice returns `x-vercel-cache: HIT`; `/dashboard` for the heaviest account renders in under 3 s; no `Task timed out` errors over 48 hours; `perf.slow` rows stay empty.
4. Close PR #75 as superseded. Its four fixes landed through #103 (network-metrics memoization, closeness materialize), #109 (notification panel ordering), and #89 (indexed dedupe on the Google and Outlook paths); diff the branch against `main` first to confirm nothing is left.
5. Rebase PR #117 after the stack lands; it also claims `SCHEMA_VERSION = 20`.

**Effort:** half a day to a day of conflict resolution and verification, plus the manual dashboard checklist already written into the readiness plan (Vercel env, GitHub secrets, Better Stack, Sentry rules, Neon `statement_timeout`).

---

## 5. Phase 1: cold start and the per-navigation tax

**Goal:** first byte under 1 s on a cold function for `/dashboard`, under 300 ms warm; the layout chain costs one round trip.

**Evidence:** cold TTFB 2.83 s versus 0.20 s warm; three serial schema round trips per cold start (`src/db/index.ts:975-1006`); three serial layout awaits with `app_surface_flags` read every navigation (`src/app/(app)/layout.tsx:50-96`, `src/lib/surface-visibility.ts:55-67`); a redundant `user_settings` UPDATE awaited on the render path (`src/lib/user-settings.ts:21-46`) even though `/api/presence` writes `last_active_at` every 45 s (`src/lib/presence.ts:43-44`); `getSettings` issues a second `SELECT user_settings` the layout already memoized (`src/actions/settings.ts:33-38`); a 4.1 MB SSR chunk evaluating Twilio and Resend on every cold start; `currentUser()` (a Clerk API call) serialized ahead of the database on `/graph` and awaited on `/settings` (`src/actions/graph.ts:36`, `src/app/(app)/settings/page.tsx:47-54`).

**Work**

1. **One-statement schema probe.** Replace `schemaIsCurrent` + `detectExtensions` with a single `SELECT (SELECT version FROM schema_migrations LIMIT 1) AS version, (SELECT array_agg(extname) FROM pg_extension) AS extensions`. Fall back to the current create-then-select path only when Postgres reports `undefined_table`. Cache the result on `globalThis` so a Fluid instance that survives a module re-evaluation does not probe twice. Three round trips become one; with #112 the runtime never runs DDL in production, so the mismatch path becomes an error-level log plus a `config.schema_drift` ops condition instead of a 320-statement sweep.
2. **Layout chain in one round trip.** Start `getHiddenSurfaceKeys()` at the top of the layout alongside `bootstrapAuthenticatedUser`; move `touchLastActive` into `after()` (presence already keeps the column fresh for open tabs, and `after()` covers the first request); make `getSettings` reuse `ensureUserSettings`. Then cache `app_surface_flags` with `unstable_cache` tagged `surface-flags` and revalidate the tag from the admin action that toggles a flag. This is config data with one writer, so the cache cannot be stale in any way a user can observe. Net: the layout costs one `user_settings` read.
3. **Clerk off the critical path.** `/graph` and `/settings` hand the `currentUser()` promise to a Suspense island rather than awaiting it before the page renders. No caching of profile data; it simply stops blocking.
4. **Server SDKs load on first use.** `src/lib/ai.ts` constructs the OpenAI, Anthropic, and Gemini clients per call from static imports; `outreach-send.ts` imports Twilio and Resend at module top. Convert those to `await import(...)` inside the functions that use them, and do the same for `jszip`, `papaparse`, `sharp`, and `stripe`. The SDKs are evaluated only by the request that needs them, and the cold path for a page render evaluates none of them. Measure with the init duration Vercel reports on cold invocations in the function logs, before and after.
5. **Dev parity.** In non-production `getDb()` rebuilds the Drizzle wrapper on every call (`src/db/index.ts:1836-1845`), so local timings do not resemble Vercel. Cache it on `globalThis` in development too, keyed by the module instance, so `npm run dev` numbers are believable.

**Guards:** extend `scripts/smoke-page-budgets.ts` with a "layout chain" budget: rendering the `(app)` layout for a warm user issues at most 1 statement. A new pure smoke asserts that importing `src/lib/ai.ts`, `src/lib/outreach-send.ts`, and `src/lib/stripe.ts` does not load `openai`, `@anthropic-ai/sdk`, `@google/genai`, `twilio`, `resend`, or `stripe` from the module cache.

**Verify:** production `/` cold TTFB measured five times after a fresh deploy; `x-vercel-id`-tagged curl of `/dashboard` with a session cookie warm and cold; Speed Insights TTFB p75 per route after one week.

**Effort:** 1.5 days.

---

## 6. Phase 2: bound every hot query

**Goal:** no page or action reads more rows or columns than it renders; no read writes; write paths issue a bounded number of round trips.

**Evidence** (all on `main`, none touched by the stack):

- `getClosenessCohort` pulls a `closeness_breakdown` JSONB blob for every contact plus a `GROUP BY` over all of the user's interactions on the fast path, and on the slow path (any contact with `closeness_computed_at IS NULL`, so after every create or import) **rescores the whole network and writes chunked UPDATEs inside a GET** (`src/lib/closeness-cohort.ts:122-183`, `src/lib/closeness-materialize.ts:149-179`, `:256-263`). `/dashboard`, `/graph`, and `/contacts/[id]` all block on it.
- `semanticSearchContacts` loads every column of every contact and scores them with `String.includes` in Node, ignoring the GIN `search_tsv` and trigram indexes that exist (`src/lib/search.ts:211`, `:326-345`). Every chat turn and every search pays this.
- `getKnowledgeBase`: all columns, all contacts, no limit, awaited at the top of a non-streaming page (`src/actions/knowledge.ts:53-56`).
- `getContact`: every column plus every interaction body and every reminder for the contact, unbounded (`src/actions/contacts.ts:582-599`).
- `previewBulkNote` and `syncCalendar` each scan all contacts with all columns per invocation for duplicate detection (`src/actions/capture.ts:232`, `src/lib/calendar-sync.ts:169`), while the import engine already does this right with a 7-column projection built once per job (`src/lib/import-engine.ts:380-391`).
- `listCampaigns` loads every campaign, prospect, and message with no limit at any level (`src/actions/outreach.ts:97-124`); `/recruiters` filters `mine` in JavaScript over the full link set (`src/actions/recruiters.ts:78-82`); `generateDueFollowUps` scans every user's scheduled messages and filters to the caller's campaign afterwards (`src/actions/outreach.ts:896-907`; not a tenancy leak, the campaign is checked, but a global scan).
- Contact create issues 15 to 20 serial round trips including a `count(*)` over the user's contacts on every insert (`src/lib/contact-writes.ts:299-372`, `src/lib/closeness-materialize.ts:293-400`), and nothing is transactional, so a mid-sequence failure leaves a contact without tags or a score.
- Vector search: the HNSW index is global with `WHERE user_id` applied after the approximate scan (`src/db/index.ts:1494-1497`, `src/lib/search.ts:159-174`). At a few hundred users the top-96 neighbours may hold none of the caller's rows. `embedding_vector` is populated only by a 500-row-a-day backfill, so a 10k-contact import takes weeks to become vector-searchable and falls back to scoring 2,000 rows of 1,536 floats in Node meanwhile (`src/db/index.ts:1453-1490`, `src/lib/search.ts:259-268`).
- Missing indexes: `contact_briefs` has none (`src/db/index.ts:266`); `contacts(user_id) WHERE closeness_computed_at IS NULL` is a full per-user scan behind `needsRecalibration`; `closeness_cohorts.dirty_at` is a table scan per job tick; `contact_embeddings.content` is searched with a leading-wildcard `ILIKE` and no trigram index (`src/lib/search.ts:287`).
- The DDL list still contains an unconditional `ALTER TABLE contacts DROP COLUMN IF EXISTS linkedin_slug` followed by a re-add (`src/db/index.ts:801-808`, still present on the stack), which rewrites every contact row under an ACCESS EXCLUSIVE lock on every version bump.

**Work**

1. **Closeness cohort read path.** Split `getClosenessCohort` into `readCohortSnapshot(userId)` (one row from `closeness_cohorts` plus the per-contact scores already stored on `contacts.closeness`; never the breakdown JSONB, never the interactions aggregate) and `ensureCohortFresh(userId)` which the read path schedules via `after()` when `dirty_at` is set or unscored contacts exist. Full recalibration stays in the hourly job. `rescoreContact` already scores the touched contact synchronously on write, so the only thing that lags is cohort-level percentile calibration, by at most one job tick. Document that in the function header.
2. **Search reads from the indexes it has.** Rewrite `semanticSearchContacts` to fetch candidate ids in SQL: the `search_tsv` GIN query for keywords, the HNSW `<=>` query for vectors, union, then load the top N rows with an explicit projection. No full-table load, no JavaScript haystacks. The stack's `contact-avatar-sql.ts` provides the avatar column. See Decision 1 for how this relates to PR #82.
3. **Projection and limit sweep** with one PR per page so each is reviewable: `getKnowledgeBase` (project to the fields the page renders, cap contacts at 500 ordered by `updated_at`, stream the rest behind Suspense); `getContact` (project, interactions limited to the latest 50 with a "show older" server action, reminders to open ones); `previewBulkNote` and `syncCalendar` reuse the import engine's `buildDuplicateIndex` projection; `listCampaigns` aggregates message counts in SQL and loads messages per prospect on demand; `/recruiters` moves the `mine` filter into the WHERE clause; `generateDueFollowUps` joins on the campaign's prospect ids.
4. **`db.batch` for independent reads.** Convert the `Promise.all` groups in `getDashboardData` (six reads), `getContact`'s side queries, `/settings`, and `/recruiters` to `db.batch([...])`. One HTTPS request each, and the reads share a snapshot, which removes the "count says 12, list shows 11" class of inconsistency.
5. **Write paths.** `createContactForUser`: run the pre-write reads (entitlements, headroom count, company lookup) in one batch; keep the INSERT and the tag sync inside a second batch so they commit together; leave scoring as it is (already scoped to one contact). Target: at most 6 round trips per create. `saveNoteBatch`: batch the per-participant statements and the per-reminder action-item updates. Guard with `scripts/smoke-write-path.ts` extended to assert the statement count.
6. **Indexes** (template plus version bump, created `CONCURRENTLY` on Neon; PGlite runs them without the keyword): `contact_briefs (user_id, contact_id)`; partial `contacts (user_id) WHERE closeness_computed_at IS NULL`; partial `closeness_cohorts (dirty_at) WHERE dirty_at IS NOT NULL`; trigram on `contact_embeddings (content)` only if the `ILIKE` boost survives item 2, otherwise delete that path.
7. **Vector search correctness at scale.** Set `hnsw.ef_search` and, on pgvector 0.8 or later, `hnsw.iterative_scan = relaxed_order` for the ANN query (both go in the same `db.batch` transaction as the query, which is how a session setting reaches `neon-http`). Confirm Neon's pgvector version first. Raise the vector backfill from 500 rows a day to "all stale rows within the route's time budget", running from the hourly GitHub schedule the stack introduces. Guard with a smoke that seeds 50 users with 200 embeddings each and asserts every user's own nearest neighbours come back.
8. **Generated-column DDL is conditional.** Wrap the `linkedin_slug` and `search_tsv` drop-and-recreate in an `information_schema.columns` check so a version bump never rewrites the contacts table unless the column is actually missing. With #112 this runs at build time, but a full-table rewrite during a deploy is still a lock held while production serves the previous build.

**Guards:** `scripts/smoke-page-budgets.ts` gains knowledge, contact detail, search, capture preview, and campaign budgets (statements, no wide columns, payload bytes). A new structural smoke greps every `db.query.contacts.findMany(` in `src/` and fails on any call without `columns:` outside an allowlist (`exportUserData`). `smoke-closeness-materialized.ts` gains "a GET never issues an UPDATE".

**Verify:** `EXPLAIN (ANALYZE, BUFFERS)` in Neon for the search, dashboard, and contact detail statements before and after, pasted into each PR; `perf.slow` stays empty for the heaviest account; search results for a fixed query set are identical before and after (the accuracy check for item 2).

**Effort:** 4 days.

---

## 7. Phase 3: client shell and landing

**Goal:** the authenticated shell's first-load JavaScript drops by a third; an anonymous visitor to `/` downloads no Clerk, toast, or animation runtime they cannot use; idle tabs do no continuous rendering work.

**Evidence:** `motion` is imported statically by the always-mounted shell (`src/components/layout/app-shell.tsx:6`, `app-sidebar.tsx:6`, `mobile-nav.tsx:7`, `jobs/global-job-progress-bar.tsx:4`), which is why two 132 KB motion chunks and a 198 KB react-dom + motion chunk sit in every authenticated page. `AppStarfield` runs a continuous `requestAnimationFrame` drawing up to 700 arcs with `shadowBlur` in dark mode (`src/components/layout/app-starfield.tsx:49`, `:132-155`). The landing page statically imports `LandingHowItWorks` (20 KB source plus a 10 KB choreography module), `CometStreak`, and `ConstellationFigure`, all client components three screens down (`src/components/landing/landing-page.tsx:3`, `landing-scenes.tsx:2-3`), while the earth globe next to them is lazy, WebGL-gated, and intersection-gated (`earth-globe-mount.tsx:11-107`) and is the pattern to copy. The root layout ships `ClerkProvider` with the `@clerk/ui` theme CSS (imported into `globals.css:4`), `<Toaster />`, `WarpProvider`, and Analytics to every anonymous visitor. The graph RSC payload carries `aiSummary`, `keyFacts`, `sharedInterests`, and `metContext` for every contact although only the inspect panel for one selected contact reads them (`src/actions/graph.ts:46-77`); the page budget allows 3 MB.

**Work**

1. **Motion out of the shell.** The sidebar, mobile nav, and job progress bar use CSS transitions; `MotionConfig` moves down to the pages that animate (capture, celebration, warp, landing already load it lazily). Measure the shared root and `(app)` layout chunks before and after with the manifest script used for this audit.
2. **Starfield budget.** Pre-render the static stars once to an offscreen canvas, animate only the twinkling subset at 30 fps, drop `shadowBlur` in favour of a pre-blurred sprite, and stop the loop entirely when no star changed in the last frame. Same look, a fraction of the GPU time.
3. **Landing below-the-fold sections are lazy.** `LandingHowItWorks`, `CometStreak`, and `ConstellationFigure` load through the same `next/dynamic` plus `IntersectionObserver` wrapper as the globe. Serve the 4096-pixel earth texture (1.4 MB) only when `devicePixelRatio >= 2` and the viewport is wider than 1280 px; everyone else gets 2048.
4. **Anonymous visitors do not pay for the app.** Move `<Toaster />`, the `@clerk/ui` theme CSS import, and the Clerk provider's theme configuration from the root layout into the `(app)`, `(admin)`, `(auth)`, and `(checkout)` layouts. `WarpProvider` stays at the root (the lift-off animation crosses route groups). The Clerk provider itself stays at the root because the marketing header shows signed-in state after hydration by Jason's decision; see Decision 3 for the alternative.
5. **Graph payload carries what the graph draws.** Drop the prose fields from `getGraphData`; the inspect panel fetches one contact's detail on selection through a small server action and keeps a client-side map of what it has seen. Lower the page budget from 3 MB to 1 MB.
6. **Presence and pulse stay as they are.** After #113 an idle visible tab makes one pulse request every 90 s and one presence beat every 45 s; that is the floor Jason chose ("active now" needs the 45 s cadence). Nothing to do here.

**Guards:** `scripts/smoke-bundle-budget.ts` runs after `next build` in CI and fails when the shared root, the `(app)` layout chunks, or the marketing page segment grow past their recorded gzipped size. The PR that adds the script records the baselines (the shared root is 130 KB gzipped today; the layout and marketing numbers are measured when the script lands) and each later PR in this phase lowers the ceiling to what it achieved. The graph payload budget lives in the existing page-budget smoke.

**Verify:** Lighthouse on `/`, `/dashboard`, `/graph` in the in-app browser before and after; Speed Insights LCP and INP per route after a week; a dark-mode dashboard tab at 0 percent CPU in the Performance panel after 10 s idle.

**Effort:** 2 days.

---

## 8. Phase 4: reliability under load

**Goal:** no request can hang until the platform kills it; no webhook can be replayed into a double purge; no background job can starve another; every multi-statement write commits or rolls back as a unit.

**Evidence:** #114 gives every AI call a 45 s signal, but Resend, Twilio, Stripe, and Blob calls still have none (`src/lib/outreach-send.ts:110`, `:130`, `src/actions/billing.ts:32`, `:84`, `src/lib/contact-avatar.ts` `persistAvatar`). The Clerk `user.deleted` webhook runs about 35 sequential DELETEs before answering 200 (`src/app/api/webhooks/clerk/route.ts:93`, `src/lib/user-data.ts:100-180`) with no event-id dedupe, so a slow purge means a Svix retry and a second concurrent purge; Resend deliveries are recorded but not deduplicated either (`webhook_deliveries.event_id` has no unique index, `src/db/schema.ts:1516`). The single `process-stalled` route also prunes events, sends interest-list follow-ups, recalibrates closeness, backfills vectors and embeddings and timelines (`src/app/api/imports/process-stalled/route.ts:139-255`), so a slow backfill can push stalled-import resumption past the 300 s wall, and a killed run leaves its `cron_runs` row `running` forever (`src/lib/cron-runs.ts:24`). `generateOutreachDraftsBatch` makes one AI call per prospect over an uncapped set (`src/actions/outreach.ts:513-564`), and the extension's `starters` and `parse` routes call AI with no limiter (`src/app/api/extension/starters/route.ts:21`, `parse/route.ts:20`).

**Work**

1. **Timeouts everywhere external.** 10 s for Stripe and Resend, 15 s for Twilio, 20 s for Blob, all through the same `withDeadline` helper the AI calls use, each raising a typed error `toUserFacingError` renders. Neon itself gets `fetchOptions: { signal: AbortSignal.timeout(25_000) }` on the client plus the `statement_timeout = '20s'` role setting from the readiness checklist.
2. **Webhooks answer first.** Clerk and Resend handlers verify, write the delivery row with a unique `(source, event_id)` index (`ON CONFLICT DO NOTHING`; a conflict returns 200 immediately), respond, and run the purge or the bounce handling in `after()`. The Stripe handler already dedupes through `billing_events`.
3. **Housekeeping splits into routes.** `process-stalled` keeps only stalled-import resumption. New `POST /api/ops/housekeeping` (prune, interest-list follow-ups, closeness recalibration) and `POST /api/ops/backfill` (vectors, embeddings, timelines) each get their own `maxDuration`, `cron_runs` job name, and line in `.github/workflows/ops.yml`. The ops sweep marks any `cron_runs` row `running` for longer than its route's `maxDuration` as `killed` so `getCronHealth` stops trusting it.
4. **Atomic writes.** With `db.batch` available from Phase 2, wrap the contact create's INSERT plus tag sync, `saveNoteBatch`'s interaction plus mentions plus reminders, and `purgeUserData` in batches. A failure rolls back instead of leaving partial rows.
5. **Caps on the remaining money-spending loops.** `generateOutreachDrafts` accepts at most 25 prospects per call (the same `BULK_SEND_LIMIT` the send path uses) and the UI pages through them; the extension `starters` and `parse` routes and `backfillContactAvatars` join the `rate_limit_buckets` table from #115 (30 a minute, and a per-user daily budget of 200 avatar resolutions).

**Guards:** `smoke-webhook-guard.ts` gains "the same Clerk event twice runs one purge"; `smoke-cron-runs.ts` (new, PGlite) asserts the killed-row transition; `smoke-rate-limit.ts` covers the new buckets.

**Verify:** replay a Clerk `user.deleted` test event twice from the Clerk dashboard and confirm one purge in the audit log; pause the ops workflow for an hour and confirm `cron.missed` plus the heartbeat alert; the `perf.slow` catalogue shows no entries over 20 s after a week.

**Effort:** 2 days.

---

## 9. Phase 5: budgets and measurement

**Goal:** the numbers from Section 1 are tracked, and a regression fails CI or pages Slack before a user notices.

**Work**

1. **CI budgets.** `npm test` already runs the page budgets and write-path smoke from the stack. Add the bundle budget (Phase 3), the layout-chain budget (Phase 1), the projection lint (Phase 2), and the SDK-lazy-import smoke (Phase 1).
2. **Production signals.** Speed Insights (from #113) is the Core Web Vitals source; `perf.slow` and `perf.slow_burst` (from #109 and #110) cover server tail latency; the Better Stack monitor's 5 s response-time alert covers the health probe. Add one thing: the ops sweep records `/api/health`'s own latency into `error_events` as `perf.health` when it exceeds 2 s, so a slow-Neon day shows up as a series rather than a single alert.
3. **A weekly look.** `docs/performance.md` (from #113) gains a "how to read the week" section: the four Speed Insights routes to check, the `perf.slow` query, and the bundle-budget numbers, so the review takes ten minutes.
4. **Baseline record.** Commit the Section 1 numbers into `docs/performance.md` as the 2026-09-03 baseline so future changes have something to compare against.

**Effort:** 1 day.

---

## 10. Decisions for Jason

1. **Search: minimal fix now or rebase PR #82?** #82 ("hybrid SQL retrieval + accuracy-first chat pipeline", about 5,000 lines, open since Aug 27) already solves the search scan with an evaluation harness as its accuracy gate, but it predates the stack's chat streaming and will conflict heavily with #114. **Recommendation:** do the bounded rewrite in Phase 2 item 2 now (one day, guarded by an identical-results check on a fixed query set), then rebase #82 after launch as its own project, reusing its harness as the standing accuracy gate for search.
2. **Closeness lag.** Phase 2 item 1 means cohort percentile calibration can lag a write by up to one hourly job tick; the touched contact's own score stays immediate. **Recommendation:** accept. The alternative (recompute in the request) is the current behaviour and is the cause of the slow path.
3. **Clerk on the marketing pages.** Keeping `ClerkProvider` at the root means anonymous visitors download Clerk's client to render "Open app" for the few who are signed in. The alternative is a signed-out header with a tiny `/api/me` fetch after hydration and no Clerk JavaScript on marketing routes at all. **Recommendation:** measure first (Phase 3 item 4 removes the theme CSS and toaster either way); switch only if the marketing first-load JavaScript is still above two-thirds of its recorded baseline afterwards.
4. **Client router cache (`experimental.staleTimes.dynamic`).** Setting it to 30 s would make back-navigation instant but can show a 30-second-old page after a mutation on another tab. **Recommendation:** leave it off. Phases 1 and 2 make the server fast enough that it is not needed, and the accuracy risk is real.
5. **Vercel Hobby.** Unchanged standing risk from the readiness plan: Hobby's terms prohibit commercial use and Stripe goes live. Not a performance item, noted so it is not forgotten.

---

## 11. Deliberately not doing

- **`cacheComponents` / Partial Prerendering.** Already deferred past launch in the readiness plan; it forces every `auth()` and `headers()` read into Suspense and breaks the `(app)` layout's redirect model.
- **A Redis or Vercel Runtime Cache layer.** Nothing in the audits is a repeated identical read that survives a projection fix; adding a cache would hide the scans instead of removing them.
- **Switching the Neon driver to a WebSocket pool.** `db.batch` on `neon-http` gives the round-trip and transaction wins without a long-lived connection per Fluid instance. Revisit only if a measured hot path still needs interactive transactions.
- **Moving the graph layout to the server.** It is memoized, debounced, and bounded per cluster; the payload trim in Phase 3 is the real cost.
- **A CDN for avatars beyond Vercel Blob.** Blob plus the `/api/avatars` indirection from #109 is sufficient at beta scale.

---

## 12. Sequencing

| Order | Work | PRs | Depends on |
|---|---|---|---|
| 0 | Land the stack; close #75; rebase #117 | #108 to #115 merged, version 22 | another session is mid-rebase; coordinate before touching the branches |
| 1 | Phase 1 items 1 to 3 (probe, layout chain, Clerk) | 1 PR | 0 |
| 1 | Phase 1 items 4 to 5 (lazy SDKs, dev parity) | 1 PR | 0 |
| 2 | Phase 2 items 1, 4, 6, 8 (cohort, batch, indexes, DDL) | 1 PR | 1 |
| 2 | Phase 2 item 2 (search) | 1 PR | Decision 1 |
| 2 | Phase 2 items 3, 5 (projection sweep, write paths) | 1 PR per page, 6 small PRs | 2 |
| 2 | Phase 2 item 7 (vector search) | 1 PR | Neon pgvector version check |
| 3 | Phase 3 items 1, 2, 5 (shell) | 1 PR | 0 |
| 3 | Phase 3 items 3, 4 (landing, root layout) | 1 PR | 0, Decision 3 |
| 4 | Phase 4 | 3 PRs (timeouts + webhooks, housekeeping routes, caps + atomic writes) | 2 for `db.batch` |
| 5 | Phase 5 | 1 PR | all |

Phases 1 and 3 can run in parallel worktrees once Phase 0 lands; they touch different files. Total: about 10 working days after the stack merges.

---

## 13. End-to-end verification

- **Cold start:** five cold curls of `/dashboard` with a session cookie after a fresh deploy, p50 under 1 s (today 2.8 s on `/`).
- **Warm navigation:** `/dashboard`, `/contacts`, `/contacts/[id]`, `/graph`, `/knowledge` for the heaviest account under 500 ms TTFB warm, streamed shell visible under 200 ms.
- **Correctness:** page budgets, write-path, closeness, search-equivalence, webhook-dedupe, and rate-limit smokes green in CI; a fixed query set returns identical search results before and after Phase 2.
- **Reliability:** no `Task timed out` errors for two weeks; no `perf.slow` row over 20 s; every external call site has a deadline shorter than its route's `maxDuration` (a grep-based smoke enforces this).
- **Bundle:** shared root held at or under its 130 KB gzipped baseline; `(app)` shell and marketing page segment each at least a third below their recorded baselines, enforced in CI.
- **Field data:** Speed Insights p75 LCP under 2.5 s and INP under 200 ms on `/dashboard` and `/` after one week of the full plan.
