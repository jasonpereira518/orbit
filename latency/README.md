# Latency harness

Repeatable, comparable latency numbers for every page, interaction, route and AI path in
Orbit, at four data tiers and two device profiles. Results go to `latency/results/<label>/`
and `LATENCY_BASELINE.md` is written from them. Nothing here touches production or a real
provider: the database is a throwaway PGlite per tier, the AI providers are a local mock
with fixed delays, and third parties that have no base-URL override are simply not
configured (the code's own "not configured" branches run, as on a fresh account).

```bash
bash latency/run-all.sh baseline                     # everything (~45–90 min)
TIERS="5000" BENCHES="ops ai" bash latency/run-all.sh quick
node latency/report.mjs latency/results/baseline latency/results/after   # before/after
```

## What is measured, and with what

| Script | Measures | Against |
|---|---|---|
| `seed.ts` | builds a tier: `new` (0), `500`, `5000`, `50000` contacts with proportional interactions, notes, memory chunks, embeddings (deterministic vectors), reminders, tags, plus the 25-person demo workspace | PGlite in `latency/.data/tier-<n>` |
| `server-ops.ts` | every page loader, search shape (keyword, semantic, hybrid, memory), MCP tool, extension route: SQL statements, **sequential round-trip depth**, CPU ms, payload KB, and a production estimate at 8 ms and 40 ms per round trip | in-process, per tier |
| `pages.mjs` | per page: TTFB, FCP, LCP, CLS, TBT, INP of the main interaction, **usable** (hydrated + content + no skeleton), JS/CSS/total KB, request count; repeat visit; client-side navigation tour; history back/forward | `next dev` demo mode, desktop and "mid-range phone on 4G" (150 ms RTT, 1.6 Mbps, 4× CPU) |
| `api.mjs` | p50/p95/p99 (TTFB and complete) for page documents, MCP tools, `/api/v1`, extension routes, avatars, polling routes; sequential and 5-way concurrent | `next dev` demo mode, per tier |
| `ai.ts` | chat: headers flushed, first token, complete, statements, stage timeline; capture: paste → reviewed; model-call count per action from the mock's log | in-process + `mock-providers.mjs`, per tier |
| `import.ts` | 20,000-row LinkedIn CSV: stage time (= time to first visible progress), engine throughput rows/s for creates and for merges, statements | in-process, per tier |
| `constellation.mjs` | `/graph` open time, idle/pan/zoom fps, heap, at 500 / 5,000 / 50,000 | static production build (`ORBIT_BENCH=1`), both profiles |
| `scripts/dev/bundle-report.mjs`, `scripts/dev/cold-start-report.mjs` (existing) | first-load JS per route; server module evaluation per route | production build |

`mock-providers.mjs` answers Gemini, OpenAI and Anthropic (JSON, streaming, embeddings,
transcription) with delays set by `MOCK_*` env vars; the defaults are the p50s the repo's own
eval harness measured (`docs/ai-evals/2026-10-14-*`). Every call it serves is one JSON line
in `mock-ai.log`, so "how many model calls did one chat turn make" is a `grep`.

## What this harness cannot measure locally, and how to get those numbers

- **Production-build browser metrics.** With no Clerk keys, `src/proxy.ts` answers every
  request of a production build with 503 by design (the repo's own bench server comments say
  not to weaken that), and `NODE_ENV` is inlined at build time, so browser numbers here come
  from `next dev`. Treat them as upper bounds for server time and for JS (dev React,
  unminified). The production JS size is the bundle report; the production server time is
  `server-ops` depth × real RTT. For real production-build vitals run `pages.mjs` against a
  **staging** deployment with a signed-in Playwright `storageState` (see `LATENCY_BASELINE.md`
  → "Staging and production readings").
- **pgvector / HNSW.** PGlite has no pgvector, so the semantic arm runs the JS cosine fallback.
  Statement counts and depth are the same as production; the vector scan's own time is not.
  `EXPLAIN (ANALYZE, BUFFERS)` commands for Neon staging are in `LATENCY_BASELINE.md`.
- **Real cold starts, region RTT, Clerk, Deepgram, Google, Apollo.** Commands and dashboard
  views to read these are in `LATENCY_BASELINE.md`; fields are left blank there.

## Conventions

- Never run an in-process bench and the dev server against the same `tier-<n>` directory at
  once (PGlite is single-writer). `run-all.sh` sequences them.
- `latency/.data/` and `latency/results/` are gitignored except committed baselines.
- Compare runs at two commits with the same label scheme: `baseline`, then `after-<finding-id>`.
