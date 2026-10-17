# Latency baseline

Measured on 2026-10-17 at commit `bf1b4ae` with the harness in `latency/` (see `latency/README.md` for how to re-run; results in `latency/results/baseline/`). Findings and the plan are in `LATENCY_PLAN.md`.

## Methodology

**Environment.** Linux container, 4 vCPU, 15 GB RAM, Node 22.22 (the repo pins 24; nothing measured depends on the difference), Chromium 1194 via Playwright 1.63, no network access to any provider. Nothing here touched production or real user data; every number is from seeded fake accounts.

**Data tiers.** `latency/seed.ts` builds one account (`demo-user`) per tier in its own PGlite directory: `new` (empty), `500`, `5000`, `50000` contacts, with ~3 interactions per contact (40 % carrying notes), one memory chunk per noted interaction, one profile embedding per contact (20 % at 50k; deterministic 1,536-dim unit vectors), reminders (2 %, half overdue), tags (30 %), 50 % long notes, 30 % inline base64 avatars, plus the 25-person demo workspace for real prose. Row counts per tier are in §Seeds.

**Device profiles.** `desktop` = 1366×850, unthrottled. `mobile4g` = 390×844 @3×, touch, CDP network emulation 150 ms RTT / 1.6 Mbps down / 750 Kbps up, 4× CPU slowdown (Lighthouse's mobile preset).

**What each number is.**
- *Server ops* run the page loaders, searches, MCP tools and extension routes in-process on PGlite and report SQL statements, **sequential depth** (wall time with 25 ms injected per statement ÷ 25), CPU ms, payload KB, and a production estimate `depth × RTT + cpu` at 8 ms (same-region Neon) and 40 ms (cross-region). On neon-http every statement is one HTTPS round trip, so depth × RTT is the server time a user waits for.
- *Pages* and *API* run against `next dev` in demo mode (production builds refuse to serve without Clerk by design, `src/proxy.ts`, and `NODE_ENV` is inlined at build time, so there is no local production-mode demo). Dev numbers are **upper bounds**: dev React, unminified chunks, no prefetch, routes compiled once before measuring. Production JS size comes from the build report; production server time from depth × RTT. TTFB/usable from dev are useful for ordering pages and for before/after, not as absolute targets.
- *AI* numbers use `latency/mock-providers.mjs` with fixed delays equal to the p50s the repo's own eval harness measured against Gemini (900 ms per non-streamed call, 4 s for > 4k-token outputs, 215 ms per embedding, 900 ms to first streamed token, 12 ms per chunk). What remains in the number is Orbit's orchestration: how many calls are serial and the database work between them.
- *Import* stages a 20,000-row LinkedIn CSV and runs the engine in-process, once as all creates and once as all merges.
- *Constellation* uses the repo's static bench page (`/bench/constellation`, production build) at 500 / 5,000 / 50,000 synthetic contacts.
- *Bundle* and *cold start* come from the production build via the repo's `scripts/dev/bundle-report.mjs` and `scripts/dev/cold-start-report.mjs`.

**Not measurable locally** (commands below, fields left blank): real Neon round-trip time and region, pgvector HNSW plans, Clerk/Deepgram/Google/Apollo latency, real cold starts, real-user Web Vitals, the 20 slowest and 20 most frequent production queries.

---

## Client JS per route (production build, first load)

From `scripts/dev/bundle-report.mjs` (entry chunks of the route; **excludes** the ~439 KB raw / ~130 KB gz framework root chunks every page also loads, lazy chunks, clerk-js from Clerk's CDN (~775 KB), and CSS).

| route | js raw KB | js gz KB | fonts KB | server KB |
|---|---|---|---|---|
| /contacts/[id] | 1169 | 382 | 112 | 12680 |
| /dashboard | 1156 | 380 | 112 | 16254 |
| /settings | 1125 | 365 | 112 | 12860 |
| /reminders | 1115 | 364 | 112 | 12433 |
| /imports | 1059 | 347 | 112 | 12697 |
| /contacts | 1034 | 341 | 112 | 12432 |
| /events/[id] | 1040 | 340 | 112 | 12440 |
| /capture/[batchId] | 1038 | 340 | 112 | 12365 |
| /radar | 1009 | 331 | 112 | 12464 |
| /recruiters | 951 | 311 | 112 | 12377 |
| /outreach/[id] | 952 | 310 | 112 | 15965 |
| /knowledge | 940 | 308 | 112 | 12399 |
| /events | 928 | 303 | 112 | 12391 |
| /find | 923 | 301 | 112 | 12324 |
| /contacts/new | 922 | 301 | 112 | 12331 |
| /outreach | 915 | 299 | 112 | 15925 |
| /meetings | 911 | 298 | 112 | 12319 |
| /capture | 909 | 297 | 112 | 12329 |
| /graph | 898 | 294 | 112 | 12688 |
| /chat | 890 | 291 | 112 | 12307 |
| /onboarding | 887 | 289 | 112 | 12276 |
| /pricing | 558 | 181 | 112 | 7015 |
| /upgrade | 558 | 181 | 112 | 7006 |
| /sign-in | 520 | 166 | 112 | 6704 |
| / | 432 | 146 | 112 | 6549 |

Shared app floor: 887 KB raw / 289 KB gz entry + 439 KB / 130 KB root = **~1.33 MB raw / ~420 KB gz** before any page-specific code. CSS: `globals.css` 331 KB raw / 50 KB gz on every `(clerk)` route; `site.css` 161 KB / 28 KB on marketing. Fonts: Outfit 31.5 KB + Fraunces 35.7 KB + Fraunces italic 44.6 KB, all preloaded on every page. Largest static chunks: three.js globe 535 KB (lazy, landing only), a 433 KB shared chunk, the 339 KB CSS, 283 KB, Sentry 243 KB (lazy), xyflow 210 KB (lazy), react-markdown 150 KB (lazy).

## Server cold start (module evaluation, fresh Node process, no I/O)

From `scripts/dev/cold-start-report.mjs --runs 3`, local CPU; Vercel is slower, read as relative. Adds to the first request on every new instance, before the schema probe round trip, Neon TLS and the first query.

| route | total ms | require | tree | ssr | eager KB |
|---|---|---|---|---|---|
| events | 780 | 351 | 218 | 201 | 3639 |
| imports | 732 | 341 | 203 | 173 | 3607 |
| onboarding | 718 | 284 | 241 | 190 | 3569 |
| dashboard | 713 | 286 | 256 | 171 | 3772 |
| radar | 709 | 328 | 244 | 177 | 3666 |
| settings | 702 | 321 | 198 | 201 | 3708 |
| knowledge | 682 | 292 | 186 | 153 | 3631 |
| chat | 678 | 316 | 220 | 128 | 3582 |
| reminders | 671 | 283 | 157 | 202 | 3592 |
| graph | 660 | 335 | 154 | 201 | 3588 |
| contacts | 659 | 289 | 183 | 189 | 3596 |
| contacts/[id] | 648 | 278 | 187 | 173 | 3710 |
| capture | 631 | 277 | 214 | 131 | 3597 |
| pricing | 394 | 229 | 89 | 77 | 1354 |
| / (landing) | 363 | 222 | 70 | 63 | 1383 |

Route handlers (`/api/*`) could not be timed by the repo's script on Next 16.3 (lazy route modules throw until awaited); their eager bytes: `/api/mcp` 2,073 KB, `/api/chat` 1,802 KB, `/api/capture/jobs` 1,631 KB, `/api/extension/*` ~1,410–1,470 KB, `/api/avatars/[contactId]` 802 KB, `/api/health` 639 KB.

---

<!-- MEASURED SECTIONS: filled from latency/results/baseline/REPORT.md -->
## Measured results

_See `latency/results/baseline/REPORT.md` for the complete tables; the sections below are copied from it once the run completes._

---

## Staging and production readings (commands; fields left blank on purpose)

Run these yourself; never against production for anything but read-only queries.

**Region and RTT.** Vercel → Project → Settings → Functions → "Function Region"; Neon console → Project → Settings → Region. From a Vercel function in that region, `SELECT 1` round trip: in `/api/health` the DB check already measures it; read `db.ms` in the health JSON on the staging deployment (`curl -s https://<staging>/api/health | jq .checks.db`). Same-region expected 5–12 ms; cross-region 30–80 ms.
RTT (staging): ______ ms. Function region: ______. Neon region: ______.

**Real cold start.** Vercel → Observability → Functions, filter "cold". Or: `for i in 1..5; do curl -s -o /dev/null -w "%{time_starttransfer}\n" https://<staging>/api/health; sleep 900; done` (Fluid instances idle out in minutes).
Cold TTFB `/api/health`: ______ ms; warm: ______ ms. Cold `/dashboard` TTFB: ______ ms.

**Real-user Web Vitals.** Vercel → Speed Insights → filter Production, routes `/dashboard`, `/contacts`, `/contacts/[id]`, `/graph`, `/chat`, `/capture`, device = Mobile. Record p75 for each.
| route | LCP p75 | INP p75 | CLS p75 | TTFB p75 |
|---|---|---|---|---|
| /dashboard | | | | |
| /contacts | | | | |
| /contacts/[id] | | | | |
| /graph | | | | |
| /chat | | | | |
| /capture | | | | |
Also `/admin/analytics` → page load timing (`page_views.load_ms`, the in-app "no skeleton" definition).

**Slowest and most frequent queries (Neon staging; enable once).**
```sql
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;  -- Neon supports it; needs a compute restart
-- after a day of traffic:
SELECT calls, round(mean_exec_time::numeric,1) AS mean_ms, round(total_exec_time::numeric) AS total_ms, rows, left(query, 120) AS query
FROM pg_stat_statements WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
ORDER BY mean_exec_time DESC LIMIT 20;
SELECT calls, round(mean_exec_time::numeric,1) AS mean_ms, left(query, 120) AS query
FROM pg_stat_statements ORDER BY calls DESC LIMIT 20;
```
Top 20 by mean: ______. Top 20 by calls: ______.

**pgvector plans (the one thing PGlite cannot show).** Pick a staging user with many embeddings and run:
```sql
SELECT user_id, count(*) FROM contact_embeddings WHERE embedding_vector IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 5;
-- the exact shape of src/lib/hybrid-search.ts semanticArm, using one of the user's own vectors as the probe:
EXPLAIN (ANALYZE, BUFFERS)
WITH probe AS (SELECT embedding_vector AS v FROM contact_embeddings WHERE user_id = '<USER>' AND embedding_vector IS NOT NULL LIMIT 1)
SELECT contact_id FROM (
  SELECT contact_id, min(distance) AS best FROM (
    SELECT contact_id, embedding_vector <=> (SELECT v FROM probe) AS distance
    FROM contact_embeddings WHERE user_id = '<USER>' AND embedding_vector IS NOT NULL
    ORDER BY embedding_vector <=> (SELECT v FROM probe) LIMIT 160
  ) nearest GROUP BY contact_id HAVING 1 - min(distance) > 0.25
) ranked ORDER BY best LIMIT 40;
-- then with the knobs the plan proposes (D-9 / finding DB-1):
SET LOCAL hnsw.ef_search = 200;  SET LOCAL hnsw.iterative_scan = relaxed_order;  -- rerun the EXPLAIN
SHOW hnsw.ef_search;  SELECT indexname, pg_size_pretty(pg_relation_size(indexname::regclass)) FROM pg_indexes WHERE tablename IN ('contact_embeddings','memory_chunks');
```
Look for `Index Scan using embeddings_vector_hnsw_idx` vs `Seq Scan`/`Bitmap Heap Scan on embeddings_user_idx`, `Rows Removed by Filter`, and `shared read`.
Plan (default): ______. Plan (ef_search 200 / iterative): ______. Rows returned vs. 40 wanted: ______.

**Dashboard and graph scans on a real-sized account.**
```sql
EXPLAIN (ANALYZE, BUFFERS) SELECT id, full_name, company, updated_at, (btrim(notes) <> '') AS has_notes FROM contacts WHERE user_id = '<USER>' ORDER BY updated_at DESC, id DESC;
EXPLAIN (ANALYZE, BUFFERS) SELECT contact_id, count(*) FROM interactions WHERE user_id = '<USER>' GROUP BY contact_id;
EXPLAIN (ANALYZE, BUFFERS) SELECT id FROM contacts WHERE user_id = '<USER>' AND closeness_computed_at IS NULL;
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM reminders WHERE user_id = '<USER>' AND status = 'pending' ORDER BY due_date LIMIT 80;
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM ai_suggestions WHERE user_id = '<USER>' AND status = 'pending' ORDER BY confidence_score DESC LIMIT 30;
```
`shared read` (cold-storage pages) and total time per statement: ______.

**Third-party latency on the request path** (Vercel → Observability → Traces, or Sentry performance, span by host): Clerk `api.clerk.com` p50 ______; Deepgram token grant p50 ______; Apollo `people/match` p50 ______; Google Calendar `events.list` p50 ______; provider embedding p50 ______; provider first token p50 ______ (the eval harness `scripts/eval-ai.ts` records these per operation; the last run is in `docs/ai-evals/2026-10-14-*`: understand 0.9–1.0 s, rerank 2.1–4.0 s, embed 0.2 s, answer 6.3–8.4 s).

**Production-build browser metrics on staging.** Create a Clerk test user, sign in once in a Playwright session and save `storageState`, then:
```bash
STORAGE_STATE=latency/.data/staging-state.json node latency/pages.mjs --base=https://<staging> --profile=both --rounds=3 --out=latency/results/staging/pages.json
```
(`pages.mjs` reads `STORAGE_STATE` when set.) These are the real TTFB/LCP/usable numbers against the production build; compare with the dev-mode tables above.
