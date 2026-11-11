# Performance harness

The tools behind `PERFORMANCE_AUDIT.md`. Each runs against its own PGlite directory, never
`.data/pglite`, and never against production. Seed once, copy the directory before every
measurement, and compare two commits by interleaving runs on identical copies (`git stash`
between them): absolute milliseconds drift with the machine, so only same-machine A/B
comparisons are claims.

| Script | Measures |
|---|---|
| `seed-sizes.ts N` | Seeds `demo-user` at N contacts (0, 100, 10k, 100k in the audit): the demo workspace plus `scale-fixture` rows, ~3 interactions each, tags, reminders. |
| `profile-ops.ts` | Every page loader, MCP tool and extension route the audit covers: statements, rows, bytes, cold and median time, and `EXPLAIN (ANALYZE, BUFFERS)` of the slowest statements with their real parameters. |
| `explain-suite.ts` | The named queries in `queries.json`. |
| `cohort-bench.ts` | Closeness recalibration, and reads with unscored contacts. |
| `webhook-drain-bench.ts` | One webhook endpoint that hangs to the attempt timeout next to a healthy one: tick time and healthy deliveries. |
| `page-bench.mjs <url>` | Every route, cold (fresh Chrome profile) and warm: TTFB, FCP, LCP, CLS, TBT, time to hydrated, requests, bytes. `--profile=desktop\|mobile` (mobile is 4x CPU, 150 ms RTT, 1.6 Mbps). Each load has a 60 s deadline. |
| `search-bench.mjs <url>` | Contacts search, from the last keystroke to settled results, plus the server's document time per query. |
| `inp-bench.mjs <url>` | Event Timing (INP-style) for typing, menus, ⌘K and clicks under CPU throttle. |
| `compare.mjs` | Before/after table from `page-bench` outputs; several files per side are medianed. |
| `bundle-attribution.mjs <route>` | Which packages and modules make up a route's first-load JS. Needs a build with `productionBrowserSourceMaps: true`. `--minus=/other` shows only what the route adds. |
| `serve-demo.sh` | Starts `next start` in demo mode on a throwaway copy of a snapshot. |
| `import-bench.ts N` | A LinkedIn Connections import of N rows: parse, staging, rows/s, statements per 1k rows, peak RSS, retained query-counter text, and whether the file fits one request. |

PGlite is Postgres 17 in WASM: per-statement times ran 1.0–2.6x native Postgres 16 in the
audit's calibration, and plan shapes matched. It ignores `statement_timeout`. Before
shipping a SQL change, replay it on a native Postgres loaded with the same rows: a rewrite
that was fast on PGlite stayed quadratic on Postgres 16 (audit B1).

## Measuring pages and interactions

A production build needs two edits to run without Clerk: `isLocalhost()` in `src/lib/demo-account.ts` also true when
`ORBIT_MEASURE=1`, and the production 503 in `src/proxy.ts` skipped under the same flag. Never commit them. Serve a
baseline worktree and the changed one side by side from copies of one snapshot, and **alternate runs between them**.
On a shared machine, one pass of desktop timings on localhost moved routes nobody had touched by +-50%
(`docs/audits/2026-11-07-performance-audit.md`). Trust CLS, bytes, request counts and the throttled `mobile` profile
before a desktop millisecond.
