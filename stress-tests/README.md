# Stress tests

Reproductions written for the 2026-10-17 audit (`SECURITY_AUDIT.md`, `FIX_PLAN.md`). They are deliberately **not** part of `npm test`: they prove findings on the current code and are expected to print `BUG` lines until the corresponding fix lands, at which point each scenario should move into `scripts/smoke-*.ts`.

Every script imports `scripts/smoke/_env.ts`, so it runs against a throwaway PGlite directory with `DATABASE_URL` and every billable provider key deleted. No network call leaves the machine (the SSRF script only resolves names; the webhook script stubs `fetch`). Requires Node 24 (`.nvmrc`).

| Script | What it exercises | Result on `eb5d69d` |
|---|---|---|
| `input-extremes.ts` | garbage dates, NUL bytes, 1–2 MB fields, bidi/zero-width text, URL schemes, a forged `options.entitlements` | 11 findings |
| `net-guard-edge.ts` | every IPv4/IPv6 literal form, private hostnames, schemes, credentials | all held |
| `recurrence-edge.ts` | Jan 31 monthly, DST, spring-forward gap, runaway `INTERVAL`/`COUNT` | 1 finding (hang) |
| `concurrency-races.ts` | limiter exactness, credit-hold serialisation, free contact cap, inbox creation, upgrade claim, bucket growth | 1 finding (cap race) |
| `scale-20k.ts` | 20,000 contacts / 40,000 interactions: graph, dashboard, knowledge, notifications, closeness rescore, full pagination walk, LIKE metacharacters, export | 3 findings |
| `resilience-repros.ts` | NULL-closeness paging, duplicate concurrent creates, overlapping webhook drains, import double-run, partial capture save, CSV formula injection, `.docx` inflate bomb | 6 findings |

Run one: `npx tsx stress-tests/<name>.ts`. `_harness.ts` prints `ok` for a property that held, `BUG` for a confirmed finding and `FAIL` for a harness problem; only `FAIL` sets a non-zero exit code. `_probes/` holds scripts a test spawns under a hard timeout.
