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

## Seeds

| tier | contacts | interactions | memory chunks | embeddings | reminders | seed time | PGlite size |
|---|---|---|---|---|---|---|---|
| new | 0 | 0 | 0 | 0 | 0 | < 1 s | – |
| 500 | 525 | 1,548 | 597 | 500 | 19 | 10.5 s | 645 MB after the import bench |
| 5000 | 5,025 | 15,049 | 5,998 | 5,000 | 109 | 44 s | 794 MB after the import bench |
| 50000 | 50,025 | ~150,000 | ~60,000 | 10,000 (20 %) | 1,000 | 3.3 min | 1.7 GB; 13.4 GB RAM free afterwards |

(+25 demo-workspace contacts each. The import bench adds and removes 20,000 rows twice, which bloats the directory and the planner statistics; `latency/explain.ts` runs `ANALYZE` first for that reason.)

## Headline measurements

**Server, in-process (statements / sequential depth / CPU ms / payload), by tier.** Depth is the number of sequential round trips; on neon-http multiply by the RTT (8 ms same-region). CPU is PGlite + JS on this machine.

| path | stmts | depth | 500 | 5,000 | 50,000 |
|---|---|---|---|---|---|
| Dashboard bundle (`getDashboardData`) | 15 | 2.4–3.6 | 175 ms / 373 KB | 763 ms / 1.19 MB | **4.7 s / 8.6 MB** |
| Graph, default scope (`loadGraphData`) | 8 | ~1 | 109 ms / 366 KB | 857 ms / 3.5 MB | **8.8 s / 34.7 MB** |
| Graph action (`getGraphData`) | 10 | 3.5 | 165 ms | 956 ms | 9.1 s |
| Contacts first page | 3 | 2.1–3.4 | 13 ms / 27 KB | 14 ms | 39 ms |
| Contacts page 2 (cursor) | 5 | 4.3–5.2 | 28 ms | 23 ms | 44 ms |
| Contacts duplicates count (streamed on `/contacts`) | 3 | 2.2 | 13 ms | **28.4 s** (30.3 s in EXPLAIN ANALYZE) | not run (~50 min by plan shape) |
| Contacts search "hop" (prefix, no embedding) | 3 | 2.3–2.5 | 17 ms | 48 ms | 383 ms |
| Contacts search "hopper" (hybrid) | 7 | 4.5–14 | 40 ms | 169 ms | 927 ms |
| Contacts search "engineer at acme" (hybrid) | 12 | 3.5–8 | 244 ms | 909 ms | **2.27 s** |
| Hybrid search, keyword only | 4 | 2 | 29 ms | 68 ms | 91 ms |
| Hybrid search, keyword + semantic (JS fallback) | 5 | 2.4–4.6 | 165 ms | 662 ms | 618 ms (20 % embedded) |
| Hybrid search, filtered (recall guard rerun) | 10 | 2–6.6 | 327 ms | 1.38 s | 1.39 s |
| Memory search, lexical / hybrid | 2 / 3 | 2 / 2–9 | 16 / 191 ms | 85 / 668 ms | 692 / 1,281 ms |
| Profile: contact + timeline | 2 + 2 | 2 + 2 | 10 + 7 ms | 17 + 11 ms | 9 + 6 ms |
| Profile: related contacts | 8 | 5 | 183 ms | **1.74 s** | **15.8 s** |
| Reminders rail + today page | 3 + 2 | 1 + 1 | 3 + 6 ms | 3 + 5 ms | 5 + 12 ms |
| Knowledge base / people | 5 / 2 | 2–4 / 1–2 | 56 / 19 ms | 115 / 22 ms | 689 / 28 ms |
| Chat threads list / suggestions | 3 / 12 | 3 / 4 | 12 / 27 ms | 12 / 29 ms | 9 / 51 ms |
| Notification panel (polled) | 11 | 3.7–4.2 | 30 ms / 22 KB | 48 ms / 64 KB | 32 ms / 64 KB |
| App pulse (every 90 s per tab) | 13 | 4.9–5.6 | 35 ms / 25 KB | 38 ms / 66 KB | 35 ms / 66 KB |
| MCP `search_contacts` / `get_contact` | 8 / 6 | 5–6 / 4–5 | 37 / 17 ms | 92 / 18 ms | 116 / 18 ms |
| MCP `who_do_i_know_at` / `find_path_to` | 7 / 12 | 5–7 / 6–7 | 19 / 40 ms | 27 / 88 ms | 111 / 253 ms |
| MCP `due_followups` / `get_network_overview` | 11 / 14 | 6.5–12 / 4.5–7.7 | 41 / 60 ms | 172 / 182 ms | **1.56 / 1.77 s** |
| Extension `me` / `search` / `resolve` | 5 / 3 / 5 | 3–4 / 3 / 3–4 | 22 / 14 / 20 ms | 17 / 11 / 37 ms | 39 / 10 / 196 ms |

Reads that stay flat in network size: contacts pages and filters (keyset + LIMIT), reminders, chat lists, notification panel, pulse, `get_contact`, extension search. Reads that grow linearly or worse: everything that scans the whole network (dashboard, graph, related contacts, due follow-ups, network overview, knowledge, duplicates count, every search arm).

