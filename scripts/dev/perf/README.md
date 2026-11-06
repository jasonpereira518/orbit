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
| `import-bench.ts N` | A LinkedIn Connections import of N rows: parse, staging, rows/s, statements per 1k rows, peak RSS, retained query-counter text, and whether the file fits one request. |

PGlite is Postgres 17 in WASM: per-statement times ran 1.0–2.6x native Postgres 16 in the
audit's calibration, and plan shapes matched. It ignores `statement_timeout`. Before
shipping a SQL change, replay it on a native Postgres loaded with the same rows: a rewrite
that was fast on PGlite stayed quadratic on Postgres 16 (audit B1).