**AI paths, mocked provider (900 ms per model call, 215 ms per embedding, 900 ms model TTFT, 12 ms per streamed chunk).**

| question | first token p50 (500 / 5,000 / 50,000) | complete p50 | statements | model calls |
|---|---|---|---|---|
| lookup "Who do I know at Acme?" | 3.06 s / 3.54 s / 3.82 s | 5.3 / 5.8 / 6.0 s | 31–32 | 1 embed + 2 fast JSON (understand, rerank) + 1 stream |
| open "Who should I talk to about hiring a staff engineer in Toronto?" | 3.06 s / 3.97 s / **8.10 s** | 5.3 / 6.2 / 10.3 s | 39–40 | same 4 |
| person "What did I last discuss with Sarah Chen?" | 2.05 s / 2.57 s / 2.66 s | 4.3 / 4.8 / 4.9 s | 27–28 | 1 embed + 1 fast JSON + 1 stream |

Headers flush in 13–32 ms. Stage timeline of an open question at 5,000: understand done at 1.21 s → search (incl. the serial second embedding) done at 2.03 s → LLM rerank done at 2.95 s → answer stream starts at 3.0 s → first token at 3.97 s. The model's own TTFT is 0.9 s of that; 2.2–3.0 s is Orbit's orchestration (2.0 s of it three serial model calls).

Capture (478-character note naming 5 people → reviewed): **12.2 s** at 500 and 5,000, 13.6 s at 50,000; 4 serial model calls (1 fast identify, 3 large-output detail/retry calls at 4 s each); 31 statements. Add ~0.75 s mean client poll lag for what a person sees.

**LinkedIn import, 20,000 rows (1.9 MB CSV).**

| tier | stage (parse + write rows; the UI's first progress follows this) | run, all creates | run, all merges |
|---|---|---|---|
| 500 | 2.2 s, 20 statements | 85 s, 234 rows/s, 823 statements | 138 s, 144 rows/s, 567 statements |
| 5,000 | 2.1 s | 89 s, 225 rows/s | 139 s, 144 rows/s |
| 50,000 | 1.6 s | 114 s, 175 rows/s | 167 s, 120 rows/s |

At 2,000 rows the engine ran 510 (creates) / 599 (merges) rows/s, so cost is superlinear in rows. The per-chunk progress sampler could not observe intermediate progress on PGlite (statements run synchronously in-process and starve timers), so "first progress" was not measurable here; by the engine's shape it is the first 250-row chunk, ≈ 1 s after staging.

**Pages (next dev, demo mode; medians of 3 cold loads; dev build, so an upper bound).** Desktop unthrottled:

| page | TTFB new / 500 / 5,000 | usable new / 500 / 5,000 | requests | notes |
|---|---|---|---|---|
| /dashboard | 393 / 949 / 1,923 ms | 977 / 1,541 / 2,568 ms | 45–65 | LCP 2.45 s at 5,000 |
| /contacts | 300 / 984 / **33,217** ms | – / 1,584 / 33,851 ms | 48–71 | the duplicates count (DB-16) |
| /contacts/[id] | – / 832 / 2,099 ms | – / 1,453 / 2,694 ms | 47–53 | related contacts (DB-8) |
| /graph | 209 / 377 / 1,722 ms | 697 / 984 / 2,419 ms | 44–69 | 4 MB document at 5,000 |
| /chat | 178 / 210 / 210 ms | 1,657 / 2,475 / **4,323** ms | 69–71 | TTFB fine; the lazy client panel is the wait |
| /knowledge | 177 / 418 / 624 ms | 730 / 1,119 / 1,315 ms | 47–61 | |
| /reminders | 245 / 297 / 573 ms | 797 / 876 / 1,238 ms | 44–61 | |
| /capture, /imports, /events, /meetings, /outreach, /recruiters, /radar, /settings | 160–460 ms | 590–1,050 ms | 42–72 | flat in network size |
| / (landing), /pricing | 128–196 ms | 590–764 ms | 44–57 | |

At 50,000 contacts (desktop, dev; `/contacts` and the sidebar tour skipped because of DB-16): dashboard TTFB 13.9 s / usable 14.5 s; profile 21.3 s / 22.0 s; graph 22.9 s / 27.7 s (TBT 2.8 s parsing the 39 MB document); chat usable 20.2 s; knowledge 4.3 s / 4.9 s; and even pages whose own render is 170–700 ms (reminders, imports, events, meetings, outreach, recruiters, radar, settings) showed TTFB 3.6–9.5 s. The dev server log explains the last group: `POST /api/contacts/avatar-backfill` takes **9.4–10.1 s at 50,000** (1.1–1.4 s at 5,000) and fires on every page load, and the single-threaded local database served the next document behind it (SRV-16 in the plan). On the phone profile at 50k: dashboard usable 22 s, profile 37 s, graph 60 s, chat 34 s.

Phone on 4G with 4× CPU (dev build): TTFB 170–940 ms (3.5 s for the profile at 5,000), FCP 1.4–2.7 s, **usable 8.7–16 s on every page** (total blocking time 560–2,135 ms; `/chat` worst at 16 s), repeat visits 2–7 s. The dev bundle is ~4× the production one, so read these as "hydration-bound" rather than as absolute numbers; the production JS floor is still 289 KB gz per page plus 130 KB of framework and clerk-js.

Client-side navigation (sidebar click → URL changed and no skeleton), desktop, 500 contacts: /contacts 1,525 ms (832 ms on revisit), /reminders 2,701 ms (skeleton at 1,448 ms), /dashboard 1,081 ms, /graph 617 ms, /chat 609 ms, /capture 761 ms; back 1,100 ms, forward 483 ms. At 5,000: /reminders 3.6 s, /dashboard 2.3 s, /graph 1.7 s, /contacts 33.7 s. Empty account: 260–650 ms per hop, back 331 ms. Phone profile: 1.8–9 s per hop in dev.

**HTTP (next dev; n=30 sequential, then 5-way concurrent; p50 / p95 ms).**

| target | new | 500 | 5,000 | 50,000 |
|---|---|---|---|---|
| doc /dashboard | 503 / 815 | 725 / 920 | 1,463 / 1,915 | **6,613 / 7,343** |
| doc /contacts | 264 / 298 | 726 / 850 | 36,849 / 36,855 | skipped (DB-16) |
| doc /contacts/[id] | – | 705 / 914 | 1,898 / 2,400 | **15,060 / 16,295** |
| doc /graph | 244 / 318 | 368 / 466 (516 KB) | 1,623 / 2,323 (4.0 MB) | **16,485 / 16,767 (38.8 MB)** |
| doc /reminders, /capture, /chat, /knowledge, /imports, /settings | 180–300 | 200–330 | 150–410 | 140–430 |
| /api/health | 47 / 67 | 48 / 75 | 40 / 49 | 44 / 52 |
| MCP search_contacts | 86 / 115 | 132 / 206 | 90 / 132 | 157 / 230 |
| MCP who_do_i_know_at | 73 / 103 | 136 / 154 | 114 / 131 | 345 / 473 |
| MCP due_followups | 99 / 134 | 118 / 130 | 252 / 284 | **2,413 / 2,553** |
| MCP get_network_overview | 121 / 142 | 138 / 191 | 327 / 438 | **2,497 / 2,971** |
| MCP get_contact | – | 70 / 88 | 61 / 99 | 54 / 62 |
| v1 contacts?q= / followups | 80 / 95 | 90 / 149 | 91 / 285 | 119 / 2,123 |
| extension me / contacts?q= | 73 / 58 | 90 / 88 | 71 / 53 | 176 / 53 |
| avatar | – | 70 / 161 | 66 / 140 | 51 / 111 |
| meetings candidates | 80 / 99 | 100 / 152 | 65 / 97 | 57 / 74 |

Under 5-way concurrency every document is 4–5× slower (the dev server and PGlite are effectively single-threaded); treat the concurrent columns in `REPORT.md` as relative.

**Constellation (static production build, desktop, GPU rasterised).**

| contacts | payload | ready | long tasks to ready | idle / pan / zoom fps | pan p95 frame | heap |
|---|---|---|---|---|---|---|
| 500 | 301 KB | 518 ms | 84 ms | 60 / 60 / 37 | 16.7 ms | 49 MB |
| 5,000 | 2.97 MB | 972 ms | 237 ms | 60 / 60 / 52 | 16.7 ms | 22 MB |
| 50,000 | 29.7 MB | 2,764 ms | 1,355 ms | 59 / 59 / 54 | 16.8 ms | 147 MB (summary view) |

The chart itself is smooth at every size; the cost is the payload (DB-3) and its parse. The static bench page does not render the phone layout (no chart mounts at 390 px), so phone numbers for the Constellation come from `/graph` in the page runs above: usable 10.1 s (500), 14.8 s (5,000) and 60 s (50,000) in dev on the 4G/4× profile, with 0.75 s, 1.55 s and 13.4 s of total blocking time.

**Local plan shapes (`latency/explain.ts`, PGlite, fresh statistics, 5,000-contact copy).** The duplicates self-join: Nested Loop, `Index Scan using contacts_pkey (id > a.id)` with the name match as a filter, 5,025 outer × 2,512 inner rows, 30.3 s; at 500 contacts the same statement is a Hash Join in 43 ms. Dashboard scan 84 ms (seq scan + sort of 5,025 rows), touches `GROUP BY` 39 ms, unscored probe 4.5 ms (seq scan, no index), reminders/suggestions panel < 1 ms at this size, contacts search OR-filter seq scan 26 ms, FTS arm seq scan 33 ms (GIN unused on a single-tenant table), trigram arm 60 ms seq scan. Single-tenant local plans prefer sequential scans; the multi-tenant plans need Neon (commands below).

## Full tables

The complete, machine-generated tables for every tier, profile and target are in `latency/results/baseline/REPORT.md` (regenerate with `node latency/report.mjs latency/results/baseline`); the raw JSON beside it is what a before/after comparison diffs (`node latency/report.mjs latency/results/baseline latency/results/<after>`).

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
